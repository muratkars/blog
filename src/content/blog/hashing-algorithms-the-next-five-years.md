---
title: "The Hash That Holds Your Data Together"
date: 2026-03-21
description: "A practitioner's guide to CRC32, MD5, SHA-256, XXHash, HighwayHash, BLAKE2, and BLAKE3. What each was designed for, where each breaks down, and which one you should bet your architecture on for the next five years."
tags: ["storage", "data-integrity", "hashing", "performance"]
type: "standard"
featured: false
image: "/images/blog/hash-browns.png"
readTime: "16 min read"
---

![A hash brown character holding your data together](/images/blog/hash-browns.png)

*A practitioner's guide to CRC32, MD5, SHA-256, XXHash, SipHash, HighwayHash, BLAKE2, and BLAKE3. What each was designed for, where each breaks down, and which one you should bet your architecture on for the next five years.*

---

## Why This Matters More Than You Think

Every storage system makes a hashing decision early in its life, and that decision haunts it forever.

ZFS chose fletcher4 in 2005, a fast, non-cryptographic checksum that can't detect adversarial corruption. Twenty years later, OpenZFS is backporting BLAKE3 support because the original choice wasn't strong enough. btrfs shipped with CRC32C, giving you 32 bits of collision resistance in a world where a single NVMe drive holds 30 TB. HDFS used CRC32C and never offered anything else. AWS S3 used MD5 for ETags and spent nearly two decades unable to change it. Only in 2024 did they finally default to CRC64-NVME.

MinIO chose HighwayHash in 2017. I was there. It was the right call at the time: blazing fast, keyed integrity, perfect for bitrot detection. The hash field in 2026 looks nothing like 2017.

