---
title: "Why SIMD Should Be Mandatory for Erasure Coding"
date: 2026-03-23
description: "Every production erasure coding library ships a scalar fallback path. This is treated as a virtue. It's actually a liability. Scalar Reed-Solomon on a single core tops out around 200 MB/s. A single NVMe Gen4 drive does 7 GB/s. SIMD isn't an optimization for EC. It's a structural requirement."
tags: ["storage", "erasure-coding", "simd", "performance"]
type: "standard"
featured: false
image: "/images/blog/simd-erasure-coding.png"
readTime: "18 min read"
---

![Scalar Path vs SIMD Path: Can you keep up?](/images/blog/simd-erasure-coding.png)

*Every production erasure coding library ships a scalar fallback path. This is treated as a virtue: "works on any hardware." It's actually a liability. A scalar Reed-Solomon encoder on a single core tops out around 200 MB/s. A single NVMe Gen4 drive does 7 GB/s sequential reads. Your erasure coding layer can't keep up with one drive, let alone twenty-four. SIMD isn't an optimization for EC. It's a structural requirement.*

---

## The Math That Makes This Unavoidable

Erasure coding in storage systems is almost universally Reed-Solomon over GF(2^8), the Galois field with 256 elements. Every byte value (0x00 through 0xFF) is an element of this field. Addition is XOR. Multiplication is polynomial multiplication modulo an irreducible polynomial (typically x^8 + x^4 + x^3 + x^2 + 1, the same one AES uses).

Reed-Solomon encoding works like this: you take K data shards and compute M parity shards by multiplying each data shard by a row of a coding matrix over GF(2^8). The computation is:

```
parity[j][i] = Σ (matrix[j][k] * data[k][i])   for k = 0..K-1
```

Where every `*` is a GF(2^8) multiply and every `Σ` is a GF(2^8) add (XOR). For a 4+2 scheme (4 data shards, 2 parity shards), encoding one byte position requires 8 GF multiplies and 6 XORs. For a shard of 1 million bytes, that's 8 million GF multiplies.

### Why GF(2^8) Multiply Is Expensive in Scalar

Scalar GF(2^8) multiplication on a general-purpose CPU requires one of two approaches:

**Lookup table.** Precompute a 256x256 multiplication table (64 KB), then each multiply is a table lookup. The problem: 64 KB doesn't fit in L1 cache (typically 32-48 KB). Under sustained encoding with random data, you get constant L1 cache misses. Measured throughput: **150-300 MB/s** on modern x86 cores, depending on data patterns and cache behavior.

**Log/exp table.** Convert to logarithms in GF(2^8) (a 256-byte table), add, convert back via antilog (another 256-byte table). Two lookups plus an add and a modular reduction. Both tables fit in L1, but each multiply now costs 4-5 dependent memory accesses. Measured throughput: **200-400 MB/s**.

Either way, scalar GF multiplication is fundamentally slow because it's memory-bound, not compute-bound. The CPU has plenty of ALU cycles to spare, but it's waiting on table lookups.

### Why SIMD Transforms the Problem

SIMD doesn't just do the same thing faster. It transforms GF multiplication from a memory-bound lookup into a compute-bound parallel operation. The technique is called **split table multiplication with SSSE3/AVX2 shuffles**, and it's brilliantly simple.

The core insight: any GF(2^8) multiply by a constant `c` can be decomposed into two 4-bit lookups:

```
c * x = table_lo[x & 0x0F] XOR table_hi[x >> 4]
```

Where `table_lo` and `table_hi` are 16-entry tables (one for each nibble value). Each table has 16 entries of 1 byte = 16 bytes. Sixteen bytes is exactly the width of an SSE register.

The `PSHUFB` (Packed Shuffle Bytes) instruction takes a 16-byte register of table entries and a 16-byte register of indices, and returns a 16-byte register of looked-up values. It's a 16-way parallel table lookup that executes in a single clock cycle.

```
┌─────────────────────────────────────────────┐
│  One PSHUFB instruction:                    │
│  Input:  16 bytes of data (low nibbles)     │
│  Table:  16 bytes of GF multiply results    │
│  Output: 16 GF multiplications in 1 cycle   │
├─────────────────────────────────────────────┤
│  Two PSHUFBs + one PXOR:                    │
│  = 16 full GF(2^8) multiplications          │
│  = 3 instructions, ~1-2 clock cycles        │
└─────────────────────────────────────────────┘
```

