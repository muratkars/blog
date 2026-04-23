---
title: "The GPU Is the New Storage Controller"
date: 2026-04-22
description: "For 40 years, the CPU decided what gets read from storage, when, and where it lands in memory. AI inference is breaking that model. The GPU now knows what data it needs next, and routing that request through the CPU is pure overhead. GPU-initiated I/O is the architectural response. But the protocol stack wasn't designed for it."
tags: ["storage", "gpu", "ai", "nvme", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/gpu-cluster.jpg"
readTime: "22 min read"
---

![GPU cluster and AI computing infrastructure](/images/blog/gpu-cluster.jpg)

*For 40 years, the CPU has been the I/O initiator for storage. It decides what gets read, when, and where it lands in memory. Every protocol in the stack assumes this: NVMe command queues, the Linux block layer, `O_DIRECT`, scatter-gather lists, interrupt-driven completions. All designed for a CPU host. AI inference is breaking that model. The GPU now knows what data it needs next (the next KV cache tensor, the next attention head), and routing that request through the CPU adds microseconds of latency that the GPU can't afford. GPU-initiated I/O, direct NVMe reads over P2P DMA, is the architectural response. But the software stack wasn't built for it, and the standards bodies haven't caught up.*

---

## The CPU Was Always the I/O Initiator

Every storage architecture since the IBM PC/AT has followed the same flow: the CPU decides what data to fetch, builds a command descriptor, submits it to a device queue, and handles the completion interrupt. NVMe refined this model (65,535 queues, polling instead of interrupts, multi-core submission), but it didn't change the fundamental assumption. The CPU is the host. The storage device is the target. Data flows from device to host memory, and if a GPU needs that data, the CPU copies it again.

This worked for 40 years because the CPU was the one doing the computation. It knew what data it needed because it was the one processing it. Even when GPUs became the dominant compute engines for training workloads, the data pipeline still made sense: the CPU prefetches training batches from storage, stages them in host DRAM, and the GPU pulls them over PCIe when ready. Training is sequential and predictable. You know which batch comes next because you designed the data loader.

Inference is different.

---

## Why Inference Breaks the Model

Training reads data in large, predictable sequential sweeps. A DataLoader shuffles the dataset once per epoch, then streams batches in order. The CPU can prefetch effectively because the access pattern is known.

Inference generates its access pattern dynamically, one token at a time. Each forward pass through the model produces a new token, which changes what the next forward pass needs. And the dominant memory consumer in inference isn't model weights (those are static, loaded once). It's the KV cache.

### The KV Cache Problem

Every transformer-based model maintains a key-value cache: the accumulated attention context from all previous tokens in the sequence. For each new token generated, the model reads the entire KV cache to compute attention, then appends the new token's key-value pair. The cache grows linearly with sequence length.

The numbers are large and getting larger:

| Model | Context Length | KV Cache Size (FP16) | Notes |
|-------|---------------|---------------------|-------|
| Llama 3.1 8B | 32K tokens | ~4 GB | Fits in single GPU HBM |
| Llama 3.1 8B | 128K tokens | ~16 GB | Still fits, barely |
| Llama 3.1 70B | 128K tokens | ~40 GB (with GQA) | Half of an H100's HBM |
| Llama 3.1 70B | 128K tokens | ~320 GB (without GQA) | Exceeds any single GPU |
| Any 70B+ model | 1M tokens | ~150+ GB | Multi-GPU required |

GQA (Grouped Query Attention) and MLA (Multi-head Latent Attention) compress the KV cache by 4-8x, but the scaling problem remains. At 128K context, 4 concurrent requests on a Llama 70B model need roughly 160 GB of KV cache. That exceeds a single H200's 141 GB of HBM. At 1M token context (which Claude, Gemini, and GPT-4 all support), the KV cache for a single session can exceed 15 GB with modern optimizations.

GPU HBM is precious. An H100 has 80 GB, an H200 has 141 GB, and a Blackwell B200 has 192 GB. Model weights for a 70B parameter model in FP16 consume ~140 GB alone. There is not enough HBM for both the model and all active KV caches. Something has to spill.

### The Tiering Imperative

The industry's answer is tiered KV cache storage. Hot cache stays in HBM. Warm cache spills to host DRAM. Cold cache goes to NVMe. The memory hierarchy that [CXL is reshaping for storage metadata](/blog/cxl-death-of-memory-hierarchy) applies equally to inference state:

```
┌─────────────────────────────────────────────────────┐
│  GPU HBM          │  ~ns access   │  80-192 GB      │
│  (active KV)      │  TB/s BW      │  $$$$$           │
├─────────────────────────────────────────────────────┤
│  Host DRAM        │  ~μs access   │  512 GB - 2 TB  │
│  (warm KV)        │  ~26 GB/s     │  $$$             │
│                   │  (PCIe Gen4)  │                  │
├─────────────────────────────────────────────────────┤
│  Local NVMe       │  ~100 μs      │  4-60 TB        │
│  (cold KV)        │  7-14 GB/s    │  $$              │
├─────────────────────────────────────────────────────┤
│  Network Storage  │  ~ms access   │  Petabytes      │
│  (shared KV/ckpt) │  variable     │  $               │
└─────────────────────────────────────────────────────┘
```

The latency differences are brutal. vLLM's KV offloading connector (v0.11.0+) measures 83.4 GB/s bidirectional transfer between GPU and CPU memory at 2 MB block sizes, yielding a 2-22x reduction in time-to-first-token for single requests. But that's the *best case*, the DRAM tier. Moving KV cache from NVMe to GPU crosses both the PCIe bus and the NVMe latency floor, adding 100+ microseconds per I/O. FlexGen demonstrated only 1.9 tokens/s on NVMe for aggressive offloading, compared to KVSwap's improved 6.9 tokens/s (2025) and vLLM's 5x throughput gains through memory layout optimization (v0.12.0).

Every microsecond in this pipeline matters. And every microsecond the CPU spends mediating between the GPU and NVMe storage is a microsecond wasted.

---

## The CPU Tax on GPU I/O

Here's the path data takes today when a GPU needs a KV cache tensor from NVMe:

```
1. GPU signals CPU:     "I need KV block 47392"
2. CPU wakes up:        context switch, scheduler, driver entry
3. CPU builds NVMe cmd: allocate SQE, set LBA, set transfer size
4. CPU submits to SQ:   write SQE to submission queue, ring doorbell
5. NVMe processes:      read from flash, DMA to... where?
6. DMA to host DRAM:    NVMe writes to CPU-pinned bounce buffer
7. CPU copies to GPU:   cudaMemcpy() from host DRAM to GPU HBM
8. GPU resumes:         finally has the data, ~100-200 μs later
```

Steps 2, 3, 6, and 7 are pure overhead. The GPU knew what it needed. The NVMe drive could have DMA'd directly to GPU memory over PCIe. But the protocol stack requires the CPU to be the intermediary at every stage: building the command, managing the DMA target, handling the completion.

NVIDIA's GPUDirect Storage (GDS) eliminates step 7. With GDS, NVMe data flows directly to GPU memory over PCIe, bypassing the host DRAM bounce buffer. GDS delivers up to 3.5x higher bandwidth and 3.5x lower latency compared to the CPU-mediated path. On a well-configured system, GDS sustains 84 GB/s across 10 NVMe drives per GPU, with peaks hitting 90 GB/s.

But GDS only removes the bounce buffer copy. The CPU still builds the NVMe commands. The CPU still submits them. The CPU still handles completions. The I/O initiation path is still CPU-bound.

For training workloads, where data access is predictable and can be prefetched in large batches, this is fine. The CPU pipelines NVMe reads far ahead of when the GPU needs the data. The GPU never stalls.

For inference, the GPU discovers what it needs during the forward pass. By the time it knows it needs KV block 47392, the decode step is already waiting. Routing that request through the CPU's scheduler, driver stack, and NVMe submission path adds latency that directly impacts token generation speed. At 200M IOPS per GPU (the figure cited at LSFMM+BPF 2025 by storage engineers working on device-initiated I/O), the CPU simply cannot keep up. The NVMe driver handles 8-12M IOPS per core in IOMMU passthrough mode, dropping to roughly 2M IOPS with DMA mapping overhead. You'd need 25-100 CPU cores per GPU just for I/O submission. That's absurd.

---

## GPU-Initiated I/O: The Architectural Response

What if the GPU could submit NVMe commands directly, without waking the CPU at all?

This is GPU-initiated I/O. The concept: map the NVMe controller's registers into GPU-accessible address space, place NVMe submission and completion queues in GPU memory, and let GPU threads build and submit I/O commands directly. The CPU handles setup (device discovery, queue creation, BAR mapping) but steps out of the data path entirely.

The path becomes:

```
1. GPU thread:          "I need KV block 47392"
2. GPU builds NVMe cmd: writes SQE directly to submission queue (in GPU memory)
3. GPU rings doorbell:  writes to NVMe BAR0 doorbell register (memory-mapped)
4. NVMe processes:      reads SQE from GPU memory via PCIe, reads flash
5. NVMe DMA to GPU:     writes data directly to GPU HBM via P2P PCIe
6. GPU polls CQ:        reads completion entry from CQ (in GPU memory)
7. GPU resumes:         has the data
```

No CPU involvement on the data path. No context switches. No bounce buffers. No cudaMemcpy. The entire I/O round-trip happens over the PCIe bus between two devices, with the GPU as the initiator.

### BaM: The Proof It Works

The most rigorous demonstration of GPU-initiated I/O is **BaM** (Big accelerator Memory), published at ASPLOS 2023 by researchers from NVIDIA and the University of Illinois. BaM moves NVMe submission and completion queues into GPU memory and maps NVMe doorbell registers into GPU-accessible address space. GPU threads submit NVMe commands and poll for completions without any CPU involvement.

The results:

| Metric | CPU-initiated (GDS) | GPU-initiated (BaM) | Improvement |
|--------|--------------------|--------------------|-------------|
| Graph analytics throughput | baseline | 5.3x faster | GPU eliminates CPU serialization |
| Hardware cost (equivalent perf) | baseline | 21.7x lower | Fewer CPU cores needed |
| Effective I/O bandwidth | limited by CPU IOPS | ~0.74 GB/s at 1.55M ops/s | GPU parallelism scales |

The 5.3x speedup comes from eliminating the CPU serialization bottleneck. When thousands of GPU threads need fine-grained, irregular storage access (graph traversal, sparse attention, KV cache page lookups), the CPU can't submit I/O requests fast enough to keep the GPU fed. GPU-initiated I/O lets each GPU thread submit its own request in parallel. The NVMe device sees a flood of small reads from the GPU's submission queue, processes them, and DMA's results directly back to GPU memory.

This is the same architectural insight that drove [io_uring's batched submission model](/blog/io-uring-spdk-kernel-bypass), taken to its logical extreme. io_uring batches CPU submissions to amortize syscall overhead. GPU-initiated I/O eliminates CPU submission entirely.

### How the Plumbing Works: dma-buf and BAR Mapping

The mechanism behind GPU-initiated I/O relies on two Linux kernel subsystems: **dma-buf** and **PCI P2PDMA**.

**dma-buf** is a kernel framework for sharing DMA buffers between devices. A device (say, an NVMe controller) can export a dma-buf representing a region of its memory. Another device (a GPU) can import that dma-buf and map it into its own address space. This is how the NVMe controller's BAR0 (Base Address Register 0, the memory-mapped region containing command registers and doorbell registers) becomes visible to the GPU.

The NVMe BAR0 contains:
- Controller registers (capabilities, configuration, status)
- Admin submission/completion queue doorbells
- I/O submission/completion queue doorbells

Each doorbell is a 32-bit register. When the GPU writes to an I/O submission queue doorbell, the NVMe controller knows new commands are waiting. The GPU calculates the doorbell address as an offset from BAR0 base, writes the new tail pointer, and the NVMe controller processes the queued commands.

**PCI P2PDMA** (peer-to-peer DMA) allows direct data transfers between PCIe devices without going through system memory. When the NVMe controller reads an SQE from the submission queue (which lives in GPU memory), it performs a PCIe read to GPU BAR space. When it completes the I/O and writes data to the target address (also in GPU memory), it performs a PCIe write to GPU BAR space. The CPU and host DRAM are not involved.

The setup looks like this:

```
         PCIe Root Complex (or PCIe Switch)
              /                    \
    ┌────────┴──────┐    ┌────────┴──────┐
    │   GPU (H100)  │    │  NVMe SSD     │
    │               │    │               │
    │  HBM          │◄──►│  NAND Flash   │
    │  [SQ][CQ]     │    │  [BAR0]       │
    │  [KV data]    │    │  [doorbells]  │
    │               │    │               │
    └───────────────┘    └───────────────┘
           ▲                     │
           │    P2P DMA over     │
           └─── PCIe ───────────┘

    GPU writes to NVMe BAR0 doorbells (submit commands)
    NVMe reads SQEs from GPU memory (fetch commands)
    NVMe writes data to GPU memory (complete I/O)
```

For this to work, three things must be true:

1. **The GPU must expose its memory via PCIe BARs.** NVIDIA datacenter GPUs (A100, H100, B200) expose their full HBM through large BARs. Consumer GPUs artificially restrict this.

2. **The NVMe controller's BAR0 must be mappable into GPU address space.** This requires either dma-buf export or VFIO passthrough of the NVMe device.

3. **PCIe routing must allow P2P.** If the GPU and NVMe are behind the same PCIe switch, P2P transactions stay local. If they're on different root ports, traffic routes through the CPU's root complex, which adds latency and may be blocked by ACS (Access Control Services) policies.

---

## What the NVMe Spec Doesn't Handle

NVMe was designed in 2011. GPUs existed, of course, but nobody was using them as storage clients. The spec makes assumptions that are baked in deeply enough that "just let the GPU submit commands" is harder than it sounds.

### Submission Queues Assume CPU-Style Threading

NVMe submission queues are circular buffers in host memory. The host (assumed to be a CPU) writes command entries sequentially, advances a tail pointer, and writes the new tail to the doorbell register. One thread per queue is the simplest model. Multiple threads sharing a queue need synchronization.

GPUs don't have "threads" the way CPUs do. A GPU has thousands of warps executing in lockstep, each potentially needing to submit an I/O request. If 10,000 GPU threads try to append commands to the same submission queue simultaneously, they need atomic coordination on the tail pointer. GPUs can do atomics, but contention on a single 32-bit counter across 10,000 threads is catastrophic for throughput.

BaM's solution: create many queues (one per GPU SM or per warp group) to reduce contention. But NVMe controllers have limits on queue count and depth. An NVMe drive might support 128 I/O queues. A GPU has 132 SMs (H100). The queue allocation and scheduling strategy becomes a non-trivial problem.

### Completion Handling Assumes Interrupts or CPU Polling

NVMe offers two completion mechanisms: MSI-X interrupts (which target CPU cores) and polling (which requires a CPU thread spinning on the CQ). Neither works for GPU threads.

GPU-initiated I/O requires GPU-side polling of completion queues. The GPU writes a command, then periodically reads the CQ to check for completions. This is doable (BaM does it), but it means GPU threads are burning compute cycles on I/O polling instead of inference math. On a GPU where every SM is precious for transformer computation, dedicating SMs to I/O polling is an expensive trade-off.

### DMA Addressing Assumes Host Physical Addresses

NVMe scatter-gather lists (PRPs and SGLs) specify where data should land using physical addresses that the NVMe controller can DMA to. These addresses are typically in host DRAM, managed by the CPU's IOMMU.

For GPU-initiated I/O, the DMA target is GPU memory. The NVMe controller needs to know the PCIe address of a GPU memory region, not a host physical address. This works if the GPU's BAR is large enough and properly mapped, but it's outside the NVMe spec's assumptions. The IOMMU configuration, the PRP/SGL format, and the controller's address validation logic all assume host memory as the target.

### No GPU-Native Error Handling

NVMe error handling (queue freeze, controller reset, namespace management) assumes a CPU host that can execute complex recovery logic. A GPU that receives an NVMe error status in a CQE has no mechanism to handle it. GPU kernels don't have exception handlers, signal delivery, or the ability to call into the NVMe driver for recovery. Any error on the NVMe path requires falling back to the CPU, which means the "zero CPU involvement" promise has an asterisk.

---

## The KV Cache Offloading Ecosystem (2024-2026)

While the protocol plumbing gets sorted out, the inference community isn't waiting. A wave of systems have appeared that work within today's constraints (CPU-initiated I/O, GDS where available) to tier KV cache across the memory hierarchy.

### vLLM KV Offloading (v0.11.0+)

The most production-ready implementation. vLLM's connector performs async GPU-to-CPU KV cache transfers using pinned host memory and CUDA streams. Benchmarks show 83.4 GB/s bidirectional throughput at 2 MB block sizes. The CPU orchestrates all transfers, but overlaps them with GPU computation so the GPU rarely stalls.

Results: 2-22x time-to-first-token reduction for single requests. Up to 9x throughput increase with 80% CPU cache hit rate. Version 0.12.0 (2026) added memory layout optimizations for a further 4x TTFT reduction and 5x throughput increase.

The key insight: when the CPU can predict which KV blocks the GPU will need (based on the attention pattern), prefetching eliminates most of the latency. The CPU is still the I/O initiator, but it's doing smart prefetching rather than reactive fetching.

### InfiniGen (2024)

Takes a different approach. Instead of moving the entire KV cache between tiers, InfiniGen dynamically predicts which KV cache entries will actually be accessed during the next attention step and loads only those. Since attention is sparse (most tokens attend to a small fraction of the cache), this reduces transfer volume by 60-80%.

Results: 1.63x to 5.28x speedups over full KV cache loading. The trade-off is prediction accuracy. If the predictor misses a KV entry the model actually needs, you get a cache miss that stalls the GPU while the CPU fetches it.

### InstInfer (2024): Compute at the Storage

The most radical approach. InstInfer offloads attention computation to Computational Storage Drives (CSDs). Instead of moving KV cache data from SSD to GPU, it runs the attention math on processors embedded in the SSD itself, exploiting the internal flash bandwidth (11.2 GB/s aggregate across 8 NAND channels) that's much higher than the external PCIe bandwidth (3-6 GB/s).

Results: 11.1x throughput improvement over FlexGen for 13B models. The limitation is obvious: current CSDs have limited compute capability. Running attention kernels on ARM cores embedded in an SSD is far slower per-operation than running them on GPU tensor cores. InstInfer wins on bandwidth, not compute.

### AttentionStore / CachedAttention (2024)

Three-tier KV cache hierarchy: GPU HBM, host DRAM, disk SSD. Uses layer-wise pre-loading to overlap KV cache transfers with GPU computation. Loading a 5 GB KV cache from DRAM to GPU takes approximately 192 ms at effective PCIe Gen4 throughput (~26 GB/s). The system uses an "importance-driven eviction" policy to decide which KV entries stay in HBM versus which get demoted.

### The Pattern

All of these systems share the same limitation: the CPU is still the I/O bottleneck. They're engineering around it with prefetching, prediction, compression, and compute offload. But the fundamental architecture (CPU initiates all I/O, GPU waits) hasn't changed. These are optimizations within a broken model, not fixes to the model itself.

---

## NVIDIA CMX: The Vendor's Answer

NVIDIA's response to the KV cache tiering problem is [CMX (Context Memory Extensions)](/blog/storage-protocols-ai-era), announced at GTC 2026. CMX defines a new tier in the inference memory hierarchy: network-attached NVMe flash, managed by BlueField-4 DPUs, optimized for shared KV cache access across an inference pod.

The CMX architecture:

```
┌──────────────────────────────────────────────────┐
│  G1: GPU HBM        nanoseconds     Active KV    │
├──────────────────────────────────────────────────┤
│  G2: Host DRAM      microseconds    Overflow KV  │
├──────────────────────────────────────────────────┤
│  G3: Local NVMe     ~100 μs         Warm context │
├──────────────────────────────────────────────────┤
│  G3.5: CMX          low μs (RDMA)   Shared KV    │
│  (BlueField-4 +     800 Gb/s        across pods  │
│   Spectrum-X)        per DPU                      │
├──────────────────────────────────────────────────┤
│  G4: Object Storage  milliseconds   Checkpoints  │
└──────────────────────────────────────────────────┘
```

CMX delivers up to 5x token throughput, 5x power efficiency, and 2x faster data ingestion compared to traditional storage for inference workloads. Each BlueField-4 DPU connects to approximately 150 TB of NVMe flash, and a 4-DPU appliance provides roughly 600 TB. DOCA Memos, NVIDIA's KV cache management framework, treats KV blocks as first-class resources with lifecycle management, prefetch hints, and cross-node sharing.

The partner ecosystem is already deploying:
- **VAST Data** runs their CNode on BlueField-4 for zero-copy transfers from remote SSDs to GPU memory
- **WEKA** claims 320 GB/s read throughput with CMX, "4-10x more tokens/s"
- **DDN Infinia** reports "up to 27x faster KV cache loading" with Dynamo integration
- **MinIO AIStor** runs natively on the BlueField-4 DPU

CMX is pragmatic. It doesn't require GPU-initiated I/O or new NVMe extensions. The BlueField-4 DPU is the I/O initiator (it has ARM cores that run the NVMe stack), and it communicates with the GPU over RDMA. The GPU doesn't submit NVMe commands. The DPU does, intelligently, based on prefetch hints from NVIDIA's Dynamo inference orchestrator.

This works today. But it's a workaround, not a solution. The DPU is a very expensive CPU that sits between the GPU and the NVMe flash specifically because the GPU can't talk to storage directly. It solves the latency problem by adding hardware to absorb the CPU tax, rather than eliminating the CPU tax.

---

## What's Actually Missing

For GPU-initiated I/O to move from research demos (BaM) to production infrastructure, four things need to happen.

### 1. Production-Grade GPU NVMe Drivers

Today, GPU-initiated NVMe access requires either custom kernel patches (BaM's approach) or VFIO passthrough of NVMe devices to user-space GPU drivers. Neither is production-ready.

NVIDIA's open-source GPU kernel modules support dma-buf for P2P DMA, but with restrictions. On non-SoC platforms (anything that isn't a Grace Superchip), P2PDMA via dma-buf is explicitly blocked in the driver code. Community developers have demonstrated this restriction is artificial by removing the code checks on Quadro RTX 5000 cards (Turing architecture), confirming the hardware supports it. But NVIDIA hasn't removed the restriction in their official drivers.

Linux 6.19 (2026) merged DMA-BUF support for VFIO PCI devices, contributed by engineers from NVIDIA and Intel. This expands the P2P ecosystem but doesn't provide a turnkey GPU-to-NVMe path.

What's needed: an NVIDIA-supported driver mode where NVMe BAR0 can be mapped into GPU address space, with submission and completion queues allocated in GPU memory, and the Linux NVMe driver aware of GPU-originated commands. This is an engineering project, not a research question. The BaM paper proved it works. The driver support needs to ship.

### 2. A GPU-Native Object/Block Protocol

NVMe's command set (read LBA X for N blocks) is too low-level for what GPUs actually need. A GPU inference engine doesn't think in logical block addresses. It thinks in KV cache blocks, attention heads, model weight shards. The mismatch creates two problems.

First, the GPU needs a translation layer to convert "fetch KV block 47392 for layer 12, heads 0-7" into one or more NVMe read commands with specific LBAs, offsets, and transfer sizes. This translation logic currently runs on the CPU. Moving it to the GPU means running a block allocator, a key-to-LBA mapping, and possibly a log-structured translation layer in GPU code. That's a lot of complexity for a device designed to multiply matrices.

Second, the granularity is wrong. NVMe operates at 4KB minimum block size. A single KV cache entry for one attention head at one layer might be 256 bytes to 4 KB depending on the model architecture. Reading an entire 4KB block to get 256 bytes of useful data wastes 94% of the I/O bandwidth.

What's needed: a higher-level protocol where the GPU can request semantic objects ("KV block ID 47392") and the storage device (or a DPU intermediary) handles the translation to physical addresses. NVIDIA's DOCA Memos is a step in this direction, but it runs on the DPU, not on the GPU. A true GPU-native object protocol would let the GPU issue object-level requests that the NVMe controller (or a computational storage controller) resolves internally.

### 3. Software Tiering Across HBM, DRAM, SSD, and Network

The memory hierarchy for inference KV cache has four tiers, but no unified software layer manages them. Today's solutions are fragmented:

- vLLM manages HBM-to-DRAM offloading
- GDS handles NVMe-to-GPU transfers (but the CPU initiates them)
- CMX manages network-attached flash via DPUs
- [CXL memory](/blog/cxl-death-of-memory-hierarchy) adds a fifth tier (200-640 ns) that nothing in the inference stack knows about yet

What's needed is a unified memory manager that sees all tiers, understands KV cache access patterns (which layers are hot, which attention heads are sparse, which context windows are reused), and moves data proactively. Google's GKE tiered KV cache (2025) and research systems like Strata (hierarchical context caching, 2025) and TraCT (disaggregated serving with CXL shared memory, 2025) are early attempts.

The Pareto-optimized tiering paper from 2026 showed that simulation-driven optimization across GPU HBM, host DRAM, and disk can achieve 9.3% throughput improvement, 58.3% TTFT reduction, and 20.2% cost reduction versus an all-DRAM baseline. These are the gains from getting the tiering policy right. The hardware stack is there. The software to exploit it is not.

### 4. Standards Body Engagement

At SNIA SDC 2025, a presentation titled "Why does NVMe Need to Evolve for Efficient Storage Access from GPUs?" laid out the requirements: GPU-native command submission, GPU-compatible completion mechanisms, support for non-contiguous GPU memory in scatter-gather lists, and optimized command sets for AI access patterns.

NVMe 2.1 (August 2024) added computational storage command sets, host-directed data placement, and key-per-I/O encryption. These are useful, but they're still CPU-centric. No NVMe specification revision has addressed GPU-initiated command submission.

The CXL consortium hasn't tackled GPU-to-storage directly either, though CXL Type 2 devices (accelerators with memory, like GPUs) are part of the specification. AMD's MI300A is a CXL Type 2 device. If GPU-initiated I/O to CXL-attached memory took off, it could bypass NVMe entirely for the DRAM/persistent memory tiers.

---

## The Topology Problem: Where GPU Meets NVMe

Even if the software stack were perfect, PCIe topology constrains GPU-to-NVMe P2P performance. The ideal case is a GPU and NVMe drive sharing a PCIe switch:

```
Ideal: GPU and NVMe behind same PCIe switch
    ┌──────────────┐
    │  PCIe Switch  │
    ├──────┬───────┤
    │ GPU  │ NVMe  │
    └──────┴───────┘
    P2P latency: minimal (switch forwarding only)
    P2P bandwidth: line rate
```

The common case is both devices on different CPU root ports:

```
Common: GPU and NVMe on different root ports
    ┌───────────────────┐
    │  CPU Root Complex   │
    ├─────────┬─────────┤
    │  Port A │  Port B  │
    │   GPU   │   NVMe   │
    └─────────┴─────────┘
    P2P latency: +root complex traversal
    P2P bandwidth: limited by RC internal fabric
    ACS may block: forces traffic through IOMMU
```

ACS (Access Control Services) is particularly painful. ACS is a PCIe security feature that forces peer-to-peer transactions through the root complex instead of allowing direct switch forwarding. It's enabled by default on many server platforms for security (isolating VMs from each other's devices). Disabling ACS for GPU-NVMe P2P is a per-platform BIOS or kernel parameter change that most datacenter operators won't do without a compelling reason.

[NUMA topology](/blog/pcie-lanes-numa-rust-storage) adds another dimension. On a dual-socket system, a GPU on socket 0 accessing an NVMe drive on socket 1 crosses the UPI/Infinity Fabric interconnect, adding 50-100 ns to every P2P transaction. For GPU-initiated I/O to work well, GPU and NVMe placement must be NUMA-aware.

This is why NVIDIA's DGX and HGX platforms place NVMe drives on the same PCIe switch tree as the GPUs they serve. And it's why CMX uses network-attached flash (via BlueField DPUs) instead of local NVMe: the DPU can be co-located with the GPUs on the same PCIe switch, providing a consistent latency path regardless of where the NVMe flash physically lives.

---

## The Clean Break vs. NVMe Extension Debate

The fundamental question: does GPU-initiated I/O evolve as an extension to NVMe, or does it require a clean-break protocol?

### The NVMe Extension Argument

NVMe already has the queue model (SQ/CQ pairs), the DMA infrastructure (PRPs and SGLs), and the deployment base (every datacenter on Earth). Extending NVMe for GPU hosts means:

- Adding a "GPU-initiated" queue type where SQ/CQ live in device-accessible GPU memory
- Defining a GPU-compatible completion mechanism (GPU-polled CQ or GPU-targeted notifications via NVLink/PCIe)
- Extending SGL formats to describe non-contiguous GPU memory regions
- Adding optional higher-level command sets (key-value, object, tensor-block)

The advantage is ecosystem leverage. Every NVMe controller vendor, every SSD vendor, every Linux kernel developer already speaks NVMe. Adding GPU awareness is incremental. The storage doesn't need to know or care that the host is a GPU versus a CPU. It just processes commands from whichever device rings the doorbell.

### The Clean Break Argument

NVMe's assumptions are deeply embedded. Circular buffer queues with single-writer semantics don't map well to thousands of GPU threads. 4 KB minimum block sizes waste bandwidth for fine-grained KV cache access. LBA-based addressing requires a translation layer that has no natural home on a GPU. Interrupt-based error handling has no GPU equivalent.

A GPU-native storage protocol would look more like:
- **Many-writer submission**: lock-free submission from thousands of concurrent GPU threads
- **Object-level addressing**: "read tensor block X" instead of "read LBA Y for N blocks"
- **Variable granularity**: 256-byte to 1 MB transfers without padding waste
- **GPU-native completion**: write a flag to GPU memory, no interrupts
- **Integrated compute**: controller-side operations (decompress, decrypt, gather) that reduce GPU involvement

This sounds like a computational storage command set crossed with an object store API, purpose-built for GPU clients. NVIDIA's DOCA Memos is the closest thing to this today, but it runs on a DPU, not on the storage device, and it's proprietary.

### Where It's Likely Heading

History suggests extension, not clean break. USB extended to support higher speeds rather than being replaced. PCIe added CXL as a layer rather than starting over. NVMe itself added ZNS, KV command sets, and computational storage as optional command set extensions rather than new protocols.

The realistic path:

**2026-2027**: NVMe consortium forms a working group on GPU/accelerator-initiated I/O. NVIDIA contributes the BaM learnings. Samsung and Western Digital contribute controller-side support. The initial spec adds a GPU-compatible queue mode as an optional NVMe feature.

**2027-2028**: First NVMe controllers ship with GPU-initiated queue support. NVIDIA integrates GPU-NVMe submission into CUDA and the Dynamo framework. Linux kernel gains a "GPU NVMe initiator" subsystem (likely built on top of the existing [io_uring_cmd](/blog/io-uring-spdk-kernel-bypass) infrastructure for hybrid CPU/GPU paths).

**2028+**: Higher-level semantic commands (tensor-block read, KV cache prefetch) appear as NVMe command set extensions. CXL Type 2 devices (GPUs with CXL interfaces) start accessing CXL-attached persistent memory directly, bypassing NVMe entirely for the CXL tier.

The DPU (BlueField-4 and successors) remains in the architecture as a management plane and network-storage gateway, but the hot-path I/O moves to direct GPU-NVMe. The DPU handles setup, error recovery, multi-tenancy, and encryption. The GPU handles the data path.

---

## What This Means for Storage Systems

If you're building storage infrastructure for AI inference, the GPU-initiated I/O transition has three practical implications.

### Design for Semantic Access, Not LBA

Today's storage systems expose block interfaces (LBA ranges) or file interfaces (POSIX paths). Neither maps cleanly to what inference engines need: tensor blocks, KV cache pages, attention head groups. The storage systems that will integrate most naturally with GPU-initiated I/O are the ones that already think in objects and semantic keys.

Object storage with key-value access patterns ([S3 API, custom KV protocols](/blog/storage-protocols-ai-era)) is better positioned than block storage for this transition. When the GPU can request "KV block 47392" by name, the storage system that can resolve that name to physical location server-side will eliminate the GPU-side translation layer entirely.

### Architect for P2P PCIe Topology

GPU-NVMe placement matters more than raw drive performance. An [EDSFF E1.S drive](/blog/edsff-e2-next-gen-drives) behind the same PCIe switch as the GPU it serves will outperform a faster drive on a different root port. Storage architects need to think about PCIe topology, NUMA affinity, and ACS configuration as first-class design constraints, not afterthoughts.

For NVMe-oF deployments, this means the [BlueField DPU](/blog/nvme-of-promise-and-pain) (which bridges NVMe-oF to local PCIe) should be co-located with the GPU on the same switch complex. NVIDIA's CMX architecture already enforces this. Follow it.

### Build the Tiering Layer Now

Regardless of when GPU-initiated I/O ships in production, KV cache tiering across HBM, DRAM, NVMe, and network storage is happening today. Systems that can move data proactively between tiers based on inference access patterns will outperform systems that treat storage as a flat pool.

The interface between your storage system and the inference engine should be: "here are the KV blocks I'll need in the next N decode steps, pre-stage them." Whether that pre-staging is CPU-initiated (today) or GPU-initiated (tomorrow), the storage-side logic is the same: predict, prefetch, place.

---

## Conclusion

For 40 years, the CPU has been the intermediary between compute and storage. It worked because the CPU was doing the computation. In the inference era, the GPU is the compute engine, and routing every storage request through the CPU is an architectural bottleneck that prefetching and DPUs can mask but not eliminate.

GPU-initiated I/O (direct NVMe command submission from GPU threads via P2P DMA) removes the CPU from the data path. BaM proved it works at ASPLOS 2023 with 5.3x speedups over CPU-initiated storage access. The mechanism (dma-buf export of NVMe BAR0, SQ/CQ placement in GPU memory, P2P PCIe data transfer) is understood. What's missing is production driver support from NVIDIA, NVMe specification extensions for GPU hosts, and a software stack that manages tiering across HBM, DRAM, CXL, NVMe, and network storage.

NVIDIA's CMX and BlueField-4 solve the near-term problem by putting a smart CPU (the DPU) between the GPU and storage. That's pragmatic. But the DPU is a band-aid over a protocol stack that assumes the wrong host. The long-term architecture is the GPU talking directly to storage, with the CPU and DPU handling management and error recovery, not the data path.

The open question is whether this becomes an NVMe extension or a clean break. History favors extension. The NVM Express consortium will likely add GPU-compatible queue modes and semantic command sets as optional features. CXL Type 2 devices may provide an alternative path for persistent memory tiers. Either way, the GPU moves from I/O consumer to I/O initiator.

The storage controller wore a CPU for 40 years. It's trying on a GPU now. The fit isn't perfect yet. But the direction is clear, and the protocol stack will adapt because it always does.

---

*BaM (Big accelerator Memory) paper from ["BaM: A Case for Enabling Fine-grain High Throughput GPU-Orchestrated Access to Storage"](https://dl.acm.org/doi/10.1145/3575693.3575748) (ASPLOS 2023, NVIDIA/UIUC). GPU-initiated I/O kernel discussion from ["Device-initiated I/O"](https://lwn.net/Articles/1022718/) (LWN.net, LSFMM+BPF 2025). NVIDIA GPUDirect Storage from [NVIDIA GDS documentation](https://docs.nvidia.com/gpudirect-storage/). NVIDIA CMX from [CMX product page](https://www.nvidia.com/en-us/data-center/ai-storage/cmx/) and [BlueField-4 blog](https://developer.nvidia.com/blog/introducing-nvidia-bluefield-4-powered-inference-context-memory-storage-platform-for-the-next-frontier-of-ai/). vLLM KV offloading from [vLLM KV Offloading Connector blog](https://vllm.ai/blog/kv-offloading-connector). InfiniGen from [arXiv 2406.19707](https://arxiv.org/html/2406.19707v1). InstInfer from [arXiv 2409.04992](https://arxiv.org/html/2409.04992v1). AttentionStore/CachedAttention from [arXiv 2403.19708](https://arxiv.org/html/2403.19708v3). KV cache memory calculations from [KV Cache Memory Calculator](https://mbrenndoerfer.com/writing/kv-cache-memory-calculation-llm-inference-gpu). NVMe GPU evolution from ["Why does NVMe Need to Evolve for Efficient Storage Access from GPUs?"](https://www.youtube.com/watch?v=GaQ6UY4uroQ) (SNIA SDC 2025). Linux P2PDMA from [kernel P2PDMA documentation](https://docs.kernel.org/driver-api/pci/p2pdma.html). Linux 6.19 DMA-BUF VFIO from [Phoronix](https://www.phoronix.com/news/Linux-6.19-DMA-BUF-VFIO-PCI). NVIDIA open-source driver P2PDMA discussion from [GitHub](https://github.com/NVIDIA/open-gpu-kernel-modules/discussions/1046). Pareto-optimized tiering from [arXiv 2603.08739](https://arxiv.org/html/2603.08739). CXL KV cache performance from [Astera Labs blog](https://www.asteralabs.com/breaking-through-the-memory-wall-how-cxl-transforms-rag-and-kv-cache-performance/). NVMe 2.1 specifications from [NVM Express](https://nvmexpress.org/specifications/). Partner CMX benchmarks from [Blocks and Files](https://www.blocksandfiles.com/ai-ml/2026/03/30/nvidia-and-its-partners-kv-cache-extenders/5209284).*
