---
title: "CXL 3.0 and the Death of the Memory Hierarchy"
date: 2026-04-10
description: "For 40 years, the memory hierarchy was a clean staircase: registers, L1, L2, L3, DRAM, SSD, disk. CXL inserts a new step between DRAM and SSD. Pooled, shared, hardware-coherent memory at 150-400 nanoseconds. For storage systems, it means shared metadata without consensus and memory pools that eliminate stranded DRAM."
tags: ["storage", "cxl", "memory", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/network-fiber.jpg"
readTime: "20 min read"
---

![CXL and the memory hierarchy](/images/blog/network-fiber.jpg)

*For 40 years, the memory hierarchy was a clean staircase: registers, L1, L2, L3, DRAM, SSD, disk. Each step was 10-100x slower than the one above it. CXL inserts a new step between DRAM and SSD. Pooled, shared, hardware-coherent memory accessible via regular load/store instructions at 150-400 nanoseconds. This isn't just "more memory." For storage systems, it's shared metadata without consensus, zero-copy data movement between nodes, and memory pools that eliminate the most wasteful allocation pattern in modern datacenters.*

---

## The Hierarchy That Was

Every computer architecture textbook draws the same pyramid:

```
          ┌──────────┐
          │ Registers │  ~0.3 ns    (sub-nanosecond)
          ├──────────┤
          │  L1 Cache │  ~1 ns      (32-48 KB per core)
          ├──────────┤
          │  L2 Cache │  ~4 ns      (256 KB - 2 MB per core)
          ├──────────┤
          │  L3 Cache │  ~12 ns     (32-256 MB shared)
          ├──────────┤
          │   DRAM    │  ~80 ns     (256 GB - 2 TB per socket)
          ├──────────┤
          │  NVMe SSD │  ~10,000 ns (1-60 TB per drive)
          ├──────────┤
          │   HDD     │  ~10,000,000 ns (10-30 TB per drive)
          └──────────┘
```

Each tier is roughly 3-10x slower than the one above it, with a corresponding increase in capacity and decrease in cost per byte. Software has been designed around this hierarchy since the 1980s. Hot data fits in cache. Warm data lives in DRAM. Cold data goes to disk. The tiers are clean. The boundaries are fixed.

Two things have disrupted this picture.

First, **NVMe closed the gap from below**. A Gen4 NVMe SSD does a 4KB random read in 10 microseconds. That's 1,000x faster than a spinning disk. The SSD-to-DRAM gap is now the dominant boundary in the hierarchy, a 100x difference between DRAM (80ns) and NVMe (10,000ns), with nothing in between.

Second, **DRAM capacity hit an economic wall**. A 512 GB DDR5 DIMM costs $2,000-4,000. A server with 8 DIMM slots per socket can hold 4 TB of DRAM, if you're willing to pay $32,000 in memory alone. Hyperscalers report that **25-50% of provisioned DRAM sits idle** at any given time, stranded by the coarse granularity of DIMM allocation and the inability to move memory between servers.

CXL fills the gap. Memory that's slower than local DRAM but faster than NVMe, cheaper than DIMMs but denser than what fits in DIMM slots, and in CXL 3.0, shareable across hosts without software-managed coherence.

---

## What CXL Actually Is

CXL (Compute Express Link) is a cache-coherent interconnect protocol layered on top of PCIe's physical layer. Where PCIe provides point-to-point I/O (DMA transfers between CPU and devices), CXL adds three sub-protocols that make remote memory look like local memory:

**CXL.io.** Standard PCIe I/O. Device discovery, configuration, DMA. This is how you talk to a CXL device before the interesting stuff starts. Every CXL device supports CXL.io.

**CXL.cache.** Allows a device (GPU, FPGA, SmartNIC) to cache lines from host memory with hardware-maintained coherence. The device sees host DRAM as if it were its own, with the CPU's cache coherency protocol ensuring consistency. No explicit flush, no software invalidation, no memory barriers.

**CXL.mem.** The one that matters for storage. Allows the host CPU to access device-attached memory using regular load/store instructions. The memory on a CXL device appears as a [NUMA node](/blog/pcie-lanes-numa-rust-storage) in the operating system. Applications access it through `mmap()` or transparent page allocation. No special API, no RDMA verbs, no driver interaction for data access.

### Three Device Types

**Type 1** (accelerator, no memory): SmartNICs and simple accelerators that want coherent access to host DRAM. Uses CXL.io + CXL.cache.

**Type 2** (accelerator with memory): GPUs and FPGAs with their own DDR or HBM that should be coherent with the CPU's memory. Uses all three protocols. AMD's MI300A is the most notable Type 2-capable device.

**Type 3** (memory expander): Pure memory, DDR4/DDR5 behind a CXL controller on a PCIe card. This is what's shipping today and what matters for storage systems. Uses CXL.io + CXL.mem. The memory appears as an additional NUMA node.

Type 3 devices are the story. Samsung's CMM-D (128-512 GB), Micron's CZ120 (128-256 GB), and SK Hynix's CXL DRAM modules (96 GB) are shipping now, plugging into standard PCIe Gen5 x8 slots. A single 1U server with 4 PCIe slots can add 1 TB of CXL memory on top of whatever DRAM is in the DIMM slots.

---

## The Latency Question

Everyone asks the same question about CXL: how slow is it compared to local DRAM?

The answer is now well-characterized. Multiple academic benchmarks (ASPLOS 2025 from Virginia Tech, MICRO 2023, IPDPS 2025) have measured production CXL Type 3 devices on Intel Sapphire Rapids and Granite Rapids systems:

| Memory Tier | Measured Latency | Relative to DRAM |
|-------------|-----------------|-------------------|
| Local DDR5 DRAM | 75-100 ns | 1.0x (baseline) |
| Remote NUMA (1-hop, same system) | 120-150 ns | 1.5-1.8x |
| **CXL Type 3 memory** | **150-400 ns** | **2.0-3.0x** |
| Remote NUMA (2-hop) | 170-250 ns | 2.0-3.0x |
| RDMA (InfiniBand/RoCE) | 1,500-3,000 ns | 15-40x |
| NVMe SSD (4KB random) | ~10,000 ns | 100-130x |

CXL memory is roughly **2-3x slower than local DRAM**. That sounds bad until you realize what it's replacing: NVMe, which is 100x slower. The 150-400ns range puts CXL memory in the same ballpark as 2-hop NUMA access, which means accessing DRAM on the other socket of a dual-socket system. If your software already handles [NUMA](/blog/pcie-lanes-numa-rust-storage), it can handle CXL.

The bandwidth picture is more constrained. A CXL Type 3 device on PCIe Gen5 x8 delivers approximately **32 GB/s** peak. A single DDR5-6400 channel delivers ~51 GB/s, and a server with 8 channels gets ~400 GB/s aggregate. CXL memory bandwidth is 6-12% of local DRAM bandwidth per device. This means CXL is a **capacity tier, not a bandwidth tier**. Workloads that touch a lot of data sequentially (sequential scans, large memcpy) will suffer. Workloads that touch a little data frequently (pointer chasing, hash table lookups, metadata traversal) will be fine.

This is exactly the access pattern of storage system metadata.

---

## CXL 1.1 → 2.0 → 3.0: What Changed

### CXL 1.1 (2019): One Device, One Host

The first version. One CXL memory device connects to one host CPU. The device provides additional memory capacity. No sharing, no pooling. Think of it as a PCIe-attached DIMM.

Intel Sapphire Rapids (2023) and AMD Genoa (2022) support CXL 1.1. This is what's in production today.

### CXL 2.0 (2020): Switching and Pooling

CXL 2.0 added a **single-level switch** between hosts and memory devices. Up to 16 hosts can connect through a switch to a shared pool of CXL memory devices. The key concept is **Logical Devices (LDs)**.

A CXL memory device is partitioned into multiple LDs. Each LD is exclusively assigned to one host at a time by a Fabric Manager (software). This is *pooling*, not *sharing*. A host gets exclusive access to its LD partition, and the Fabric Manager can dynamically reassign LDs as demand shifts. If host A needs more memory and host B has idle capacity, the Fabric Manager can move an LD from B to A without rebooting either host.

Intel Granite Rapids (2024) and AMD Turin (2024) support CXL 2.0. XConn's Apollo switch (shipped March 2024) was the first CXL 2.0 switch silicon. Astera Labs' Leo controller is deployed in Microsoft Azure M-series VMs, the first production CXL memory pooling deployment.

### CXL 3.0 (2022): Fabric, Sharing, and Everything Changes

CXL 3.0 is the generational leap. Three fundamental additions:

**Multi-level switching.** CXL 2.0 had a single switch layer (host → switch → device). CXL 3.0 supports multiple switch levels, enabling fabric topologies: mesh, ring, spine-leaf. Port-based routing scales to **4,096 endpoints** (hosts + devices) in a single fabric. This is rack-scale, potentially multi-rack.

**True memory sharing.** CXL 2.0 pooling gives each host its own private partition. CXL 3.0 introduces **shared memory regions** where multiple hosts access the same physical memory simultaneously with hardware-maintained coherence. The mechanism is directory-based back-invalidation. When host A writes to a cache line that host B has cached, the CXL fabric sends an invalidation to B's cache. No software involvement. No lock. No message passing. Hardware coherence, the same kind that keeps L1 caches consistent across cores within a CPU, now works across separate CPUs connected by a CXL fabric.

**Dynamic Capacity Devices (DCD).** Memory devices that support elastic allocation. A host can request additional memory extents at runtime, and the device can release them back when no longer needed. No reboot, no pre-allocation, no fixed partitioning. This is what makes memory pooling practical at cloud scale.

Each switch hop adds approximately **50-60 nanoseconds** of latency. A 2-hop fabric path adds 100-120ns on top of the base CXL controller latency. For a CXL 3.0 fabric with 2 switch hops, end-to-end memory access latency is roughly **250-500 nanoseconds**, still 20-40x faster than NVMe.

### CXL 3.1, 3.2, 4.0: Refinement and Bandwidth

CXL 3.1 (November 2023) refined port-based routing and added the Trusted Execution Environment Security Protocol (TSP) for confidential computing over shared memory. CXL 3.2 (December 2024) improved memory device monitoring and management. CXL 4.0 (November 2025) doubled bandwidth to 128 GT/s via PCIe 7.0 and introduced Bundled Ports that aggregate multiple physical ports into a single logical connection, targeting multi-rack pooling at massive scale.

---

## What This Means for Storage Systems

Let's move past hardware specifications and talk about what CXL does to storage architecture. There are three implications, each more transformative than the last.

### 1. The Metadata Cache That Never Evicts

Every storage system struggles with metadata caching. A billion-object storage cluster has tens of gigabytes of hot metadata: object locations, erasure coding layouts, checksums, bucket configurations, listing caches. This metadata doesn't fit in L3 cache (hundreds of MB) but easily fits in DRAM (hundreds of GB). The problem is when it doesn't fit in *one node's* DRAM.

In a cluster with 20 storage nodes, each holding 50 million objects, the metadata for the entire cluster is ~200 GB. Each node can cache its own metadata locally, but cross-node metadata lookups (required for forwarded requests, heal operations, listing across nodes) go to the network. That means [RDMA](/blog/nvme-of-promise-and-pain) at 1,500+ ns, or HTTP/TCP at 50,000+ ns.

CXL changes this. A 1 TB CXL memory pool connected to all 20 nodes via a CXL switch holds the entire cluster's metadata in a single shared address space. Any node can access any metadata record via a load instruction at 250-500 ns. No network round-trip. No serialization. No RPC framework. No retry logic. A pointer dereference.

```
Before CXL:
    Node A needs Node B's metadata
    → serialize request → TCP/RDMA → Node B deserializes
    → reads metadata → serializes response → TCP/RDMA → Node A deserializes
    Total: 50,000-200,000 ns (TCP) or 3,000-5,000 ns (RDMA)

After CXL:
    Node A needs Node B's metadata
    → load instruction to CXL memory address
    Total: 250-500 ns
```

That's a 10x improvement over RDMA and a 100-400x improvement over TCP. For a LIST operation that touches 1,000 metadata records across 10 nodes, the difference is transformative: 5 milliseconds (TCP) vs 50 microseconds (RDMA) vs **500 microseconds (CXL)**. The CXL path requires no deserialization because FlatBuffer metadata is already zero-copy.

### 2. Shared State Without Consensus

This is the big one. The hardest problem in distributed storage isn't moving data; it's coordinating state. Which nodes are alive? Which objects are where? Which version of the cluster map is current? Today, these questions are answered by consensus protocols (Raft, Paxos) or eventually-consistent gossip, each with their own operational costs and failure modes.

CXL 3.0's shared memory with hardware coherence makes a third option possible: **shared data structures in CXL memory that every node can read and write with hardware-guaranteed consistency.**

Consider a cluster membership table, a simple array of (node_id, status, last_heartbeat) tuples. Today, this is either:
- Maintained by a Paxos/Raft quorum (Ceph's monitor daemons), or
- Propagated by gossip with eventual convergence (MinIO's approach), or
- Stored in an external coordinator (etcd/ZooKeeper for Kubernetes-deployed systems)

With CXL 3.0 shared memory, the membership table lives in a CXL memory region accessible to all nodes. Each node writes its own heartbeat timestamp via a store instruction. Each node reads other nodes' timestamps via load instructions. The CXL fabric guarantees coherence: if node A writes and node B reads, B sees the write. No consensus protocol. No gossip round. No external coordinator.

The same pattern applies to:
- **Placement maps**: the mapping from hash partitions to node assignments, updated atomically in shared CXL memory
- **Lock-free data structures**: concurrent hash maps, skip lists, queues. The same lock-free algorithms that work across cores within a CPU now work across CPUs in a CXL fabric
- **Distributed counters**: request rates, bandwidth meters, storage utilization, all using atomic increment in CXL memory, readable by any node

This doesn't eliminate the need for all coordination. CXL 3.0 fabrics are rack-scale (4,096 endpoints, ~2-meter reach without retimers). Cross-rack and cross-datacenter coordination still needs networking ([RDMA, TCP](/blog/nvme-of-promise-and-pain)). But within a rack, which is where 80%+ of storage I/O stays in a well-designed system, CXL shared memory replaces consensus protocols with hardware coherence.

### 3. Memory Pooling Kills Stranding

Hyperscalers report that 25-50% of provisioned DRAM is stranded. It's allocated to a server but not used, because memory is allocated in fixed DIMM increments and can't be moved between servers. A server with 512 GB of DRAM using only 200 GB is wasting 312 GB. Across a 10,000-server datacenter, that's **3.1 petabytes of wasted DRAM** at ~$5/GB, or $15.5 million sitting idle.

CXL memory pooling solves this by decoupling memory from servers. A CXL memory pool (say, 4 TB of CMM-D modules behind a CXL switch) is dynamically allocated to hosts based on actual demand. A storage node processing a burst of large PUT requests that needs 200 GB for compression/encryption buffers gets it from the pool. When the burst subsides, the memory returns to the pool for other hosts to use.

For storage systems specifically, this means:
- **Listing caches** that grow and shrink with query load instead of being statically sized
- **Prefetch buffers** for batch operations (training data pipelines) that borrow pool memory during epochs and release it between batches
- **EC encode/decode buffers** that scale with concurrent requests instead of being pre-allocated at startup
- **Write coalescing buffers** that absorb ingest bursts without preallocating worst-case memory

The economic impact is significant. If CXL pooling reduces memory stranding from 35% to 10%, a 1,000-server storage cluster saves 25% of its DRAM budget. At $5/GB for DDR5, that's hundreds of thousands of dollars, more than the cost of the CXL switches and controllers.

---

## CXL vs RDMA: Complementary, Not Competing

The inevitable question: if [RDMA already gives us remote memory access](/blog/nvme-of-promise-and-pain), why do we need CXL?

| | CXL | RDMA |
|---|---|---|
| Latency | 150-400 ns | 1,500-3,000 ns |
| Access model | Load/store (CPU instructions) | Verbs API (ibv_post_send/recv) |
| Coherence | Hardware cache coherence | None (software-managed) |
| Granularity | 64-byte cache line | Typically KB-MB messages |
| Scale | Rack (~2m, 4,096 endpoints) | Datacenter (100m+, thousands of nodes) |
| Programming | Transparent (NUMA node) | Explicit (memory registration, QP management) |

The differences are architectural, not incremental. CXL provides **load/store access at cache-line granularity with hardware coherence**. RDMA provides **message-based access at kilobyte granularity with no coherence**. You can build a pointer-chasing data structure (hash table, B-tree, skip list) on CXL memory and access it from multiple hosts with no software coordination. You cannot do this with RDMA. Every access requires an explicit send/receive or RDMA read/write verb, and coherence is the application's problem.

The right model is **CXL for intra-rack, RDMA for inter-rack.** Within a storage rack (8-32 nodes), CXL provides shared metadata, pooled memory, and coordination-free shared state at 250-500ns. Between racks, RDMA (or TCP over 100GbE+) provides data replication, cross-rack healing, and geo-distributed operations at microsecond scale.

This maps directly to the storage access pattern. Most storage I/O is local to a rack (the object's erasure-coded shards live within the rack). Cross-rack traffic is limited to healing, rebalancing, and replication, operations that are bandwidth-sensitive but not latency-sensitive.

---

## After Optane

Intel killed Optane in January 2023. No more 3D XPoint DIMMs, no more Optane Persistent Memory. This left a void: persistent memory at near-DRAM latency was supposed to be a new tier in the hierarchy, and suddenly it was gone.

CXL is filling that void, but differently than Optane did.

Samsung's **CMM-H** (CXL Memory Module, Hybrid) combines 16 GB of DDR DRAM as a cache with 1 TB of TLC NAND flash behind a CXL Type 3 controller. Hot data is served from DRAM cache at CXL latency (~200ns). Cold data falls through to NAND at microsecond latency. The device supports **Global Persistent Flush (GPF)**. On power loss or explicit command, all dirty cache blocks are flushed from DRAM to NAND, giving crash-consistent persistence.

This is not Optane. Optane provided byte-addressable persistence at 300-350ns natively. CMM-H provides byte-addressable access with a DRAM cache, fast for hot data, slow (microseconds) for cache misses that hit NAND. The persistence guarantee requires GPF, not hardware-level persistence per store.

For storage systems, the difference matters less than it sounds. What we want from persistent memory is:
1. Fast metadata access. CMM-H's DRAM cache handles this for hot metadata.
2. Crash-consistent state. GPF provides this.
3. More capacity than DRAM at lower cost. 1 TB CMM-H is dramatically cheaper than 1 TB of DDR5 DIMMs.

What we don't need is byte-granularity persistence for every store instruction (which Optane provided). Storage metadata is written in bulk (a FlatBuffer record, a listing cache update) and fsynced. Write-back caching with GPF flush is sufficient.

KIOXIA is pursuing a similar path: CXL + XL-Flash (SLC NAND) for low-latency persistence, and CXL + BiCS 3D NAND for [high-capacity tiers](/blog/edsff-e2-next-gen-drives). The pattern is clear. CXL provides the coherent access protocol, and the memory behind it can be DRAM (volatile, fast, expensive), NAND (persistent, slower, cheaper), or hybrid.

---

## What Breaks

CXL isn't free. Hardware-coherent shared memory across hosts introduces problems that storage engineers haven't had to think about before.

### NUMA Gets More Complex

A server with local DRAM, remote NUMA DRAM (second socket), and CXL memory now has **three memory tiers** with different latency characteristics:

```
Socket 0 (local DRAM):     80 ns
Socket 1 (remote NUMA):    140 ns
CXL memory pool:           250-400 ns
```

Linux exposes CXL memory as additional NUMA nodes, so existing [NUMA-aware software](/blog/pcie-lanes-numa-rust-storage) works, but only if it understands that not all NUMA nodes are equal. A page migration policy that treats CXL memory the same as remote NUMA DRAM will make suboptimal placement decisions. The kernel's memory tiering subsystem (demotion/promotion between tiers) is evolving but not yet mature.

For storage systems that already manage their own memory (buffer pools, slab allocators, arena-based allocation), the solution is explicit: allocate hot data structures (metadata caches, hash tables, lookup indexes) in DRAM, and cold/overflow data (listing caches, prefetch buffers, large EC buffers) in CXL memory. Use `mmap()` on a DAX device (`/dev/daxN.Y`) for explicit CXL memory placement, not transparent page allocation.

### Pointer-Based Data Structures Across Hosts

If two hosts share a CXL memory region, pointers within that region must be valid from both hosts' perspectives. This means no absolute virtual addresses (they differ between processes), no `Box<T>` or `Arc<T>` (Rust heap pointers are process-local). Shared CXL data structures must use **offset-based addressing**, where every reference is an offset from the base of the shared region, not an absolute address.

This is the same constraint that shared memory (`mmap` with `MAP_SHARED`) has always imposed, but now it applies to data structures that might be accessed from entirely different machines. FlatBuffers, incidentally, are already offset-based. Every reference in a FlatBuffer is a relative offset, not a pointer. This makes FlatBuffer metadata naturally CXL-friendly.

### Memory Ordering and Coherence Domains

CXL 3.0's coherence model guarantees that writes are visible to other hosts, but it does not provide total ordering of writes across hosts without explicit fences. Two hosts writing to different addresses in CXL memory can observe each other's writes in different orders. This is the same memory ordering model as multi-core CPUs (TSO on x86, relaxed on ARM), extended across a fabric.

For lock-free data structures, this is manageable with the same techniques used for multi-core programming: atomic operations for coordination points, acquire/release semantics for publish/subscribe patterns, and `SeqCst` only where total ordering is required. Rust's `std::sync::atomic` types work correctly with CXL memory because they emit the same fence instructions.

For Rust specifically, this is a strength. Rust's ownership model ensures that shared mutable state requires explicit synchronization (`Mutex`, `RwLock`, `Atomic`). You can't accidentally share CXL memory without synchronization because the compiler won't let you. The type system enforces the discipline that CXL's memory model requires.

---

## The "CXL Is Dead" Debate

In March 2024, SemiAnalysis published "CXL Is Dead In The AI Era," arguing that CXL's relevance has been undermined by NVIDIA's dominance of AI training infrastructure. Their core argument:

1. **NVIDIA GPUs don't support CXL.** NVIDIA uses NVLink (450 GB/s between GPUs) and its own C2C interconnect. The GPU shoreline (chip edge I/O area) is dedicated to NVLink, not PCIe/CXL. Since AI training is the dominant datacenter capital expenditure, and NVIDIA controls that market, CXL's addressable market is constrained.

2. **Hyperscaler CXL projects were "quietly shelved."** Several large-scale CXL evaluations at major cloud providers were reportedly paused in 2023-2024 as AI training budgets consumed available infrastructure investment.

3. **Market projections are overstated.** The $15B-by-2028 CXL market forecasts were called "outright ridiculous."

The critique has merit for GPU training workloads. NVLink provides 7x the bandwidth of PCIe Gen5. For GPU-to-GPU communication in training clusters, CXL cannot compete.

But storage is not GPU training.

Storage systems are **CPU-centric**. The data path (compress, encrypt, erasure code, checksum, write) runs on CPU cores. The metadata path (hash lookup, FlatBuffer decode, listing cache, cluster coordination) is pure CPU memory access. Neither path benefits from GPU acceleration. Neither path uses NVLink.

For CPU-centric workloads, the CXL value proposition is intact:

- **Memory expansion** for metadata-heavy storage nodes (1 TB CXL + 512 GB DRAM = 1.5 TB total memory, at lower cost than 1.5 TB of DIMMs)
- **Memory pooling** to reduce stranding across a storage rack (20 nodes sharing a 4 TB CXL pool instead of each over-provisioning 512 GB locally)
- **Shared metadata** across storage nodes in a rack (CXL 3.0 shared regions for placement maps, membership tables, listing caches)

Microsoft Azure's deployment of Astera Labs' Leo controllers in M-series VMs is real production usage. Samsung is ramping CMM-D 2.0 samples with 3.1 targeted for year-end 2025. Micron's CZ120 is Red Hat certified and shipping. XConn's Apollo switch is in production.

CXL isn't dead. It's targeting the 80% of datacenter workloads that don't involve NVIDIA GPUs. Storage is squarely in that 80%.

---

## The Software Gap

The hardware is arriving. The software isn't ready.

### Linux CXL Support: Functional but Immature

Linux's CXL subsystem has progressed steadily since kernel 5.12 (April 2021). CXL Type 3 devices are detected, enumerated, and exposed as additional NUMA nodes. DAX (Direct Access) mode provides `/dev/daxN.Y` character devices for explicit user-space mapping. Memory tiering policies (demotion of cold pages from DRAM to CXL) are available but still being tuned.

What's missing:

- **DCD (Dynamic Capacity Device) support** is not yet in mainline Linux. Active patchsets (v6-v7) are under review on LKML, targeting future kernel releases. Until DCD lands, memory pooling requires static partitioning by the Fabric Manager.
- **Fabric Manager interfaces** are vendor-specific. There's no standard Linux API for managing CXL switch topology, LD assignment, or memory sharing. Each switch vendor (XConn, Astera Labs) provides its own management tool.
- **Memory tiering policies** are evolving. The kernel's page demotion/promotion logic works but isn't optimized for CXL's specific latency profile. A page that should demote from DRAM to CXL (2-3x slower) but not from DRAM to NVMe (100x slower) requires workload-specific tuning.
- **No storage system uses CXL today.** Zero. Not Ceph, not MinIO, not any production object storage system. The academic work is there (Pasha at CIDR 2025, Tigon at OSDI 2025, SAP HANA on CXL at VLDB 2024, SK Hynix key-value cache research), but production integration is ahead, not behind us.

### The Application Problem

The biggest gap isn't in kernel drivers. It's in applications. Most storage systems allocate memory with `malloc()` and let the kernel place pages wherever it wants. To benefit from CXL, applications need to:

1. **Distinguish between memory tiers**: allocate hot metadata in DRAM, overflow in CXL memory
2. **Use DAX devices for explicit placement**: `mmap("/dev/dax0.0", ...)` for CXL-backed buffers
3. **Handle NUMA-tier-aware scheduling**: pin [I/O threads](/blog/io-uring-spdk-kernel-bypass) to cores that are topologically close to their CXL memory
4. **Design shared data structures**: offset-based addressing, lock-free algorithms, CXL-aware serialization

None of this is impossible. All of it is work that no storage team has done yet.

---

## The Timeline: What to Build, When

### 2025-2026: Memory Expansion (CXL 1.1/2.0)

**Available now.** Intel Granite Rapids, AMD Turin, Samsung CMM-D, Micron CZ120. No switching, no pooling, no sharing. One device, one host.

**What to do:** Design your storage node to be CXL-aware. Use `numactl` or explicit NUMA allocation to place hot data in DRAM and cold data in CXL memory. Test with listing caches, bloom filters, and metadata indexes in CXL-backed NUMA nodes. Measure the impact.

For Rust:
```rust
// CXL memory appears as a NUMA node.
// Allocate explicitly using libnuma or mmap on DAX device.
let cxl_fd = std::fs::OpenOptions::new()
    .read(true).write(true)
    .open("/dev/dax0.0")?;
let cxl_mem = unsafe {
    libc::mmap(
        std::ptr::null_mut(),
        size,
        libc::PROT_READ | libc::PROT_WRITE,
        libc::MAP_SHARED,
        cxl_fd.as_raw_fd(),
        0,
    )
};
// cxl_mem is now a pointer to CXL-backed memory.
// Use it for large, cold data structures.
```

### 2026-2027: Memory Pooling (CXL 2.0 Switches)

**Early production.** CXL 2.0 switches (XConn Apollo, Astera Labs Leo/Scorpio) connecting multiple hosts to shared memory devices. Dynamic capacity allocation via DCD (when Linux support lands).

**What to do:** Architect your storage rack with a CXL switch connecting all storage nodes to a shared memory pool. Design buffer allocation to borrow from the pool during bursts and release during quiescence. Build a CXL-aware memory allocator that transparently spills from DRAM to CXL pool when local memory is exhausted.

### 2027+: Shared Memory Fabric (CXL 3.0+)

**Future.** PCIe Gen6 hardware, multi-level switches, true shared memory regions with hardware coherence. This is where the architecture transforms.

**What to do today:** Design your metadata layer so it can run in shared memory. Use offset-based data structures (FlatBuffers already work). Separate coordination state (membership, placement) from data state (shard contents). The coordination state moves to CXL shared memory first. It's small, frequently accessed, and currently the most expensive to synchronize.

Design your cluster coordination to have a pluggable backend: RPC today, CXL shared memory tomorrow. The API should be the same (`get_placement(key) → nodes`, `get_membership() → live_nodes`), but the implementation switches from "serialize, send, deserialize" to "read from shared memory region."

---

## A CXL-Aware Storage Architecture

Here's what a storage rack looks like with CXL 3.0:

```
                        CXL 3.0 Fabric Switch
                    ┌────────────┼────────────┐
                    │            │            │
                ┌───┴───┐  ┌────┴────┐  ┌────┴────┐
                │ Node 0│  │ Node 1  │  │ Node N  │
                │       │  │         │  │         │
                │ DRAM  │  │  DRAM   │  │  DRAM   │
                │(hot)  │  │ (hot)   │  │ (hot)   │
                └───┬───┘  └────┬────┘  └────┬────┘
                    │            │            │
                    └────────────┼────────────┘
                                │
                    ┌───────────┴───────────┐
                    │    CXL Memory Pool     │
                    │                        │
                    │  Shared metadata        │
                    │  ├─ Cluster membership  │  ← all nodes read/write
                    │  ├─ Placement map       │  ← atomic updates
                    │  └─ Listing cache       │  ← shared bloom filters
                    │                        │
                    │  Pooled buffers         │
                    │  ├─ EC encode/decode    │  ← borrow on demand
                    │  ├─ Compression scratch │  ← return when done
                    │  └─ Prefetch pipeline   │  ← elastic sizing
                    │                        │
                    │  4 TB Samsung CMM-D     │
                    └────────────────────────┘
```

**Hot path (metadata):** Any node reads any object's metadata from the shared CXL listing cache at 250-500ns. No RPC. No serialization. FlatBuffer MetaView reads directly from CXL-backed memory. The same zero-copy access pattern that works for local memory now works for shared memory.

**Coordination:** Cluster membership and placement maps live in CXL shared memory. Updates are atomic writes visible to all nodes via hardware coherence. No Raft, no Paxos, no gossip, no monitor daemons. A node joining writes its entry to the shared membership table. A node failing is detected by stale heartbeat timestamps, the same mechanism as today's polling, but with 500ns reads instead of 50,000ns RPCs.

**Buffer pooling:** EC encode/decode buffers, compression scratch space, and prefetch pipeline memory are borrowed from the CXL pool during active I/O and returned afterward. A node processing a burst of PUTs borrows 100 GB from the pool. When the burst subsides, the memory returns for other nodes. No stranding.

**Data path:** Object data still lives on [NVMe drives](/blog/edsff-e2-next-gen-drives). CXL doesn't replace NVMe for bulk storage. It replaces DRAM for metadata, coordination, and transient buffers. The PUT path is: receive via network → compress/encrypt/EC in DRAM → write shards to NVMe. CXL memory handles the metadata bookkeeping around that path, not the path itself.

---

## Conclusion

The memory hierarchy is gaining a tier. Not a speculative, might-happen-someday tier, but a tier with shipping hardware (Samsung CMM-D, Micron CZ120, SK Hynix CXL DRAM), production CPU support (Intel Granite Rapids, AMD Turin), production switch silicon (XConn Apollo, Astera Labs Scorpio), and production deployments (Microsoft Azure M-series VMs).

CXL memory at 150-400ns fills the 100x gap between DRAM (80ns) and NVMe (10,000ns). For storage systems, this means metadata caches that span an entire rack, coordination state maintained by hardware coherence instead of consensus protocols, and memory pools that eliminate the billions of dollars in stranded DRAM across the industry.

The CXL 3.0 fabric vision (multi-level switching, shared memory regions, 4,096 endpoints) is 2027+ hardware. But CXL 1.1/2.0 memory expansion is available today, and the architectural decisions you make now determine whether your storage system can exploit the fabric when it arrives. Design metadata for shared memory (offset-based, zero-copy, lock-free). Design coordination for pluggable backends (RPC today, CXL shared memory tomorrow). Design buffer allocation for elastic pooling (borrow and return, not allocate and own).

The hierarchy that was (registers, caches, DRAM, SSD, HDD) served us for 40 years. The hierarchy that's coming adds a new tier between DRAM and SSD, and that tier is shared. Shared memory changes everything about how distributed systems coordinate, cache, and allocate. Storage systems that design for it now will own the next decade of infrastructure. Systems that treat memory as a per-node resource will be the new legacy.

The staircase has a new step. Start building for it.

---

*CXL specification versions and features from the [CXL Consortium](https://computeexpresslink.org/cxl-specification/). CXL latency measurements from ["Dissecting CXL Memory Performance at Scale"](https://arxiv.org/html/2409.14317v1) (ASPLOS 2025, Virginia Tech), ["Performance Characterization of CXL Memory"](http://pasalabs.org/papers/2025/IPDPS25_CXL.pdf) (IPDPS 2025), and [The Next Platform](https://www.nextplatform.com/2022/12/05/just-how-bad-is-cxl-memory-latency/). CXL switch latency from [Hot Chips 34 presentation](https://www.servethehome.com/compute-express-link-cxl-latency-how-much-is-added-at-hc34/). Shipping CXL hardware: [Samsung CMM-D](https://semiconductor.samsung.com/cxl-memory/cmm-d/), [Micron CZ120](https://www.micron.com/products/memory/cxl-memory), [SK Hynix CXL DRAM](https://www.servethehome.com/sk-hynix-cxl-2-0-memory-expansion-modules-launched-with-96gb-of-ddr5/), [XConn Apollo](https://www.servethehome.com/xconn-shows-its-cxl-2-0-and-pcie-switch-off-at-fms-2024/), [Astera Labs Leo on Azure](https://www.asteralabs.com/news/astera-labs-leo-cxl-smart-memory-controllers-on-microsoft-azure-m-series-virtual-machines-overcome-the-memory-wall/). Samsung CMM-H from [Samsung Semiconductor](https://semiconductor.samsung.com/emea/news-events/tech-blog/samsung-cxl-solutions-cmm-h/). CXL database research: [Pasha](https://vldb.org/cidrdb/papers/2025/p8-huang.pdf) (CIDR 2025), [SAP HANA on CXL](https://www.vldb.org/pvldb/vol17/p3827-ahn.pdf) (VLDB 2024). Intel Optane discontinuation from [Tom's Hardware](https://www.tomshardware.com/news/intel-drops-optane-persistent-memory-support-from-emerald-rapids). SemiAnalysis CXL analysis from ["CXL Is Dead In The AI Era"](https://newsletter.semianalysis.com/p/cxl-is-dead-in-the-ai-era) (March 2024). Linux CXL subsystem from [kernel documentation](https://docs.kernel.org/driver-api/cxl/index.html) and [Steve Scargall's CXL tracking](https://stevescargall.com/blog/2025/06/cxl-server-buyers-guide-a-complete-list-of-ga-platforms-updated-2025/). CXL vs RDMA analysis from [ACM TACO Rcmp paper](https://dl.acm.org/doi/10.1145/3634916). CXL consortium history from [AnandTech](https://www.anandtech.com/show/14885/cxl-consortium-officially-incorporated-new-members-announced). Gen-Z and OpenCAPI transfers from [HPC Wire](https://www.hpcwire.com/2022/08/01/opencapi-to-be-folded-into-cxl/). Memory stranding data from [Penguin Solutions CXL overview](https://www.penguinsolutions.com/en-us/resources/blog/what-is-cxl-memory-expansion). CXL 4.0 from [BusinessWire](https://www.businesswire.com/news/home/20251118275848/en/CXL-Consortium-Releases-the-Compute-Express-Link-4.0-Specification-Increasing-Speed-and-Bandwidth).*