With AVX2 (256-bit registers), you get 32 GF multiplies per PSHUFB. With AVX-512, 64. Each instruction has a throughput of one per clock on modern CPUs (Zen 4, Golden Cove).

This is why the throughput gap is so large. The scalar path does one GF multiply per 3-5 cycles (table lookup latency). The SIMD path does 32-64 GF multiplies per 3 cycles (two shuffles plus XOR). That's a **50-100x** improvement per core.

---

## The Throughput Gap: Numbers That Should Scare You

Here are measured encode throughput numbers for a 4+2 Reed-Solomon configuration on a single core:

| Implementation | ISA | Throughput (GB/s) | Notes |
|---------------|-----|-------------------|-------|
| Scalar (log/exp table) | Generic | 0.2-0.4 | L1 cache dependent |
| SSSE3 (128-bit PSHUFB) | x86-64 | 2.0-3.0 | 2009+ CPUs |
| AVX2 (256-bit VPSHUFB) | x86-64 | 6.0-9.0 | 2013+ CPUs |
| AVX-512 (512-bit VPSHUFB) | x86-64 | 12.0-18.0 | Xeon, EPYC |
| NEON (128-bit TBL) | AArch64 | 3.0-6.0 | Apple M-series, Graviton |
| SVE/SVE2 (variable width) | AArch64 | 5.0-10.0 | Graviton 3+, Neoverse V2 |

*Throughput = input data processed per second. Sources: ISA-L benchmarks, reed-solomon-simd benchmarks, klauspost/reedsolomon Go benchmarks.*

Now compare with what you need to keep up:

| Drive Configuration | Sequential Read Throughput | EC Encode Required |
|--------------------|--------------------------|-------------------|
| 1x NVMe Gen4 | 7 GB/s | 7 GB/s |
| 1x NVMe Gen5 | 14 GB/s | 14 GB/s |
| 4x NVMe Gen4 | 28 GB/s | 28 GB/s |
| 24x NVMe Gen4 | 168 GB/s | 168 GB/s |
| 32x NVMe Gen5 | 448 GB/s | 448 GB/s |

A scalar encoder at 300 MB/s cannot keep up with **a single NVMe Gen4 drive**. You'd need 23 dedicated CPU cores just for EC encoding to match one 7 GB/s drive. For a 24-drive system, you'd need 560 cores. For scalar encoding. This isn't a "nice to have faster" situation. Scalar EC at NVMe line rate is a mathematical impossibility.

With AVX2, a single core encodes at ~8 GB/s, enough to keep up with one Gen4 drive. Four cores cover a 24-drive system at typical write rates. That's the difference between "dedicating your entire CPU budget to erasure coding" and "EC is a rounding error in your CPU utilization."

---

## How Production Systems Do It

Nobody ships scalar EC in production. Let me walk through what the major storage systems actually use.

### Intel ISA-L (Intelligent Storage Acceleration Library)

The gold standard. ISA-L is Intel's open-source library that provides SIMD-optimized erasure coding (plus CRC, compression, and crypto). Ceph uses it as the primary EC engine. HDFS uses it via Intel's native EC codec. DAOS runs it natively.

ISA-L detects CPU features at runtime (CPUID) and dispatches to the fastest available kernel: AVX-512 > AVX2 > SSSE3 > SSE2. On a Sapphire Rapids Xeon, ISA-L's `ec_encode_data` hits 15+ GB/s per core for typical RS configurations.

The downside: ISA-L is C code with handwritten assembly for each ISA target. Integrating it into a Rust or Go storage system means crossing an FFI boundary.

### klauspost/reedsolomon (Go)

The de facto standard for EC in the Go ecosystem. Used by several major object storage systems. It uses Go assembly (`.s` files) with AVX2 and NEON kernels. No scalar fallback in the hot path. The library detects SIMD support at init time and panics (or falls back to a dramatically slower pure-Go path) if the minimum ISA isn't available.

Performance: 8-12 GB/s per core on AVX2. Competitive with ISA-L despite being Go assembly rather than C/intrinsics.

Klaus Post also wrote `leopard-rs`, a library for Leopard-RS (a different EC algorithm based on FFTs over GF(2^16)), which achieves even higher throughput for configurations with many parity shards.

