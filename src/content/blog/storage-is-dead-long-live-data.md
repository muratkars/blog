---
title: "Storage Is Dead. Long Live Data."
date: 2026-03-01
description: "The 40-year journey from NAS to block to S3 was just the prologue. The real story starts with Iceberg tables, vector indexes, and NVIDIA's new memory tier for AI inference."
tags: ["storage", "ai", "infrastructure"]
type: "standard"
featured: true
image: "/images/blog/storage-is-dead-hero.jpg"
readTime: "14 min read"
---

![A modern data center with rows of illuminated servers](/images/blog/storage-is-dead-hero.jpg)

*Published ahead of [NVIDIA GTC 2026](https://www.nvidia.com/gtc/) (San Jose, March 16-19)*

---

## The Four Eras of Keeping Bytes

Every decade, the storage industry reinvents itself. But each reinvention has shared the same core assumption: storage is about *bytes*. Store them, retrieve them, don't lose them. The interface changes (SCSI, iSCSI, NFS, S3) but the contract doesn't: you give me bytes, I give them back when you ask.

That contract is ending.

### Era 1: The File (NAS, 1980s-2000s)

Network Attached Storage gave us the file abstraction. Hierarchical namespaces, POSIX semantics, NFS and SMB. It was the language of workstations, home directories, and shared drives. Files had names, permissions, and modification times. Storage understood *nothing* about what was inside them.

### Era 2: The Block (SAN, 1990s-2010s)

Storage Area Networks stripped away even the file abstraction. Raw blocks, addressed by LUN and offset, served databases and virtual machines that needed deterministic latency and their own filesystem semantics. Storage became dumber on purpose. Block devices are maximally generic, maximally fast, and maximally ignorant of their contents.

### Era 3: The Object (S3, 2006-present)

Amazon S3 reinvented storage as an HTTP API. Objects with keys, metadata, and flat namespaces. No hierarchy, no POSIX, no open/close semantics. Just PUT and GET over the internet. S3's genius wasn't technical. It was economic. Pay-per-request pricing, infinite namespace, and eleven nines of durability turned storage from a capital expenditure into a utility.

For nearly two decades, the entire industry orbited S3's API. MinIO, Ceph RGW, Wasabi, Backblaze B2, Cloudflare R2. Every alternative object store exists because S3 defined the interface. The competition was on cost, performance, and deployment model. Never on capability.

### Era 4: The Data (2024-)

We're now entering the fourth era, and it breaks the pattern. For the first time, the storage system is expected to understand *what it stores*. Not just bytes, but rows, columns, embeddings, schemas, versions, and inference context. The contract is no longer "store my bytes." It's "understand my data."

Three simultaneous shifts are driving this.

---

## Shift 1: Tables Are Eating Object Storage

![Server infrastructure and networking equipment](/images/blog/server-cables.jpg)

Apache Iceberg has quietly become the most consequential data infrastructure project since S3 itself.

The numbers tell the story: Iceberg adoption is projected to surpass Delta Lake within three years, with 31% current adoption and 29% planned adoption versus Delta's 39%/23% split. The Iceberg catalog service market hit $578 million in 2024 and is projected to reach $4.18 billion by 2033, growing at 21.7% annually. Enterprises report 90% reductions in S3 API costs after migrating from Hive to Iceberg, and 20% savings on compute from more efficient query execution.

What's happening is structural: **organizations are replacing their data warehouses with Iceberg tables sitting on object storage.** The lakehouse architecture (coined by Databricks, now an industry-wide movement) puts an open table format (Iceberg, Delta, Hudi) on top of S3-compatible storage and queries it directly with Spark, Trino, DuckDB, Flink, or any engine that understands the format.

This changes what object storage needs to be. An Iceberg table isn't a single object. It's a graph of metadata files (manifest lists, manifests, snapshots) pointing to data files (Parquet, ORC, Avro), all stored as objects. The catalog that tracks tables, schemas, and snapshots becomes the critical control plane. **If your object store doesn't speak Iceberg natively, you need an external catalog service.** Another system to deploy, monitor, secure, and scale.

The hyperscalers got the memo. AWS launched [S3 Tables](https://aws.amazon.com/s3/features/tables/) in December 2024, the first S3 feature that understands tabular structure, with built-in Iceberg support delivering 3x faster query throughput and 10x higher TPS than self-managed tables, plus automatic compaction and snapshot management. S3 Tables added [Iceberg REST Catalog APIs](https://aws.amazon.com/about-aws/whats-new/2025/03/amazon-s3-tables-apache-iceberg-rest-catalog-apis/) in March 2025, letting any Iceberg-compatible engine discover and query tables stored in S3 without an external metastore.

On the software-defined side, MinIO is the only company that has fully internalized this shift. [AIStor Tables](https://blog.min.io/aistor-tables-native-iceberg-v3-for-on-premises-object-storage/), announced GA in February 2026, embeds the full Apache Iceberg V3 Catalog REST API directly into the object store. No external Hive Metastore. No AWS Glue dependency. No separate catalog service. Tables and objects coexist in a single system. The catalog *is* the storage.

This is the right architectural instinct. When every analytics query begins with a catalog lookup that resolves to a set of objects, separating the catalog from the store is an artificial boundary that adds latency, complexity, and failure modes.

---

## Shift 2: Vectors Are Becoming a Storage Primitive

The rise of RAG (Retrieval-Augmented Generation), semantic search, and AI agents has created a new data type that doesn't fit any existing storage abstraction: the **vector embedding**.

An embedding is a fixed-length array of floating-point numbers (typically 256-2048 dimensions) that represents the semantic meaning of a piece of content. A document paragraph, an image, a code snippet, a customer interaction. Querying vectors means finding the nearest neighbors in high-dimensional space, not matching keys or scanning columns.

The first generation of vector databases (Pinecone, Weaviate, Qdrant, Milvus) built purpose-built systems for this workload. But as embedding counts scale into the billions, a pattern is emerging: **vector storage is converging back into object storage.**

AWS made this explicit with [S3 Vectors](https://aws.amazon.com/s3/features/vectors/), launched in preview in 2025 and [generally available in December 2025](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/) with support for 2 billion vectors per index. S3 Vectors reduces vector storage and query costs by up to 90% compared to purpose-built vector databases, delivers sub-second query latency for infrequent access patterns, and integrates natively with Amazon Bedrock for RAG workflows.

The takeaway is clear: vectors aren't a separate workload that needs a separate database. They're a data type that belongs in the same store as the objects and tables they index. A document lives in object storage. Its Iceberg-managed metadata lives in a table. Its embedding lives in a vector index. All three should be in the same system, governed by the same policies, replicated by the same engine, and queried through the same endpoint.

No software-defined object store handles this today. The ones that recognize the convergence first will define the next decade.

---

## Shift 3: NVIDIA Is Building a New Memory Tier

![GPU and AI computing hardware](/images/blog/gpu-cluster.jpg)

At CES 2026, Jensen Huang announced something that most storage coverage buried under GPU hype: the **[Inference Context Memory Storage (ICMS)](https://developer.nvidia.com/blog/introducing-nvidia-bluefield-4-powered-inference-context-memory-storage-platform-for-the-next-frontier-of-ai/)** platform. ICMS is not a storage product. It's a new *tier* in the memory hierarchy, and it rewrites the relationship between GPUs and storage.

### The Memory Hierarchy for AI Inference

NVIDIA's Rubin platform defines five tiers for inference data:

| Tier | Medium | Access Time | Purpose |
|------|--------|-------------|---------|
| **G1** | GPU HBM | Nanoseconds | Active token generation |
| **G2** | Host System RAM | Microseconds | KV cache staging, prefill buffers |
| **G3** | Local NVMe SSDs | ~100 microseconds | Warm KV cache, short-term reuse |
| **G3.5 (ICMS)** | **Ethernet-attached flash** | **Low microseconds (RDMA)** | **Shared KV cache across pods** |
| **G4** | Shared Object Storage | Milliseconds | Durable artifacts, checkpoints, datasets |

The breakthrough is G3.5. Traditional inference offloads KV cache from GPU HBM to host RAM (G2) or local SSD (G3). But these are per-node resources. When Agent A builds a 128K-token context on Node 1, and Agent B needs a related context on Node 7, there's no shared tier. The context must be recomputed from scratch.

ICMS solves this with a **pod-level shared flash tier**, powered by [BlueField-4 DPUs](https://nvidianews.nvidia.com/news/nvidia-bluefield-4-powers-new-class-of-ai-native-storage-infrastructure-for-the-next-frontier-of-ai) with 800 Gb/s connectivity, RDMA-accelerated NVMe-oF transport, and purpose-built KV cache management via [NVIDIA Dynamo](https://developer.nvidia.com/dynamo) and NIXL (NVIDIA Inference Transfer Library).

The performance claims are striking: **5x higher tokens-per-second and 5x better power efficiency** compared to traditional storage approaches for long-context inference. The key insight is that KV cache is *transient, derived, and recomputable*. It doesn't need the durability guarantees of traditional storage, but it needs the bandwidth and shareability that local SSDs can't provide.

### What This Means for Storage Systems

ICMS doesn't replace object storage. It creates a new tier *above* it in the latency hierarchy and *below* it in the durability hierarchy. The infrastructure looks like:

```
┌──────────────────────────────────────────────────┐
│              GPU Cluster (Rubin Pods)             │
│  G1: HBM  ←→  G2: Host RAM  ←→  G3: Local NVMe  │
│                      ↕                            │
│         G3.5: ICMS (BlueField-4 + Flash JBOFs)   │
│         Shared KV cache, RDMA, NVMe-oF            │
│                      ↕                            │
│        G4: Object Storage (S3-compatible)          │
│        Training data, checkpoints, Iceberg tables  │
│        Vector indexes, model artifacts             │
└──────────────────────────────────────────────────┘
```

**G4, the object storage layer, is still the foundation.** It holds the durable data: training datasets, model weights, fine-tuning artifacts, Iceberg-managed analytics tables, vector embeddings, and RAG corpora. ICMS doesn't replace any of this. What it does is create a new *consumer* of object storage, one that pre-stages context from G4 into G3.5 for rapid inference access.

The downstream effects are significant:

1. **Object storage must be fast enough to feed ICMS.** If the G4 tier can't deliver data to G3.5 at wire speed, the entire memory hierarchy stalls. Slow object storage becomes the bottleneck for inference latency.

2. **Object storage must understand data semantics.** ICMS doesn't want raw bytes. It wants KV cache blocks, embedding chunks, and context windows. The storage system that can organize, index, and pre-stage this data based on inference patterns will outperform one that treats everything as opaque objects.

3. **The storage vendor ecosystem is mobilizing.** NVIDIA named [12 storage partners](https://nvidianews.nvidia.com/news/nvidia-bluefield-4-powers-new-class-of-ai-native-storage-infrastructure-for-the-next-frontier-of-ai) for ICMS at launch: DDN, Dell, HPE, Hitachi Vantara, IBM, Nutanix, Pure Storage, Supermicro, VAST Data, and WEKA among them. Conspicuously, no software-defined object storage project is on that list. The ICMS ecosystem is being built by proprietary vendors.

At GTC 2026, expect NVIDIA to deepen the Dynamo + ICMS integration story, likely with live demos showing agentic AI workloads with shared context across inference pods. The storage systems that integrate with this stack (speaking NVMe-oF, understanding KV cache semantics, delivering RDMA-capable throughput) will be positioned as the G4 foundation for the next generation of AI infrastructure.

---

## The Convergence: What the Next Storage System Must Be

These three shifts (tables, vectors, and inference context) are not separate trends. They're converging into a single requirement: **the storage system must understand data, not just bytes.**

What that looks like in practice:

### 1. Native Table Support (Iceberg)

The storage system must embed an Iceberg REST Catalog, manage table metadata (snapshots, manifests, schema evolution), and perform automatic maintenance (compaction, orphan file cleanup, snapshot expiration). Tables are not a separate product. They're a view of the same objects.

AWS understood this with S3 Tables. MinIO understood this with AIStor Tables. The next software-defined storage system must understand it too.

### 2. Native Vector Support

Vector embeddings must be a first-class storage primitive, not a separate database that happens to use the object store as a backend. Store vectors, query nearest neighbors, and link embeddings to their source objects and table rows, all through the same API.

AWS understood this with S3 Vectors. No one else has followed.

### 3. ICMS-Ready Performance

The G4 tier must deliver sustained, high-bandwidth reads to feed ICMS pre-staging. This means:
- RDMA-capable networking (RoCEv2, with Spectrum-X compatibility)
- NVMe-oF support for direct flash access
- Erasure-coded reads that can saturate 100+ Gb/s links
- Latency-optimized metadata lookups for context-aware pre-staging

### 4. Schema-Aware Replication and Governance

When storage understands tables and vectors, replication becomes semantic: replicate a table's latest snapshot (not individual Parquet files), replicate an embedding index (not individual vector blobs), apply retention policies to table versions (not object prefixes). Governance becomes meaningful: column-level access control in Iceberg tables, embedding visibility policies for multi-tenant RAG, audit trails that reference table operations rather than raw PUTs and GETs.

### 5. Single System, Single Endpoint

The worst outcome is the current state: one system for objects, another for tables, another for vectors, and a proprietary appliance for KV cache. Each with its own API, its own consistency model, its own failure modes, its own monitoring stack.

The right outcome is a single system that stores objects, manages Iceberg tables over those objects, indexes vectors alongside them, and serves as the durable foundation for ICMS-accelerated inference. All through one endpoint, on one cluster, with one operational model.

---

## Who Gets It?

Let's be honest about the competitive landscape.

**The hyperscalers get it.** AWS is systematically expanding S3 from "object store" to "data platform." S3 Tables for Iceberg, S3 Vectors for embeddings, S3 Express One Zone for low-latency inference data. Each launch makes S3 harder to leave. That's the point.

**MinIO gets it.** They're the only software-defined storage company with no hardware lock-in that has shipped native Iceberg V3 support (AIStor Tables, GA February 2026), articulated a coherent lakehouse-on-object-storage strategy, and positioned their product as a data platform rather than just a byte store. AB Periasamy and the MinIO team have consistently been 12-18 months ahead of the rest of the software-defined storage world in recognizing architectural shifts.

**The traditional storage vendors are adapting.** Dell, Pure, NetApp, and VAST Data are all part of NVIDIA's ICMS partner ecosystem. But their advantage is integration agreements, not architecture. They're adding Iceberg support, adding vector capabilities, and adding RDMA endpoints to existing products. Bolted on, not built in.

**The rest of the software-defined world doesn't get it.** Ceph is still arguing about RGW performance. SeaweedFS is focused on POSIX compatibility. Garage is optimizing for self-hosting. These are all valid goals, but they're goals from Era 3. The data-aware storage system (the one that speaks Iceberg, indexes vectors, and feeds NVIDIA's inference pipeline) doesn't exist yet in the software-defined world outside of MinIO's commercial offering.

---

## The Opportunity

![Fiber optic cables carrying data at the speed of light](/images/blog/network-fiber.jpg)

There is a gap in the market that is about to become a chasm.

On one side: AWS, building the definitive data platform but locking it inside their cloud. On the other: MinIO, building the on-premises alternative but as a commercial product with enterprise licensing.

In between: no software-defined, cloud-native, data-aware object storage with no hardware lock-in that natively handles Iceberg tables, vector indexes, and ICMS-ready inference workloads. No system that an organization can deploy on their own hardware, on any cloud, and use as the foundation for both analytics and AI.

The infrastructure stack that Jensen Huang will showcase at GTC 2026 (Rubin GPUs, BlueField-4 DPUs, Dynamo inference framework, Spectrum-X networking, and ICMS) needs a G4 layer. NVIDIA doesn't build storage. They build partnerships with storage vendors. The question is whether that G4 layer will be a proprietary appliance from a traditional vendor, a hyperscaler lock-in play, or a software-defined data platform with no hardware lock-in that runs anywhere.

**Storage is no longer about storage. It's about data.** The system that understands this, that treats tables, vectors, and inference context as native citizens rather than afterthoughts, will define the next era.

The first three eras were about how to store bytes efficiently. The fourth era is about what those bytes *mean*.

---

*NVIDIA GTC 2026 runs [March 16-19 in San Jose](https://www.nvidia.com/gtc/). Jensen Huang's keynote is Monday, March 16, 8-11 AM PDT. ICMS details from the [NVIDIA Technical Blog](https://developer.nvidia.com/blog/introducing-nvidia-bluefield-4-powered-inference-context-memory-storage-platform-for-the-next-frontier-of-ai/) and [NVIDIA Newsroom](https://nvidianews.nvidia.com/news/nvidia-bluefield-4-powers-new-class-of-ai-native-storage-infrastructure-for-the-next-frontier-of-ai). MinIO AIStor Tables coverage from [Blocks and Files](https://www.blocksandfiles.com/ai-ml/2026/02/05/minio-plugs-apache-iceberg-tables-directly-into-aistor/4090411) and [MinIO Blog](https://blog.min.io/aistor-tables-native-iceberg-v3-for-on-premises-object-storage/). Apache Iceberg adoption data from the [2025 State of the Iceberg Ecosystem](https://datalakehousehub.com/blog/2026-02-state-of-the-apache-iceberg-ecosystem/) survey. Amazon S3 Tables [announcement](https://aws.amazon.com/blogs/aws/new-amazon-s3-tables-storage-optimized-for-analytics-workloads/) and S3 Vectors [GA announcement](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/). NVIDIA Dynamo [documentation](https://developer.nvidia.com/dynamo).*
