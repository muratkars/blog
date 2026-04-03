---
title: "The Rebuild Time Crisis: Why 100TB Drives Will Break Your Storage System"
date: 2026-03-26
description: "Drive capacities are growing exponentially. Rebuild speeds aren't. A 20TB HDD rebuild takes 2-5 days. A 60TB HDD takes 6-9 days. The storage industry's dirty secret: RAID and traditional erasure coding were designed for drives that rebuild in minutes, not days."
tags: ["storage", "durability", "erasure-coding", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/rebuild-time-crisis.png"
readTime: "20 min read"
---

![The rebuild time crisis](/images/blog/rebuild-time-crisis.png)

*Drive capacities are growing exponentially. Rebuild speeds aren't. A 20TB HDD rebuild takes 2-5 days. A 60TB HDD rebuild takes 6-9 days. A 122TB QLC SSD, already shipping, takes 5-14 hours even on NVMe Gen4. During every hour of that rebuild window, a second drive failure means data loss. The storage industry's dirty secret: RAID and traditional erasure coding were designed for drives that rebuild in minutes, not days. We're still using those designs. The drives moved on.*

---

## The Math That Kills

There are two trend lines in storage, and they're diverging catastrophically.

**Drive capacity is exponential.** HDD capacity doubles roughly every 3-4 years: 1TB in 2007, 10TB in 2015, 20TB in 2020, 30TB in 2024, 36TB in 2025. Seagate's HAMR roadmap targets 50TB by 2028 and 100TB by 2030. SSDs are worse: QLC NAND is pushing past HDDs in raw capacity. Solidigm shipped a 122TB QLC SSD (D5-P5336) in Q1 2025. They've confirmed 245TB for late 2026. Samsung showed a 128TB-class BM1743 at FMS 2024. The 200TB+ SSD is not a question of if, but when.

**Rebuild speed is linear.** HDD sequential throughput has been flat at 200-250 MB/s for over a decade. A 2015 HDD and a 2025 HDD read at roughly the same rate; the platters spin at 7200 RPM regardless of capacity. NVMe SSDs are faster (7 GB/s for Gen4, 14 GB/s for Gen5), but sustained rebuild throughput is 30-50% of peak because foreground I/O competes for the same drive bandwidth.

The result is a chart shaped like an opening jaw:

```
Capacity          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ → exponential
                  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                  ▓▓▓▓▓▓▓▓▓▓
                  ▓▓▓▓▓▓
                  ▓▓▓▓
Throughput        ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ → flat
                  2007    2015    2020    2025    2030
```

Rebuild time equals capacity divided by throughput. Capacity grows exponentially. Throughput grows linearly (for SSDs) or not at all (for HDDs). The rebuild window, the hours during which your data is running on reduced redundancy, is growing without bound.

---

## The Rebuild Time Table

Let me be precise. These are calculated rebuild times at realistic sustained throughput (30-50% of max drive speed, accounting for competing foreground I/O):

### HDD (at 75-125 MB/s sustained rebuild throughput)

| Drive Capacity | Optimistic (125 MB/s) | Pessimistic (75 MB/s) |
|---------------|----------------------|---------------------|
| 20 TB | 44 hours (1.9 days) | 74 hours (3.1 days) |
| 30 TB | 67 hours (2.8 days) | 111 hours (4.6 days) |
| 36 TB | 80 hours (3.3 days) | 133 hours (5.6 days) |
| 60 TB | 133 hours (5.6 days) | 222 hours (9.3 days) |
| 100 TB | 222 hours (9.3 days) | 370 hours (15.4 days) |

### NVMe SSD (at 2.5-5 GB/s sustained rebuild throughput)

| Drive Capacity | NVMe Gen5 (5 GB/s) | NVMe Gen4 (2.5 GB/s) |
|---------------|--------------------|--------------------|
| 30 TB | 1.7 hours | 3.3 hours |
| 60 TB | 3.3 hours | 6.7 hours |
| 122 TB | 6.8 hours | 13.6 hours |
| 200 TB | 11.1 hours | 22.2 hours |
| 245 TB | 13.6 hours | 27.2 hours |

A 30TB HDD takes nearly **3-5 days** to rebuild. 30TB drives are shipping today. They're mainstream. And 3-5 days of reduced redundancy is a window large enough to drive a truck through.

Even NVMe SSDs, 30-50x faster than HDDs, can't fully escape the problem at large capacities. A 122TB SSD, already shipping from Solidigm, takes 7-14 hours to rebuild. A 245TB SSD (shipping late 2026) will take 14-27 hours. These aren't theoretical numbers. This hardware exists.

ZFS operators already feel this pain. TrueNAS community forums report **5+ days** to resilver 20TB drives in a RAIDZ2 vdev of 12 drives. One user estimated 10 days, 7 hours for a full resilver. The canonical advice, "never exceed 12 drives per vdev," is an admission that the rebuild time problem has already broken the RAIDZ model at current capacities.

---

## Why Rebuild Time Is the Dominant Durability Factor

Storage durability is measured in "nines." 99.999999999% (eleven nines) durability means you lose one object in 100 billion per year. This is S3's published durability target. The math behind these nines is MTTDL: Mean Time To Data Loss.

For an erasure-coded system with M parity shards, MTTDL follows this relationship:

```
MTTDL ∝ MTTF^(M+1) / MTTR^M
```

Where:
- MTTF = Mean Time To Failure per drive (inversely proportional to Annual Failure Rate)
- MTTR = Mean Time To Repair (rebuild time)
- M = number of parity shards (fault tolerance)

The crucial insight is the exponent on MTTR. For double parity (M=2):

**Doubling rebuild time quarters your MTTDL.**

For triple parity (M=3): doubling rebuild time reduces MTTDL by **8x**. For quad parity (M=4): **16x**. The relationship is exponential in the parity count. Every increase in rebuild time compounds super-linearly against your durability guarantee.

### A Worked Example

Consider a 12-drive erasure group with 8+4 coding (4 parity shards, tolerates 4 simultaneous failures):

- AFR = 1.5% (enterprise HDD, per Backblaze 2025 fleet data: 1.36%)
- MTTF = 584,000 hours
- 20TB HDD, MTTR = 55 hours

```
MTTDL = MTTF^5 / (C(12,5) * 5! * MTTR^4)
      = enormous / (792 * 120 * 9,150,625)
      ≈ billions of years
```

Now swap in a 60TB HDD with MTTR = 180 hours:

```
MTTR ratio: 180/55 = 3.27x
MTTDL impact: 3.27^4 = 114x worse
```

The same EC scheme, the same drives, the same failure rate, just larger capacity, and durability drops by **two orders of magnitude**. You didn't change anything in your design. The drives just got bigger.

This is the rebuild time crisis in a single equation. Drive vendors ship bigger drives. Your rebuild time goes up. Your MTTDL goes down. And you didn't do anything wrong.

---

## The Double-Failure Window

MTTDL is an average. Let me make it concrete: what's the probability that a second drive fails *during* a rebuild?

For a 12-drive EC group at 1.5% AFR, with 11 surviving drives during rebuild:

```
P(second failure) ≈ (N-1) × T × AFR / 8760
```

| Rebuild Time | P(2nd failure in group) |
|-------------|------------------------|
| 8 hours (NVMe, 30TB) | 0.015% |
| 55 hours (HDD, 20TB) | 0.104% |
| 111 hours (HDD, 30TB) | 0.210% |
| 222 hours (HDD, 60TB) | 0.419% |
| 370 hours (HDD, 100TB) | 0.697% |

These look small. They're not.

In a fleet of 10,000 drives organized in 12-drive EC groups, you'll have roughly 150 drive failures per year (at 1.5% AFR). Each failure opens a rebuild window. The fleet-wide probability of **at least one double failure** during any rebuild window in a year:

| Fleet Size | Failures/Year | P(double failure, any group, per year), 20TB HDD |
|-----------|--------------|--------------------------------------------------|
| 100 drives | 1.5 | ~0.16% |
| 1,000 drives | 15 | ~1.6% |
| 10,000 drives | 150 | ~14.8% |
| 100,000 drives | 1,500 | ~80%+ |

**At 10,000 HDDs, there's a 15% annual chance of a double failure during a rebuild.** At 100,000 HDDs, it's a near-certainty. And this is with 20TB drives. With 60TB HDDs, double the probabilities. With 100TB HDDs, triple them.

This is with 4 parity shards. With only 2 parity (RAID-6), a double failure is data loss. With 4 parity, a double failure means you're down to 2 remaining parity, still alive, but one more failure away from loss. A triple failure during a prolonged rebuild of a 60TB HDD is not impossible. It's a fleet-level probability that actuaries would refuse to ignore.

---

## The URE Multiplier

As if the double-failure window weren't enough, there's a compounding factor that most rebuild time analyses ignore: Unrecoverable Read Errors (UREs).

Every drive has a specified URE rate, the probability that a read returns an error instead of data. For enterprise drives:

| Drive Type | URE Rate | One Error Per |
|-----------|---------|---------------|
| Consumer HDD | 10^14 bits | 12.5 TB |
| Enterprise HDD | 10^15 bits | 125 TB |
| Enterprise SSD | 10^17-10^18 bits | 12.5-125 PB |

During a rebuild, you must read the **entire contents** of every surviving drive in the EC group. For a 12+4 EC scheme with 30TB drives, rebuilding one drive means reading 15 surviving drives x 30TB = 450TB.

The probability of hitting at least one URE during that 450TB read:

| Drive Type | P(URE during 450TB rebuild read) |
|-----------|--------------------------------|
| Consumer HDD | 100% (guaranteed) |
| Enterprise HDD | 36% |
| Enterprise SSD | 0.36% |

A 36% chance of hitting a URE during rebuild of enterprise HDDs. That URE is effectively another drive failure for that specific stripe; you've lost another shard's worth of data for those sectors. With only double parity, one URE during a single-drive rebuild leaves you at single parity for that stripe. If you're unlucky enough to hit two UREs on different surviving drives during the same rebuild, you lose data.

**This is why RAID-5 is dead.** With single parity, any URE during rebuild is data loss. At 30TB drive capacities, the probability of a URE during rebuild with consumer HDDs is essentially 100%. Even with enterprise HDDs, it's 3-4%. IBM published ["Re-evaluating RAID-5 and RAID-6"](https://www.ibm.com/support/pages/re-evaluating-raid-5-and-raid-6-slower-larger-drives) explicitly warning that RAID-5 is unsuitable for drives above ~12TB.

SSDs are dramatically better. Enterprise SSD URE rates are 1,000x lower than enterprise HDDs. This is an underappreciated advantage of NVMe over HDD for erasure-coded storage. The URE risk during rebuild is negligible for SSDs, while it's a meaningful contributor to data loss probability for HDDs at current capacities.

---

## How the Industry Copes (and Where It Falls Short)

### NetApp: Triple Parity (RAID-TEC)

NetApp addressed the rebuild time crisis head-on by making **triple parity the default** for all HDDs 6TB and larger. RAID-TEC (Triple Erasure Coding) tolerates 3 simultaneous drive failures, with a default group size of 23 drives (20 data + 3 parity). NetApp estimates ~12 hours to rebuild a 15.3TB SSD and ~30 hours for a 30TB HDD.

The logic is sound: if double failures during rebuild are becoming probable, add a third parity so that even a double failure during rebuild doesn't lose data. But RAID-TEC is a defensive measure, not a solution. At 60TB HDDs, the rebuild window stretches to 5+ days, and the triple-failure probability during that window starts to matter. Quadruple parity is the obvious next step, and indeed, wide EC codes with 4 parity shards are becoming standard.

### Ceph: Declustered Recovery via Placement Groups

Ceph's architecture naturally declusters data across all OSDs in a pool via Placement Groups (PGs) distributed by CRUSH. When an OSD fails, its PGs are spread across many surviving OSDs, so dozens or hundreds of OSDs participate in recovery, both reading source data and writing rebuilt shards.

This is the right idea. If a traditional 12-drive RAID group loses one drive, 11 drives participate in rebuild. If a Ceph pool has 100 OSDs, all 99 participate. The parallelism scales with cluster size, not EC group size.

The problem is Ceph's defaults. `osd_max_backfills = 1` limits each OSD to one concurrent backfill operation. `osd_recovery_op_priority = 3` gives recovery very low priority versus client I/O. With default settings, users report 350 MB/s recovery at best. Tuning to `osd_max_backfills = 8-16` raises this to 700+ MB/s per OSD, but operators are conservative. Aggressive recovery settings can noticeably impact foreground latency, and the tuning requires understanding the I/O profile of the cluster.

Ceph has the architecture for fast rebuilds but defaults to slow ones, and most operators never change the defaults.

### Per-Object Healing in Object Storage

Some object storage systems don't rebuild drives. They heal objects.

When a drive fails, there's no volume-level reconstruction. Instead, a background scanner and on-read healing mechanism repair individual objects. Each object is independently erasure-coded, so healing one object means reading its surviving shards from peer drives, reconstructing the missing shard, and writing it to the replacement drive.

The advantages are significant:

**Sparse rebuild.** Only actual objects are reconstructed. A 30TB drive with 18TB of data only rebuilds 18TB, a 40% reduction versus full-drive rebuild.

**On-read prioritization.** When a GET request hits an object that has a missing shard, the system immediately reconstructs it, repairs the shard, and serves the request. Hot data is healed first, as a side effect of being accessed.

**No dedicated rebuild I/O.** Healing is interleaved with normal operations. There's no "rebuild mode" that changes the system's behavior. The scanner runs continuously, and heals are queued alongside client I/O.

The disadvantage: this approach is not designed for speed. A typical scanner checks a fraction of objects per pass, cycling through all objects over multiple passes. This is thorough but slow. After a drive failure, full recovery of all objects can take hours to days, depending on the object count and scanner throughput.

### VAST Data: Locally Decodable Erasure Codes

VAST Data takes the most radical approach. Their Locally Decodable Erasure Codes (LDEC) use extremely wide stripes, typically 150 data + 4 parity, across an entire DASE (Disaggregated Shared Everything) cluster.

The key innovation: LDEC allows reconstructing a lost strip by reading only **1/4th** of surviving data strips, not all K. For a 150+4 scheme, rebuilding one strip reads ~42 strips instead of 150. This is a fundamental property of the code construction, not an optimization on top of Reed-Solomon.

The result: 2.7% storage overhead (150+4), 4 fault tolerance, and rebuild read amplification equivalent to a much narrower code. VAST claims 60 million years MTTDL and throttles rebuild to ~30 hours per SSD, intentionally slow to minimize foreground impact, because the LDEC's low read amplification makes even throttled rebuilds safe.

This is the most advanced production answer to the rebuild time crisis, but it requires VAST's full DASE architecture. It's not a technique you can bolt onto a traditional storage system.

---

## What a Rebuild-Resilient Architecture Looks Like

The rebuild time crisis isn't solvable by any single technique. It requires a layered approach where each layer reduces the risk that the layers below it can't handle.

### Layer 1: Wide Erasure Codes with 4+ Parity

The first line of defense: tolerate more simultaneous failures. With 4 parity shards, you can lose 4 drives simultaneously before data loss. During a single-drive rebuild, you're running at 3 parity, still safe against a double failure plus a URE.

| EC Scheme | Fault Tolerance | Storage Overhead | Sweet Spot |
|-----------|----------------|-----------------|------------|
| 4+2 | 2 | 50% | Small clusters, <12 drives |
| 8+4 | 4 | 50% | Medium clusters, 12-24 drives |
| 12+4 | 4 | 33% | Large clusters, good efficiency |
| 16+4 | 4 | 25% | Very large clusters, high efficiency |

8+4 is the pragmatic minimum for any system deploying drives larger than 20TB. The 50% overhead is the same as 4+2, but you get double the fault tolerance. There is no reason to use 4+2 on hardware where a single drive failure opens a multi-day rebuild window.

### Layer 2: Declustered Placement

Don't lock data into fixed RAID groups. Distribute erasure-coded shards across all drives in the system using consistent hashing (CRUSH, HRW, or similar). When a drive fails, every surviving drive in the cluster participates in the rebuild, reading its share of the lost drive's data and writing reconstructed shards.

The speedup is proportional to the ratio of pool size to EC group size. If your EC groups are 12 drives but your cluster has 120 drives, rebuild parallelism increases 10x. If you have 1,200 drives, 100x.

```
Traditional RAID (12-drive group, 1 drive fails):
    11 drives read → 1 hot spare writes
    Bottleneck: single spare drive's write throughput

Declustered (120-drive cluster, 1 drive fails):
    119 drives read (proportionally) → 119 drives write (proportionally)
    Bottleneck: aggregate cluster bandwidth
```

### Layer 3: Sparse Rebuild

Only rebuild data that actually exists. A 60TB drive at 65% utilization has 39TB of data and 21TB of free space. Traditional RAID rebuilds all 60TB. Object storage rebuilds 39TB, a 35% reduction.

This sounds obvious, but it requires the rebuild engine to know which blocks are allocated. Traditional hardware RAID controllers don't have this information. Filesystem-integrated RAID (ZFS, IBM Spectrum Scale) does. Object storage systems do inherently. You can enumerate the objects on a failed drive and rebuild exactly those objects.

### Layer 4: Prioritized Healing

Not all data is equally urgent. An object being actively served to inference workers needs its redundancy restored immediately. A cold archival object that hasn't been accessed in 6 months can wait.

A priority-based healing queue orders repair by:

1. **Criticality.** Objects that have lost the most shards (down to minimum quorum) rebuild first. An object at 8+2 surviving shards (lost 2 of 4 parity) is more critical than an object at 8+3 (lost 1).

2. **Hotness.** Objects with recent access are rebuilt before cold objects. If the healing engine is competing with foreground I/O for bandwidth, healing hot objects reduces the chance that a GET request hits a degraded object.

3. **Age.** Older unrebuilt shards are prioritized over newer ones, preventing starvation.

### Layer 5: Proactive Healing (Background Scrubbing)

The cheapest rebuild is the one that never happens. Background scrubbing, reading every shard, verifying its checksum, and repairing any corruption found, catches problems before they combine with a drive failure.

A shard with a silent checksum mismatch (bit rot, firmware bug, SDC) is one fewer good shard for reconstruction if a drive fails. If a 12-shard object has 1 silently corrupted shard and then loses a drive, it's effectively down to 10 healthy shards instead of 11. With 4 parity, that's still recoverable. With 2 parity, it's not.

Proactive healing eliminates these silent failures before they compound. A background scanner that verifies every shard on a 30-day cycle means no silent corruption persists for more than a month. Combined with on-read verification (check the checksum on every GET), the probability of encountering a silently corrupted shard during a rebuild approaches zero.

### Layer 6: Design for 200TB Drives Today

This is the most important principle and the one most teams ignore. Your storage system's rebuild architecture should be designed for **the largest drive you'll deploy in 5 years**, not the largest drive you're deploying today.

If you're deploying 30TB NVMe SSDs in 2025, you should be designing your rebuild strategy for 120-200TB SSDs. That means:

- **Rebuild time budget**: assume 12-24 hours, not 2-4 hours
- **EC width**: 4 parity minimum, preferably adaptive
- **Declustering**: mandatory, not optional
- **Prioritized healing**: a first-class subsystem, not an afterthought
- **Monitoring**: real-time rebuild progress dashboards, not "check back tomorrow"

If your architecture handles 200TB drives gracefully, it'll handle 30TB drives trivially. The reverse is not true.

---

## The Read Amplification Problem

There's a cost to rebuilding that goes beyond time: read amplification. To reconstruct one lost shard using Reed-Solomon erasure coding, you must read K surviving data shards. For wider EC codes, K is larger:

| EC Scheme | Shards Read per Rebuild | Read Amplification |
|-----------|------------------------|-------------------|
| 4+2 | 4 | 4x |
| 8+4 | 8 | 8x |
| 12+4 | 12 | 12x |
| 16+4 | 16 | 16x |

For a 16+4 scheme with 30TB drives, rebuilding one drive means reading 16 x 30TB = **480TB** from surviving drives. At 3 GB/s sustained per NVMe drive, that's 160 seconds per drive x 16 drives = about 44 minutes of wall-clock time (with parallelism). But the aggregate I/O is 480TB, bandwidth that competes with client requests.

In a distributed system where shards are spread across nodes, this read amplification becomes network traffic. Rebuilding a 30TB drive in a 16+4 scheme transfers 480TB across the network. At 100 Gbps (12.5 GB/s), that's 10.7 hours of sustained wire-rate transfer. At 25 Gbps per link, it's 42 hours. Network bandwidth, not drive speed, becomes the bottleneck for cross-node rebuild.

Meta documented this: in their HDFS clusters, erasure-coded recovery generated **180TB per day** of cross-rack network traffic just for repair. This consumed meaningful fractions of their TOR switch bandwidth and impacted MapReduce job performance.

### Reducing Read Amplification

Three approaches exist:

**Locally Decodable Codes** (VAST's LDEC). Algebraically designed so that each lost symbol can be reconstructed by reading a small subset (e.g., 1/4th) of surviving symbols. For 150+4, rebuilding reads ~42 strips instead of 150. This reduces read amplification by 3.5x at the cost of code construction complexity.

**Minimum Storage Regenerating (MSR) codes.** MSR codes (including Clay codes, published at USENIX FAST 2018) achieve the information-theoretic minimum repair bandwidth. For a (10,4) code, Clay codes reduce repair bandwidth by **2.9x** compared to Reed-Solomon, with only 1.25x storage overhead. Ceph has implemented Clay codes as an experimental EC backend.

**Multi-Level Erasure Coding (MLEC).** Use fast, narrow local EC within each node (e.g., 4+2 across local drives) and wide global EC across nodes (e.g., 8+4 across nodes). Local drive failures are repaired locally, zero network traffic. Only correlated failures (node loss, rack loss) trigger global repair. Research from UChicago (SC'23) showed MLEC reduces repair network traffic by **orders of magnitude** versus single-level EC.

Each of these is a production-ready technique (LDEC at VAST, Clay codes in Ceph, MLEC in research). The storage systems of 2030, facing 200TB drives, will need all three.

---

## The HDD vs SSD Calculation

Everything I've described is worse for HDDs than SSDs. Let me quantify how much worse.

| Factor | HDD (30TB) | NVMe Gen4 SSD (30TB) | SSD Advantage |
|--------|-----------|---------------------|---------------|
| Rebuild throughput | 75-125 MB/s | 2.5-3.75 GB/s | **20-50x faster** |
| Rebuild time | 67-111 hours | 2.2-3.3 hours | **20-50x shorter** |
| URE rate | 10^15 (enterprise) | 10^17-10^18 | **100-1,000x better** |
| P(URE during rebuild) | 14-36% | 0.04-0.36% | **40-1,000x lower** |
| AFR | 1.0-2.0% | 0.5-1.0% | **2x better** |

SSDs address the rebuild time crisis at every level: faster rebuild, fewer UREs during rebuild, lower failure rate, shorter vulnerability window. The total durability improvement from switching HDD to NVMe SSD for the same capacity is not 20-50x (the throughput ratio). It's multiplicative across all factors, easily **1,000x+** improvement in effective MTTDL.

This is why the all-flash datacenter isn't just about performance. It's about durability. At 60TB+ drive capacities, HDDs cannot rebuild fast enough to maintain acceptable durability without heroic engineering (LDEC, triple parity, aggressive declustering). SSDs maintain acceptable rebuild windows at current capacities and have headroom for 200TB+.

The remaining argument for HDDs, cost per TB, is narrowing. QLC NAND is closing the gap. A 60TB QLC SSD is cheaper per TB than a 60TB HAMR HDD would be, and it rebuilds 20-50x faster. The TCO calculation must include the durability benefit, not just the acquisition cost.

---

## Design Principles for the 200TB Era

If you're building a storage system in 2025, these are the non-negotiable principles for rebuild resilience:

**1. Four parity shards minimum.** Double parity (RAID-6, 4+2 EC) is insufficient for drives above 20TB. The double-failure probability during a multi-day HDD rebuild is too high, and the URE risk compounds it. Four parity shards (8+4, 12+4, 16+4) give you two additional failures of margin during rebuild. This is the minimum, not the target.

**2. Declustered placement is mandatory.** Fixed RAID groups limit rebuild parallelism to the group size. Declustered placement across all drives in the cluster makes rebuild parallelism proportional to cluster size. There is no reason to limit rebuild to a subset of drives when consistent hashing already distributes shards everywhere.

**3. Rebuild must be sparse and prioritized.** Rebuilding free space is wasted I/O. Rebuilding cold data before hot data is wasted risk. The healing engine must enumerate actual objects, order them by criticality, and rebuild the most vulnerable data first.

**4. Background scrubbing is non-negotiable.** Silent corruption that accumulates between drive failures reduces your effective parity count. A shard with an undetected checksum mismatch is a dead shard; you just don't know it yet. Monthly full-cycle scrubbing with cryptographic checksums (BLAKE3, not CRC32) eliminates this hidden risk.

**5. Design for NVMe, not HDD.** HDD rebuild times at 60TB+ are measured in weeks. No amount of EC parity, declustering, or prioritization makes a 9-day rebuild window acceptable. NVMe SSDs rebuild 20-50x faster and have 100-1,000x better URE rates. The durability advantage alone justifies the cost premium.

**6. Monitor rebuild progress in real time.** A rebuild that's "happening in the background" with no visibility is a rebuild you can't manage. Real-time dashboards showing rebuild progress, estimated completion, current vulnerability level (how many more failures can we tolerate?), and foreground I/O impact let operators make informed decisions: throttle rebuild for peak traffic, boost rebuild overnight, or escalate if the window is growing.

**7. Test rebuild at capacity, not with small drives.** Your 1TB test cluster rebuilds in seconds. Your production 60TB drives take hours. If you haven't tested a full rebuild with production-sized drives under production-realistic load, you don't know your actual rebuild time. Most teams learn their rebuild times during an incident. Don't be that team.

---

## Conclusion

The rebuild time crisis is the storage industry's version of compound interest in reverse. Drive capacities compound upward. Rebuild speeds don't. The gap between them determines how long your data is vulnerable after every drive failure.

At 20TB drives, the gap was manageable: a few days for HDDs, a few hours for SSDs. At 60TB, it's concerning, over a week for HDDs. At 122TB (already shipping), it's dangerous. At 245TB (shipping late 2026), it's untenable without fundamental architectural changes.

The changes aren't speculative. They're known: wide EC codes with 4+ parity, declustered placement across all drives, sparse and prioritized rebuild, proactive scrubbing, and NVMe over HDD. VAST proved that locally decodable codes can make 150+4 practical. Ceph proved that declustered recovery via placement groups can scale. Clay codes proved that read amplification can be cut by 3x. Multi-level EC proved that network traffic can be reduced by orders of magnitude.

The engineering exists. The question is whether your storage system uses it.

Every drive vendor on Earth is working to ship 100TB+ drives by 2030. When they succeed, and they will, every storage system whose rebuild strategy was designed for 1-10TB drives will face a durability crisis. The math is unforgiving. Capacity is exponential. Throughput is flat. Rebuild time is their ratio. And your data's survival depends on that ratio being small enough that a second failure during rebuild remains improbable.

Build for 200TB today. Your drives will catch up.

---

*HDD capacity milestones and HAMR roadmap from [Tom's Hardware](https://www.tomshardware.com/pc-components/hdds/seagate-exos-m-30tb-hdd-review), [Horizon Technology](https://horizontechnology.com/news/hard-drive-capacity-and-the-road-to-50tb/), and [Blocks & Files](https://blocksandfiles.com/2025/02/13/wd-is-hamring-out-its-future/). Solidigm 122TB SSD from [Tom's Hardware](https://www.tomshardware.com/pc-components/ssds/solidigm-reveals-122tb-ssd-the-worlds-highest-capacity-drive-for-ai-workloads-d5-p5336-offers-unlimited-write-durability); 245TB roadmap from [TechRadar](https://www.techradar.com/pro/solidigm-confirms-245-tb-ssds-set-to-launch-before-end-of-2026). Samsung 128TB BM1743 from [AnandTech FMS 2024](https://www.anandtech.com/show/21526/samsungs-128-tbclass-bm1743-enterprise-ssd-displayed-at-fms-2024). Backblaze 2025 drive statistics from [Storage Review](https://www.storagereview.com/news/backblaze-2025-year-end-drive-stats-annual-afr-falls-to-1-36-as-high-capacity-drives-dominate-fleet). MTTDL formulas from [USENIX FAST Workshop 2013](https://www.usenix.org/system/files/fastpw13-final25.pdf) and [UMass RAID reliability](http://www.ecs.umass.edu/ece/koren/architecture/Raid/reliability.html). IBM RAID-5/6 re-evaluation from [IBM Support](https://www.ibm.com/support/pages/re-evaluating-raid-5-and-raid-6-slower-larger-drives). NetApp RAID-TEC from [NetApp documentation](https://docs.netapp.com/us-en/ontap/disks-aggregates/default-raid-policies-aggregates-concept.html). Ceph recovery tuning from [Thomas-Krenn wiki](https://www.thomas-krenn.com/en/wiki/Ceph_-_increase_maximum_recovery_&_backfilling_speed). VAST LDEC from [VAST Data blog](https://www.vastdata.com/blog/breaking-resiliency-trade-offs-with-locally-decodable-erasure-codes). Clay codes from [USENIX FAST 2018](https://www.usenix.org/conference/fast18/presentation/vajha). Multi-Level EC from [SC'23](https://ucare.cs.uchicago.edu/pdf/sc23-mlec.pdf). Meta HDFS repair traffic from [USENIX OSDI 2014 (f4)](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-muralidhar.pdf). URE rates from [The Register](https://www.theregister.com/2015/05/07/flash_banishes_the_spectre_of_the_unrecoverable_data_error/) and [DSHR Blog](https://blog.dshr.org/2015/05/unrecoverable-read-errors.html). ZFS resilver times from [TrueNAS community](https://www.truenas.com/community/threads/replacing-12tb-drives-with-20tb-drives-resilver-impossibly-long.105628/). EC survey from [ACM Transactions on Storage 2024](https://dl.acm.org/doi/10.1145/3708994).*