### reed-solomon-simd (Rust)

Pure Rust, no C dependencies, no handwritten assembly. It uses Rust's `std::arch` SIMD intrinsics (AVX2 `_mm256_shuffle_epi8`, NEON `vqtbl1q_u8`) to implement the split-table GF multiply technique. Runtime detection via the `cpufeatures` crate.

Performance: 6-10 GB/s per core on AVX2, 3-6 GB/s on NEON. Slightly behind ISA-L on peak throughput, but the entire implementation is memory-safe Rust (the SIMD intrinsics are `unsafe`, but they're encapsulated in a well-tested library, not scattered through application code).

The API is clean:

```rust
// Encode: data shards in, parity shards out
let parity = reed_solomon_simd::encode(
    data_shards,    // K = 8
    parity_shards,  // M = 4
    &data_slices,   // &[&[u8]], K slices of equal length
)?;

// Decode: any K of K+M shards in, missing shards out
let restored = reed_solomon_simd::decode(
    data_shards,
    parity_shards,
    surviving_data.iter().map(|(idx, data)| (*idx, data.as_slice())),
    surviving_parity.iter().map(|(idx, data)| (*idx, data.as_slice())),
)?;
```

No configuration for SIMD mode. No feature flags. It detects what your CPU supports and uses the fastest available path. If your CPU has SSSE3 (any x86-64 CPU made after 2008), it uses SIMD. If you're on ARM with NEON (any ARMv8 CPU, so any Apple Silicon, any Graviton, any Ampere Altra), it uses SIMD.

---

## The Fallback Trap

So if every production library uses SIMD, why do they all ship scalar fallback code?

The usual justifications:

**"CI/CD environments might not have SIMD."** This is the most common excuse and the weakest. CI runners on GitHub Actions, GitLab CI, and every major cloud provider run on x86-64 CPUs with at least AVX2 (Haswell-era, 2013). ARM CI runners have NEON. If your CI environment doesn't support SSSE3, your CI environment is running on a CPU from 2007 and you have bigger problems.

**"Portability to exotic architectures."** Fair enough for a general-purpose library. Not relevant for a storage system. Storage systems run on x86-64 or AArch64. Period. Nobody is deploying petabyte-scale object storage on MIPS, RISC-V (yet), or PowerPC. When RISC-V storage deployments become real, they'll have the V (vector) extension, which supports the same shuffle-based GF multiply technique.

**"Graceful degradation is better than hard failure."** This sounds reasonable until you think about what "graceful degradation" means for EC. At 300 MB/s encode throughput, your 24-NVMe storage node has silently become a 300 MB/s system. That's not graceful degradation. That's a 50x performance cliff that no monitoring dashboard will explain because the system is "working." A hard failure at startup with a clear error message ("SIMD required: AVX2 or NEON not detected") is infinitely more debuggable than mysterious throughput collapse.

**"The compiler will auto-vectorize it."** No, it won't. Auto-vectorization works on simple loops with straightforward arithmetic: add, multiply, compare. GF(2^8) multiplication is not straightforward arithmetic. It's polynomial multiplication modulo an irreducible polynomial. The compiler doesn't know about carry-less multiply. It doesn't know that XOR is addition in GF(2). It doesn't know that the nibble-split lookup trick transforms a memory-bound computation into a compute-bound one. I've looked at the codegen from `rustc` and `gcc` with `-O3 -mavx2` for a scalar GF multiply loop. Neither compiler vectorizes it. They emit byte-at-a-time table lookups, exactly as written.

The right answer: SIMD should be a hard requirement at startup. Check CPUID, verify AVX2 (x86) or NEON (ARM), and refuse to start if neither is present. Print a clear error. Don't silently fall back to a path that makes your system 50x slower.

---

## Cauchy vs Vandermonde: The Matrix Matters

Not all Reed-Solomon implementations are equal, even at the same SIMD width. The choice of coding matrix affects how much work the SIMD units actually do.

### Vandermonde Matrices

Classical Reed-Solomon uses a Vandermonde matrix (powers of generator elements):

```
┌                           ┐
│  1    1    1    1   ...    │
│  α⁰   α¹   α²   α³  ...  │
│  α⁰   α²   α⁴   α⁶  ...  │
│  α⁰   α³   α⁶   α⁹  ...  │
└                           ┘
```

Each matrix entry is a GF(2^8) element. Computing parity requires multiplying each data byte by the matrix entry and XORing the results. With SIMD, each matrix-entry multiply uses the split-table technique (2 shuffles + 1 XOR per multiply).

For M parity shards and K data shards, each byte position requires M*K GF multiplies = M*K * (2 shuffles + 1 XOR) = 3*M*K SIMD instructions.

### Cauchy Matrices

Cauchy matrices over GF(2^8) have a useful property: they can be decomposed into binary matrices (over GF(2)) through a process called "binary extension." Each GF(2^8) multiply becomes 8x8 XOR operations on individual bits.

Many entries in the binary-extended Cauchy matrix are 0 or 1. Zero entries skip computation entirely. One entries are just XOR (no multiply needed). Only entries that are neither 0 nor 1 require a GF multiply.

In practice, a well-constructed Cauchy matrix reduces the total operation count by 20-40% compared to Vandermonde for typical storage configurations (K=4-16, M=2-4). More importantly, the operations that remain are predominantly XORs, which are cheaper than shuffles on all SIMD architectures (XOR has higher throughput and lower latency than PSHUFB on Intel cores).

**Who uses what:**

| Library | Matrix Type | Notes |
|---------|-------------|-------|
| ISA-L | Cauchy | Optimized binary Cauchy with XOR reduction |
| klauspost/reedsolomon | Cauchy (via Leopard-like optimization) | Default for new encoders |
| reed-solomon-simd | Cauchy | Binary extension with XOR optimization |
| Jerasure | Both (configurable) | Cauchy recommended |

The industry has converged on Cauchy. If someone tells you their RS implementation uses a Vandermonde matrix, they're leaving 20-40% of SIMD throughput on the table.

---

## ARM Isn't x86-Lite: NEON and SVE Are Real

A common misconception: SIMD-optimized EC is "an Intel thing" and ARM systems get scalar fallbacks. This hasn't been true since 2011.

ARM NEON provides 128-bit SIMD with the `TBL` instruction, which is functionally equivalent to x86's `PSHUFB` for table lookups. Every ARMv8-A CPU has NEON. That includes:

- **Apple M1/M2/M3/M4.** All Mac and iPad chips since 2020.
- **AWS Graviton 2/3/4.** The most popular ARM server platform.
- **Ampere Altra/AmpereOne.** Up to 192 cores, designed for cloud.
- **NVIDIA Grace.** The CPU half of Grace Hopper superchip.

NEON EC throughput is typically 3-6 GB/s per core. On a 128-core Ampere Altra, that's 384-768 GB/s aggregate EC throughput across all cores. Plenty for even the densest NVMe configurations.

ARM SVE (Scalable Vector Extension) goes further. SVE vector widths are implementation-defined (128 to 2048 bits), and SVE2 (mandatory in ARMv9) adds cryptographic and per-lane operations that can further accelerate GF arithmetic. AWS Graviton 3 has SVE with 256-bit vectors; Neoverse V2 (Graviton 4) has the same. SVE EC implementations are still maturing, but early benchmarks show 30-50% throughput improvement over NEON.

If you're designing a storage system in 2026 that runs on ARM (and you should be, given Graviton's price-performance advantage), your EC library needs NEON support as a first-class citizen, not an afterthought. The major libraries (ISA-L, klauspost/reedsolomon, reed-solomon-simd) all provide it.

