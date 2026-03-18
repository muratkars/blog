---
title: "Why Object Storage Won, And Why the S3 API Is Holding It Back"
date: 2026-03-15
description: "The S3 API is the POSIX of cloud storage. A lowest-common-denominator interface that became the standard not because it's good, but because it's everywhere. Its limitations are now the ceiling for innovation."
tags: ["storage", "s3", "ai", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/hard-drives.jpg"
readTime: "22 min read"
---

![Array of hard drives in a storage chassis](/images/blog/hard-drives.jpg)

*Everything I've learned from talking to AI/ML teams about their storage struggles, and why the S3 API is at the center of all of them.*

---

## What AI/ML Teams Keep Telling Me

Over the past two years, I've talked to dozens of teams building AI infrastructure. Training pipelines, inference platforms, data engineering stacks. Different companies, different scales, different cloud strategies. The complaints are remarkably consistent.

"We spend more on S3 API calls than on the storage itself." "Our data loader is the bottleneck, not the GPUs." "We built a whole caching layer just to avoid LIST calls." "Checkpointing takes so long our GPUs sit idle." "We tried three different data loading libraries before one worked."

Every conversation circles back to the same root cause: the S3 API. Not S3's throughput (that's fine). Not S3's durability (that's excellent). The API itself. The operations it exposes, the operations it doesn't, and the workarounds that every team independently reinvents.

This post is the long version of what I tell those teams. The S3 API is the POSIX of cloud storage. Its limitations are now the ceiling for innovation. And every workaround the industry has built on top of it is an admission that the foundation is cracked.

---

## The Accidental Standard

In March 2006, Amazon launched S3 with five operations: `PUT`, `GET`, `DELETE`, `HEAD`, and `LIST`. The namespace was flat. The consistency model was eventual. The interface was HTTP. The pricing was pay-per-request.

It was, by any engineering measure, primitive. No append. No partial update. No transactions. No server-side compute. No streaming. Error responses in XML. A list operation that returns at most 1,000 keys per page, with no server-side filtering, no sorting beyond lexicographic, and no metadata projection.

Twenty years later, S3 is the most widely implemented storage API in computing history. Every cloud provider speaks it. Every analytics engine queries through it (Spark, Trino, DuckDB, Flink, Athena, Redshift, BigQuery). Every table format builds on it (Iceberg, Delta Lake, Hudi). Every ML framework reads from it (PyTorch, TensorFlow, Hugging Face, NVIDIA DALI). Every object storage system implements it (MinIO, Ceph RGW, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces). Kubernetes has COSI (Container Object Storage Interface) as the native standard for provisioning S3-compatible buckets.

The S3 API won. And now it's in the way.

---

## The Seven Limitations That Matter

### 1. No Append

S3 has no append operation. Every write is a full object replacement. If you're ingesting a streaming log, a growing CSV, or a checkpoint file that accumulates data over time, your only option is multipart upload. That requires a minimum of N+2 requests (InitiateMultipartUpload, N UploadPart calls, CompleteMultipartUpload), enforces a 5 MiB minimum part size, and demands an XML request body for completion.

If a multipart upload is never completed or aborted, the uploaded parts remain in storage *indefinitely*, silently accumulating charges. AWS's own documentation recommends configuring lifecycle rules with `AbortIncompleteMultipartUpload` to auto-clean. That's an admission that the protocol's failure mode is silent data accumulation. Storage Lens exists partly to discover accounts hemorrhaging money from orphaned uploads.

The 100 GB file uploaded as 800 x 128 MB parts? On AWS, that's 802 billable requests. On-prem S3-compatible systems like MinIO don't charge per-request, but the protocol overhead is the same: 802 round trips, 802 HTTP transactions, and an XML completion body. The streaming ingest that writes 1 KB every second? That's either one multipart upload held open for hours (with timeout risks) or thousands of tiny objects that must be compacted later.

AWS eventually added append operations, but only in S3 Express One Zone directory buckets, via the `x-amz-write-offset-bytes` header. Standard S3 buckets, where 99% of data lives, still cannot append. Azure Blob Storage has had Append Blobs since inception. The absence in S3 is not a technical limitation. It's an API limitation that has calcified into an ecosystem constraint.

### 2. No Partial Update

S3 supports byte-range GET (the `Range` header for downloads works fine). But there is no byte-range PUT. No PATCH. No partial update of any kind.

To modify one byte of a 10 GB object, you re-upload 10 GB.

