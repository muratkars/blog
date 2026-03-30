---
title: "The Form Factor Nobody Is Talking About"
date: 2026-03-28
description: "The 2.5-inch drive bay is 26 years old. It was designed for laptop hard drives. Today we're shoving 122 TB of QLC flash into that same hole. EDSFF is the first SSD form factor designed for data centers from scratch, and E2 will put a petabyte on a single drive."
tags: ["storage", "hardware", "edsff", "nvme"]
type: "standard"
featured: false
image: "/images/blog/gpu-cluster.jpg"
readTime: "18 min read"
---

![GPU cluster hardware](/images/blog/gpu-cluster.jpg)

*The 2.5-inch drive bay is 26 years old. It was designed for laptop hard drives spinning at 5,400 RPM. Today we're shoving 122 TB of QLC flash into that same rectangular hole, bolting on a PCIe Gen4 x4 interface, and pretending nothing has changed. Something has changed. EDSFF is the first SSD form factor designed for data centers from scratch, and its newest member, E2, will put a petabyte on a single drive and 40 petabytes in a single 2U server. That's not just a hardware story. It's a storage software story, because every assumption your code makes about drive count, failure domains, rebuild times, and power budgets is about to be wrong.*

---

## A Brief History of Putting Storage in Boxes

Each form factor transition changed the math for storage software. The transition to EDSFF will be the most consequential since the move from spinning rust to flash.

### 3.5-Inch HDD (1983-present)

The original. Designed for desktop PCs, adopted by servers because that's what existed. A 4U chassis holds 36 3.5-inch drives. At 20 TB per HDD (Seagate Exos X20), that's 720 TB raw in 4U. The form factor assumes mechanical spindles, vibration isolation, and 12V power delivery. Cooling is a non-issue because HDDs generate 5-8W each.

Storage software was designed around this: hundreds of drives per rack, each one slow (200 MB/s sequential), each failure losing 20 TB. Rebuild times of 4-8 hours at full drive speed. RAID-6 or 8+3 erasure coding with enough parity to survive two simultaneous failures during the rebuild window.

### 2.5-Inch SSD (2007-present)

The laptop form factor that ate the data center. Originally 15mm thick for enterprise (U.2 connector), now the standard NVMe SSD carrier. A 2U chassis holds 24 U.2 SSDs. At 30.72 TB per drive (Samsung PM1733), that's 737 TB raw in 2U. At Solidigm's 122.88 TB D5-P5336 (shipping Q1 2025), that's 2.95 PB raw in 2U. From a 24-bay chassis. Designed for laptop drives.

The 2.5-inch form factor has three problems at these densities:

1. **Power delivery.** The U.2 connector was designed for 25W. A high-performance NVMe SSD can draw 25-40W under sustained write. Twenty-four drives at 40W is 960W just for storage, in a chassis whose power supply and cooling were designed for 24 drives at 10W each.

2. **Airflow.** 2.5-inch drives sit perpendicular to the airflow in most chassis designs (drive cages with front-loading trays). Hot air from the front drives heats the rear drives. At 24 drives generating 25W each, thermal throttling in the back row is a real problem.

3. **Wasted space.** An NVMe SSD doesn't have a spinning platter. The PCB inside a 2.5-inch SSD uses maybe 60% of the available volume. The rest is air, structural frame, and a connector designed for a different era.

### M.2 (2013-present)

The gumstick form factor. Compact, direct-attach via M-key PCIe slot, no cables. Popular in consumer, workstation, and some server boot drives. But M.2 has no hot-swap capability, limited cooling surface area, and maxes out at about 8 TB in the 22110 length. Not a serious data center form factor for bulk storage.

---

## Enter EDSFF: Designed for Data Centers, Not Laptops

EDSFF (Enterprise and Data Center Standard Form Factor) is a family of SSD form factors developed by SNIA's SFF Technical Work Group, with contributions from Intel, Samsung, Kioxia, Dell, HPE, and 10+ other companies. The specifications define form factors purpose-built for server and storage chassis.