The hash you choose determines your collision resistance, your throughput ceiling, your regulatory compliance story, your post-quantum readiness, and (if you're building something meant to last) whether your integrity guarantees will still hold in 2031.

This is the guide I wish I'd had before making hashing decisions at three different storage companies.

---

## The Contenders

Let me lay out the field. Nine algorithms, three categories, one question: which one deserves to be the default for the next generation of object storage?

### The Non-Cryptographic Speed Demons

| Algorithm | Throughput (GB/s) | Output | Collision Bits | Year |
|-----------|------------------|--------|---------------|------|
| CRC32C (SSE4.2) | ~5.7 | 32-bit | 32 | 1975 |
| CRC32C (AVX-512 VPCLMULQDQ) | **~97** | 32-bit | 32 | 2019+ |
| XXHash3 (64-bit) | **~31.5** | 64-bit | 64 | 2019 |
| XXH128 | ~29.6 | 128-bit | 128 | 2019 |

### The Keyed PRFs (Pseudorandom Functions)

| Algorithm | Throughput (GB/s) | Output | Security Model | Year |
|-----------|------------------|--------|---------------|------|
| SipHash-2-4 | ~2.0 | 64-bit | Keyed PRF | 2012 |
| SipHash-1-3 | ~3.8 | 64-bit | Keyed PRF (reduced) | 2012 |
| HighwayHash-256 (AVX2) | **~10-12** | 256-bit | Keyed PRF | 2016 |

### The Cryptographic Hashes

| Algorithm | Throughput (GB/s) | Output | Collision Bits | FIPS | Year |
|-----------|------------------|--------|---------------|------|------|
| MD5 | ~0.69 | 128-bit | **0 (broken)** | Disallowed | 1992 |
| SHA-256 (no SHA-NI) | ~0.22 | 256-bit | 128 | **Yes** | 2001 |
| SHA-256 (SHA-NI hw) | ~1.5 | 256-bit | 128 | **Yes** | 2001 |
| SHA-3-256 | ~0.55 | 256-bit | 128 | **Yes** | 2015 |
| BLAKE2b-256 | ~0.75 | 256-bit | 128 | No | 2012 |
| **BLAKE3** (AVX2) | **~6.4** | 256-bit | 128 | No | 2020 |
| **BLAKE3** (AVX-512) | **~8.4** | 256-bit | 128 | No | 2020 |
| **BLAKE3** (multi-threaded) | **~15.8** | 256-bit | 128 | No | 2020 |

*Benchmarks: single-threaded on modern x86-64 (Cascade Lake, Ice Lake, Sapphire Rapids class), large messages (≥4 KB). Sources: BLAKE3 paper, xxHash repo, Google HighwayHash repo, btrfs wiki, Joey Lynch's hash benchmarks.*

Look at that table carefully. BLAKE3 on AVX2 delivers **6.4 GB/s**. Cryptographic-strength hashing, at a speed nobody would have believed five years ago. 4x faster than SHA-256 with hardware acceleration. 8x faster than BLAKE2b. 30x faster than SHA-256 in software.

And it's the only cryptographic hash in the table that gets *faster* when you throw more cores at it.

---

## Algorithm by Algorithm: The Full Story

### CRC32C: The Honest Checksum

**What it is.** A 32-bit cyclic redundancy check using the Castagnoli polynomial (0x1EDC6F41), hardware-accelerated via Intel's SSE4.2 `CRC32` instruction since Nehalem (2008).

**What it's good for.** Detecting random bit errors in transit: network corruption, memory errors, storage media degradation. CRC32C is the workhorse of error detection in databases (RocksDB, ScyllaDB), network protocols (iSCSI, gRPC), and filesystems (btrfs default).

**What it can't do.** Anything adversarial. CRC32C has exactly 32 bits of collision resistance, which means a brute-force collision takes roughly 2^16 = 65,536 attempts. An attacker with a laptop can forge a collision in milliseconds. It cannot detect intentional tampering. It cannot serve as a content address. It cannot provide deduplication safety.

**The hardware acceleration story is remarkable.** On Sapphire Rapids with AVX-512 VPCLMULQDQ, CRC32C hits **97 GB/s**, faster than DRAM bandwidth on most systems. But speed doesn't compensate for 32 bits of output. A 30 TB NVMe drive has roughly 2^34 sectors; with 32-bit checksums, you expect at least one undetected collision by random chance once the drive is ~16% full. For petabyte-scale storage, CRC32C is structurally inadequate.

**Who still uses it.** btrfs (default), HDFS, RocksDB, gRPC. These are legacy choices that made sense when CPU time was expensive and disks were small.

**Verdict.** Use it for wire-level error detection where you also have a stronger integrity check at rest. Never use it as your only defense against corruption.

---

### MD5: The Walking Dead

**What it is.** A 128-bit cryptographic hash designed by Ron Rivest in 1991. Merkle-Damgard construction, 64 rounds.

**Why it's still everywhere.** AWS S3 defined ETags as MD5 digests in 2006. Every S3 client in the world computes MD5 on upload. Every S3 server in the world returns MD5 in the ETag header. Changing this required nearly two decades of backwards compatibility work. AWS only defaulted to CRC64-NVME for new buckets in 2024.

**Why it must die.** MD5 has been cryptographically broken since 2004. [Wang et al.](https://link.springer.com/chapter/10.1007/978-3-540-30539-2_1) demonstrated collision attacks that year. By 2008, researchers demonstrated [chosen-prefix collisions against X.509 certificates](https://www.win.tue.nl/hashclash/rogue-ca/). Today, a full MD5 collision takes under a second on a single core.

The only reason to compute MD5 in 2026 is S3 API compatibility. MinIO's brilliant hack, the [md5-simd](https://github.com/minio/md5-simd) library that uses AVX-512 to compute 16 MD5 hashes simultaneously, pushes aggregate throughput to 17 GB/s. But that's 17 GB/s of effort wasted on a broken algorithm, spent purely because AWS defined the API 20 years ago.

**Verdict.** Compute it for ETags if you must speak S3. Never use it for integrity, addressing, or deduplication.

---

### SHA-256: The Regulatory Standard

**What it is.** The 256-bit member of the SHA-2 family (FIPS 180-4), designed by the NSA. Merkle-Damgard construction, 64 rounds.

**Performance:**
- Software: ~220 MB/s, painfully slow for storage workloads
- SHA-NI hardware (all modern x86 since 2017): ~1.5 GB/s, usable but not fast
- AVX-512 multi-buffer (8 parallel streams): ~3.5 GB/s aggregate

**The FIPS advantage is real.** SHA-256 is the only hash function in this comparison that is approved under FIPS 180-4 and FIPS 140-3. If your storage system serves U.S. government agencies, healthcare organizations under HIPAA, financial institutions, or defense contractors, SHA-256 is not optional. It's mandated. No amount of BLAKE3 benchmarks changes a compliance requirement.

**The performance disadvantage is also real.** At 1.5 GB/s with SHA-NI, SHA-256 is 4x slower than BLAKE3 on AVX2 and 55x slower than BLAKE3 multi-threaded. On a storage node processing 10 million objects per day, that's the difference between hashing being invisible overhead and hashing being a measurable bottleneck.

**Who uses it.** ZFS (optional), btrfs (optional), git (migrating from SHA-1), Bitcoin, TLS, Docker content addressing, AWS SigV4 authentication.

**Verdict.** The compliance hash. Use it when regulations demand it. Don't use it by default when you have better options. You're paying a 4-7x performance tax for a NIST stamp.

---

### SHA-3 (Keccak): The Insurance Policy Nobody Uses

**What it is.** The winner of NIST's SHA-3 competition (2012), standardized as FIPS 202. Sponge construction based on the Keccak permutation, fundamentally different from SHA-2's Merkle-Damgard design.

**Performance.** ~0.55 GB/s on modern x86-64. That's slower than SHA-256 with SHA-NI, and there are **no hardware acceleration instructions** for SHA-3 on any current x86 CPU. Intel has shown no interest in adding them.

**Why it exists.** NIST wanted a backup in case SHA-2 was broken. SHA-3's sponge construction means a break in SHA-2 wouldn't imply a break in SHA-3. It's also immune to length-extension attacks (unlike SHA-256), which matters for MAC constructions but is irrelevant for storage checksums.

**Why nobody uses it for storage.** It's slower than SHA-256 on hardware-accelerated x86, offers the same 128-bit collision resistance for SHA3-256, and has no unique advantage for integrity checking workloads. The [KangarooTwelve](https://keccak.team/kangarootwelve.html) variant (reduced-round Keccak with tree hashing) is significantly faster but isn't FIPS-standardized.

**Verdict.** Theoretically interesting, practically irrelevant for storage. Keep it in your regulatory toolkit in case SHA-2 is ever compromised. Don't build a storage system around it.

---

### XXHash3: The Speed King

**What it is.** Yann Collet's non-cryptographic hash, designed purely for speed. 64-bit and 128-bit variants.

**Performance.** **31.5 GB/s** on an i7-9700K with SSE2. At that speed, XXHash3 is faster than DRAM bandwidth. The benchmark data lives in L3 cache. In real-world scenarios where data streams from memory, XXHash3 is effectively memory-speed limited, not compute-limited.

**What it gives you.** Maximum throughput for non-adversarial checksumming. If your threat model is exclusively random bit errors (cosmic rays, media degradation, controller bugs), and you need maximum performance, XXHash3 is the answer.

**What it can't give you.** Any cryptographic guarantee whatsoever. XXHash3 is not designed to resist adversarial collisions, preimage attacks, or second-preimage attacks. A determined attacker can construct collisions efficiently. It is **not** a substitute for a cryptographic hash in any scenario where an adversary might modify data.

**Who uses it.** btrfs (xxhash64 option, recommended for performance-sensitive workloads), Ceph (internally), various databases for page checksums, data pipelines for deduplication of trusted data.

**Verdict.** The best non-cryptographic hash available. Use it for in-process checksums, page verification, and integrity checks within a trusted boundary. Never use it as the sole integrity mechanism for data at rest in a storage system exposed to untrusted clients.

---

### SipHash: The Hash Table Protector

**What it is.** A keyed PRF (pseudorandom function) designed by Jean-Philippe Aumasson and Daniel J. Bernstein specifically to protect hash tables against algorithmic complexity attacks (HashDoS).

**Performance.** ~2 GB/s for SipHash-2-4, ~3.8 GB/s for the reduced SipHash-1-3. Optimized for short inputs (8-64 bytes) rather than bulk data.

**Why it matters.** SipHash is the default hasher in Rust's standard library `HashMap` (SipHash-1-3) and Python's `dict` (SipHash-2-4). It's why modern languages are immune to the [2011 HashDoS attacks](https://events.ccc.de/congress/2011/Fahrplan/events/4680.en.html) that took down PHP, Java, and Ruby web servers.

**Why it doesn't matter for storage.** SipHash is designed for short, in-memory keys. Its per-byte cost is too high for multi-megabyte objects, and it requires a secret key, making it unsuitable for content addressing.

**Verdict.** Essential for hash tables. Irrelevant for storage integrity. You'll use it indirectly through Rust's HashMap, but never as a storage checksum.

---

### HighwayHash: The Keyed Speedster

**What it is.** A SIMD-accelerated keyed pseudorandom function developed at Google by Jan Wassenberg and Jyrki Alakuijala (2016). Designed to be the fastest hash that still provides strong integrity guarantees when keyed with a secret 256-bit key.

**Performance.** ~10-12 GB/s with AVX2. MinIO's [Go implementation](https://github.com/minio/highwayhash) achieves similar numbers on Skylake and later. All three output sizes (64, 128, 256 bit) run at the same speed; the core computation is identical, and only the output extraction differs.

**How it works.** HighwayHash's permutation is designed around SIMD instructions natively. Instead of computing scalar operations and hoping the compiler auto-vectorizes (it won't), the algorithm's internal state maps directly onto AVX2 lanes. Four 64-bit multiplies feed into a mixing step that uses vector addition and rotation. The result is a hash that runs at hardware speed by design, not by optimization.

The typical deployment pattern is bitrot detection in object storage: compute HighwayHash on write, store it alongside the data, verify on every read. Because it runs at 10+ GB/s, verification adds no measurable latency even on fast NVMe drives. If a shard fails verification, the storage system reconstructs from erasure-coded parity and heals the corrupted copy automatically. This inline-verify-and-heal loop is only practical because the hash is fast enough to run on every I/O without becoming a bottleneck.

**The limitation:**

HighwayHash is a keyed PRF, not a general-purpose cryptographic hash. This means:

1. **It requires a secret key.** Without the key, you can't verify the hash. This makes it useless for content addressing, deduplication across trust boundaries, and public integrity verification.
2. **It's not a collision-resistant hash.** The security claim is PRF security *under the key*. Given the key, an attacker still can't forge a valid hash. But unkeyed collision resistance (the property you need for content addressing) is not claimed and not proven.
3. **It hasn't received deep cryptanalysis.** Compared to the SHA-2/SHA-3/BLAKE families, which have been subjected to decades of international cryptanalytic effort (the SHA-3 competition alone generated thousands of papers), HighwayHash has received relatively modest scrutiny. The design is clever: the permutation uses SIMD instructions directly, avoiding the scalar bottlenecks of traditional ARX constructions. But "clever and fast" is not the same as "deeply analyzed and trusted."
4. **It's architecturally limiting.** Because the hash depends on a deployment-wide secret key, you can't compare hashes across deployments, you can't publish hashes for third-party verification, and you lose the hash if you lose the key.

**Verdict.** An excellent choice for keyed integrity checking in a closed system, exactly what MinIO uses it for. Not the right foundation for a next-generation storage system that needs content addressing, cross-deployment verification, and post-quantum durability.

---

### BLAKE2: The Bridge Generation

**What it is.** The successor to BLAKE (a SHA-3 finalist), designed by Jean-Philippe Aumasson, Samuel Neves, Zooko Wilcox-O'Hearn, and Christian Winnerlein. Standardized in RFC 7693. Two variants: BLAKE2b (64-bit optimized, 128-byte blocks) and BLAKE2s (32-bit optimized, 64-byte blocks).

**Performance.** BLAKE2b at ~750 MB/s is faster than SHA-256 in software but slower than SHA-256 with SHA-NI. The parallel variants (BLAKE2bp, BLAKE2sp) reach ~1.6 GB/s using 4-way or 8-way tree hashing, but this requires committing to a tree mode at the API level.

**Legacy.** BLAKE2 proved that the BLAKE/ChaCha core (add, rotate, XOR operations) could outperform SHA-256 while maintaining cryptographic security. It earned widespread adoption: WireGuard, libsodium, Zcash, Argon2, IPFS, btrfs (optional). The Rust ecosystem standardized on BLAKE2b through the `blake2` crate.

**Why BLAKE3 supersedes it.** BLAKE3 takes BLAKE2s's compression function, reduces rounds from 10 to 7, and wraps it in a Merkle tree that enables inherent parallelism without requiring a special API mode. The result: 6.4 GB/s vs. 750 MB/s, an **8.5x speedup** over BLAKE2b, using the same fundamental cryptographic core. BLAKE3 is to BLAKE2 what BLAKE2 was to SHA-256: the same security lineage, dramatically better performance.

**Verdict.** A great hash that served its era well. BLAKE3 is its direct successor in every meaningful dimension: faster, simpler API, built-in parallelism, same security lineage. New systems should use BLAKE3.

---

### BLAKE3: The Future

**What it is.** A cryptographic hash function built on a Merkle tree of BLAKE2s-derived compressions. Designed by Jack O'Connor, Jean-Philippe Aumasson, Samuel Neves, and Zooko Wilcox-O'Hearn. Released January 2020.

**Why it's different: the architecture.**

Every other cryptographic hash in this comparison is **inherently serial**. SHA-256 processes 64-byte blocks one at a time, where each block's compression depends on the previous block's output (Merkle-Damgard chaining). To hash a 1 MB file, you must perform ~16,384 sequential compressions. No amount of SIMD or multi-threading can parallelize this.

BLAKE3 breaks the chain. The input is split into **1,024-byte chunks**, each hashed independently. The chunk outputs form the leaves of a binary Merkle tree, and parent nodes combine pairs of children through a single compression call. This structure is embarrassingly parallel at every level:

```
Input: [chunk₀] [chunk₁] [chunk₂] [chunk₃] [chunk₄] [chunk₅] [chunk₆] [chunk₇]
          ↓        ↓        ↓        ↓        ↓        ↓        ↓        ↓
Level 0:  h₀       h₁       h₂       h₃       h₄       h₅       h₆       h₇
           \      /           \      /           \      /           \      /
Level 1:    h₀₁                h₂₃                h₄₅                h₆₇
              \              /                        \              /
Level 2:       h₀₁₂₃                                  h₄₅₆₇
                    \                              /
Root:                    BLAKE3(input)
```

**SIMD parallelism within a single thread.** The BLAKE2s-derived compression uses 32-bit words. An AVX2 register (256 bits) holds 8 x 32-bit values, allowing 8 independent chunk compressions to proceed in lockstep. AVX-512 doubles this to 16 chunks per vector operation. This is why BLAKE3 chose BLAKE2s (32-bit) over BLAKE2b (64-bit) as its base: twice the SIMD parallelism per register width.

| SIMD Level | Register Width | Chunks in Parallel | Input Window |
|-----------|---------------|-------------------|-------------|
| SSE4.1 | 128-bit | 4 chunks | 4 KiB |
| AVX2 | 256-bit | 8 chunks | 8 KiB |
| AVX-512 | 512-bit | 16 chunks | 16 KiB |
| ARM NEON | 128-bit | 4 chunks | 4 KiB |

**Multi-threaded parallelism across cores.** Because chunks are independent, the Rust implementation supports Rayon-based multithreading (opt-in). On an 8-core machine, BLAKE3 reaches ~15.8 GB/s, hashing faster than most NVMe drives can deliver data. The `b3sum` CLI tool enables this by default.

**Streaming verification.** The Merkle tree structure means a receiver can verify chunks incrementally without buffering the entire file. This enables verified streaming downloads, where each chunk can be authenticated independently against the root hash. For a storage system serving 100 GB objects, this is not a nice-to-have. It's essential.

**Extendable output (XOF).** BLAKE3 can produce output of any length: 128 bits, 256 bits, 384 bits, or beyond. Shorter outputs are prefixes of longer ones, enabling efficient truncation without recomputation. This matters for storage. You can store a 128-bit truncated hash for ETags, a 256-bit hash for integrity, and a 384-bit hash for post-quantum collision resistance, all from a single computation.

**Security:**

- **Collision resistance:** 128 bits (the authors explicitly claim 128-bit security)
- **Preimage resistance:** 256 bits classically, 128 bits under Grover's quantum algorithm
- **Rounds:** 7 (reduced from BLAKE2s's 10)
- **Security margin:** Best known attacks reach 2.5 rounds, leaving 64% of rounds untouched, a wider margin than AES-128 (30%) or SHA-256 (28%)
- **Cryptanalysis:** Zero known attacks better than generic on full 7-round BLAKE3, inheriting the extensive cryptanalytic effort from the BLAKE family during and after the SHA-3 competition
- **Side channels:** The ARX (add-rotate-XOR) construction is inherently constant-time. No table lookups, no data-dependent branches, no cache-timing vulnerabilities

**What it's missing:**

1. **FIPS certification.** BLAKE3 is not in FIPS 180-4, FIPS 202, or NIST SP 800-140C. An IETF Internet-Draft exists ([draft-aumasson-blake3](https://datatracker.ietf.org/doc/draft-aumasson-blake3/)) but it has not been adopted by a working group. For regulated environments, SHA-256 remains the only option.

2. **Post-quantum collision resistance at 256-bit output.** Under the BHT quantum collision algorithm, a 256-bit hash has ~85-bit collision resistance, below the 128-bit threshold. But BLAKE3's XOF mode can trivially produce 384-bit or 512-bit digests, restoring full 128-bit quantum collision resistance at negligible cost.

**Verdict.** BLAKE3 is the biggest jump in hash function design since SHA-256. Cryptographic strength, 6+ GB/s throughput, built-in parallelism, streaming verification, flexible output length. Its only limitation (no FIPS approval) is a regulatory gap, not a technical one.

---

## The Storage System Hash Decision Matrix

Let me cut through the benchmarks and give you the decision framework:

### If you need FIPS compliance

**SHA-256 with SHA-NI.** No choice. It's slow (1.5 GB/s), it's from 2001, and it's the only FIPS 180-4 approved option that's remotely practical. Budget 4-7x more CPU for hashing than a BLAKE3 system.

If you also need a backup in case SHA-2 is broken: SHA-3-256 (FIPS 202). But you'll pay an even steeper performance penalty.

### If you need maximum non-cryptographic speed

**XXHash3** for checksums within a trusted boundary. **CRC32C** if hardware-accelerated and you only need error detection (not integrity verification against any adversary). Use these for page checksums, network integrity, and in-process verification. Never as the sole integrity mechanism at rest.

### If you need keyed integrity (closed system)

**HighwayHash-256.** This is MinIO's model: a deployment-wide secret key, HighwayHash per shard, verified on every read. It works well for self-contained systems where you control both writer and reader. Understand the limitation: you can't do content addressing, cross-deployment verification, or public integrity proofs.

### If you're building new storage infrastructure

**BLAKE3.** And let me be specific about why:

1. **6.4 GB/s single-threaded (AVX2)** means hashing is never your bottleneck. Not on NVMe reads, not on 100 GbE network ingestion, not on erasure-coded shard verification.

2. **Cryptographic security without the performance tax.** You don't have to choose between "fast but insecure" (XXHash, CRC) and "secure but slow" (SHA-256, SHA-3). BLAKE3 is both.

3. **Content addressing is free.** Because BLAKE3 is an unkeyed cryptographic hash, the hash of an object is deterministic and verifiable by anyone. This enables deduplication, Merkle-tree-based replication verification, and public integrity proofs. None of which are possible with a keyed PRF like HighwayHash.

4. **Streaming verification is built in.** The Merkle tree structure means you can verify individual chunks of a multi-gigabyte object without reading the whole thing. For erasure-coded storage where you reconstruct objects from shards, this is essential.

5. **Post-quantum ready via XOF.** If quantum computing advances threaten 256-bit collision resistance (the BHT algorithm reduces it to ~85 bits), BLAKE3 can output 384-bit or 512-bit digests from the same computation, restoring 128-bit quantum collision resistance.

6. **The FIPS gap will close.** The IETF draft is in progress. BLAKE3's lineage (BLAKE was a SHA-3 finalist, BLAKE2 has RFC 7693 and wide deployment) gives it the pedigree for eventual standardization. In the meantime, offer SHA-256 as a configurable fallback for regulated deployments, but make BLAKE3 the default.

---

## The Next Five Years: Where Each Algorithm Lands

Here's where I think this goes between now and 2031:

### Rising

**BLAKE3.** It will become the default cryptographic hash for new systems. ZFS already supports it (OpenZFS 2.2+). The IETF draft will progress toward RFC status. More storage systems, VCS tools, and integrity frameworks will adopt it as the performance advantage becomes impossible to ignore.

### Stable

**SHA-256.** It's not going anywhere. FIPS compliance ensures its place. But it will increasingly be the "compliance fallback" rather than the default. New systems will use it only when regulations require it.

**XXHash3.** Dominant for non-cryptographic checksumming. The ~31 GB/s throughput at 128 bits of output is hard to argue with for trusted-boundary integrity checks.

### Declining

**HighwayHash.** Its niche (keyed integrity faster than any cryptographic hash) has shrunk. At 6.4 GB/s (BLAKE3) vs. 10-12 GB/s (HighwayHash), the speed gap is less than 2x now. And BLAKE3 gives you unkeyed cryptographic strength, content addressing, streaming verification, and post-quantum extensibility on top of that. Existing HighwayHash deployments will keep working fine, but new systems will pick BLAKE3.

**BLAKE2.** Superseded by BLAKE3 in every dimension. Existing deployments (WireGuard, libsodium, btrfs) will persist, but new projects will use BLAKE3.

**MD5.** Dead but undead. AWS S3 ETag compatibility will keep it shambling through codebases for another decade. Every S3-compatible server will compute it, and every engineer will wish they didn't have to.

### Extinct (for storage)

**CRC32C as a sole integrity mechanism.** 32 bits of collision resistance is indefensible at petabyte scale. Systems that use CRC32C today (btrfs default, HDFS) will either add stronger alternatives or accept the risk.

**SHA-3 for storage.** Without hardware acceleration on x86, it's slower than SHA-256 with SHA-NI and offers no practical advantage for integrity checking. Its role is NIST insurance, a backup if SHA-2 is ever broken, not a production hash for storage systems.

---

## The Uncomfortable Truth About Hash Migrations

I've been through this. At Nexenta, we inherited ZFS's fletcher4 and lived with its limitations. At my next company, we chose HighwayHash and built an entire integrity architecture around it. Both were the right call when they were made. Both have been overtaken.

The uncomfortable truth is this: **you cannot easily change a hash algorithm after deployment.** Every stored hash must be recomputed or maintained in parallel. Every client that validates hashes must be updated. Every integrity check that depends on hash comparison must handle the transition period where some objects have old hashes and some have new ones.

This is why the choice matters so much. The hash you choose today is the hash you'll live with for 5-10 years. Maybe longer. ZFS's fletcher4 is 20 years old and still the default.

If you're building something new in 2026, you have the luxury of starting clean. **BLAKE3 is the right default.** It's the fastest cryptographic hash available, it scales with your hardware (more SIMD lanes = faster, more cores = faster), it enables streaming verification and content addressing, and it has a clear path to post-quantum safety through its XOF mode.

Offer SHA-256 as a configurable option for FIPS compliance. Compute MD5 for S3 ETag compatibility. But make BLAKE3 the foundation, the hash that holds your data together for the next decade.

The era of choosing between fast and secure is over. BLAKE3 is both.

---

*Hash performance data from the [BLAKE3 paper](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf), [xxHash repository](https://github.com/Cyan4973/xxHash), [Google HighwayHash repository](https://github.com/google/highwayhash), and [Joey Lynch's hash benchmarks](https://jolynch.github.io/posts/use_fast_data_algorithms/). CRC32C AVX-512 numbers from [corsix/fast-crc32](https://github.com/corsix/fast-crc32). MinIO md5-simd from [minio/md5-simd](https://github.com/minio/md5-simd). MinIO HighwayHash from [minio/highwayhash](https://github.com/minio/highwayhash). BLAKE3 IETF draft at [datatracker.ietf.org](https://datatracker.ietf.org/doc/draft-aumasson-blake3/). BLAKE3 security analysis and round reduction from [BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs). Post-quantum hash security from [NIST Post-Quantum Cryptography](https://csrc.nist.gov/projects/post-quantum-cryptography) and the [BHT quantum collision algorithm](https://en.wikipedia.org/wiki/BHT_algorithm). btrfs checksum benchmarks from the [btrfs wiki](https://wiki.tnonline.net/w/Btrfs/Checksum_Algorithms). SHA-NI performance from [Intel SHA Extensions documentation](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sha-extensions.html).*