This makes S3 fundamentally unsuitable as a mutable data store without application-level chunking. Every system that needs in-place updates (databases, append-optimized logs, memory-mapped files) must either avoid S3 or build an entire abstraction layer on top of it. Azure Blob Storage has Page Blobs with random read/write on 512-byte-aligned pages. S3 has nothing.

The workaround is to shard your data into small objects and manage them yourself. This is exactly what every lakehouse table format does: Iceberg, Delta Lake, and Hudi decompose tables into immutable Parquet files and manage them through metadata. It works. But the architectural complexity of every table format is, in part, compensation for a missing primitive in the storage API.

### 3. LIST Is a Full Table Scan

`ListObjectsV2` returns at most 1,000 keys per page. Listing 1 million keys requires a minimum of 1,000 API calls, each returning a paginated XML response with continuation tokens. There is no server-side filtering beyond prefix matching. No filtering by metadata, size, last-modified date, or tags. No sorting other than lexicographic. No projection. You get every field for every key whether you need it or not.

At scale, this becomes pathological. Joshua Robinson documented listing [67 billion objects in a single bucket](https://joshua-robinson.medium.com/listing-67-billion-objects-in-1-bucket-806e4895130f). That required millions of LIST calls and careful parallelization across prefix ranges. S3's 5,500 GET/HEAD requests per second per partitioned prefix means a naive listing of that bucket would take *days*.

Every analytics query that begins with "find me the Parquet files matching this partition" starts with LIST calls. Every garbage collection sweep that identifies orphaned objects starts with LIST calls. Every data governance audit that inventories a bucket starts with LIST calls. And every one of those LIST calls is O(n) in the number of keys, paginates at 1,000, and cannot be filtered server-side.

GCS does this marginally better. Its JSON API returns only requested fields (projection), reducing payload size. But the fundamental problem is the same: flat-namespace listing is an inherently expensive operation that the API provides no tools to optimize.

### 4. No Server-Side Compute

Every byte stored in S3 must traverse the network to be processed. There is no way to push computation to the data.

AWS tried twice to fix this. Both attempts failed.

**S3 Select** (2017-2024) pushed SQL queries down to S3 for CSV, JSON, and Parquet. It supported a limited SQL subset with no JOINs, no subqueries, no aggregation beyond basic functions. For Parquet files, which already have column pruning and predicate pushdown at the format level, S3 Select offered minimal improvement. AWS [deprecated S3 Select to new customers in July 2024](https://aws.amazon.com/blogs/storage/how-to-optimize-querying-your-data-in-amazon-s3/), recommending Athena or client-side filtering as replacements.

**S3 Object Lambda** (2021-2025) invoked Lambda functions to transform objects on read. On-the-fly redaction, format conversion, enrichment. Lambda cold-start latency added 100ms-1s+ per request. Per-invocation cost stacked on top of S3 pricing. Execution was capped at 60 seconds. Adoption was low enough that AWS [restricted it to existing customers in November 2025](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazons3-ol-change.html).

The lesson: **server-side compute in object storage is hard**. Both attempts were deprecated within five years of launch. The compute belongs in purpose-built query engines (Athena, Spark, Trino), not in the storage layer. But this means every byte of data must leave the storage system before any processing can happen, and that inefficiency grows linearly with data volume.

### 5. XML in 2026

S3 error responses are XML. `CompleteMultipartUpload` request bodies are XML. `ListBuckets`, `ListObjectsV2`, and ACL responses are XML. `CopyObjectResult` is XML. `DeleteObjects` (multi-object delete) request bodies are XML.

Every S3 client in 2026 must parse and generate XML for core operations. Every SDK carries XML serialization dependencies. Every error handler must extract structured information from XML payloads. Every CompleteMultipartUpload call must construct an XML body listing part numbers and ETags, and a malformed XML body is a common failure mode documented across multiple SDK issue trackers.

The industry moved to JSON a decade ago. GCS has a full JSON API. Azure Blob Storage uses JSON. Every modern REST API uses JSON. S3 cannot change because every existing client depends on XML responses, and changing the wire format would break the entire ecosystem.

This is the compatibility trap in miniature: a design decision from 2006 that wasn't wrong at the time, but cannot be corrected in 2026 without fracturing the installed base.

### 6. No Real-Time Change Streams

S3 Event Notifications are asynchronous, delivered via SNS, SQS, Lambda, or EventBridge. AWS documentation states they are "typically delivered in seconds but can sometimes take a minute or longer." Delivery is at-least-once, with no exactly-once guarantee. There is no WebSocket, gRPC stream, or Server-Sent Events interface for watching bucket changes in real time.

For systems that need to react immediately to new data (real-time ETL, streaming analytics, cache invalidation, event-driven architectures) S3 notifications are too slow, too unreliable, and too loosely coupled. The workaround is polling: periodically LIST the bucket and diff against the previous state. On AWS, every poll is a billable LIST call. On-prem you skip the bill, but you still pay in latency, wasted bandwidth, and CPU cycles. Most polls find nothing new.

Azure Blob Storage has Change Feed with append-only log semantics. GCS has Pub/Sub notifications with stronger delivery guarantees. S3's event model was designed for batch-oriented workflows where minutes of delay are acceptable. For real-time data pipelines, it's insufficient.

### 7. No Multi-Object Transactions

There is no way to atomically update multiple objects in S3. You cannot say "put these three objects or none of them." You cannot say "delete this object only if that object exists." You cannot implement a consistent two-phase commit across objects.

Before August 2024, even single-object conditional writes were impossible natively. The workaround for multi-writer coordination was DynamoDB-based locking (which is how Delta Lake manages multi-cluster writes on S3), external coordination services (ZooKeeper, etcd, Consul), or write-ahead logging patterns that add latency and complexity.

AWS added conditional writes in August 2024 with `If-None-Match` for write-once semantics and `If-Match` for compare-and-swap via ETag. This is single-object CAS only. Multi-object atomicity remains impossible. If your application needs to update a metadata index and a data file atomically (which is what every table format does on every commit) you must build your own coordination on top of an API that provides none.

Project Nessie addresses this with git-like semantics (branches, commits, multi-table atomic commits) layered on top of object storage. But Nessie is infrastructure you must deploy, manage, and scale. Infrastructure that exists because the storage API lacks a primitive.

---

## What ML Actually Needs (And What S3 Can't Provide)

The mismatch between S3 and modern workloads is most acute in machine learning, where data access patterns diverge completely from what S3 was designed for.

### The Shuffle Problem

PyTorch's DataLoader assumes random access to individual samples. On S3, this is catastrophic: each random read is a separate GET request with 10-100ms latency. A training run that reads 10 million samples per epoch means 10 million GET requests. On AWS, that's $4 per epoch in request costs alone. On-prem S3 systems dodge the per-request bill, but the latency problem is identical: 10 million sequential HTTP round trips is slow no matter who runs the servers.

The entire ML data loading ecosystem exists to work around this:

- **WebDataset** packs training samples into POSIX tar archives (100 MB-1 GB shards), converting random access into sequential I/O. Shuffles at shard level, then within a buffer. Reports 3-10x throughput improvement over per-sample access.
- **MosaicML StreamingDataset** (Databricks) was built after the team "tried for weeks to get existing solutions like TorchData or WebDataset to work." It's a drop-in IterableDataset replacement with deterministic resumption across preempted training runs.
- **FFCV** uses a custom `.beton` format with internal sharding for higher-quality randomness than shard-level shuffle.
- **Hugging Face datasets** streams from Arrow-format files with configurable shuffle buffers, and in testing, [generated over 100,000 S3 requests in under a minute](https://huggingface.co/docs/datasets/en/stream), causing IP-level throttling.

Every one of these libraries is an application-layer workaround for the fact that S3 has no concept of "iterate over this dataset in shuffled order" or "prefetch the next N samples."

### The Fan-Out Problem

Data-parallel training means 1,000 GPUs reading the same dataset. If each GPU fetches its own copy from S3, you get 1,000x request amplification. S3's per-prefix rate limit of 5,500 GET/s means 1,000 workers targeting the same prefix will be throttled immediately.

WebDataset's solution is to split shards across workers (20 tar files across 2 GPUs via `nodesplitter`). MosaicML Streaming notes that downloading ImageNet from AWS S3 costs ~$3 per machine. At 4 machines, that's $12, and it scales linearly. On-prem S3 avoids the dollar cost, but the request amplification is the same: 1,000 workers hitting the same prefix will saturate your cluster's metadata handling regardless of pricing model.

### The Checkpoint Problem

Model checkpoints must be written quickly (to minimize GPU idle time) and atomically (a half-written checkpoint is worse than no checkpoint). Checkpoint sizes range from gigabytes to hundreds of gigabytes. NVIDIA's DGX SuperPOD reference architecture specifies 40-125 GB/s aggregate write bandwidth for checkpointing.

S3's inconsistent latency (p99 write latency exceeding 100ms) makes it poorly suited for time-critical checkpoint writes. A 100 GB checkpoint to S3 at ~1 GB/s takes 100 seconds. That's 100 seconds of GPUs sitting idle, which at $3/GPU-hour across 1,000 GPUs costs $83 per checkpoint pause.

This is exactly why DeepSeek built [3FS](https://github.com/deepseek-ai/3FS). A purpose-built distributed filesystem with RDMA, CRAQ-based consistency, and 7.3 TB/s aggregate read throughput. Not because they wanted to build a filesystem, but because S3's per-request latency model and lack of POSIX random-access semantics couldn't meet their checkpoint write and data shuffling requirements. (To be clear: the S3 *protocol* doesn't limit aggregate throughput. MinIO's AIStor has demonstrated 20+ TiB/s at line rate over S3. The problem is access pattern, not bandwidth.)

### The KV Cache Problem

LLM inference KV cache uses paged attention with 16-64 KB pages. These small, non-contiguous chunks require sub-millisecond latency for offload and reload. S3's 10-100ms latency is three orders of magnitude too slow. The result: a parallel ecosystem of KV cache solutions (LMCache, Mooncake, InfiniStore, NVIDIA's BlueField-4-powered [CMX](https://www.nvidia.com/en-us/data-center/ai-storage/cmx/)) that exists entirely because the object storage API cannot serve small objects fast enough.

S3 was designed for web applications uploading images and serving static files. ML workloads need shuffle-and-stream, high fan-out, atomic checkpoints, and sub-millisecond KV access. The gap is not a tuning problem. It's a fundamental API mismatch.

---

## The Compatibility Trap

The S3 API cannot be fixed because fixing it would break everything that depends on it. And everything depends on it.

### The Ecosystem Is the Moat

MinIO built a [$1.47 billion market](https://growthmarketreports.com/report/minio-compatible-private-object-storage-market) (projected to $7.13 billion by 2033) on one proposition: full S3 compatibility, on any hardware, at any scale. Cloudflare R2's pitch: S3-compatible, zero egress fees. Backblaze B2: S3-compatible, cheapest per GB. Tigris: S3-compatible, globally distributed. Every competitor's first feature is "we speak S3."

The tools are even more locked in. Apache Spark's `S3AFileSystem` is the most-used cloud storage connector in the Hadoop ecosystem. Iceberg's `S3FileIO` is the default for AWS deployments. Delta Lake's S3 integration required building an entire DynamoDB-based coordination layer for multi-cluster writes. Not because DynamoDB is a good locking primitive, but because S3 doesn't have one.

When AWS added default data integrity protections to their S3 SDKs in 2025, the change inadvertently [made the default SDK settings incompatible with most third-party S3-compatible services](https://www.beginswithdata.com/2025/05/14/aws-s3-tools-with-gcs/), including GCS's S3 compatibility layer. A non-breaking server change in the SDK broke the ecosystem. That's how fragile the compatibility surface is.

### The LCD Effect

Any feature that enters the S3 API must work on AWS S3, MinIO, GCS (XML API), Azure (S3 compatibility layer), Ceph RGW, Cloudflare R2, and dozens of smaller implementations. This means:

- **Conditional writes** (August 2024): Every S3-compatible implementation must add `If-Match`/`If-None-Match` support or lose compatibility.
- **S3 Express One Zone append**: Only works on AWS directory buckets. No other provider can implement it without the directory bucket abstraction.
- **S3 Tables**: AWS-managed Iceberg. Incompatible concept for other providers.
- **S3 Vectors**: AWS-only. No S3-compatible equivalent exists.

AWS is increasingly shipping features that are S3 in name only. The S3 API is simultaneously too frozen to fix its core problems (XML responses, no append, no byte-range writes) and too AWS-specific to standardize its new capabilities (Express One Zone, Tables, Vectors). The lowest common denominator stays low, and innovation happens outside the API.

### The Cost of Chatty Protocols

On AWS, the S3 API's per-request pricing model creates perverse incentives. Databricks documented streaming workloads generating [17.28 million S3 API calls per day per pipeline](https://www.databricksters.com/p/the-hidden-price-of-streaming-cutting) at a 500ms trigger interval. That's $38.71/day, $1,161/month per pipeline. Ten pipelines: $10,000+/month in API costs, not storage costs.

On-prem S3-compatible systems eliminate the per-request charges, but the chattiness of the protocol remains a problem. 17.28 million API calls per day is 17.28 million HTTP round trips, 17.28 million request parsings, and 17.28 million response serializations. That's CPU and network overhead regardless of whether anyone sends you an invoice.

High-frequency writes produce many small files (the "small file problem"), which degrade query performance and amplify downstream LIST and GET calls. The S3 API has no batched write operation (PUT 100 objects in one request), no coalesce operation (merge these 50 objects into one), and no server-side compaction. Every workaround (compaction jobs, intermediate buffering, write batching) is application-level complexity born from API-level deficiency.

---

## What GCS and Azure Got Right

If we could redesign S3, what would we steal from the competition?

### From GCS

- **JSON API with field projection.** Request only the fields you need. A LIST call that needs only key names and sizes doesn't return ETags, storage class, owner, and ACL for every object.
- **gRPC transport.** Google Cloud Storage offers a native gRPC interface alongside REST. 2025 benchmarks show gRPC delivering [107% higher throughput for small payloads, 48% lower latency, 19% lower CPU usage, 34% less memory, and 41% less network bandwidth](https://cloud.google.com/storage/docs/enable-grpc-api) compared to REST.
- **Compose operations.** Server-side concatenation of up to 32 objects without downloading and re-uploading. Enables parallel composite uploads and append patterns without multipart upload complexity.
- **Resumable uploads.** Built-in resumability with session URIs. Failed uploads resume from the last successful byte, not the last successful part.

### From Azure

- **Append Blobs.** A purpose-built blob type optimized for append operations. Logging, streaming ingest, and audit trails work naturally without multipart upload gymnastics.
- **Page Blobs.** Random read/write on 512-byte-aligned pages. Databases can use blob storage without decomposing every operation into full-object replacement.
- **Lease mechanism.** Pessimistic concurrency control with 15-60 second exclusive locks. Not elegant, but functional for coordination scenarios where optimistic CAS is insufficient.
- **Batch operations.** Up to 256 sub-requests per batch call. S3's `DeleteObjects` supports batch deletes (up to 1,000 keys), but there is no general-purpose batch API for mixed operations.

Neither GCS nor Azure solved every problem. But both shipped primitives (append, partial update, batch, field projection, server-side compose) that S3 lacks in 2026. The S3 API's missing primitives aren't unsolved problems. They're solved problems that S3 chose not to adopt.

---

## The Attempts to Escape

The industry has tried multiple times to move beyond S3. Each attempt reveals something about why it's so hard.

### SNIA CDMI: The Standard Nobody Implemented

The Cloud Data Management Interface (CDMI) was an ISO/IEC standard (17826:2012, updated 2016) that defined a REST-based API for cloud data with rich metadata, capability discovery, and data management. It was thoughtfully designed, thoroughly specified, and comprehensively ignored.

The failure was simple: AWS never implemented it. Without AWS, no ecosystem formed. Without an ecosystem, no tools adopted it. Without tools, no users demanded it. CDMI is now working on version 3.0 with MCP (Model Context Protocol) support for AI. A standard searching for relevance fifteen years after its creation.

A better standard cannot displace a worse standard that has network effects. The S3 API didn't win because it's good. It won because it was first, and because everything else was built on top of it.

### Iceberg REST Catalog: The Quiet Successor

The most successful "beyond S3" API isn't a storage API at all. It's a table catalog API. The Apache Iceberg REST Catalog specification defines a standardized way to discover tables, manage schemas, perform commits, and handle multi-table operations. AWS Glue supports it. Project Nessie implements it. Polaris, Tabular (acquired by Databricks in June 2024), and multiple other catalogs expose it.

The Iceberg REST Catalog works *on top of* S3, not instead of it. Objects are still stored via the S3 API. But the table-level operations (the operations that actually matter for analytics) happen through a higher-level API that provides what S3 cannot: schema awareness, atomic commits, and multi-object coordination.

This is pragmatic and revealing. The industry didn't try to fix S3 for structured data. It built a new API layer above S3 for the operations S3 can't handle, and left S3 to do what it does adequately: store and retrieve blobs.

### LakeFS: Git for Data

LakeFS layers git-like operations (branch, commit, merge, revert) on top of object storage. It solves the multi-object atomicity problem that S3 lacks. A commit in LakeFS is an atomic snapshot of the entire repository. Triple-digit user adoption growth, organizations including NASA, Arm, and Volvo, $43M in funding, and the acquisition of the DVC project in November 2025 suggest genuine market demand.

LakeFS exists because S3 has no concept of a consistent snapshot across multiple objects. Every organization that deploys LakeFS is paying the operational cost of running a separate service to compensate for a missing S3 primitive.

### Hugging Face Hub: Purpose-Built for ML

Hugging Face took a different approach: forget S3 compatibility, design for ML artifacts. Their Hub API handles model weights, datasets, tokenizers, and configs with purpose-built semantics. In August 2024, they acquired XetHub and replaced Git LFS with a Xet storage backend featuring chunk-level deduplication. This addresses the "upload 70 GB of model weights that differ by 2% from the previous version" problem that S3's full-object-replacement model handles terribly.

By May 2025, Xet-enabled repositories became the default. Hugging Face then launched "Buckets," S3-like object storage powered by the Xet backend with content-addressable deduplication. They started by escaping S3, and are now building their own object storage with the primitives that ML actually needs.

### DeepSeek 3FS: Escape Velocity

The most dramatic escape from S3 is DeepSeek's 3FS, open-sourced in February 2025. A distributed filesystem purpose-built for AI training and inference, delivering 7.3 TB/s aggregate read throughput across their production clusters. It uses RDMA, CRAQ for strong consistency, and a FUSE interface. They explicitly chose POSIX semantics over S3 semantics because training frameworks need random access, not object-level GET/PUT.

3FS sorted 110.5 TiB across 8,192 partitions in 30 minutes (3.66 TiB/min). This is the performance profile that ML training demands, and it's several orders of magnitude beyond what any S3-compatible system delivers.

DeepSeek didn't build 3FS because they enjoy building filesystems. They built it because their workload demanded sub-millisecond random reads, RDMA transport, and POSIX semantics that the S3 API doesn't expose. Regardless of how much aggregate throughput the underlying system can deliver.

---

## What AWS Is Actually Doing

AWS isn't fixing S3. They're building specialized sub-APIs within S3's namespace.

**S3 Tables** (December 2024): Managed Apache Iceberg with 3x faster query throughput and 10x higher TPS than self-managed tables. Automatic compaction, snapshot management, schema evolution. A new "table bucket" type that acknowledges raw object storage isn't enough for analytics.

**S3 Vectors** (GA December 2025): Native vector storage for RAG and agents. 2 billion vectors per index, 20 trillion vectors per bucket, ~100ms query latency, up to 90% cost reduction versus purpose-built vector databases. A new data type that acknowledges objects aren't the only storage primitive AI needs.

**S3 Express One Zone** (November 2023, price cuts April 2025): Single-digit millisecond latency, ~9 GB/s throughput, append operations. A new storage class that acknowledges S3 Standard's latency profile is too slow for hot data paths. But single-AZ only, 8x the storage cost, and requires a different bucket type with different API behavior (LIST doesn't return lexicographic order).

**Conditional writes** (August 2024): `If-None-Match` and `If-Match` for single-object CAS. A primitive that should have existed from day one, arriving 18 years late.

The pattern is clear: AWS is not going to ship "S3 v2." They're going to keep the base S3 API frozen (XML, no append, no partial update, no transactions, no streaming) and build increasingly sophisticated features on top of it. Each with its own bucket type, its own pricing model, its own regional availability, and its own compatibility limitations. S3 Tables isn't S3. S3 Vectors isn't S3. S3 Express isn't S3. They're new products wearing S3's name.

Jack Vanlightly's assessment of S3 Express captures the broader dynamic: "The right technology, at the right time, with the wrong price." The same could be said of S3 itself in 2026: the right ecosystem, at the right scale, with the wrong API.

## Credit Where It's Due: MinIO Saw This Coming

If AWS is addressing S3's limitations from the cloud side, MinIO is addressing them from the infrastructure side. And in several cases, they got there first.

The MinIO team has consistently been 12-18 months ahead of legacy storage vendors in recognizing that object storage must evolve beyond the bare S3 API. While Dell, NetApp, and Pure Storage were still selling block and file appliances with S3 gateways bolted on, MinIO was shipping native capabilities that address the limitations outlined in this post:

**AIStor Tables** (GA February 2026): Native Apache Iceberg V3 with the full Iceberg REST Catalog API embedded directly in the object store. No external Hive Metastore. No AWS Glue dependency. No separate catalog service to deploy and manage. Tables and objects coexist in a single system. MinIO shipped this on-premises, on any hardware, without AWS lock-in.

**S3 Select replacement**: When AWS deprecated S3 Select in July 2024, MinIO [kept their implementation alive](https://blog.min.io/minio-s3-select/) and extended it. They recognized that server-side query pushdown is genuinely useful for reducing data movement, even if AWS's implementation was too limited to sustain.

**PromptObject**: MinIO's approach to AI-native object access. Structuring and serving objects in formats optimized for LLM consumption and RAG pipelines. While Hugging Face built a purpose-built Hub API and AWS shipped S3 Vectors, MinIO is building similar capabilities within the S3-compatible ecosystem, giving organizations a private, on-premises alternative to Hugging Face Hub for model artifacts and training data.

**Line-rate performance**: MinIO's AIStor has demonstrated 20+ TiB/s aggregate throughput over the standard S3 API. This proves that the protocol itself is not the bandwidth bottleneck. When we say S3's limitations are in access patterns and missing primitives, MinIO is the proof: their implementation maxes out the network while staying within S3 wire compatibility.

The contrast with legacy storage vendors is stark. EMC (now Dell) spent a decade trying to make HDFS work on Isilon. NetApp bolted an S3 gateway onto ONTAP. Pure Storage added S3 to FlashBlade as an afterthought. These companies are adding S3 compatibility to products designed for file and block. MinIO built for S3 from day one, and is now extending beyond it.

MinIO has shifted to a commercial-first model. The AGPL v3 license change came in 2021, the web console was removed from the community edition in early 2025, and in December 2025 the community edition entered maintenance mode. No new features, no accepted PRs, only critical security fixes on a case-by-case basis. The code remains open source under AGPL v3, but the development focus is entirely on AIStor, MinIO's commercial product. New features (Tables, PromptObject, enterprise management) ship exclusively in AIStor.

That said, their architectural instincts have been right at every turn: S3-native, not S3-bolted-on. Tables, not just objects. AI-aware, not byte-agnostic. The rest of the industry is catching up to positions MinIO staked out years ago. The gap MinIO leaves in the open-source world (a truly community-driven, S3-native object store with native Iceberg, ML-aware data access, and beyond-S3 primitives) is real, and it's growing.

---

## What the Next Storage API Actually Needs

If you were designing an object storage API from scratch in 2026, freed from backward compatibility, what would it look like?

### 1. Append and Partial Update as First-Class Operations

`APPEND /key` with an offset check. `PATCH /key` with byte-range specification. These are not exotic features. They're solved problems in Azure Blob Storage, in every database, in every filesystem. Their absence from S3 forces every streaming, logging, and incremental-update workload to build workarounds.

### 2. Batch Operations

`PUT_BATCH [{key1, data1}, {key2, data2}, ...]` with atomic semantics: all succeed or none do. This eliminates the need for external coordination services (DynamoDB, ZooKeeper, etcd) for every multi-object write. Table format commits become a single API call instead of a multi-step protocol.

### 3. Server-Side Filtering and Projection

`LIST /prefix?filter=size>1MB&fields=key,size&sort=last_modified&limit=100`. The storage system has all the information to evaluate this server-side. Forcing clients to page through thousands of XML responses and filter locally is a waste of network bandwidth, client CPU, and API request budget.

### 4. Change Streams

`WATCH /prefix` with a persistent connection (WebSocket, gRPC stream, SSE) that delivers object mutations in order. Real-time ETL, cache invalidation, and event-driven architectures should not require polling.

### 5. Conditional Multi-Object Writes

`PUT_IF [{key1, data1, if_match: etag1}, {key2, data2, if_none_match: *}]`. A single request that atomically applies multiple conditional writes. If any condition fails, none apply. Transactional semantics for object storage without requiring a full ACID database.

### 6. JSON Wire Format

Error responses, list responses, and request bodies in JSON. Optional content negotiation for backward compatibility. XML as a legacy format, not the default.

### 7. gRPC Transport

An optional gRPC interface alongside REST. GCS demonstrated that gRPC delivers 2x throughput and 48% lower latency for small payloads. For high-throughput data pipelines, the HTTP parsing overhead is measurable.

### 8. Prefetch and Hint APIs

`PREFETCH /prefix/shard-{00..99}.tar`. Tell the storage system what you'll need next. `HINT /key priority=high`. Inform caching and placement decisions. ML training pipelines have deterministic access patterns (epoch-based iteration over a fixed dataset). The storage system should exploit this predictability.

---

## The Pragmatic Path

None of this means you should stop using S3. The ecosystem is real. The tooling is mature. The compatibility is valuable. Abandoning S3 compatibility would be architectural malpractice for any storage system that wants adoption.

The pragmatic path is what AWS is doing, but open:

**S3-compatible base layer.** Full S3 API support (XML and all) so that every existing tool works without modification. Spark reads from it. Iceberg writes to it. PyTorch loads from it. The investment that the ecosystem has made in S3 integration is real and must be honored.

**Extended API for what S3 can't do.** Batch operations, change streams, append, server-side filtering, gRPC transport. Exposed through additional endpoints that don't break S3 compatibility but provide escape hatches for workloads that need them.

**Native ML data access.** Epoch-based iteration, shuffle-and-stream, prefetch hints, fan-out delivery. The patterns that WebDataset, MosaicML Streaming, and FFCV implement in application code should be storage-system primitives. A `POST /bucket?batch-get` that returns a TAR stream of objects in shuffled order. A `POST /bucket?batch-epoch` that registers an epoch and delivers objects in deterministic shuffled order across workers.

**Table and vector awareness.** Iceberg REST Catalog embedded in the storage system, not bolted on. Vector indexes as a native data type. Schema-aware replication and governance. The operations that matter for analytics and AI should not require separate infrastructure.

---

## The API Is the Ceiling

The S3 API's dominance is both its greatest achievement and the industry's biggest constraint. It unified an ecosystem. It enabled interoperability at a scale no storage standard has achieved before or since. It made object storage the default for an entire generation of data infrastructure.

But every innovation now happens *despite* the S3 API, not because of it:

- Table formats exist because S3 has no schema awareness
- LakeFS exists because S3 has no multi-object atomicity
- WebDataset exists because S3 has no shuffle-and-stream
- DeepSeek 3FS exists because S3's per-request latency and lack of random-access semantics don't fit ML training's access patterns
- S3 Express One Zone exists because S3 Standard is too slow
- S3 Tables exists because S3 doesn't understand Iceberg
- S3 Vectors exists because S3 doesn't understand embeddings

Each of these is an admission that the S3 API has become the ceiling, not the floor. The question isn't whether we need something beyond S3. Every system built in the last five years has already answered that. The question is whether the "beyond S3" capabilities will be proprietary AWS features, fragmented open-source workarounds, or native primitives in the next generation of storage systems.

SNIA's CDMI proved that a better standard can't displace a worse one through technical merit alone. But Iceberg's REST Catalog proved that purpose-built APIs can coexist with S3, addressing specific limitations without demanding a wholesale replacement.

The S3 API won the war. The next battle is everything it can't do.

---

*S3 API documentation from [AWS](https://docs.aws.amazon.com/AmazonS3/latest/API/). S3 Select deprecation from [AWS Storage Blog](https://aws.amazon.com/blogs/storage/how-to-optimize-querying-your-data-in-amazon-s3/). S3 Object Lambda maintenance mode from [AWS documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazons3-ol-change.html). S3 Express One Zone analysis from [Jack Vanlightly](https://jack-vanlightly.com/blog/2023/11/29/s3-express-one-zone-not-quite-what-i-hoped-for) and [WarpStream benchmarks](https://www.warpstream.com/blog/warpstream-s3-express-one-zone-benchmark-and-total-cost-of-ownership). S3 conditional writes from [AWS announcement](https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes/). S3 API cost analysis from [Databricksters](https://www.databricksters.com/p/the-hidden-price-of-streaming-cutting). GCS gRPC benchmarks from [Google Cloud](https://cloud.google.com/storage/docs/enable-grpc-api). MosaicML StreamingDataset from [Databricks Blog](https://www.databricks.com/blog/mosaicml-streamingdataset). DeepSeek 3FS from [GitHub](https://github.com/deepseek-ai/3FS). 67 billion object listing from [Joshua Robinson](https://joshua-robinson.medium.com/listing-67-billion-objects-in-1-bucket-806e4895130f). MinIO market data from [Growth Market Reports](https://growthmarketreports.com/report/minio-compatible-private-object-storage-market). Hugging Face Xet integration from [Hugging Face Blog](https://huggingface.co/blog/huggingface-hub-v1). LakeFS from [lakefs.io](https://lakefs.io/). SNIA CDMI from [snia.org](https://www.snia.org/cdmi). Iceberg REST Catalog spec from [iceberg.apache.org](https://iceberg.apache.org/rest-catalog-spec/). NVIDIA DGX SuperPOD storage requirements from [CudoCompute](https://www.cudocompute.com/blog/storage-requirements-for-ai-clusters). S3 latency benchmarks from [nixiesearch](https://nixiesearch.substack.com/p/benchmarking-read-latency-of-aws) and [Tigris](https://www.tigrisdata.com/blog/benchmark-small-objects/).*