---

## The Decode Side: Even More SIMD-Critical

Everything above focuses on encode throughput. Decode (reconstruction from partial shards after a failure) is worse.

RS decode requires:

1. **Matrix inversion.** Given the set of K surviving shards (out of K+M), compute the inverse of the corresponding K-row submatrix of the coding matrix. This is O(K^3) GF multiplies. For K=16, that's 4,096 GF multiplies. Expensive, but it's a one-time cost per reconstruction.

2. **Matrix-vector multiplication.** Multiply each surviving shard by the inverted matrix to recover the missing shards. This is the same structure as encoding: M_missing * K GF multiplies per byte position.

The practical effect: decode throughput is roughly (K / M_missing) * encode throughput for the matrix-vector phase, but the constant factor is larger because the inverted matrix entries are "random" GF elements (unlike the structured Cauchy matrix used for encoding), which means fewer zero/one optimizations.

Decode throughput for 8+4 with 4 shards lost, AVX2:

| Library | Decode Throughput (GB/s per core) |
|---------|----------------------------------|
| ISA-L | 3.5-5.0 |
| klauspost/reedsolomon | 3.0-4.5 |
| reed-solomon-simd | 2.5-4.0 |
| Scalar fallback | 0.08-0.15 |

Scalar decode is even slower than scalar encode because the inverted matrix has worse cache behavior. At 100 MB/s, reconstructing a single 30 TB drive takes **83 hours**. With AVX2 at 4 GB/s on 4 dedicated cores, it's **2 hours**. That's the difference between "your data is at risk for 3.5 days" and "your data is at risk for 2 hours."

