---
title: "NVMe-oF: The Promise, The Pain, and What Actually Works in 2026"
date: 2026-04-07
description: "NVMe over Fabrics was supposed to make remote flash indistinguishable from local flash. Six years in, TCP added latency nobody budgeted for, RDMA requires a network engineering PhD, and half the industry is deploying NVMe-oF without understanding what they're buying."
tags: ["storage", "nvme", "networking", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/network-fiber.jpg"
readTime: "18 min read"
---

![NVMe over Fabrics networking](/images/blog/network-fiber.jpg)

*NVMe over Fabrics was supposed to make remote flash indistinguishable from local flash. Six years in, the reality is messier: TCP added latency that nobody budgeted for, RDMA requires a network engineering PhD, and half the industry is deploying NVMe-oF without understanding what they're buying. Here's what actually works, what quietly doesn't, and what you should bet on for the next five years.*

---

## The Promise That Launched a Thousand Slides

The pitch was irresistible.

Local NVMe is fast: 10 microseconds for a 4KB random read, 7 GB/s sequential bandwidth on a single PCIe Gen4 x4 drive. But local NVMe has a problem: the drives are trapped inside the server. If Server A has idle flash capacity and Server B is starving for I/O, tough luck. You can't share local NVMe across a network the way you share a SAN LUN or an NFS export.

NVMe over Fabrics, ratified by NVM Express in 2016, proposed the fix: extend the NVMe protocol over a network fabric so that remote drives appear as if they're locally attached. Same NVMe command set. Same multi-queue architecture (65,535 queues, 65,536 commands each). Same sub-millisecond ambition. Just... over a wire instead of a PCIe bus.

The architecture diagrams wrote themselves:

```
┌─────────────────────────────────────────────┐
│            Compute Pool (Initiators)        │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐   │
│  │ GPU  │  │ GPU  │  │ GPU  │  │ GPU  │   │
│  │Node 1│  │Node 2│  │Node 3│  │Node N│   │
│  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘   │
│     │         │         │         │        │
│ ════╪═════════╪═════════╪═════════╪══════  │
│     │     NVMe-oF Fabric (RDMA/TCP)        │
│ ════╪═════════╪═════════╪═════════╪══════  │
│     │         │         │         │        │
│  ┌──▼───┐  ┌──▼───┐  ┌──▼───┐  ┌──▼───┐   │
│  │Flash │  │Flash │  │Flash │  │Flash │   │
│  │JBOF 1│  │JBOF 2│  │JBOF 3│  │JBOF M│   │
│  │24xSSD│  │24xSSD│  │24xSSD│  │24xSSD│   │
│  └──────┘  └──────┘  └──────┘  └──────┘   │
│             Storage Pool (Targets)          │
└─────────────────────────────────────────────┘
```

Compute and storage scale independently. Any GPU node can access any flash shelf. Add more GPUs without adding more storage, or vice versa. This is disaggregation: the architectural pattern that every infrastructure vendor has been promising since 2018.

The promise: **less than 10 microseconds of additional latency over RDMA**. Remote NVMe that "feels local."

Here's what actually happened.

---

## The Three Transports: A Tale of Trade-offs

NVMe-oF is not one protocol. It's a command set that runs over multiple transports, and the transport you choose determines whether you get the promise or the pain.

### Transport 1: RDMA (RoCEv2 and InfiniBand)

RDMA (Remote Direct Memory Access) lets one machine read from or write to another machine's memory without involving either CPU. No kernel, no socket buffer copies, no TCP stack. Data moves directly from NIC to application memory via hardware-managed queue pairs.

**The performance is real.** RDMA over InfiniBand adds 2-5 microseconds to an NVMe I/O. RoCEv2 (RDMA over Converged Ethernet) adds 5-10 microseconds. At these latencies, remote NVMe genuinely starts to feel local. A 4KB random read that takes 10us locally takes 15us over RoCEv2. That's a 50% latency increase on paper, but in absolute terms, 15 microseconds is still screaming fast.

**InfiniBand** is the simpler path. It's a dedicated fabric: InfiniBand switches, InfiniBand HCAs (Host Channel Adapters), InfiniBand cables. The network is purpose-built for RDMA and has been doing it reliably since the early 2000s. NVIDIA's ConnectX adapters and Quantum switches dominate this market. In HPC and AI clusters, InfiniBand is already there for GPU-to-GPU communication, so extending it to storage is natural.

Latency is exceptional. Bandwidth is exceptional. The catch is that you need a separate network. InfiniBand doesn't converge with your Ethernet management network, your out-of-band network, or anything else. It's a parallel universe of cabling and switching.

**RoCEv2** tries to get InfiniBand's performance on Ethernet infrastructure. Same RDMA semantics, same ConnectX adapters, but over standard Ethernet switches. This is where the pain begins.

RDMA assumes a lossless fabric. Drop a single packet and the RDMA connection stalls or resets. Unlike TCP, which gracefully retransmits, RDMA has no tolerance for loss. Ethernet, by design, drops packets when congested. To make RoCEv2 work, you need:

- **PFC (Priority Flow Control):** Per-priority pause frames that prevent buffer overflow. Sounds great. In practice, PFC creates head-of-line blocking, pause storms that cascade across switches, and deadlocks in networks with cycles. Arista, Cisco, and Mellanox have all published white papers on how to configure PFC correctly. The fact that these white papers exist, and that they're 40+ pages long, tells you everything about the difficulty.

- **ECN (Explicit Congestion Notification):** Marks packets when queues build up, so senders can back off before drops occur. Requires ECN support on every switch in the path, correct threshold configuration, and a DCQCN (Data Center QCN) congestion control algorithm on the endpoints. Misconfigure the ECN marking threshold by 20% and you get either premature throttling (wasted bandwidth) or late marking (packet drops, RDMA failures).

- **DSCP-based QoS:** Traffic classification to separate RDMA traffic from regular Ethernet traffic. Different queues, different priorities, different scheduling. On every switch. Consistently.

I've seen teams spend six months getting RoCEv2 stable on a 100-switch leaf-spine fabric. They hire a network consultant, reconfigure every switch, run ib_send_bw and ib_read_lat tests on every link, and eventually get it working. Then someone adds a new ToR switch with slightly different firmware and the pause storms return.

**The dirty secret of RoCEv2:** it works beautifully in controlled environments. A single rack with two leaf switches and homogeneous hardware? Flawless. A 500-node cluster with three tiers of switching from two vendors? Budget six months of network engineering and keep the consultant on retainer.

### Transport 2: NVMe/TCP

NVMe/TCP, standardized in 2019 (TP8000), does the obvious thing: encapsulate NVMe commands in TCP segments and send them over standard Ethernet. No special NICs, no lossless fabric, no RDMA configuration. If you have an Ethernet network, you can run NVMe/TCP.

**The latency reality:**

| Operation | Local NVMe | NVMe/RDMA (RoCEv2) | NVMe/TCP | iSCSI |
|-----------|-----------|-------------------|----------|-------|
| 4KB random read | ~10 us | ~15-20 us | ~40-80 us | ~100-200 us |
| 128KB sequential read | ~15 us | ~20-25 us | ~50-90 us | ~120-250 us |
| 4KB random write | ~15 us | ~20-30 us | ~50-100 us | ~150-300 us |

NVMe/TCP adds 30-80 microseconds of latency, depending on network conditions, CPU load, and how many TCP connections you're multiplexing. That's 3-8x the overhead of RDMA. "Feels local" it does not.

But here's the thing: **NVMe/TCP is still 2-5x faster than iSCSI**, the protocol it replaces. And it runs on the network you already have. No PFC configuration. No lossless fabric. No network consultant. Install the `nvme-tcp` kernel module, point it at a target, and go.

For bulk data transfer (model checkpoint writes, dataset pre-staging, asynchronous replication), 50 microseconds of latency per I/O is perfectly acceptable. You're streaming gigabytes; the throughput matters more than the per-I/O latency. At 100 GbE, NVMe/TCP saturates the link just fine.

**Where NVMe/TCP breaks down:**

The CPU cost. TCP processing is not free. Each NVMe/TCP connection consumes CPU cycles for segmentation, checksumming, and retransmission. At high IOPS (500K+), the host CPU spends significant cycles just running the TCP stack. This is precisely the overhead that RDMA eliminates.

Then there's tail latency. TCP retransmission on packet loss adds milliseconds (the default RTO minimum is 200ms on Linux, though this can be tuned). RoCEv2 on a properly configured lossless fabric never retransmits; it pauses instead. For latency-sensitive workloads, a single TCP retransmission blows your P99.

**TCP offload is changing the calculus.** Modern NICs (ConnectX-7, Intel E810) offer NVMe/TCP hardware offload that moves the TCP state machine into the NIC firmware. Early benchmarks show offloaded NVMe/TCP approaching within 2x of RDMA latency at significantly reduced CPU consumption. This is the technology to watch. If NIC-offloaded NVMe/TCP can deliver 20-30us latency with near-zero CPU overhead, the case for RoCEv2's complexity weakens considerably.

### Transport 3: FC-NVMe

Fibre Channel NVMe runs NVMe commands over Fibre Channel fabrics. If you have an existing FC SAN infrastructure (many enterprises do, as banks, hospitals, and government agencies have invested millions), FC-NVMe lets you modernize the protocol without replacing the physical network.

**The reality:** FC-NVMe works well in existing FC environments. The latency is between RDMA and TCP (roughly 15-30us). The fabric management tools (Brocade FOS, Cisco MDS NX-OS) already handle zoning, multipath, and QoS. It's a natural evolution for FC shops.

**The trajectory:** FC-NVMe is a bridge technology. New greenfield deployments overwhelmingly choose Ethernet (either RoCEv2 or TCP). FC-NVMe extends the life of existing FC investments, but FC's market share has been declining for a decade and NVMe/TCP accelerates that decline. Gen7 FC at 64 Gb/s is competitive with 100 GbE today, but 400 GbE and 800 GbE are already shipping while FC Gen8 (128 Gb/s) is still in development.

---

## Discovery, Multipath, and the Operational Reality

Choosing a transport is just the beginning. Once you have NVMe-oF connectivity, you need to solve three operational problems that don't exist with local NVMe.

### Discovery: How Do Initiators Find Targets?

Local NVMe is simple: the kernel scans the PCIe bus, finds NVMe controllers, creates `/dev/nvmeXnY` devices. Done.

NVMe-oF requires explicit discovery. The initiator must know where the targets are. Three mechanisms exist:

**Static configuration.** Hardcode target IP/port in `/etc/nvme/discovery.conf` or systemd unit files. Simple, brittle. Every time you add or move a storage target, you update every initiator's config. This is how most deployments start, and how many still operate. It doesn't scale past a few dozen nodes.

**Discovery Controller.** The NVMe spec defines a Discovery Controller service that initiators query to learn available subsystems and paths. The initiator connects to a well-known discovery endpoint, receives a list of (transport, address, subsystem NQN) tuples, and connects to the ones it needs. This is the right answer, but implementing a production-quality Discovery Controller requires handling registration, deregistration, health checks, access control, and multipath advertisement. Most open-source implementations are basic.

**mDNS/DNS-SD.** Draft spec for automatic discovery via multicast DNS. The "zero-configuration" dream. Not widely implemented yet, and multicast in large data center networks is a governance headache.

**TP8009 (Centralized Discovery Controller).** Ratified in 2022, CDC adds a persistent, centralized discovery service that can manage thousands of initiator-target relationships. Think of it as DNS for NVMe-oF. This is what production deployments need, but adoption is still early. Linux kernel support landed in 6.x, and SPDK has an implementation, but the ecosystem tooling (monitoring, RBAC, federation) is immature.

### Multipath: Surviving Failures

In a local NVMe setup, the drive either works or it doesn't. With NVMe-oF, the drive might be fine but the *network path* to it fails. Multipath means connecting to the same NVMe namespace through multiple independent network paths, so a single link or switch failure doesn't cause an outage.

**ANA (Asymmetric Namespace Access)** is the NVMe spec's answer. Each path to a namespace has an ANA state: Optimized, Non-Optimized, or Inaccessible. The host prefers Optimized paths and fails over to Non-Optimized paths when Optimized paths go down. This is analogous to ALUA (Asymmetric Logical Unit Access) in SCSI, and if you've configured ALUA multipath with `multipathd`, you know both the power and the misery.

**Linux native multipath** (`nvme-core.multipath=Y` kernel parameter) handles path selection in the kernel. It works. Failover times range from sub-second (when the failure is clean, like a TCP RST or an ANA state change notification) to 30+ seconds (when the failure is ambiguous, where a path goes silent and the transport timeout must expire before failover triggers).

**The timeout problem.** NVMe/TCP's default `ctrl-loss-tmo` is 600 seconds. That means if a controller becomes unreachable, the host will retry for *ten minutes* before declaring the path dead. For many workloads, ten minutes of I/O stalls is indistinguishable from an outage. Tuning these timeouts (`ctrl-loss-tmo`, `reconnect-delay`, `keep-alive-tmo`, `nr-io-queues`) is an art that most deployment guides gloss over.

Here's a set of timeouts that works for latency-sensitive workloads:

```
# /etc/nvme/discovery.conf or nvme connect parameters
--ctrl-loss-tmo=30       # give up after 30s, not 600s
--reconnect-delay=2      # retry every 2s, not 10s
--keep-alive-tmo=5       # detect controller death in 5s
--nr-io-queues=8         # match to CPU cores serving I/O
--nr-write-queues=4      # separate write queue pool
```

These values are aggressive. They trade resilience (a brief network hiccup triggers failover) for responsiveness (the application knows within seconds, not minutes). The right values depend on your tolerance for false positives.

### Zoning and Security: The "See Everything" Problem

SAN administrators recognized this problem in 1999, and NVMe-oF is only now solving it.

By default, an NVMe-oF initiator that discovers a target can access *every namespace* on that target. There's no isolation. In a multi-tenant environment, or even in a single-tenant environment where different teams own different storage pools, this is a security hole.

**NVMe subsystem NQN-based access control** is the basic mechanism: the target defines which initiator NQNs (NVMe Qualified Names) are allowed to connect to which subsystems. This is the equivalent of FC LUN masking, and it works, but it's per-subsystem, not per-namespace. Fine-grained isolation requires one subsystem per tenant, which adds management overhead.

**TLS 1.3 for NVMe/TCP** (TP8011) adds encryption and authentication to the transport. Without it, NVMe/TCP traffic flows in cleartext, and any network tap sees your data. With TLS, you get encrypted transport plus certificate-based authentication. Linux kernel support is available as of 6.7, and SPDK added TLS support in 24.01. The performance impact is meaningful: expect 10-15% throughput reduction with software TLS, less with NIC-offloaded TLS.

**In-band authentication** (TP8010, DH-HMAC-CHAP) provides challenge-response authentication at the NVMe protocol level, independent of the transport. This matters for RDMA, where TLS isn't applicable (RDMA bypasses the TCP stack entirely). DH-HMAC-CHAP with DH group negotiation provides reasonable security without transport-level encryption.

The honest assessment: NVMe-oF security in 2026 is roughly where iSCSI security was in 2008. It exists, it works, and almost nobody enables it because the performance cost feels unjustifiable in a trusted data center network. Then someone plugs a rogue device into the fabric and you have a very bad day.

---

## What Works Today

Let's be specific about where NVMe-oF is deployed in production and delivering value.

### All-Flash Arrays

Pure Storage FlashArray, NetApp AFF, Dell PowerStore, and VAST Data all expose NVMe-oF front-end connectivity. These are traditional storage arrays that replaced FC-SCSI or iSCSI with NVMe-oF as the host-facing protocol.

**Why it works:** The array handles all the complexity. Discovery, multipath, namespace management, zoning: it's all managed by the array's control plane. The host just runs `nvme connect` and gets a block device. The operational model is identical to a traditional SAN, just faster.

**The win:** 2-5x IOPS improvement over iSCSI on the same hardware, with lower CPU utilization on the host. For database workloads (Oracle, SQL Server, PostgreSQL) that are latency-sensitive and IOPS-hungry, this is a genuine, measurable improvement.

### NVIDIA DGX and AI Clusters

NVIDIA's DGX SuperPOD reference architecture uses NVMe-oF (over InfiniBand) to connect GPU nodes to shared flash storage tiers. The BlueField DPU acts as both the NVMe-oF target (serving local NVMe drives to the fabric) and the initiator (consuming remote namespaces).

**Why it works:** InfiniBand is already there. DGX clusters run InfiniBand for NCCL (GPU-to-GPU communication), so extending it to storage adds no new infrastructure. BlueField handles NVMe-oF target/initiator duties in hardware, offloading the host CPU entirely. And NVIDIA controls the entire stack (DPU firmware, ConnectX drivers, DOCA SDK, Dynamo framework), so interoperability is tested by one vendor.

This is the most compelling NVMe-oF deployment model in 2026: AI clusters where InfiniBand is a given, BlueField handles the storage fabric, and the performance requirements (feeding 8x H100/B200 GPUs with training data) justify the infrastructure investment.

### Hyperscaler Internal Infrastructure

AWS EBS, Google Persistent Disk, and Azure Managed Disk all use NVMe-oF internally to connect compute instances to remote storage. When you attach an EBS volume to an EC2 instance, the NVMe device you see in the guest is backed by NVMe-oF over the hyperscaler's custom fabric.

**Why it works:** Hyperscalers control the switch firmware, the NIC firmware, the host kernel, and the storage backend. They can build lossless Ethernet fabrics with custom congestion control algorithms (AWS's SRD, Google's Snap) that wouldn't work in a heterogeneous enterprise network. They can also deploy at a scale where the engineering investment amortizes to pennies per instance.

You can't replicate this. But it's worth knowing that NVMe-oF at scale *does* work, if you control every layer of the stack.

---

## What Doesn't Work (Yet)

### General-Purpose Disaggregated Storage

The dream: separate compute and storage into independent pools. Scale each independently. Any compute node accesses any storage node over NVMe-oF.

**Why it doesn't work yet:**

**Tail latency.** NVMe-oF adds a latency distribution, not a fixed overhead. The median is acceptable, but the P99 and P999 include TCP retransmissions, RDMA path failovers, and congestion events that add milliseconds. For workloads that are tolerant of tail latency (batch analytics, training data reads), this is fine. For workloads that aren't (OLTP databases, real-time serving), it's a deal-breaker.

**Blast radius.** A network partition in a disaggregated architecture can make storage inaccessible to every compute node simultaneously. With locally-attached storage, a network failure affects only network-dependent workloads, and local I/O continues. Full disaggregation means full dependency on the fabric.

**Complexity cost.** Running a disaggregated NVMe-oF fabric requires expertise in NVMe target management, fabric zoning, multipath configuration, timeout tuning, performance monitoring (which latencies are NVMe, which are fabric, which are congestion?), and capacity planning across the fabric. Most organizations don't have this expertise, and the tooling to make it accessible doesn't exist yet.

The organizations that successfully run disaggregated NVMe-oF in 2026 are hyperscalers and HPC centers with dedicated storage networking teams. Everybody else is doing DAS or hyper-converged.

### Cross-Datacenter NVMe-oF

NVMe-oF over a WAN doesn't work. The protocol was designed for data center fabrics with microsecond-scale RTTs. At 10ms WAN latency, the NVMe queuing model breaks down. You need thousands of outstanding commands to keep throughput high, but the NVMe/TCP connection stalls on flow control long before that.

Replication between data centers should use application-level protocols (HTTP, gRPC, custom replication streams), not NVMe-oF. This seems obvious, but I've seen it in vendor presentations: "NVMe-oF for DR replication." No.

### Multi-Tenant NVMe-oF Fabrics

Running multiple tenants on a shared NVMe-oF fabric requires per-tenant isolation (separate NQNs, access control, bandwidth guarantees), per-tenant QoS (one tenant's sequential scan shouldn't destroy another's IOPS-sensitive workload), and per-tenant monitoring. The NVMe spec supports some of this (NVMe rate limiting, namespace-level QoS), but the tooling, orchestration, and operational practices are years behind what FC SANs offer.

Kubernetes persistent volumes over NVMe-oF (via the NVMe-oF CSI driver) are emerging, but they add another layer of abstraction on top of an already complex stack. Getting PV failover, resize, and snapshot operations working reliably through Kubernetes, CSI, NVMe-oF, and the target is a test of patience.

---

## The Software Stack: Kernel vs. SPDK

NVMe-oF targets (the storage side) can run in-kernel or in user-space. The choice matters more than most people think.

### Linux Kernel NVMe-oF Target (nvmet)

The kernel's `nvmet` subsystem implements NVMe-oF targets using standard kernel block devices as backing stores. It's included in mainline Linux, requires no additional software, and supports all three transports (RDMA, TCP, FC).

**Pros:** Simple to set up. Uses standard kernel block devices, so any filesystem, LVM, or device-mapper setup works as a backend. Integrates with kernel block layer features (QoS, cgroups, dm-crypt). Operational tools (`nvmetcli`, `configfs`) are straightforward.

**Cons:** Performance is limited by the kernel block layer overhead. At high IOPS (1M+), the CPU cost of crossing the kernel block layer for each I/O becomes significant. TCP transport performance is particularly affected, as both the NVMe target processing and TCP stack run in kernel context, competing for CPU.

**Real-world performance:** A single `nvmet` TCP target serving 8 NVMe drives can deliver roughly 600K-800K IOPS on a modern dual-socket server. For many workloads, this is plenty. For an all-flash array or a dedicated storage node serving a GPU cluster, it's the bottleneck.

### SPDK NVMe-oF Target

SPDK runs the NVMe-oF target entirely in user-space. NVMe drives are unbound from the kernel, and both the NVMe backend and the NVMe-oF transport (RDMA or TCP) run in polled mode on dedicated cores.

**Pros:** Performance. SPDK's NVMe-oF target delivers 2-4x the IOPS of the kernel target at lower and more consistent latency. For TCP transport, SPDK uses its own user-space TCP stack (POSIX sockets or DPDK-based), avoiding the kernel TCP overhead.

**Cons:** Everything I described in the [io_uring and SPDK piece](/blog/io-uring-spdk-kernel-bypass). Dedicated cores, hugepage memory, no filesystem, no kernel tooling. The operational complexity is significant.

**Who uses it:** Storage vendors building NVMe-oF appliances (Lightbits, E8 Storage/VAST Data, Samsung SmartSSD), and hyperscalers running custom storage backends. If you're building a storage *product*, SPDK makes sense. If you're running a storage *service* on general-purpose infrastructure, the kernel target is the pragmatic choice.

### The Middle Path: io_uring-Based Targets

The emerging third option is an NVMe-oF target built on [io_uring for backend I/O](/blog/io-uring-spdk-kernel-bypass) with kernel TCP or RDMA for the fabric transport. This keeps the drives in kernel space (operational tooling works), uses io_uring's async I/O for near-SPDK backend performance, and avoids SPDK's dedicated-core requirement.

No production-ready open-source implementation exists yet, but this is the architectural direction that makes the most sense for software-defined storage projects. The kernel `nvmet` target is slowly gaining io_uring integration, and several startups are building user-space targets on io_uring.

---

## The Ethernet Speed Ladder: When TCP Stops Losing

There's a subtle dynamic that most NVMe-oF discussions miss: **the latency gap between RDMA and TCP narrows as Ethernet speeds increase.**

Here's why. NVMe/TCP's overhead has two components: protocol processing (serializing NVMe commands into TCP segments, checksumming, managing connections) and serialization delay (the time to put bits on the wire).

At 25 GbE, serializing a 4KB NVMe command + data payload takes about 1.3 microseconds. At 100 GbE, it takes 0.3 microseconds. At 400 GbE, it takes 0.08 microseconds. The serialization delay is shrinking toward zero.

Protocol processing overhead is relatively constant (a few microseconds for software TCP, sub-microsecond for NIC-offloaded TCP). As serialization delay becomes negligible, the gap between TCP and RDMA compresses to just the protocol processing difference.

| Ethernet Speed | NVMe/TCP 4KB Latency (sw) | NVMe/TCP 4KB Latency (offload) | NVMe/RDMA 4KB Latency |
|---------------|--------------------------|-------------------------------|----------------------|
| 25 GbE | ~60-80 us | ~35-50 us | ~10-15 us |
| 100 GbE | ~40-60 us | ~20-35 us | ~8-12 us |
| 200 GbE | ~30-50 us | ~15-25 us | ~7-10 us |
| 400 GbE | ~25-40 us | ~10-20 us | ~5-8 us |

At 400 GbE with TCP offload, the gap between TCP and RDMA is 2x or less. Still measurable, but for bulk transfer workloads (streaming training data, checkpoint writes, replication), the difference is academic. You save the six months of lossless Ethernet configuration and the network consultant's fees.

This is why I believe **NVMe/TCP with NIC offload will be the dominant NVMe-oF transport by 2028** for all workloads except ultra-low-latency database access. RDMA will remain important for InfiniBand-based AI clusters where it's already deployed, but new Ethernet-based deployments will increasingly choose TCP + offload over the operational burden of RoCEv2.

---

## CXL vs. NVMe-oF: Complementary, Not Competing

A question I hear frequently: "Does CXL replace NVMe-oF?"

No. They operate at different scales and different latency tiers.

**CXL (Compute Express Link)** is a PCIe-based coherency protocol designed for rack-scale interconnect. CXL 3.0 supports fabric switching, but the target distance is short: meters, not hundreds of meters. CXL latency for memory access is 150-300 nanoseconds, an order of magnitude faster than NVMe-oF. CXL is for sharing memory and metadata *within* a rack or a few racks connected by a CXL switch fabric.

**NVMe-oF** operates at pod and cluster scale: tens to hundreds of meters over Ethernet or InfiniBand. Latency is microseconds to tens of microseconds. NVMe-oF is for accessing storage *across* a data center.

The architecture that emerges combines both:

```
┌─────────────────────────────────────┐
│          Within a Rack              │
│  CXL 3.0 fabric: 150-300ns         │
│  Shared metadata, pooled memory     │
│  Cache-coherent access across hosts │
├─────────────────────────────────────┤
│          Within a Pod (10-100m)     │
│  NVMe-oF RDMA: 5-15us              │
│  Disaggregated flash access         │
│  Shared storage pools               │
├─────────────────────────────────────┤
│          Within a DC (100m-2km)     │
│  NVMe/TCP: 30-80us                 │
│  Bulk data transfer, replication    │
│  Tiered storage access              │
├─────────────────────────────────────┤
│          Across DCs (WAN)           │
│  HTTP/S3: milliseconds             │
│  Replication, DR, cross-region      │
│  Object storage as durable tier     │
└─────────────────────────────────────┘
```

Each protocol owns a latency tier and a distance budget. Trying to stretch any one of them outside its tier produces misery: CXL across a data center doesn't work (distance), NVMe-oF across a WAN doesn't work (latency), and S3 for low-latency local access doesn't work (overhead).

The storage software that wins is the one that speaks all four tiers and places data in the right one based on access patterns. Model weights that haven't been accessed in a week live in S3 (object storage). Model weights being loaded for inference pre-stage via NVMe-oF to a local JBOF. KV cache metadata is coordinated via CXL shared memory. Active KV cache lives in GPU HBM. Each tier serves its purpose.

---

## What Storage Software Needs to Change

Most storage software was designed for either local disks or TCP-based network protocols (NFS, iSCSI, S3). NVMe-oF introduces requirements that break assumptions baked into every layer.

### Connection Management

A traditional NFS client maintains one or a few TCP connections to a server. An iSCSI initiator manages a small number of sessions. NVMe-oF, by contrast, creates multiple I/O queues per connection (typically one per CPU core), and each queue can have thousands of outstanding commands.

Storage software needs to manage these queue resources explicitly: allocating the right number of I/O queues based on workload, monitoring per-queue depth and latency, and rebalancing when paths change. Over-allocating queues wastes target resources. Under-allocating leaves performance on the table.

### NUMA-Aware Path Placement

On a dual-socket server, NVMe-oF connections land on a specific NIC, which is attached to a specific PCIe root complex, which is local to a specific NUMA node. If the application thread processing I/O completions runs on the *other* NUMA node, every completion incurs a cross-socket memory access (an extra 100-200 nanoseconds per I/O). For a deeper dive into PCIe topology and NUMA effects on storage, see the [PCIe lanes and NUMA-aware storage](/blog/pcie-lanes-numa-rust-storage) post.

At local NVMe speeds, this doesn't matter much. At NVMe-oF speeds, where you're fighting for every microsecond, cross-NUMA completions can add 10-15% latency. Storage software should pin NVMe-oF I/O processing to cores on the same NUMA node as the NIC.

### Timeout Tuning

As discussed above, default NVMe-oF timeouts are conservative (600 seconds for controller loss). Storage software that builds on NVMe-oF must expose and intelligently manage these timeouts, because the right values depend on the workload's tolerance for stalls versus false failovers.

For AI training workloads (where a 30-second I/O stall means wasted GPU-hours at thousands of dollars per hour), aggressive timeouts with fast failover are essential. For database workloads (where a false failover can cause split-brain or data corruption), conservative timeouts are safer.

### Performance Monitoring

"The storage is slow" is no longer a simple diagnosis. With NVMe-oF, latency has three components:

1. **Target-side device latency.** The NVMe drive itself. Usually 10-20us for reads.
2. **Fabric latency.** Network transit time, including serialization, switching, and any congestion. Depends on transport (5us for RDMA, 30-80us for TCP).
3. **Host-side processing latency.** Kernel or SPDK command processing, memory copies, interrupt handling.

Diagnosing a latency regression requires decomposing total latency into these components. NVMe-oF provides some help: the NVMe-oF target can stamp commands with target-side completion time, and the host can measure round-trip time. The difference is fabric + host processing. But standard monitoring tools (iostat, blktrace) don't distinguish these components, and most storage observability stacks need new instrumentation.

---

## What to Bet On

If you're making NVMe-oF decisions in 2026, here's the practical guidance:

**If you already have InfiniBand (AI/HPC clusters):** Use NVMe-oF over InfiniBand. You have the fabric, the NICs, and the expertise. Add NVMe-oF targets to your existing fabric. This is the lowest-risk, highest-performance option.

**If you're building new Ethernet infrastructure:** Start with NVMe/TCP. Get it working, get it monitored, get your timeout tuning right. Plan for NIC-offloaded TCP as the performance upgrade path. Only invest in RoCEv2 if you have a specific latency requirement that TCP can't meet AND you have the network engineering team to maintain a lossless fabric.

**If you have an existing FC SAN:** FC-NVMe is a natural upgrade. Same fabric, faster protocol. Don't rip out FC to build an Ethernet NVMe-oF fabric unless you have a compelling reason beyond protocol modernization.

**If you're building storage software:** Abstract the transport. Your storage engine should not care whether the backend is local NVMe, NVMe-oF over RDMA, NVMe-oF over TCP, or a remote S3 endpoint. Use an `IoEngine` trait (or equivalent) that abstracts read/write/trim operations, and let deployment configuration choose the transport. Test against all of them. Your users' infrastructure is heterogeneous even if yours isn't.

**If you're evaluating disaggregation:** Be skeptical. The architecture diagrams are beautiful, but the operational reality is 10x more complex than DAS or hyper-converged. Start with a single-rack proof of concept. Measure tail latency, not just median latency. Test failure scenarios: what happens when a switch goes down, when a path flaps, when a target reboots during heavy I/O? If the answers are acceptable, scale cautiously.

---

## The Honest Summary

NVMe-oF is real infrastructure solving real problems. It's not vaporware, and it's not just benchmarks. All-flash arrays with NVMe-oF front ends are measurably faster than iSCSI. AI clusters with InfiniBand NVMe-oF are feeding GPUs effectively. Hyperscalers run their entire block storage stack on NVMe-oF at billions of IOPS.

But the gap between "NVMe-oF works" and "NVMe-oF feels local" is still wide for most organizations. TCP adds real latency. RDMA adds real complexity. Discovery and multipath tooling is immature. Security is an afterthought. And the operational expertise required to run a production NVMe-oF fabric is significantly higher than what most teams have.

The trajectory is positive. NIC-offloaded TCP is narrowing the RDMA gap. Centralized discovery controllers are maturing. The kernel NVMe-oF stack improves with every release. Five years from now, NVMe-oF over TCP will be as unremarkable as iSCSI is today, standard infrastructure that just works.

But we're not there yet. In 2026, NVMe-oF is a technology that rewards expertise and punishes assumptions. The promise is real. The pain is real too. The winners are the teams that understand both.

---

*NVMe-oF specifications are maintained by [NVM Express, Inc.](https://nvmexpress.org/developers/nvme-of-specification/) NVMe-oF transport specs: TP8000 (TCP), TP8010 (In-Band Authentication), TP8011 (TLS), TP8009 (Centralized Discovery Controller). Linux kernel NVMe-oF documentation at [kernel.org](https://docs.kernel.org/nvme/index.html). SPDK NVMe-oF target documentation at [spdk.io](https://spdk.io/doc/nvmf.html). SNIA NVMe-oF interoperability testing conducted at [SNIA Plugfest](https://www.snia.org/plugfest) events. NVIDIA BlueField DPU NVMe-oF capabilities at [NVIDIA DOCA documentation](https://docs.nvidia.com/doca/). Latency measurements cited from VU Amsterdam CHEOPS '23, Samsung PM9A3 data sheets, and published NVMe/TCP benchmarks from Lightbits Labs and Samsung.*