The key insight behind EDSFF: **the form factor should serve the flash, not the other way around.** Flash packages are flat rectangles. The optimal form factor for packing flash is a flat rectangle. Not a 2.5-inch box designed for a spinning disk, and not a gumstick designed for a laptop motherboard.

### The EDSFF Family

| Form Factor | Dimensions (mm) | PCIe Lanes | Max Power | Target Use Case |
|------------|-----------------|-----------|-----------|----------------|
| **E1.S (short)** | 31.5 x 111.49 (5.9mm) | x4 | 12-25W | Boot, caching, mixed-use |
| **E1.L (long ruler)** | 38.4 x 318.75 (9.5/18mm) | x4 or x8 | 25-40W | Maximum capacity per drive |
| **E3.S (short square)** | 76.0 x 111.49 (16.8mm) | x4 or x8 | 25-40W | U.2 replacement, performance |
| **E3.L (long)** | 76.0 x 142.2+ | x4 or x8 | 25-70W | Extreme capacity, AI |

All EDSFF form factors share the SFF-TA-1002 edge connector: a card-edge PCIe interface that eliminates the U.2/SAS cable. No cables means no cable routing, no cable failures, and no airflow obstruction. The drive slides into a backplane slot, makes contact, and starts serving I/O.

### E1.S: The Quiet Revolution Already Happening

E1.S is the most widely adopted EDSFF variant today, and it's eating U.2 from the bottom up. It's the form factor behind Meta's, Microsoft's, and Google's latest server designs (aligned with the Open Compute Project specifications).

**Why E1.S is winning:**

- **Hot-swappable** with a simple latch mechanism (no screw-down like M.2, no tray like U.2)
- **Slim enough for 1U.** At 5.9mm thick (or 9.5mm/15mm/25mm in taller variants), you can pack 32 E1.S drives vertically in a 1U chassis
- **Right-sized power.** 12W for a read-heavy caching SSD, 25W for a write-intensive workload. The connector supports up to 70W for future Gen6 drives
- **Available now** from Samsung, Kioxia, Solidigm, Micron, SK hynix, and Western Digital. Capacities up to 30.72 TB (Kioxia CD8P, Samsung PM9D3a)

Market projections show E1.S growing from 7.2% of total PCIe exabytes shipped in 2022 to 25.9% in 2027, and from 8% of PCIe units to 40.4% of units. The transition is underway.

### E1.L: The Ruler That Packs a Petabyte

E1.L is the "ruler" form factor: 318.75mm long (12.5 inches), designed to slide vertically into a 1U chassis from the front. At 38.4mm wide, you can fit 32 E1.L drives in a single 1U row. Intel originally championed this form factor for their 3D XPoint (Optane) ruler drives, but it's now the natural home for high-capacity QLC flash.

Solidigm's D5-P5336 is shipping in E1.L form factor at 30.72 TB and 61.44 TB, with the 122.88 TB version sampling. Kioxia's LC9 Series targets the same form factor at up to 245.76 TB per drive.

**The density math with E1.L:**

```
32 x E1.L drives in 1U:

At 61.44 TB/drive:   1.97 PB raw in 1U
At 122.88 TB/drive:  3.93 PB raw in 1U
At 245.76 TB/drive:  7.86 PB raw in 1U
```

Compare with today's standard: 24 x U.2 in 2U = 737 TB at 30.72 TB/drive. The E1.L configuration delivers **5-10x the density per rack unit**.

### E3.S and E3.L: The Performance Tier

E3.S is positioned as the direct U.2 replacement for performance-oriented workloads. It's wider than E1.S (76mm vs 31.5mm), which gives more PCB area for DRAM cache, power delivery circuitry, and heat spreader contact. E3.S supports x4 or x8 PCIe lanes, enabling higher bandwidth per drive.

Samsung's PM1743 (TLC) ships in E3.S at up to 15.36 TB. Their BM1743 (QLC) has been demonstrated at FMS 2024 in E3.S, 2.5", E1.S, and E1.L form factors, with the flagship 122.88 TB model.