In a system with 24 drives where the probability of a second drive failure increases with time, reconstruction speed directly determines your MTTDL (Mean Time To Data Loss). Scalar decode doesn't just make things slower. It makes your data less durable.

---

## What "Mandatory" Looks Like in Practice

I've argued that SIMD should be a hard requirement for EC. Here's what that means concretely in a storage system's codebase.

### Startup Check

```rust
fn verify_simd_support() -> Result<(), StartupError> {
    #[cfg(target_arch = "x86_64")]
    {
        if !std::is_x86_feature_detected!("avx2") {
            return Err(StartupError::UnsupportedHardware(
                "AVX2 required for erasure coding. \
                 CPU does not support AVX2 (requires Haswell/2013 or later)."
                    .into(),
            ));
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        // NEON is mandatory in ARMv8-A. If we're on AArch64, we have it.
        // No check needed.
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        return Err(StartupError::UnsupportedHardware(
            "Unsupported architecture. Erasure coding requires \
             x86-64 (AVX2) or AArch64 (NEON)."
                .into(),
        ));
    }

    Ok(())
}
```

This runs once at process startup, before any data is written. If the check fails, the process prints a clear error and exits. No silent degradation. No surprise 50x slowdown three months later when someone replaces a drive and triggers a rebuild.

### Library Choice

Use a library that is SIMD-first, not SIMD-optional:

- **reed-solomon-simd** (Rust): automatically detects and uses the fastest available ISA. The library name literally has "simd" in it.
- **ISA-L** (C): the "ISA" stands for "Intelligent Storage Acceleration." SIMD is the product, not a feature.
- **klauspost/reedsolomon** (Go): uses Go assembly with SIMD kernels. The scalar path exists but is documented as "do not use in production."

### No Feature Gate for Scalar

Don't provide a `--allow-scalar-ec` flag. Don't add a `disable-simd` feature in your Cargo.toml. Every escape hatch becomes someone's production configuration. The moment you add a scalar option, someone will enable it "just for testing" and forget to disable it. A year later, you're debugging why a customer's rebuild is taking 4 days and the answer is a flag in a config file nobody remembers setting.

---

## The Counter-Arguments (And Why They're Wrong)

### "But what about testing on my laptop?"

Your laptop has AVX2. Every Intel laptop since Haswell (2013) and every AMD laptop since Excavator (2015) supports AVX2. Every Apple Silicon Mac has NEON. If you're developing a storage system on a laptop that doesn't support SSSE3, you're working on hardware that's old enough to vote.

### "What about Docker / QEMU / emulated environments?"

Docker passes through the host CPU's SIMD support. If your Docker host has AVX2, containers see AVX2. QEMU with KVM also passes through host SIMD. QEMU in full emulation mode doesn't, but nobody runs production storage in full CPU emulation.

### "What about WASM?"

WASM has SIMD128, which is equivalent to SSE2/NEON (128-bit vectors). This is enough for PSHUFB-based GF multiply. Regardless, nobody is running erasure coding in WASM in production storage. This is a future concern, not a present one.

### "The throughput gap will shrink as CPUs get faster."

The gap scales with vector width. As CPUs add wider SIMD (AVX-512 was 512 bits, ARM SVE can be up to 2048 bits), the SIMD path gets proportionally faster. The scalar path doesn't. The gap is widening, not shrinking.

---

## A Real-World Pipeline

Here's what the data flow looks like in a SIMD-mandatory storage system for a 100 MB PUT with 8+4 erasure coding:

```
Client sends 100 MB object
    ↓
Compress (LZ4, ~2 GB/s)                    → 60 MB compressed
    ↓
Encrypt (AES-256-GCM, ~4 GB/s per core)    → 60 MB + 16-byte tags
    ↓
EC Encode (reed-solomon-simd, AVX2)
  Split: 60 MB / 8 shards = 7.5 MB/shard
  Encode: 4 parity shards                  → 12 shards × 7.5 MB
  Time: ~8 ms (single core, 8 GB/s)
    ↓
BLAKE3 checksum per shard (~6 GB/s)         → 12 × 32-byte hashes
    ↓
Write 12 shards to NVMe (parallel)          → 90 MB total, ~13 ms at 7 GB/s
    ↓
Write metadata (FlatBuffer, <512 bytes)     → <1 ms
    ↓
Total wall time: ~35 ms
```

EC encoding at 8 ms is 23% of the total pipeline. Acceptable. With scalar encoding at 300 MB/s, the encode step alone would take 200 ms, ballooning total wall time to 225 ms and making EC the dominant bottleneck. The rest of the pipeline (compress, encrypt, hash, write) is fast. EC is only fast if you use SIMD.

---

## The Industry Has Already Decided

Look at the actual production deployments:

| System | EC Library | SIMD Required | Scalar Fallback |
|--------|-----------|--------------|-----------------|
| **Ceph** | ISA-L / Jerasure | Yes (ISA-L default) | Jerasure as fallback |
| **HDFS** | ISA-L (native codec) | Yes | Java fallback (10x slower) |
| **DAOS** | ISA-L | Yes | None |

Every system that matters uses SIMD for erasure coding. The ones that provide scalar fallbacks document them as "not for production use." HDFS's Java EC codec is so slow that the documentation explicitly recommends the ISA-L native codec for anything beyond testing.

The debate isn't "should we use SIMD for EC?" That question was answered a decade ago. The real question is "should we even compile the scalar path?" And my answer is no. Drop it. Ship SIMD-only. Your binary gets smaller, your test matrix gets simpler, and nobody accidentally deploys on a path that turns their storage system into a bottleneck.

---

## Conclusion

Erasure coding is GF(2^8) arithmetic at scale. GF(2^8) arithmetic is a shuffle-table computation that maps perfectly to SIMD instructions. Every modern CPU (x86-64 since 2008, AArch64 since 2011) has the SIMD instructions needed. The throughput gap between scalar and SIMD is 30-100x. NVMe drives are fast enough that scalar EC can't keep up with a single drive, let alone a chassis full of them.

The entire history of storage EC points in one direction: SIMD isn't optional. ISA-L, klauspost/reedsolomon, and reed-solomon-simd all implement the same split-table GF multiply technique, all use the same PSHUFB/TBL instruction, and all achieve throughput that makes EC a small fraction of the I/O pipeline instead of the bottleneck.

Ship your storage system with a CPUID check at startup. Require AVX2 on x86, NEON on ARM. Print a clear error if neither is present. Don't provide a scalar fallback, don't provide a flag to skip the check, and don't apologize for it. Any CPU that doesn't support SSSE3 is old enough that it shouldn't be running a storage system handling production data.

Your drives are fast. Your network is fast. Your compression is fast. Make sure your erasure coding is, too.

---

*ISA-L source and benchmarks from [Intel's ISA-L repository](https://github.com/intel/isa-l). klauspost/reedsolomon from [Klaus Post's GitHub](https://github.com/klauspost/reedsolomon). reed-solomon-simd from [crates.io](https://crates.io/crates/reed-solomon-simd). GF(2^8) split-table multiply technique described in James Plank's [FAST 2013 tutorial](http://web.eecs.utk.edu/~jplank/plank/papers/FAST-2013-Tutorial.html). Cauchy RS optimization from Plank and Xu, ["Optimizing Cauchy Reed-Solomon Codes for Fault-Tolerant Storage Applications"](http://web.eecs.utk.edu/~jplank/plank/papers/CS-05-569.pdf). NVMe Gen4/Gen5 throughput from NVM Express specification 2.0. NEON shuffle instruction reference from [ARM Architecture Reference Manual](https://developer.arm.com/documentation/ddi0487/latest). Ceph EC configuration from [Ceph documentation](https://docs.ceph.com/en/latest/rados/operations/erasure-code-isa/). HDFS native codec recommendation from [Apache HDFS EC documentation](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSErasureCoding.html).*
