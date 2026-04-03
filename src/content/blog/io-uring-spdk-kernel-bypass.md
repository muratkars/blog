---
title: "io_uring, SPDK, and the Kernel Bypass Wars"
date: 2026-04-04
description: "The Linux kernel I/O stack was designed when a disk seek took 10 milliseconds. NVMe completes I/O in 10 microseconds. Two competing approaches emerged to fix this: SPDK rips out the kernel entirely, io_uring makes it fast enough. SPDK won the benchmarks. io_uring is winning the war."
tags: ["storage", "linux", "io_uring", "spdk", "performance"]
type: "standard"
featured: false
image: "/images/blog/io-uring-spdk.png"
readTime: "16 min read"
---

![io_uring vs SPDK kernel bypass wars](/images/blog/io-uring-spdk.png)

*The Linux kernel I/O stack was designed when a disk seek took 10 milliseconds. NVMe completes I/O in 10 microseconds. The kernel overhead (context switches, VFS traversal, page cache, block layer, scheduler) now consumes 40% of your I/O latency. Two approaches emerged to fix this: SPDK (rip out the kernel entirely) and io_uring (make the kernel fast enough that you don't need to). SPDK won the benchmarks. io_uring is winning the war. Here's why.*

---

## The Syscall Tax: Why the Kernel Is the Bottleneck

Every traditional Linux I/O operation follows the same path:

```
Application                          Kernel
    │                                   │
    ├─ read() ──── context switch ────► VFS layer
    │                                   ├─► page cache lookup
    │                                   ├─► filesystem (ext4/XFS)
    │                                   ├─► block layer (bio, elevator)
    │                                   ├─► NVMe driver
    │                                   ├─► device interrupt
    │                                   ├─► completion processing
    ◄── context switch ────────────────┘
    │
    ├─ ~4 microseconds overhead
```

Each `read()` or `write()` crosses the user-kernel boundary twice, walks the VFS, checks the page cache, traverses the block layer, and wakes the thread on completion via interrupt. On a good day, the overhead is about **4 microseconds per I/O**.

When the storage device was a spinning disk with a 10ms seek time, 4us of kernel overhead was 0.04%. Invisible. Free.

A modern NVMe SSD completes a 4KB random read in about **10 microseconds**. Now that 4us kernel overhead is **40% of your total I/O latency**. The kernel isn't managing the device anymore. It's competing with it.

At scale, this gets worse. A single Samsung PM9A3 NVMe drive handles 900K random read IOPS. At 24 drives per node, that's 21.6 million potential IOPS. Each IOP requires at least one syscall, one context switch, one interrupt. The CPU spends more time managing I/O than the drives spend doing I/O.

This is why the storage industry went looking for alternatives.

---

## SPDK: The Nuclear Option

Intel's Storage Performance Development Kit (SPDK) takes the most aggressive possible approach: **remove the kernel from the I/O path entirely.** NVMe devices are unbound from the Linux kernel driver, bound to a user-space driver (via VFIO or UIO), and the application talks directly to the NVMe submission and completion queues through memory-mapped registers.

No syscalls. No context switches. No VFS. No block layer. No interrupts. The application polls the completion queue in a tight loop, burning CPU cycles to achieve the lowest possible latency.

The performance is real. Research from VU Amsterdam (CHEOPS '23, SYSTOR '22) measured SPDK delivering **4.2 million IOPS using only 5 CPU cores**, peak throughput that no other I/O API could match. At low queue depths where latency matters most, SPDK's polled completion eliminates the interrupt latency that penalizes every other approach.

### What SPDK Costs You

But SPDK doesn't just bypass the kernel's I/O stack. It bypasses the kernel's *everything*:

**Hugepages.** SPDK requires pre-allocated hugepages, minimum 2 GB, pinned in physical memory before the application starts. The memory must be physically contiguous for DMA, which means you're reserving large chunks of RAM at boot time. Memory fragmentation on long-running systems makes this increasingly unreliable. [GitHub issue #707](https://github.com/spdk/spdk/issues/707) documents production systems failing to allocate hugepages after weeks of uptime.

**Dedicated CPU cores.** SPDK runs in polled mode, consuming 100% of each dedicated core. Research from HotStorage '25 ("SPDK+: Low Latency or High Power Efficiency?") measured that when polling 7 NVMe drives at queue depth 8, only **15.17% of clock cycles** were actively used. The remaining 84.83% are wasted spinning on an empty completion queue. You're paying for 6 CPU cores to get the useful work of 1.

**Device unbinding.** NVMe devices must be unbound from the kernel's `nvme` driver and rebound to `vfio-pci` or `uio_pci_generic` via SPDK's `setup.sh` script. While SPDK owns a device, it's invisible to the operating system. No `lsblk`. No `smartctl`. No filesystem. No kernel QoS, no cgroups, no quota enforcement. Your operational tooling goes dark.

**Custom memory management.** All data buffers must be allocated via `spdk_dma_malloc()` for DMA-safe, physically-pinned memory. Standard `malloc()` buffers cannot be used for I/O. Every library, every abstraction layer, every buffer pool in your application must be aware of this constraint.

**DPDK dependency.** SPDK depends on Intel's Data Plane Development Kit (DPDK) for memory management and device infrastructure. DPDK is itself a large, complex C library with its own hugepage requirements, EAL (Environment Abstraction Layer) initialization, and threading model. You're not just adopting SPDK. You're adopting SPDK *and* DPDK.

**No filesystem integration.** This is the one that kills most adoption attempts. With SPDK, there is no filesystem on top of the NVMe device. No ext4, no XFS, no file permissions, no `ls`, no `dd`, no `cp`. You get raw block access. Building anything on top (an object store, a database, a log-structured storage engine) means implementing your own space management, your own allocation, your own crash recovery. From scratch.

### The SPDK Adoption Picture

Given all of this, SPDK's production footprint is concentrated in a few categories:

- **Purpose-built storage appliances**: VAST Data uses SPDK in their metadata path, reporting 30-40% better latency and 50-100% IOPS improvement. Nutanix's Acropolis BlockStore is built entirely on SPDK. These are teams with 50-100 storage engineers dedicated to a single product.

- **NVMe-oF targets**: OpenEBS/Mayastor uses SPDK to expose Kubernetes persistent volumes over NVMe over Fabrics. Longhorn V2 (SUSE) has an experimental SPDK data engine. Both require a full CPU core per node and kernel 6.7+.

- **Hardware vendors**: Samsung and Intel are major SPDK contributors, using it internally for firmware validation and performance testing.

Notice who's missing? General-purpose storage systems. Databases. Application developers. The teams that build 90% of the world's storage software. For them, SPDK's operational burden (hugepages, dedicated cores, device unbinding, custom allocators, no filesystem) is a price they can't or won't pay.

The industry needed something between "4us of kernel overhead on every I/O" and "rip out the entire kernel." That something is io_uring.

---

## io_uring: Making the Kernel Fast Enough

io_uring, introduced by Jens Axboe in Linux 5.1 (May 2019), takes a fundamentally different approach than SPDK. Instead of bypassing the kernel, it redesigns how applications talk to the kernel.

The core insight: the expensive part of a syscall isn't the work, it's the transition. Crossing from user space to kernel space and back costs 100-500ns per call due to context switching, TLB flushes, and speculative execution mitigations (KPTI, Spectre). If you could submit a batch of I/O operations without a syscall per operation, and harvest completions without a syscall per completion, the overhead drops by an order of magnitude.

### The Ring Buffer Architecture

io_uring uses two shared memory ring buffers: a **Submission Queue (SQ)** and a **Completion Queue (CQ)**, mapped into both user space and kernel space.

```
User Space                         Kernel Space
    │                                   │
    ├─ Write SQE to SQ ring ───────────►│ (no syscall, just memory write)
    ├─ Write SQE to SQ ring ───────────►│
    ├─ Write SQE to SQ ring ───────────►│
    ├─ io_uring_enter() ───────────────►│  (one syscall, submits all 3)
    │                                   ├─► process I/O operations
    │                                   ├─► write CQEs to CQ ring
    ◄── read CQE from CQ ring ─────────┤ (no syscall, just memory read)
    ◄── read CQE from CQ ring ─────────┤
    ◄── read CQE from CQ ring ─────────┤
```

The application writes Submission Queue Entries (SQEs) directly into the shared ring, no syscall needed. When it's ready, a single `io_uring_enter()` call submits the entire batch to the kernel. Completions appear in the CQ ring, readable from user space without any syscall.

**One syscall for N operations**, versus N syscalls for N operations with `read()`/`write()`.

### The Evolution: 2019 to 2026

io_uring didn't ship fully formed. It evolved over 30+ kernel releases, each adding capabilities that closed the gap with SPDK:

| Kernel | Year | Capability | Impact |
|--------|------|-----------|--------|
| 5.1 | 2019 | Basic SQ/CQ rings | Foundation: batched async I/O |
| 5.3 | 2019 | Linked SQEs | Dependent I/O chains without round-trips |
| 5.6 | 2020 | Fixed files, 30 opcodes | Eliminate fd refcount overhead |
| 5.7 | 2020 | Internal polling (FAST_POLL) | Eliminate async thread punt |
| 5.11 | 2021 | Unprivileged SQPOLL | Kernel-side submission thread, no syscall at all |
| 5.19 | 2022 | `io_uring_cmd` (NVMe passthrough) | Bypass block layer entirely |
| 6.0 | 2022 | Zero-copy network send, ublk | Network I/O, user-space block drivers |
| 6.10 | 2024 | Improved zerocopy, bundles | 3x fewer cycles per byte for networking |
| 6.12 | 2024 | Hugepage coalescing, async discard | 5-6x faster discard, less CPU |

Two features deserve special attention.

### SQPOLL: Eliminating the Last Syscall

With `IORING_SETUP_SQPOLL`, the kernel spawns a dedicated thread that polls the submission queue. The application writes SQEs to the ring and the kernel thread picks them up. **Zero syscalls on the submission path.** Completions are read from the CQ ring, also without a syscall. The entire I/O path becomes shared-memory communication between the application and a kernel thread.

This is architecturally identical to SPDK's approach (poll-based, no interrupts) but with the kernel still managing the device. You keep your filesystem, your `smartctl`, your cgroups, your permission model. The NVMe device stays visible to the OS.

The cost is one kernel thread burning a CPU core, the same cost as SPDK's poll loop, but with the kernel's infrastructure intact.

### io_uring_cmd: NVMe Passthrough Without SPDK

Added in kernel 5.19, `io_uring_cmd` (also called NVMe passthrough) lets applications submit **native NVMe commands** directly to device queues via io_uring, bypassing the entire Linux block layer (bio allocation, I/O scheduler, merge logic) while still going through the kernel's NVMe driver.

```
Traditional path:     app → syscall → VFS → filesystem → block layer → NVMe driver → device
io_uring path:        app → SQ ring → block layer → NVMe driver → device
io_uring_cmd path:    app → SQ ring → NVMe driver → device
```

The results, measured at USENIX FAST '24 by the Samsung/Western Digital team:

- Block I/O path: up to **2.9 million IOPS**
- io_uring_cmd passthrough: up to **3.9 million IOPS**, a **35% improvement**
- Combined with fixed buffers and polling: within **9-16%** of raw SPDK performance

That's SPDK territory. Without hugepages, without device unbinding, without custom allocators, without losing your filesystem, without DPDK. The device stays in the kernel's NVMe driver. You can still run `smartctl`. You can still use cgroups. You can still see the device in `lsblk`.

`io_uring_cmd` is integrated into fio (`--ioengine=io_uring_cmd --cmd_type=nvme`) and into xNVMe, Samsung's cross-platform NVMe access library. It's the closest thing to "SPDK performance with kernel manners."

---

## The Numbers: io_uring vs SPDK in 2026

Let me lay out the performance data honestly. SPDK is still faster. The question is whether the gap justifies the cost.

### Raw IOPS (Single NVMe, 4K Random Read)

| Configuration | IOPS | CPU Cores Used |
|--------------|------|----------------|
| `read()` synchronous | ~15K (QD1) | 1 |
| libaio | ~600K | 1-2 |
| io_uring (interrupt) | ~850K | 1-2 |
| io_uring (SQPOLL) | ~950K | 2 (1 app + 1 kernel poll) |
| io_uring_cmd (passthrough + poll) | ~1.3M | 2 |
| SPDK (polled) | ~1.5M | 1-2 (dedicated) |

*Source: fio benchmarks, FAST '24, CHEOPS '23.*

### Multi-Drive Aggregate (8x PCIe 5.0 NVMe)

From the December 2024 DBMS benchmark (8x Kioxia CM7-R, 2.45M IOPS per drive):

| Configuration | Aggregate IOPS | Notes |
|--------------|---------------|-------|
| Synchronous | ~100K | Pathetic |
| io_uring (basic) | ~1.1M | Good baseline |
| io_uring + registered buffers | ~1.4M | 11% gain from buffer pre-registration |
| io_uring_cmd + IOPoll | ~2.3M | Block layer bypass |
| io_uring + SQPOLL (full stack) | ~3.3M | Peak io_uring config |
| SPDK | ~4.2M | Peak, 5 dedicated cores |

io_uring with the full optimization stack (SQPOLL + io_uring_cmd + registered buffers + fixed files) reaches **~80% of SPDK's peak IOPS** while retaining full kernel integration. For database workloads (PostgreSQL), applying io_uring optimization guidelines yielded a **14% throughput improvement** over baseline. Meaningful, not revolutionary, but free.

### The Real Comparison

The fair comparison isn't "io_uring peak IOPS vs SPDK peak IOPS." It's:

| | io_uring (full optimization) | SPDK |
|---|---|---|
| Peak IOPS | ~80% of SPDK | 100% (reference) |
| CPU efficiency | Comparable with SQPOLL | 84% wasted cycles polling |
| Kernel integration | Full (cgroups, permissions, fs) | None |
| Device visibility | `lsblk`, `smartctl`, everything | Invisible to OS |
| Memory management | Standard `malloc()` + registered buffers | `spdk_dma_malloc()` only |
| Hugepages | Not required | Required (2GB+ pre-allocated) |
| Dependencies | Linux kernel 5.19+ | SPDK + DPDK + vfio/uio |
| Filesystem support | ext4, XFS, anything | None, raw block only |
| Operational tooling | All standard Linux tools | Custom tooling required |
| Build complexity | `#include <liburing.h>` | Link SPDK + DPDK + configure EAL |

You're trading 20% peak IOPS for an operational cost reduction that's hard to overstate. And that 20% gap continues to shrink with every kernel release.

---

## The Security Elephant

I would be dishonest if I didn't address io_uring's security record. It's bad.

### The CVE Count

| Year | io_uring CVEs |
|------|--------------|
| 2021 | ~10 |
| 2022 | ~15 |
| 2023 | ~19 |
| 2024 | ~21 |
| 2025 | ~10 (partial year) |

That's approximately **75 CVEs in 5 years** for a single kernel subsystem. For context, the entire NVMe driver has had a handful in the same period.

### The Highlights Reel

- **CVE-2021-41073**: Type confusion leading to local privilege escalation. Public exploit on GitHub.
- **CVE-2022-29582**: Use-after-free, cross-cache exploit. Full LPE writeup published.
- **CVE-2024-0582**: Use-after-free in provided buffer rings. Patched in mainline December 2023, but not ported to Ubuntu for **two months**, a patch gap exploited in the wild.

### The Google Verdict

In June 2023, Google reported that **60% of kernel exploits** submitted to their bug bounty in 2022 targeted io_uring. They paid out roughly **$1 million** in io_uring vulnerability rewards. Their response was sweeping:

- **ChromeOS**: io_uring disabled entirely
- **Android**: seccomp-bpf blocks io_uring for apps
- **Google production servers**: io_uring disabled

When Google, which runs one of the largest storage infrastructures on Earth, disables a feature, the storage industry should pay attention.

### The Curing Rootkit

In April 2025, security firm ARMO published a proof-of-concept rootkit called "Curing" that operates entirely via io_uring's 61 supported operations. Because io_uring operations don't go through the syscall path, they completely bypass syscall-based security monitoring. Tested tools that **failed to detect it**: Falco, Microsoft Defender, and most Linux runtime security tools.

The mitigation requires KRSI (Kernel Runtime Security Instrumentation) using eBPF programs attached to LSM hooks, a capability that most production security stacks don't have yet.

### The Container Situation

- **Docker 25.0.0+** (January 2024): io_uring blocked by default seccomp profile
- **containerd**: Runtime default seccomp profile updated to block io_uring
- **Podman**: Community discussions on the same restrictions

If you're running storage in containers (Kubernetes), you need to explicitly allow io_uring syscalls in your seccomp profile. This is a deliberate decision with security trade-offs, not something you should do casually.

### What This Means in Practice

For storage systems that run on **dedicated bare-metal nodes** (which most serious storage deployments do), io_uring's security profile is manageable. You control the kernel, the seccomp policy, the attack surface. The CVEs are local privilege escalation; they require existing code execution on the machine. A storage appliance that only runs trusted storage software has a small attack surface regardless.

For storage running in **multi-tenant containers** or **shared cloud VMs**, io_uring's security posture is a real concern. The default seccomp restrictions exist for good reason. You're adding kernel attack surface for I/O performance that may or may not be your bottleneck.

The honest engineering answer: use io_uring on dedicated storage nodes where you control the stack. Fall back to libaio (or regular io_uring without SQPOLL/passthrough) in restricted environments. Test your security tooling against Curing-style attacks before assuming your monitoring covers io_uring operations.

---

## Rust and io_uring: The Ecosystem Reality

Rust is the natural language for io_uring storage systems. No GC to interfere with I/O-pinned threads, no runtime to fight with. But the Rust io_uring ecosystem is fragmented in a way that matters for architectural decisions.

### The Foundation: `io-uring` Crate

The low-level `io-uring` crate (34 million downloads, actively maintained under the tokio-rs organization) provides safe Rust bindings to `liburing`. It's solid, well-tested, and the foundation that everything else builds on. If you're building a storage engine and want direct control over SQE/CQE management, this is the right starting point.

### The Runtime Layer: Three Competing Models

**tokio-uring** (tokio-rs): The official Tokio io_uring integration. Semi-dormant; last release May 2024, many open issues. It runs an io_uring event loop alongside Tokio's epoll-based reactor, which means you get io_uring for file I/O but still use epoll for networking. Not production-ready by community consensus.

**glommio** (Datadog): Thread-per-core design, cooperative scheduling, direct io_uring usage without Tokio. Actively maintained. Used at Datadog for high-throughput data pipeline components. Linux-only, no cross-platform story. The most mature option for server-side Rust io_uring.

**monoio** (ByteDance): Thread-per-core, pure io_uring/epoll runtime. Used in production at ByteDance via the Monolake framework for application gateways. Benchmarks show peak performance **close to 3x Tokio** under 16 cores. Most performant of the three, and provides cancellable I/O components that address the fundamental safety issue.

### The Cancellation Problem

There's a fundamental tension between Rust's async model and io_uring. When you drop an async future in Rust, the language guarantees the computation stops. But io_uring operations are submitted to the kernel. Dropping the future doesn't cancel the kernel-side I/O. The kernel may still be writing to your buffer after Rust has freed it.

Standard Rust async I/O uses borrowed buffers:
```rust
async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>
```

This is unsound with io_uring. If the future is dropped while the kernel is writing to `buf`, you have a use-after-free. All io_uring runtimes must instead use buffer-ownership semantics:

```rust
async fn read(buf: Vec<u8>) -> (io::Result<usize>, Vec<u8>)
```

The buffer is *moved* into the future, and returned alongside the result. The kernel can write to it safely because the buffer's lifetime is tied to the operation, not to a borrow.

This means io_uring-based Rust code is **not API-compatible** with the standard `tokio::io::AsyncRead`/`AsyncWrite` traits. Libraries built for Tokio's epoll model don't work with io_uring runtimes without adaptation. This is the single biggest obstacle to io_uring adoption in the Rust ecosystem.

### The Practical Recommendation

For a storage system in 2026:

1. **Use the `io-uring` crate directly** for the I/O engine, with your own SQE/CQE management. You want fine-grained control over submission batching, registered buffers, and polling mode anyway.
2. **Use Tokio for everything else**: networking, timers, task scheduling, the S3 HTTP layer.
3. **Bridge the two** with a dedicated I/O thread pool that owns the io_uring instances and communicates with Tokio tasks via channels. This is the same architecture that ScyllaDB's Seastar uses (separate I/O reactor, separate network reactor), adapted for Rust.

Don't wait for tokio-uring to mature. Don't rewrite your network stack on glommio or monoio. Use io_uring where it matters (disk I/O) and Tokio where it's proven (everything else).

---

## The Middle Path: What Actually Makes Sense

The storage industry's io_uring vs SPDK debate is a false dichotomy. The right architecture uses io_uring differently for different parts of the I/O stack.

### For Bulk Data I/O: io_uring with Direct I/O

Object storage is sequential-write, random-read. For bulk data operations (PUT shards to disk, GET shards from disk), io_uring with `O_DIRECT` and registered buffers eliminates both the page cache (which you don't want for object storage, since you have your own caching) and the per-I/O buffer mapping overhead.

```
PUT shard pipeline:
    Compress → Encrypt → EC Encode → io_uring O_DIRECT write (batched, registered buffers)

GET shard pipeline:
    io_uring O_DIRECT read (batched, registered buffers) → EC Decode → Decrypt → Decompress
```

Multiple shard writes from a single PUT can be batched into a single `io_uring_enter()` call. For a 12-shard [erasure coded](/blog/simd-mandatory-erasure-coding) write, that's 12 I/O operations submitted with one syscall instead of 12.

### For Metadata I/O: io_uring with Buffered I/O

Metadata files (FlatBuffer shard metadata, listing caches, bucket configs) are small, frequently accessed, and benefit from the page cache. Regular io_uring (not `O_DIRECT`) lets the kernel cache hot metadata in memory while still batching submissions.

### For NVMe-Dense Nodes: io_uring_cmd Passthrough

On dedicated storage nodes with [24-48 NVMe drives](/blog/edsff-e2-next-gen-drives), `io_uring_cmd` passthrough eliminates the block layer overhead entirely. You're talking directly to the NVMe driver, skipping bio allocation, I/O scheduling, and merge logic. This is where io_uring approaches SPDK performance.

The requirement: kernel 5.19+ and using the NVMe character device (`/dev/ngXnY`) instead of the block device (`/dev/nvmeXnYpZ`). The drives remain visible to the kernel, but I/O bypasses the generic block layer.

### For Networking: Tokio (epoll), Not io_uring

io_uring's networking support is improving (zero-copy send in 6.0, zero-copy receive in 6.17), but epoll-based networking is battle-tested, debuggable, and well-understood. The latency difference for S3 HTTP request handling is negligible compared to the I/O latency. Use Tokio's proven networking stack and spend your complexity budget where it matters, on the storage I/O path.

### The Architecture

```
S3 HTTP Layer (Tokio + Axum, epoll-based networking)
    │
    ├─ PUT request
    │   ├─ Compress (CPU, Tokio task)
    │   ├─ Encrypt (CPU, Tokio task)
    │   ├─ EC Encode (SIMD, Tokio task)
    │   └─ Write shards ──► io_uring instance (O_DIRECT, registered buffers)
    │                        ├─ SQE: write shard 0 to /dev/ng0n1
    │                        ├─ SQE: write shard 1 to /dev/ng1n1
    │                        ├─ SQE: write shard 2 to /dev/ng2n1
    │                        └─ single io_uring_enter() submits all
    │
    ├─ GET request
    │   ├─ Read shards ◄── io_uring instance (O_DIRECT, batched reads)
    │   ├─ EC Decode (SIMD)
    │   ├─ Decrypt (CPU)
    │   └─ Decompress (CPU)
    │
    └─ Metadata
        └─ Read/write meta ──► io_uring instance (buffered, page cache)
```

Each [NUMA node](/blog/pcie-lanes-numa-rust-storage) gets its own io_uring instances, pinned to local cores, handling I/O for locally-attached NVMe drives. The Tokio runtime handles networking, task scheduling, and CPU-bound work (compression, encryption, erasure coding). The two worlds communicate via channels.

This is not a compromise. It's using each tool where it's strongest: Tokio for networking and concurrency, io_uring for storage I/O, and neither SPDK nor the legacy `read()`/`write()` path for anything.

---

## Who Uses What: The Production Picture

### Ceph

Ceph added io_uring support for BlueStore in 2020 (PR #27392). Mark Nelson's benchmarks showed **+14% IOPS at 4K reads, +42% at 8K** versus libaio. However, io_uring remains experimental/optional in Ceph. The community assessment: "did not show significant benefit for BlueStore as I/O submission is not a bottleneck there." libaio remains the default. This tells you something important: for systems that are already bottlenecked elsewhere (Ceph's metadata operations, CRUSH calculation, PG peering), io_uring's I/O submission improvement doesn't move the needle.

### ScyllaDB / Seastar

Seastar added an io_uring reactor backend. ScyllaDB engineers reported io_uring was "a bit faster than linux-aio, but nothing revolutionary" for their use case. Initial benchmarks showed a ~4% regression in HTTP benchmarks due to runtime differences. Both backends (linux-aio and io_uring) are available at runtime. Like Ceph, ScyllaDB had already optimized heavily for linux-aio. The diminishing returns from io_uring are real for already-optimized systems.

### RocksDB

RocksDB uses io_uring for `MultiGet()` to parallelize reads from the same SST file. But it's disabled by default; you must set `ROCKSDB_USE_IO_URING=1`. The Java bindings don't support it at all. io_uring in RocksDB is a "nice to have," not a core architectural choice.

### ByteDance

ByteDance's monoio runtime powers production Rust gateways (Monolake) using io_uring. This is arguably the most aggressive production adoption of io_uring in Rust, and it's by a company processing enormous traffic volumes.

### The Pattern

The systems that benefit most from io_uring are those where **I/O submission is actually the bottleneck**. For systems already optimized with libaio, the improvement is incremental. For new systems that can design around io_uring from the start (batched submissions, registered buffers, direct I/O, NVMe passthrough), the improvement is transformative.

---

## When to Use What: A Decision Framework

```
Is I/O submission latency your measured bottleneck?
    │
    ├─ No → libaio or regular io_uring is fine. Optimize elsewhere.
    │
    └─ Yes ↓
         Are you building a new system or retrofitting?
             │
             ├─ Retrofitting → io_uring (basic) as drop-in libaio replacement.
             │                  10-40% IOPS improvement with minimal code change.
             │
             └─ New system ↓
                  Can you dedicate bare-metal nodes to storage?
                      │
                      ├─ Yes → io_uring with full optimization stack:
                      │        O_DIRECT, registered buffers, fixed files,
                      │        io_uring_cmd passthrough on NVMe-dense nodes.
                      │        80% of SPDK, 0% of the operational burden.
                      │
                      └─ No (containers/shared VMs) ↓
                           io_uring without SQPOLL/passthrough.
                           Check your seccomp profile.
                           Accept the security trade-offs or fall back to libaio.
```

And SPDK? Use SPDK when:
- You're building a **dedicated NVMe-oF target** (Mayastor pattern)
- You have a team of **10+ storage engineers** maintaining a custom stack
- You've **already optimized io_uring** and need the last 20% of IOPS
- You're willing to give up filesystem integration, kernel tooling, and cgroups

For everyone else, and I mean this literally, io_uring is the right answer. The 20% IOPS gap isn't worth the operational cost for any team that doesn't have dedicated kernel engineers on staff.

---

## The Trajectory

io_uring is getting faster with every kernel release. SPDK is not getting simpler.

The io_uring_cmd passthrough path already eliminates the block layer, which was the last major source of overhead between io_uring and SPDK. Future kernel work (zero-copy data paths, further reduction of per-I/O overhead, SQPOLL improvements) will continue to narrow the gap. The direction is clear: io_uring will asymptotically approach SPDK's performance while maintaining kernel integration.

SPDK, by contrast, has no path to reducing its operational complexity. Hugepages are fundamental to its DMA model. Dedicated cores are fundamental to its polling model. Device unbinding is fundamental to its user-space driver model. These aren't bugs to be fixed. They're architectural choices that can't be unwound.

The last argument for SPDK is absolute peak IOPS on dedicated hardware. That argument gets weaker every six months as io_uring adds another optimization. At some point, possibly kernel 7.x, possibly sooner, io_uring_cmd with registered buffers and kernel polling will match SPDK IOPS. When it does, SPDK's only remaining advantage is momentum.

And momentum is not a technical argument.

---

## Conclusion

The kernel bypass wars are over. Not because one side surrendered, but because the battlefield changed.

SPDK proved that the kernel I/O stack was the bottleneck. That was a necessary, valuable contribution. It demonstrated that NVMe hardware could deliver millions of IOPS if software got out of the way. But SPDK's solution (rip out the kernel entirely) creates an operational burden that limits its adoption to a handful of dedicated storage appliance teams.

io_uring took SPDK's lesson (the overhead is in the kernel path, not the device) and applied it differently: make the kernel path fast enough that bypassing it isn't worth the cost. Shared memory rings eliminate syscall overhead. SQPOLL eliminates submission overhead. `io_uring_cmd` eliminates block layer overhead. Registered buffers eliminate per-I/O page mapping. Each optimization closes a piece of the gap while preserving the kernel's infrastructure.

The result: io_uring delivers 80%+ of SPDK's IOPS with 0% of its operational burden. For a new storage system in 2026, the architecture is clear:

- io_uring with `O_DIRECT` and registered buffers for data I/O
- io_uring_cmd passthrough for NVMe-dense nodes
- Tokio/epoll for networking and concurrency
- SPDK for... well, benchmark blog posts

The kernel isn't the enemy. The syscall path was the enemy, and io_uring fixed it. Build on that.

---

*But fast I/O doesn't help if a [drive failure triggers a multi-hour rebuild](/blog/rebuild-time-crisis) that saturates every remaining disk in the cluster.*

---

*io_uring architecture and evolution from Jens Axboe's ["Efficient IO with io_uring"](https://kernel.dk/io_uring.pdf) and [liburing wiki](https://github.com/axboe/liburing/wiki). io_uring vs SPDK benchmarks from ["Performance Characterization of Modern Storage Stacks"](https://dl.acm.org/doi/10.1145/3578353.3589545) (CHEOPS '23, VU Amsterdam). NVMe passthrough performance from ["I/O Passthru: Upstreaming a flexible and efficient I/O Path in Linux"](https://www.usenix.org/conference/fast24/presentation/joshi) (USENIX FAST '24). DBMS benchmark from ["io_uring for High-Performance DBMSs"](https://arxiv.org/html/2512.04859v1) (arXiv, December 2024). SPDK CPU efficiency from ["SPDK+: Low Latency or High Power Efficiency?"](https://zhou-diyu.github.io/files/spdkp-hotstorage25.pdf) (HotStorage '25). Google io_uring security stance from [Phoronix reporting](https://www.phoronix.com/news/Google-Restricting-IO_uring) (June 2023). Curing rootkit from [ARMO research](https://www.armosec.io/blog/io_uring-rootkit-bypasses-linux-security/) (April 2025). Docker seccomp changes from [moby PR #46762](https://github.com/moby/moby/pull/46762). Ceph io_uring benchmarks from [Mark Nelson](https://markhpc.github.io/2020/10/29/Ceph-io_uring.html). ScyllaDB assessment from [ScyllaDB database internals](https://www.scylladb.com/2024/11/25/database-internals-working-with-io/). Rust `io-uring` crate from [crates.io](https://crates.io/crates/io-uring). Monoio from [ByteDance/monoio](https://github.com/bytedance/monoio). io_uring cancellation safety from [Tonbo engineering blog](https://tonbo.io/blog/async-rust-is-not-safe-with-io-uring). xNVMe NVMe passthrough from [xnvme.io](https://xnvme.io/). SNIA NVMe passthrough presentation from [SDC 2023](https://www.snia.org/educational-library/xnvme-and-iouring-nvme-passthrough-what-does-it-mean-spdk-nvme-driver-2023) and [SDC 2025](https://www.sniadeveloper.org/austin/agenda/session/553).*
