---
title: "Your CPU Is Lying to You"
date: 2026-03-17
description: "One in every thousand servers in your data center is silently corrupting data right now. Not crashing. Not throwing errors. Just quietly turning 1+1 into 3. Google, Meta, and NVIDIA have independently confirmed this."
tags: ["storage", "data-integrity", "ai", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/server-cables.jpg"
readTime: "18 min read"
---

![Server cables and connections](/images/blog/server-cables.jpg)

*Silent data corruption, AI, and why I lost files despite spending years at two data integrity companies.*

---

## The Confession

I need to start with a personal story, because it's the one that made this article real instead of theoretical.

I spent years at Nexenta, the company that built enterprise storage on ZFS, the filesystem famous for one thing above all others: **data integrity**. ZFS checksums every block. ZFS scrubs detect bit rot before it reaches your applications. ZFS was built, from the ground up, by Jeff Bonwick and Matt Ahrens at Sun Microsystems, specifically because silent data corruption was a known, measured, inevitable reality of storing bits on magnetic and solid-state media.

I lived and breathed this. I worked with the ZFS community. I understood copy-on-write semantics, Merkle tree verification, and the entire philosophy that data must be checksummed, verified, and self-healing. I could explain the difference between `fletcher4` and `sha256` in my sleep. I watched Nexenta grow to nearly 2,000 petabytes under management across 3,000 enterprise customers before DDN acquired us in 2019.

After Nexenta, I went to MinIO, where data integrity was, if anything, even more central to the product identity. MinIO called itself ["the ZFS of cloud storage"](https://min.io/blog/minio-the-zfs-of-cloud-storage) and meant it. Bitrot protection was enabled **by default**. Not an optional feature, not a checkbox in advanced settings, but the baseline behavior of every deployment. MinIO computed HighwayHash checksums on every erasure-coded shard, verified them on every read, and automatically healed corrupted shards by reconstructing from parity. All inline, all transparent, all without operator intervention.

I watched customers discover corruption that had been silently accumulating on their previous storage systems for months. I watched the background scanner find and heal bitrot on drives that SMART data reported as perfectly healthy. I saw firsthand that data integrity wasn't a theoretical concern. It was a continuous, measurable, operational reality. MinIO's approach (checksum everything, verify on every read, heal automatically) was the right architecture. It caught corruption that no other layer in the stack would have detected.

Two jobs. Years of building, evangelizing, and deploying data integrity systems. ZFS at Nexenta. HighwayHash-protected erasure coding at MinIO.

And then I went home and ran a NAS without proper checksumming.

Not because I didn't know better. Because I got lazy. Because the NAS vendor's default filesystem didn't checksum at the block level. Because the RAID controller said "redundant" and I heard "safe." Because I had backups, but the backups were faithfully copying already-corrupted files, since nothing in the pipeline checked whether the bits being backed up were the bits originally written.

I discovered the corruption when I opened family photos that had been stored for years. Some had visual artifacts: color bands, missing sections, JPEG headers intact but payloads scrambled. Others opened fine but were subtly wrong in ways I couldn't identify without the originals. The originals were gone. The backups contained the same corruption. The files were lost.

**Years at a ZFS company, then years at MinIO where we literally built bitrot healing into the product, and I still lost files to silent data corruption on my own NAS.**

The lesson isn't that I'm careless (though I was). The lesson is that silent data corruption is so insidious, so invisible, so contrary to our mental model of how computers work, that even people who *know* about it, who've *built careers* fighting it, can be caught off guard.

Now imagine what it's doing to your AI training pipeline.

---

## The Research: Your CPUs Are Corrupting Data at Scale

### Google: "Cores That Don't Count" (2021)

In 2021, Peter Hochschild and colleagues at Google published ["Cores that don't count"](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s01-hochschild.pdf) at HotOS, and the findings shook the systems community.

Google discovered that a measurable fraction of CPUs in their fleet contained **mercurial cores**, individual cores that produced incorrect computation results without triggering any hardware error detection mechanism. No machine check exception. No ECC error. No kernel panic. Just wrong answers.

Key findings:

- The rate is **a few mercurial cores per several thousand machines**, roughly **1 in 1,000**
- Errors are **core-specific**: a single core on a multi-core CPU computes incorrectly while all other cores on the same chip work fine
- Errors are **deterministic for specific inputs**: the same corrupt core will produce the same wrong answer for the same computation, every time, making random testing insufficient
- Root causes include **manufacturing variability at nanometer-scale feature sizes**, voltage marginality, and aging effects that push transistor behavior outside specified tolerances
- Standard hardware tests (POST, BIST) **do not catch these defects** because they test generic functionality, not the specific instruction sequences that trigger corruption

Google's term, "mercurial cores," captures the essence: these cores aren't broken in an obvious way. They're capricious. They produce correct results for almost everything, then silently produce wrong results for specific computations under specific conditions.

### Meta: Silent Data Corruptions at Scale (2021-2022)

Meta independently confirmed the problem across their fleet of hundreds of thousands of servers. Their [2021 paper](https://engineering.fb.com/2021/02/23/data-infrastructure/silent-data-corruption/) and [2022 follow-up](https://engineering.fb.com/2022/03/17/production-engineering/silent-errors/) documented concrete examples:

**The decompression failure:** A file with a nonzero size was provided as input to a decompression algorithm. The CPU returned a computed size of **zero** for a nonzero input. The computation was mathematically wrong, but no hardware error was raised.

**The `Math.pow()` corruption on Core 59:** A specific core produced these results:
- `int(1.153)` returned **0** (expected: 1)
- `int(1.1³)` returned **0** (expected: 1)
- `int(1.1¹⁰⁷)` returned **32,809** (expected: 26,854)
- `int(1.1⁻³)` returned **1** (expected: 0)

Every one of those results is silently, confidently wrong. The CPU didn't crash. It didn't set an error flag. It just returned the wrong number.

Meta's conclusion: **1 in 1,000 machines** in a data center fleet has a silent data corruption defect. Their detection tools ([FleetScanner](https://engineering.fb.com/2022/03/17/production-engineering/silent-errors/) for out-of-production testing every ~6 months and Ripple for in-production testing with ~15-day fleet coverage) can detect about 70% of affected machines. The remaining 30% evade detection.

### The Industry Response: OCP Whitepaper (2024)

The problem is severe enough that AMD, ARM, Google, Intel, Meta, Microsoft, and NVIDIA jointly authored an [Open Compute Project whitepaper on Silent Data Corruption in AI](https://www.opencompute.org/documents/sdc-in-ai-ocp-whitepaper-final-pdf). The paper establishes that:

- With increased silicon density in modern processors and accelerators, SDC now occurs at approximately **one fault per thousand devices**, orders of magnitude higher than cosmic-ray-induced soft errors alone
- Most SDCs involve single bitflips, but a "considerable number" involve two or more flipped bits
- SDC errors in some settings show **position-correlated patterns** (85.57% of bitflips are spatially related), suggesting systematic manufacturing defects rather than random events
- There is a fundamental **misalignment between hardware fault metrics and AI correctness metrics**: hardware measures FIT rates and bit error rates, AI measures loss curves and accuracy, and the two don't map to each other cleanly

---

## Why AI Training Is Uniquely Vulnerable

Silent data corruption has always existed. What's changed is the scale of computation and the consequences of undetected errors.

### The Math of Scale

A single LLM training run involves:
- **Thousands of GPUs** running for weeks or months
- **Trillions of floating-point operations** per second across the cluster
- **Petabytes of data** flowing through CPUs, GPUs, memory, and storage

If 1 in 1,000 servers has a mercurial core, a 10,000-server training cluster contains approximately **10 affected machines**. Each one is silently corrupting computations (gradient calculations, attention scores, weight updates, checkpoint data) without any hardware indication.

### The Research: SDC During LLM Training

A groundbreaking [ACL 2025 paper](https://arxiv.org/html/2502.12340v1), "Understanding Silent Data Corruption in LLM Training," provides the first comprehensive study of how SDC affects real training runs. Using deterministic execution via the XLA compiler to isolate SDC effects, the researchers found:

**SDC is frequent in production:**
- Meta reported **6 unplanned job interruptions** attributed to SDC during a single 54-day pre-training snapshot of Llama 3 405B
- Google estimated **an SDC event occurs every one to two weeks** during Gemini training

**SDC is invisible in loss curves:** This is the most terrifying finding. Training loss curves on healthy and unhealthy nodes remained **identical** despite underlying computation errors. The researchers noted: *"SDCs can silently occur without any clear indication from training loss."* You cannot detect SDC by watching your loss curve.

**SDC causes silent model divergence:** Despite identical loss values, model parameters on unhealthy nodes **incrementally drifted away** from healthy node weights, eventually converging to entirely different local minima. The models looked fine by every standard metric but had different, and potentially inferior, learned representations.

**SDC can catastrophically corrupt models:** While most fine-tuning runs on unhealthy nodes performed comparably, some experienced **sudden training loss spikes that fully corrupted model weights**, resulting in zero test accuracy. These events were rare but unrecoverable without rolling back to a clean checkpoint.

**SDC-induced gradient noise is small but cumulative:** The worst-case noise-to-signal ratio in gradients was only 5.1%, which seems negligible. But accumulated over millions of training steps, it steers the model to different optima. The corruption is not a single catastrophic event. It's a slow drift that's undetectable until you compare against a ground-truth run.

### The Cost

ByteDance's infrastructure team [documented](https://arxiv.org/html/2509.16293v4) that SDC-induced training failures require checkpoint rollback, which means:
- **Terabytes of checkpoint data** reloaded from remote storage
- **Hours or days of recomputation** from the last known-good checkpoint
- **Wasted GPU hours** at $2-3 per GPU-hour, multiplied by thousands of GPUs

A single SDC event during a large training run can waste **$100,000 or more** in compute. Across an organization running multiple training jobs continuously, SDC-related waste reaches millions of dollars annually.

---

## Why Most Storage Systems Don't Help

This is where the storage industry has failed.

### The Checksum Gap

Most storage systems, including the enterprise arrays and cloud services that hold training datasets, model checkpoints, and inference artifacts, verify data integrity at the **block device** level using hardware ECC in drives. But SDC doesn't corrupt data *on disk*. It corrupts data **in transit through the CPU**.

The data path from application to disk:
```
Application buffer
    ↓ (CPU processes: compress, encrypt, encode)
Processed buffer      ← SDC CAN CORRUPT DATA HERE
    ↓ (DMA to NVMe controller)
NVMe write buffer
    ↓ (drive firmware writes to NAND)
NAND flash            ← ECC protects data HERE
```

A mercurial CPU core corrupts data *after* the application writes it and *before* (or *during*) the storage system processes it. Drive-level ECC faithfully stores the corrupted bits. The storage system's RAID or erasure coding faithfully replicates the corrupted bits across multiple nodes for durability. Backups faithfully copy the corrupted bits to another location.

**Every layer does its job perfectly. The data is still wrong.**

### What ZFS Got Right (and What It Didn't)

ZFS was the first mainstream filesystem to checksum data at the block level, storing checksums in parent block pointers (never alongside the data they protect). On every read, ZFS verifies the checksum and can reconstruct corrupted blocks from redundant copies.

This catches:
- Bit rot on the storage media
- Firmware bugs that corrupt data during write
- Controller errors that deliver wrong data on read
- Phantom writes (data written to the wrong block)

This does **not** catch:
- Corruption in CPU during compression (`lz4`, `zstd` compress data *before* ZFS checksums it)
- Corruption in CPU during application processing (the application writes corrupted data, and ZFS faithfully checksums and stores the already-wrong bytes)
- Corruption in CPU during checksum computation itself (the checksum matches because it was computed by the same corrupted core)

ZFS protects the storage layer. It does not protect the compute layer. And SDC is a compute problem, not a storage problem.

### What MinIO Got Right (and Where It Still Falls Short)

MinIO took ZFS's philosophy and translated it to object storage, arguably better than anyone else in the industry.

**Inline bitrot protection on every shard.** MinIO computes a [HighwayHash](https://min.io/blog/data-authenticity-integrity) checksum on every erasure-coded shard during write and verifies it on every read. This isn't optional. It's the default behavior. Every GET or HEAD operation automatically checks shard consistency before returning data to the client.

**Automatic self-healing during reads.** When MinIO detects a checksum mismatch on a shard during a GET, it doesn't return an error and wait for an operator. It reconstructs the object from healthy parity shards, heals the corrupted shard in place, and serves the correct data to the client, all in the same request path. The client never knows corruption existed.

**Background scanning.** MinIO runs a [background data scanner](https://min.io/docs/minio/linux/operations/concepts/healing.html) that continuously traverses all objects, checking shard integrity, evaluating lifecycle rules, and queuing repairs for inconsistencies. Deep scan mode performs full bitrot verification by recomputing checksums against stored data. Objects that fail are added to the Manual Repair Failed (MRF) queue for prioritized healing.

**Per-object erasure coding.** Unlike systems that erasure-code at the volume or pool level, MinIO encodes each object individually. This means healing is granular. One corrupted object is repaired without touching any other data. No pool rebuild, no RAID reconstruction, no cluster-wide I/O storm.

This architecture catches the same class of problems ZFS catches (media degradation, firmware bugs, phantom writes) and adds something ZFS can't do easily: **healing across independent nodes**. When MinIO reconstructs from parity shards, those shards were written and stored by different servers with different CPUs. Cross-node reconstruction probabilistically survives CPU-level SDC because the corruption is specific to one core on one machine.

Where MinIO falls short is the same place ZFS does: if the CPU corrupts data *before* the checksum is computed (during compression, during the application's own processing, during the initial hash computation itself) the system faithfully stores and verifies the wrong data. The HighwayHash matches because it was computed on the already-corrupted bytes. The erasure coding faithfully distributes the corrupted shards. The self-healing mechanism has nothing to heal because the checksums are consistent.

This isn't a MinIO problem specifically. It's a fundamental limitation of any system that checksums data at one layer without verifying across layer boundaries. It's the gap between "storage integrity" and "end-to-end integrity."

That's why I lost files despite years of working with ZFS and MinIO. My NAS wasn't even running either of them (lazy, remember?), but even if it had been, if the CPU corrupted the JPEG data before the storage system saw it, both ZFS and MinIO would have checksummed and replicated the garbage faithfully.

### What the Next Generation Must Do Differently

The fix requires **end-to-end data integrity verification**, from the moment data enters the storage system to the moment it leaves, with checksums computed at every boundary crossing.

A properly designed storage system does this:

**1. Checksum on ingest, before any processing.**

The moment bytes arrive over the wire, compute a cryptographic hash (BLAKE3, not MD5 or CRC32, you need collision resistance, not just error detection). This is the **ground truth hash**. Store it in metadata. It represents what the client sent, before the storage system's CPUs touched the data.

```
Client sends data
    ↓
BLAKE3(raw_bytes) → etag (ground truth)    ← FIRST CHECKSUM
    ↓
Compress → BLAKE3(compressed) → stored      ← SECOND CHECKSUM
    ↓
Encrypt → BLAKE3(encrypted) → stored        ← THIRD CHECKSUM
    ↓
EC encode → per-shard BLAKE3 → stored        ← FOURTH CHECKSUM (per shard)
    ↓
Write to disk
```

Four checksum boundaries. If any CPU corruption occurs during compression, encryption, or erasure coding, the downstream checksum won't match. The system can detect it, discard the corrupted output, and retry, potentially on a different CPU core.

**2. Verify on read, at every layer.**

```
Read shard from disk
    ↓
Verify shard BLAKE3                          ← CHECK 1
    ↓
EC decode → verify post-decode BLAKE3        ← CHECK 2
    ↓
Decrypt → verify post-decrypt BLAKE3         ← CHECK 3
    ↓
Decompress → verify against ground truth     ← CHECK 4 (etag)
    ↓
Serve to client
```

If any verification fails, the system reconstructs from parity shards (which are on different nodes, processed by different CPUs) and retries. The probability that the same SDC pattern affects the same computation on two independent nodes is negligible.

**3. Background scrubbing with cross-node verification.**

Periodically read every shard, verify its checksum, and compare reconstruction results across nodes. This catches corruption that occurred after write (media degradation) and corruption that was written (CPU SDC during initial write that happened to produce matching checksums on the same core).

**4. Use cryptographic hashes, not CRC.**

CRC32 catches random bit flips but is trivially fooled by systematic corruption patterns (like the position-correlated bitflips documented in the OCP whitepaper, where 85.57% of SDC bitflips are spatially related). BLAKE3 is effectively impossible to fool. Any change to the input, no matter how structured, produces a completely different hash.

BLAKE3 is also fast enough that checksumming doesn't become a bottleneck: 10+ GB/s on a single core, scaling linearly with core count. There is no performance excuse for weak checksums.

---

## What This Means for AI Infrastructure

Yesterday, NVIDIA launched the [BlueField-4-powered CMX (Context Memory Extensions)](https://www.nvidia.com/en-us/data-center/ai-storage/cmx/) platform at GTC 2026, creating a new shared KV cache tier across inference pods. That's a new surface area for silent data corruption. KV cache data is derived and recomputable, but if it's corrupted, inference quality degrades silently. Per-block checksums on KV cache writes catch corruption before it propagates across the pod.

But CMX is just one layer. The full picture:

### Training Pipelines

1. **Checksum training data at ingest.** When datasets are written to object storage, compute and store a BLAKE3 hash of every object. Before training reads a batch, verify the hash. If the training data is corrupted, you need to know *before* it poisons the model.

2. **Checksum checkpoints end-to-end.** Model checkpoints are the recovery mechanism for SDC-induced training failures. If the checkpoint itself is corrupted (because the CPU that serialized the model state had a mercurial core) the recovery fails. Checkpoints must be verified immediately after write, ideally by a different node.

3. **Compare gradient checksums across data-parallel replicas.** In distributed training, multiple nodes compute gradients on different data shards. Before all-reduce, hash the gradient tensors. If one node's gradients have a different hash from its replicas, that node has an SDC problem. Quarantine the node and recompute.

### Inference Pipelines

4. **Verify model weights on load.** Before an inference server starts serving requests, verify that the model weights loaded from storage match their stored checksums. A corrupted weight tensor produces silently wrong inference results, forever.

5. **Verify KV cache integrity in CMX.** NVIDIA's CMX tier (G3.5) caches KV blocks across inference pods. KV data is derived, not durable, but if it's corrupted, inference quality degrades silently. Per-block checksums on KV cache writes catch corruption before it propagates.

### Storage Systems

6. **Build integrity verification into the I/O path, not as an afterthought.** Checksums aren't a feature you add in v2. They're the foundation. Every byte written must be checksummed before processing. Every byte read must be verified before delivery. The storage system should **refuse to serve data that fails verification**, returning an error rather than silently delivering corrupt bytes.

This is the lesson of ZFS and MinIO: data integrity was the *primary design goal* of both systems, not an optimization bolted on later. ZFS proved that filesystems must checksum every block. MinIO proved that object stores must checksum every shard and self-heal on read. The next generation must take both philosophies and extend them from the storage layer to the entire data path, covering CPU processing boundaries, not just disk storage.

---

## The Hard Truth

Here's what the industry needs to accept:

**1 in 1,000 servers is silently corrupting data.** This isn't a theoretical risk from cosmic rays hitting your DRAM (which ECC handles). This is a measured, confirmed, reproducible defect in **mainstream CPUs from every major manufacturer**, documented by Google, Meta, and a joint industry whitepaper from AMD, ARM, Intel, and NVIDIA.

**Your storage system probably doesn't check for this.** Most storage systems trust the CPU. They assume that if `compress(data)` returns a buffer, the buffer is the correct compressed representation of the data. They assume that if `memcpy(dst, src, len)` completes, `dst` contains the same bytes as `src`. These assumptions are wrong 0.1% of the time across your fleet. That's not a rounding error. At scale, it's a certainty.

**Your AI models may already be affected.** If you've trained on data that passed through a mercurial core, your training data is corrupted. If your model checkpoints were serialized by a mercurial core, your recovery mechanism is corrupted. If your inference servers loaded weights through a mercurial core, your production predictions are wrong. And you have no way to know, because the corruption is silent.

**The fix is architectural, not operational.** You can't solve this by buying better CPUs (every manufacturer has the problem). You can't solve it with more testing (30% of affected machines evade Meta's best detection tools). You can't solve it with ECC memory (the corruption happens in the CPU execution pipeline, not in DRAM).

You solve it with **end-to-end checksums at every processing boundary**, combined with redundancy across independent hardware. Compute a hash before the CPU processes the data. Compute a hash after. If they don't match, retry on different hardware. Same principle ZFS applied to disks, but applied to the entire data path, including the CPUs.

---

## What I Do Now

After losing those files, I rebuilt my home NAS on ZFS with `sha256` checksums enabled, monthly scrubs scheduled, and off-site backups to S3-compatible storage with its own integrity verification. Belt and suspenders. The kind of setup I should have had from day one, given that I spent years at Nexenta building ZFS appliances and then years at MinIO building self-healing object storage.

I've worked at two companies whose core value proposition was "your data is safe with us," and I still managed to lose data on my own home system. Nexenta taught me that every block must be checksummed. MinIO taught me that every shard must be verified on read and healed automatically. Both were right. Both were insufficient against the threat that Google and Meta have now quantified.

Because even ZFS's block-level checksums and MinIO's shard-level HighwayHash verification share the same blind spot: they trust the CPU. If the CPU corrupts data before the checksum is computed, the checksum is consistent with the corrupted data. The corruption is invisible to the storage layer.

For my home NAS, the probability of a mercurial core is low enough that ZFS + scrubs + verified backups is adequate. I accept the residual risk. For a 10,000-node AI training cluster, that residual risk is a mathematical certainty. Approximately 10 machines silently corrupting data at any given time.

The storage systems we build for AI must be paranoid in a way that no previous generation of storage had to be. Not because disks are less reliable (they're more reliable than ever). Not because networks are lossy (they're better than ever). But because the CPUs, the one component we always trusted, are lying to us at a rate of 1 in 1,000.

ZFS got us checksums per block. MinIO got us checksums per shard with automatic healing. The next generation must get us checksums per *processing stage*, verifying data integrity across every CPU boundary in the I/O path, not just at the storage endpoints.

Build your storage system like every CPU is suspect. Checksum everything. Verify everything. Trust nothing.

It's the only honest architecture left.

---

*Google "Cores that don't count" from [HotOS 2021](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s01-hochschild.pdf). Meta's SDC research from [Engineering at Meta (2021)](https://engineering.fb.com/2021/02/23/data-infrastructure/silent-data-corruption/) and [2022 follow-up](https://engineering.fb.com/2022/03/17/production-engineering/silent-errors/). OCP industry whitepaper on [SDC in AI](https://www.opencompute.org/documents/sdc-in-ai-ocp-whitepaper-final-pdf) (AMD, ARM, Google, Intel, Meta, Microsoft, NVIDIA). LLM training SDC study from [ACL 2025](https://arxiv.org/html/2502.12340v1). ByteDance infrastructure from [SIGMOD 2025](https://arxiv.org/html/2509.16293v4). Nexenta history from [Wikipedia](https://en.wikipedia.org/wiki/Nexenta_Systems) and [DDN acquisition announcement](https://nexenta.com/company/media/press-releases/ddn-completes-acquisition-nexenta). MinIO bitrot protection from [MinIO data integrity blog](https://min.io/blog/data-authenticity-integrity), [erasure coding documentation](https://github.com/minio/minio/blob/master/docs/erasure/README.md), and [healing documentation](https://min.io/docs/minio/linux/operations/concepts/healing.html). ZFS data integrity from the [OpenZFS documentation](https://openzfs.github.io/openzfs-docs/). NVIDIA CMX from the [CMX product page](https://www.nvidia.com/en-us/data-center/ai-storage/cmx/).*