E3.L is the newest and most extreme variant. Kioxia's LC9 Series (announced July 2025) puts 245.76 TB in an E3.L form factor using 32-die stacked BiCS QLC flash with CBA (CMOS Bonded to Array) technology. PCIe 5.0 x4, dual-port capable. 12 GB/s sequential read, 3 GB/s sequential write, 1.3M read IOPS. This is the world's first quarter-petabyte SSD, and it won "Best of Show" at FMS 2025.

---

## E2: The Petabyte Drive

E1.S, E1.L, E3.S, and E3.L are evolutionary. They're better shapes for flash packages, optimized for existing server platforms. E2 is something else entirely. It's a new form factor co-developed by SNIA and OCP specifically to kill the hard drive in warm storage tiers, and the numbers are staggering.

### The Spec: SFF-TA-1042

The E2 specification (SFF-TA-1042) was published on June 16, 2025. It defines a ruler-shaped drive with these dimensions:

| Property | E2 Specification |
|----------|-----------------|
| **Length** | 200 mm (7.9 inches) |
| **Height** | 76 mm (3.0 inches) |
| **Thickness** | 9.5 mm |
| **Interface** | PCIe 6.0 x4 (256 GT/s) |
| **Connector** | SFF-TA-1002 edge + SFF-TA-1009 pinout |
| **Max Power** | 79.2W (6.6A at 12V) |
| **Typical Power** | 20-30W (read-heavy workloads) |
| **NAND Packages** | 64+ minimum |
| **Target Capacity** | Up to **1 PB per drive** |
| **Target Throughput** | 8-10 MB/s per TB (~10 GB/s at 1 PB) |
| **Chassis Fit** | 40 drives vertical in 2U |

Read that last line again. Forty E2 drives in a standard 2U rack-mount server. At the target capacity of 1 PB per drive, that's **40 PB raw in a 2U chassis**. A single server. Two rack units.

For context: 40 PB is roughly the total storage capacity of a medium-sized cloud provider's region. In 2020, that took a data center wing. With E2, it takes a shelf.

### How E2 Differs from E1.L and E3.L

E2 is not just a bigger ruler. It's designed from scratch to achieve a different goal: **HDD cost per TB at SSD performance**.

| Property | E1.L | E3.L | E2 |
|----------|------|------|----|
| Length | 318.75 mm | 142.2+ mm | 200 mm |
| Height | 38.4 mm | 76 mm | 76 mm |
| Target capacity | 61-245 TB | 245 TB | **Up to 1 PB** |
| NAND packages | 16-32 | 32-64 | **64+** |
| Interface | PCIe 5.0 x4/x8 | PCIe 5.0 x4/x8 | **PCIe 6.0 x4** |
| Chassis density | 32 in 1U | 8-16 in 2U | **40 in 2U** |
| Performance model | Balanced | Read-heavy | **Capacity-optimized** |

E2's design goal is explicit: support at least 64 NAND packages in a single drive, double capacity outside of the NAND technology cadence. Where E1.L and E3.L get bigger by waiting for denser NAND (more layers, more bits per cell), E2 gets bigger by fitting more packages on the PCB. It's a packaging innovation as much as a silicon innovation.

### Who's Building E2

The E2 specification was presented at the OCP Storage Tech Talk on May 14, 2025, in a panel featuring:

- **Micron** (demonstrated a 500+ TB prototype)
- **Pure Storage** (exhibited a 300 TB E2 prototype with large flash controller, six DRAM cache chips, and capacitors for power-loss data protection)
- **Meta** (shared 3D CAD renders of an E2 server system, defining the chassis and cooling requirements)
- **Microsoft** (provided requirements from Azure's warm storage tier)

This isn't vaporware from a startup. These are the companies that build the world's largest storage deployments telling SNIA what they need next. When Meta designs a 2U chassis around E2, that chassis will ship in volumes measured in hundreds of thousands.

### The Warm Data Target

E2 has a specific workload in mind: **warm data**. Not the hot tier (frequently accessed, latency-sensitive, served by TLC NVMe). Not the cold tier (rarely accessed, archived, served by HDDs or tape). The warm tier is data accessed occasionally but not constantly: older social media posts, completed ML training datasets, regulatory archives that must be queryable, surveillance footage past the 30-day active window.

Today, warm data lives on HDDs because the cost per TB of QLC SSDs is still 3-5x higher than HDDs. E2's thesis is that the density advantage (40 PB in 2U vs. 40 PB in multiple racks of HDDs), the performance advantage (10 GB/s vs. 200 MB/s), and the power advantage (20-30W per drive vs. 8-10W per HDD, but serving 50x more TB per watt) will close the TCO gap.

The math: a 4U JBOD chassis holds 60 3.5-inch HDDs at 20 TB each = 1.2 PB raw. A 2U E2 chassis holds 40 drives at 1 PB each = 40 PB raw. To match the E2 chassis capacity with HDDs, you need 33 JBOD chassis (132U, more than three full racks). The floor space, power, cooling, cabling, and operational overhead of 33 chassis vs. 1 is where E2 wins the TCO argument, even if the per-TB media cost is higher.

### The 40 PB Server

Let me sketch what a fully populated E2 server looks like:

```
┌────────────────────────────────────────────────────────────────┐
│  2U E2 Chassis: 40x E2 Drives + Dual-Socket Compute           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Front (drive bays):                                           │
│  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
│  │E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│
│  │E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│E2│
│  └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘
│  40 x E2 @ 9.5mm thick, 76mm tall, vertical in 2U             │
│                                                                │
│  At 500 TB/drive:  20 PB raw     │  At 1 PB/drive:  40 PB raw │
│  After 8+4 EC:     13.3 PB usable│  After 8+4 EC:   26.7 PB   │
│                                                                │
│  Compute: 2x next-gen Xeon or EPYC (PCIe 6.0)                 │
│  Network: 2x 400GbE (or 1x 800GbE)                            │
│  PCIe lanes needed: 40x4 + NIC + mgmt = ~176 lanes            │
│  Power: 40 x 25W avg + CPUs + NIC = ~1,800-2,200W             │
│  Cooling: front-to-back airflow, ruler drives act as chimneys  │
└────────────────────────────────────────────────────────────────┘
```

A single 42U rack with 21 of these 2U servers: **21 x 20 PB = 420 PB raw** (at 500 TB/drive, the near-term target). At 1 PB/drive: **840 PB raw per rack**. After erasure coding: roughly 280-560 PB usable per rack.

We're talking about half an exabyte in a single standard rack. This is a fundamentally different scale than anything storage software has been designed for.

---

## The Software Implications Nobody Is Designing For

Hardware engineers are shipping 245 TB drives in 2025 and prototyping 500 TB+ E2 drives. Storage software engineers are still designing for 8-16 TB drives. This gap will cause real problems.

### Problem 1: Rebuild Times

This is the most urgent issue. As I covered in the [rebuild time crisis post](/blog/rebuild-time-crisis), reconstruction speed is limited by surviving drive throughput, EC computation speed, and write throughput to replacement drives.

At realistic rebuild rates (500 MB/s sustained, accounting for competing production I/O):

| Drive Capacity | Rebuild Time | Vulnerability Window |
|---------------|-------------|---------------------|
| 8 TB | 4.4 hours | Low risk |
| 30 TB | 16.7 hours | Moderate risk |
| 61 TB | 33.9 hours | High risk |
| 122 TB | 67.8 hours (2.8 days) | Very high risk |
| 245 TB | 136 hours (5.7 days) | Unacceptable |
| 500 TB (E2 near-term) | 278 hours (11.6 days) | Catastrophic |
| 1 PB (E2 target) | 555 hours (23.1 days) | Beyond current models |

**What software must do:**

- **Declustered erasure coding.** Don't bind erasure groups to fixed drive sets. Spread parity across all drives so that rebuilding one drive reads from all remaining drives in parallel.
- **Prioritized rebuild.** Hot data first, cold data later. Rebuild the objects that users are actually reading before rebuilding archival data nobody's touched in months.
- **Partial rebuild.** A 245 TB drive may be only 60% full. Only rebuild the objects that actually existed, not the empty space. This cuts rebuild time by 40%.
- **Background throttling.** Rebuild I/O competes with production I/O. Adaptive throttling that backs off during peak hours and accelerates during off-hours.

### Problem 2: Failure Domain Explosion

A 1U chassis with 32 E1.L drives at 122 TB each contains 3.9 PB of raw data. If the chassis fails (power supply, backplane, network switch), you lose 3.9 PB simultaneously. Even with erasure coding protecting against individual drive failures, a chassis-level failure requires a different strategy.

**What software must do:**

- **Cross-chassis erasure coding.** The erasure group must span multiple chassis, so that losing one chassis loses at most M shards from any group. This requires network bandwidth for parity distribution but eliminates the chassis as a single failure domain.
- **Rack-aware placement.** Place shards on different racks when possible, so that a top-of-rack switch failure doesn't take out an entire erasure group.
- **Power domain awareness.** In data centers with redundant power feeds, ensure that an erasure group's shards span both power domains.

This is where deterministic placement algorithms like HRW with failure-domain constraints become essential. The placement function needs to understand the physical topology (drive, chassis, rack, power domain, data center) and ensure that erasure groups span the boundaries that matter.

### Problem 3: PCIe Lane Budget

32 E1.L drives at PCIe x4 each = 128 lanes. Add two 100GbE NICs (32 lanes) and you need 160+ lanes. This pushes you into dual-socket territory on Intel (176 lanes with two Xeon 6760P) or requires PCIe switches on AMD single-socket (128 lanes max).

With PCIe Gen5 drives (like the Kioxia LC9 at Gen5 x4), each drive can sustain 14 GB/s reads. Thirty-two drives reading simultaneously is 448 GB/s. This is more than the aggregate memory bandwidth of most dual-socket systems (~400 GB/s for DDR5-6400 x 16 channels). The storage subsystem is now faster than the memory subsystem. Software that buffers I/O through DRAM becomes the bottleneck. Direct I/O (O_DIRECT) and zero-copy I/O paths (io_uring with fixed buffers) become mandatory.

### Problem 4: Power and Thermal

32 E1.L drives at 25W each = 800W for storage alone. A 1U chassis with dual-socket CPUs (2 x 350W TDP), networking (50W), and fans (50W) totals 1,550W. That's approaching the limit of a single 2,000W power supply, and well above the per-rack-unit power budget of most data center designs (which assume 8-12 kW per rack with 42U).

**What software must do:**

- **Power-aware scheduling.** Don't issue concurrent writes to all 32 drives simultaneously. Stagger write operations across drives to stay within the power envelope. Sequential writes are more power-hungry than reads (QLC programming requires higher voltages).
- **Thermal monitoring.** Read SMART temperature data and throttle I/O to drives approaching thermal limits. NVMe thermal management (TSEL, TMT1/TMT2 thresholds) is exposed via the NVMe admin command set. Storage software should use it.
- **Idle power management.** Put unused drives into lower power states (NVMe PS1-PS4). A drive in PS3 consumes ~2W instead of 25W. For a chassis with bursty workloads, aggressive power management can cut average storage power by 50%.

### Problem 5: QLC Write Endurance

This is the quiet assumption behind every high-capacity EDSFF drive: they're QLC. Four bits per cell. About 1,000 program/erase cycles before the NAND wears out, compared to 3,000 for TLC and 10,000 for MLC.

The endurance is expressed as DWPD (Drive Writes Per Day over the warranty period). Typical QLC enterprise SSDs are rated at 0.3-1 DWPD for 5 years. At 0.3 DWPD, a 122 TB drive can sustain 36.8 TB of writes per day. That sounds like a lot until you consider:

- Write amplification from erasure coding: 1.5x for 8+4 (writing parity shards)
- Write amplification from the FTL's internal GC: 2-3x on QLC
- Write amplification from compaction (if you run an LSM-based metadata engine): 10-30x

The aggregate WAF can easily reach 5-10x, meaning 36.8 TB of "allowed" daily writes translates to 3.7-7.4 TB of effective application writes. For a write-heavy workload on a 122 TB drive, that's a 1.7-3.3% daily utilization ceiling before you're eating into warranty life.

Samsung's BM1743 has an additional caveat: a 1-month data retention spec without power. This means the drive is designed for environments where it's always powered on and data is continuously refreshed. Not a cold storage tier. Not an archival drive. An always-on, read-heavy data lake.

**What software must do:**

- **Write tiering.** Use a small TLC/SLC tier (or SLC cache on the QLC drive itself) for write-hot data. Flush to QLC in large, sequential batches. Minimize random writes to QLC.
- **Wear monitoring.** Track NVMe SMART attributes for percentage used, available spare, and media/data integrity errors. Proactively migrate data off drives approaching end of life.
- **Workload-appropriate placement.** Write-heavy objects (frequently updated, small, random I/O) should land on TLC drives. Read-heavy, large, sequential objects (Parquet files, video archives, ML training data) belong on QLC.

---

## What's Actually Shipping (Early 2026)

Let me anchor this in reality. Here are the highest-capacity EDSFF drives available or sampling today:

| Vendor | Model | Capacity | Form Factor | Interface | NAND | Status |
|--------|-------|----------|------------|-----------|------|--------|
| **Solidigm** | D5-P5336 | 122.88 TB | 2.5" U.2, E1.L | PCIe 4.0 x4 | QLC (3D5) | Shipping Q1 2025 |
| **Solidigm** | D5-P5336 | 61.44 TB | E1.L | PCIe 4.0 x4 | QLC (3D5) | Shipping now |
| **Samsung** | BM1743 | 122.88 TB | 2.5" U.2, E3.S, E1.S, E1.L | PCIe 5.0 | QLC (V8) | Sampling/demo |
| **Kioxia** | LC9 Series | 245.76 TB | 2.5", E3.L | PCIe 5.0 x4 | QLC (BiCS, 32-die stack) | Sampling H2 2025 |
| **Samsung** | PM1743 | 15.36 TB | E3.S | PCIe 5.0 x4 | TLC (V6) | Shipping |
| **Micron** | 6550 ION | 61.44 TB | E3.S | PCIe 5.0 x4 | QLC (G8, 232-layer) | Shipping |
| **Micron** | 6550 ION | 122.88 TB | E3.L | PCIe 5.0 x4 | QLC (G8, 232-layer) | Sampling |
| **Kioxia** | CD8P | 30.72 TB | E1.S, E3.S | PCIe 5.0 x4 | TLC (BiCS) | Shipping |

The trajectory is clear: 30 TB today, 60 TB common, 122 TB shipping, 245 TB sampling. Micron's 6550 ION adds another player at the 60-120 TB tier with competitive sequential read (12 GB/s) and the density advantages of their 232-layer G8 NAND. By 2027, 500 TB per drive is plausible with PLC (5 bits/cell) and continued die-stacking improvements.

---

## The 1 PB Node: An Architecture Sketch

What does a storage node look like when a single 1U chassis holds a petabyte?

```
┌─────────────────────────────────────────────────────────┐
│  1U EDSFF Chassis: 32x E1.L + Dual-Socket Xeon 6760P   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Socket 0 (88 PCIe 5.0 lanes)                          │
│  ├── 16x E1.L NVMe @ 30.72 TB each = 491 TB (64 lanes)│
│  ├── 1x 200GbE NIC (16 lanes)                          │
│  ├── Management + boot (8 lanes)                        │
│  ├── 4x DDR5-6400 channels (256 GB)                    │
│  └── Async runtime A (32 cores, pinned)                │
│                                                         │
│  Socket 1 (88 PCIe 5.0 lanes)                          │
│  ├── 16x E1.L NVMe @ 30.72 TB each = 491 TB (64 lanes)│
│  ├── 1x 200GbE NIC (16 lanes)                          │
│  ├── Management + boot (8 lanes)                        │
│  ├── 4x DDR5-6400 channels (256 GB)                    │
│  └── Async runtime B (32 cores, pinned)                │
│                                                         │
│  Total: 983 TB raw                                      │
│  After 8+4 EC: 655 TB usable                           │
│  Power: ~1,400W (32 drives x 25W + 2 CPUs + network)   │
│  Network: 2x 200GbE = 400 Gbps = 50 GB/s aggregate     │
└─────────────────────────────────────────────────────────┘
```

With Solidigm 61.44 TB E1.L drives, the same chassis holds 1.97 PB raw. With the 122.88 TB version: 3.93 PB raw.

**A 42U rack of these nodes:** 42 x 983 TB = 40.3 PB raw per rack. After 8+4 erasure coding: 26.9 PB usable per rack. In a standard data center cabinet, on standard power.

For context: a traditional Ceph cluster achieving 26 PB usable might use 6-8 racks of 4U servers with 3.5-inch HDDs. The EDSFF configuration achieves the same capacity in a single rack, with flash-speed performance.

### The Software Stack for This Node

The storage software running on this node needs capabilities that most current systems lack:

1. **NUMA-aware I/O pinning.** Two separate async runtimes, each pinned to its socket's cores, handling I/O only for locally-attached drives. Cross-socket traffic limited to coordination, not data.

2. **32-drive interrupt steering.** Each NVMe drive generates interrupts via MSI-X. With 32 drives, the system needs interrupt affinity configuration that distributes interrupt handling across cores on the correct NUMA node. Default Linux behavior (irqbalance) doesn't understand this.

3. **io_uring with registered buffers.** At 32 drives x 14 GB/s each = 448 GB/s of potential read throughput, the system is I/O-bound, not CPU-bound. io_uring's registered buffer and fixed-file modes eliminate per-I/O syscall overhead. Traditional read/write syscalls can't keep up.

4. **Cross-chassis erasure coding.** Shards from a single object must span at least 3 chassis to survive a chassis failure. This means 12 RPC calls per PUT (for 8+4 EC), each writing a shard to a different chassis over the 200GbE fabric.

5. **Wear-aware shard placement.** Don't write new objects to drives that are already at 80% wear life. Redirect writes to younger drives. This requires reading SMART data periodically and incorporating drive health into the placement algorithm.

---

## The Data Center Impact

The ripple effects of 1 PB/1U extend beyond the storage node:

### Network

If each 1U node has 50 GB/s of network bandwidth and 450 GB/s of storage bandwidth, the network is the bottleneck by a factor of 9x. This means:

- **Most data stays local.** Object storage workloads that can be served from local drives (single-node reads) use 0% of the network. Only cross-node operations (erasure coding writes, healing, rebalancing) consume network bandwidth.
- **400GbE becomes mandatory.** Two 200GbE NICs (or one 400GbE NIC) per 1U node. The uplink to the spine switch must be 400GbE or 800GbE. Network infrastructure cost per rack increases significantly.
- **Compression pays more.** Every byte saved by compression is a byte that doesn't traverse the network. LZ4 compression at 2:1 ratio effectively doubles your network bandwidth for EC writes.

### Power

At 1,400W per 1U node, a 42U rack draws ~59 kW. Most data centers are designed for 8-15 kW per rack. High-density deployments exist (30-50 kW/rack for GPU clusters), but they require liquid cooling or rear-door heat exchangers. EDSFF storage racks may need the same cooling infrastructure previously reserved for AI compute.

### Operational Model

When a single 1U chassis holds a petabyte, operational procedures change:

- **Drive replacement** is a 30-second hot-swap (latch, pull, insert), but the rebuild takes days. Operations teams need monitoring dashboards that track rebuild progress per drive and alert when rebuild time exceeds the safe window.
- **Chassis failure** is a multi-petabyte event. Runbooks need procedures for "chassis offline, 4 PB at risk." If erasure coding spans chassis (as it should), the data is safe, but the degraded state affects multiple erasure groups simultaneously.
- **Firmware updates** are higher-stakes. Updating NVMe firmware on a 245 TB drive while it's serving production traffic requires careful sequencing. A firmware bug that causes a drive to go offline during the update takes 245 TB out of the cluster for the duration of the rebuild.

---

## Conclusion

The EDSFF family tells a story in three acts. Act one is already playing out: E1.S is replacing U.2 in hyperscale deployments, quietly and without drama. Act two is starting now: E1.L and E3.L drives at 122-245 TB are forcing storage software to rethink rebuild times, failure domains, and power budgets in ways that most production systems aren't ready for.

Act three is E2. A petabyte per drive. Forty drives in a 2U chassis. Forty petabytes behind a single backplane. When Micron demos a 500 TB prototype and Meta designs the chassis around it, this isn't a research project. It's a roadmap item.

E2 breaks assumptions that E1.L merely stresses. A 23-day rebuild time for a 1 PB drive isn't a scaling problem you solve with faster hardware. It's a fundamental redesign of how storage software thinks about durability. Traditional rebuild (read everything, recompute parity, write everything back) doesn't work when "everything" is a petabyte. You need incremental, object-granular healing. You need erasure groups that span chassis so that a single drive failure never puts more than a fraction of its data at risk. You need placement algorithms that understand not just racks and power domains but the economic reality that the drive you lost costs more than some cars.

The form factor is changing. The software needs to change faster.

---

*EDSFF specifications: SFF-TA-1006 (E1.S), SFF-TA-1007 (E1.L), SFF-TA-1008 (E3.S), SFF-TA-1002 (connector), SFF-TA-1042 (E2), maintained by [SNIA SFF Technical Work Group](https://www.snia.org/forums/cmsi/knowledge/formfactors). Micron E2 500 TB prototype and warm storage thesis from [Micron blog](https://www.micron.com/about/blog/applications/data-center/edsff-e2-form-factor-purpose-built-for-data-center-warm-storage). Pure Storage 300 TB E2 prototype from [StorageReview](https://www.storagereview.com/news/edsff-e2-ssd-form-factor-emerges-at-ocp). Solidigm D5-P5336 122.88 TB from [ServeTheHome](https://www.servethehome.com/solidigm-d5-p5336-122-88tb-nvme-ssd-launched-shipping-in-q1-2025/). Samsung BM1743 128 TB from [AnandTech at FMS 2024](https://www.anandtech.com/show/21526/samsungs-128-tbclass-bm1743-enterprise-ssd-displayed-at-fms-2024). Kioxia LC9 245.76 TB from [Kioxia press release](https://americas.kioxia.com/en-us/business/news/2025/ssd-20250721-1.html) and [Tom's Hardware](https://www.tomshardware.com/pc-components/ssds/kioxia-unveils-245tb-ssd-the-worlds-highest-capacity-storage-device-could-store-12-500-4k-movies). EDSFF market share projections from [Kioxia/Meta E1.S white paper](https://americas.kioxia.com/content/dam/kioxia/en-us/business/ssd/data-center-ssd/asset/KIOXIA_Meta_Microsoft_EDSFF_E1_S_Intro_White_Paper.pdf). Intel Xeon 6760P PCIe lane counts from [Intel ARK](https://www.intel.com/content/www/us/en/products/sku/241836/intel-xeon-6760p-processor-320m-cache-2-20-ghz/specifications.html). Samsung PM1743 E3.S from [Samsung Semiconductor](https://semiconductor.samsung.com/ssd/enterprise-ssd/pm1743/). QLC endurance characteristics from [SNIA SSSI](https://www.snia.org/forums/sssi).*
