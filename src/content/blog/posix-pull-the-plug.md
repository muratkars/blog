---
title: "Pull the Plug on POSIX"
date: 2026-03-07
description: "POSIX was a masterpiece of 1988 engineering. It also encodes assumptions about storage that are fundamentally incompatible with how data infrastructure works in 2026. It's time to stop building bridges to the past."
tags: ["storage", "posix", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/posix-pull-the-plug-hero.jpg"
readTime: "18 min read"
---

![Circuit board close-up representing legacy computing architecture](/images/blog/posix-pull-the-plug-hero.jpg)

*A 37-year-old standard is holding storage back.*

---

## Where POSIX Came From (and Why It Made Sense)

In 1983, the IEEE authorized a project to standardize the kernel interface across the proliferating zoo of Unix variants: AT&T System V, BSD, Xenix, SunOS, HP-UX, and others. The result, published in 1988 as IEEE Std 1003.1, was named POSIX (Portable Operating System Interface, the name suggested by Richard Stallman). Its goal was elegantly simple: write your program once, compile it on any conforming Unix, and it works.

POSIX's I/O model reflected the reality of 1988 computing:

- **One machine, one filesystem.** Storage was a disk attached to the machine your program ran on. Network filesystems (NFS) existed but were slow, unreliable, and optional.
- **Files in directories.** The hierarchical namespace (`/home/user/data/file.txt`) mapped directly to the on-disk structure of the Unix filesystem (UFS, later ext2/3/4, XFS, ZFS).
- **Open, read, write, close.** Stateful file descriptors tracked your position in a file. The kernel maintained per-process state for every open file.
- **Strong consistency.** A `write()` followed by a `read()` on the same file descriptor returns the data you just wrote. Always. Immediately. No eventual consistency, no stale reads.
- **Metadata is cheap.** `stat()`, `chmod()`, `chown()`, `utimes()`. Querying and modifying file metadata costs a few microseconds because the inode is on a local disk, cached in RAM.

For three decades, this model worked. It worked for workstations, for databases, for HPC (where parallel filesystems like Lustre and GPFS extended POSIX semantics across clusters), for web servers, for everything that ran on Unix.

It worked because the fundamental assumption held: **storage is local, or close enough to local that the abstraction doesn't leak.**

That assumption is now false. If you want the short version of why, skip to "The Way Forward" at the end. But if you want the full case, here are six reasons POSIX doesn't hold up at modern scale.

---

## The Six Sins of POSIX at Scale

### 1. The Metadata Wall

Every POSIX operation begins with metadata. `open()` traverses the directory tree, resolving each path component through inode lookups. `stat()` fetches inode attributes. `readdir()` enumerates directory entries. On a local ext4 filesystem with VFS caching, these operations complete in microseconds.

On a distributed filesystem with billions of files, they don't.

A metadata server (MDS) in Lustre, CephFS, or HDFS must handle every `stat()`, every `open()`, every `readdir()` from every client. AI training pipelines that scan millions of small image files (ImageNet: 14 million files, average 100 KB) generate **millions of metadata operations per minute**. The MDS becomes the bottleneck long before the data servers are saturated.

The standard workaround ("pack your small files into tar archives") is an admission that the filesystem abstraction has failed. When the recommended practice is to *work around* the interface rather than *use* it, the interface is wrong.

Object storage has no metadata server. A key like `training/imagenet/n01440764/n01440764_10026.JPEG` is hashed directly to a storage node. No directory traversal, no inode lookup, no centralized bottleneck. Flat namespaces scale linearly.

### 2. The Statefulness Tax

POSIX I/O is stateful. `open()` creates a file descriptor with an implicit seek position. The kernel tracks this state for every open file, across every process, on every node that mounts the filesystem.

In a distributed system with 1,000 clients, each with 100 open files, the filesystem must maintain **100,000 pieces of state** and keep them consistent. If a client crashes, the server must detect the failure and clean up its state (file locks, lease renewals, buffered writes). NFS's `statd` and `lockd` daemons exist solely to manage this complexity, and they are [notoriously unreliable](https://apenwarr.ca/log/20101213).

Object storage is stateless. `PUT /key` writes an object. `GET /key` reads it. No open, no close, no seek position, no file descriptor. Each request is self-contained. A crashed client leaves no state to clean up. A failed server leaves no orphaned locks to resolve.

### 3. The Locking Nightmare

POSIX defines two locking mechanisms: `flock()` (BSD advisory locks) and `fcntl()` (POSIX record locks). Both are broken in distributed environments.

The dysfunction is legendary:

- **`flock()` doesn't work over NFS.** Prior to Linux 2.6.12, `flock()` on NFS files locked only locally. Other nodes saw no lock at all. Kernel 2.6.12 "fixed" this by silently converting `flock()` calls to `fcntl()` POSIX locks, which broke programs that acquired both lock types on the same file.
- **`fcntl()` is unreliable over NFS.** Different kernel versions implement it differently. Some lock locally and don't notify the server. Some notify the server but do it wrong. There is [no way to detect](http://0pointer.de/blog/projects/locking.html) whether file locking actually works on a given NFS mount.
- **No locking method works on all remote filesystems.** `flock()` fails on NFS. `fcntl()` fails on SMB. There is literally no POSIX-compliant locking mechanism that works reliably across network filesystems.

Object storage doesn't need locks. Objects are immutable once written (or versioned). Concurrent writes to the same key are resolved by last-writer-wins or conditional writes (ETags, `If-Match`). There is no shared mutable state to protect.

### 4. The Consistency Trap

![Terminal screen with code, representing the complexity of POSIX interfaces](/images/blog/vintage-terminal.jpg)

POSIX guarantees close-to-open consistency at minimum, and many implementations provide stricter guarantees: a `read()` after a `write()` on the same file always returns the new data. In a distributed filesystem, maintaining this guarantee requires **distributed locking, cache invalidation, and consensus protocols** that scale poorly.

CephFS, which implements POSIX semantics over a distributed object store (RADOS), [documents its deviations from POSIX](https://docs.ceph.com/en/latest/cephfs/posix/) explicitly, because full compliance is either impossible or prohibitively expensive at scale. Lustre similarly relaxes POSIX guarantees under concurrent access to maintain performance.

But here's the thing: most modern applications don't need POSIX consistency. AI training reads are embarrassingly parallel. Each worker reads different files, no sharing. Analytics queries read immutable Parquet files. Log ingestion appends to different partitions. The consistency guarantees that POSIX enforces (at enormous cost) are consumed by almost nobody.

Object storage offers tunable consistency. S3 achieved strong read-after-write consistency in December 2020, not because POSIX demanded it, but because applications needed it. The system provides exactly the guarantee required, no more.

### 5. The Hierarchy Illusion

POSIX namespaces are hierarchical: directories contain files and other directories, forming a tree. This model assumes that the organizational structure of data is known at write time and doesn't change.

Modern data infrastructure violates this constantly. AI datasets are organized by task, not by filesystem path. The same image appears in training, validation, and test splits, requiring symlinks, hardlinks, or copies. Lakehouse tables are organized by partitions (year/month/day) that span many directories. A query for "all sales in Q3" must enumerate and `stat()` thousands of directory entries.

And the permission model is just as rigid. POSIX permissions (owner/group/other, rwx bits) were designed for multi-user Unix workstations: numeric UIDs, small local groups, per-file granularity. None of this maps to modern cloud infrastructure, where identity is federated (OAuth, OIDC, SAML), access control is policy-based (IAM), granularity is per-API-call (allow `GetObject` but deny `ListBucket` for the same prefix), and temporary credentials (STS, pre-signed URLs) have no POSIX equivalent.

Object storage solves both problems. Flat namespace with prefix-based listing: `ListObjectsV2(prefix="sales/2025/Q3/")` returns matching keys without traversing a directory tree. IAM policies attached to identities and evaluated per-request replace the rwx permission bits entirely.

### 6. The Syscall Overhead

Every POSIX I/O operation is a syscall: `open()`, `read()`, `write()`, `close()`, `stat()`, `fstat()`, `lseek()`, `fsync()`. Each syscall crosses the user-kernel boundary, triggering a context switch that costs 100-500 nanoseconds on modern hardware.

For a training pipeline reading millions of small files:
- `open()`: 1 syscall
- `fstat()`: 1 syscall (get file size)
- `read()`: 1-N syscalls (depending on file size)
- `close()`: 1 syscall

That's 4+ syscalls per file, millions of files, hundreds of nanoseconds each. **Millions of context switches per second just to read training data.** This is why frameworks like NVIDIA DALI, WebDataset, and TFRecord exist. They pack files into sequential archives to amortize syscall overhead across thousands of samples.

Object storage replaces this with a single HTTP request: `GET /key`. One network round-trip, one response, no kernel state transitions.

---

## The Gateway Trap: Why Translation Layers Are a Dead End

![Server room with dense network cabling](/images/blog/server-cables.jpg)

The storage industry's instinct, when confronted with a new paradigm, is to build a bridge. POSIX is everywhere. Applications expect it. So we'll put a POSIX layer on top of object storage and everyone can keep their existing code.

This is how we got:

- **Ceph RGW.** S3-compatible gateway over RADOS. Every PUT becomes a chain of internal writes with metadata bookkeeping. Translation overhead (multipart handling, bucket index updates, journal writes) can exceed actual data I/O.

- **S3FS-FUSE.** Mounts an S3 bucket as a local filesystem. Each `read()` becomes an HTTP GET, each `stat()` a HEAD request, each `readdir()` a ListObjects call. Microsecond operations become millisecond round-trips. [SNIA documented](https://www.snia.org/sniadeveloper/session/19445) why this fails for AI/ML workloads: 10-100x performance penalty.

- **HDFS.** Filesystem interface over distributed storage with relaxed POSIX semantics (append-only, no random writes). Still bottlenecked by a centralized NameNode for all metadata.

- **JuiceFS, cunoFS, Alluxio.** Modern attempts at high-performance POSIX over object storage. Better engineered than S3FS, but still constrained by the same impedance mismatch: every POSIX operation translates into one or more object operations, with metadata consistency maintained by an external database (Redis, TiKV, PostgreSQL).

Translation layers add latency, complexity, and failure modes. Gateways become bottlenecks. Bridges become constraints.

**The solution is not a better bridge. The solution is to stop crossing the river.**

Applications that need POSIX (legacy databases, desktop file managers, NFS-based workflows) will continue to use local or network filesystems. They always will. But new applications, new training pipelines, new analytics platforms, and new AI agent frameworks should be built on native object storage APIs. Not because POSIX is bad. It was great for what it was designed to do. But the workloads have changed, the scale has changed, and the assumptions have changed.

So if POSIX is the past and object storage is the present, what about the future?

---

## But What About Quantum Computing?

If POSIX is legacy, could quantum computing leapfrog the whole debate? Could quantum storage replace object storage entirely?

The short answer: no. Not in any timeline that matters for infrastructure decisions today.

### Why Quantum Storage Is Not a Thing (Yet)

Quantum computing's fundamental unit, the qubit, has a property that makes it useless for persistent storage: **decoherence**. A qubit's quantum state (the superposition that gives it computational power) decays over time as the qubit interacts with its environment. As of early 2026, coherence times range from microseconds to milliseconds for superconducting qubits.

For context: a modern NVMe SSD retains data for *years*. A qubit retains its state for *millionths of a second*.

Recent progress is encouraging. Researchers at the University of Innsbruck demonstrated a multi-ion quantum memory with a coherence time exceeding two hours in a cryogenic trap. But this required exotic laboratory conditions and stored a *single qubit*. Storing a petabyte (8 x 10^18 bits) with quantum fidelity is not an engineering challenge we're within decades of solving.

Moreover, the **no-cloning theorem** (a fundamental law of quantum mechanics, not an engineering limitation) states that an unknown quantum state cannot be perfectly duplicated. This means:
- No backups
- No replication
- No erasure coding
- No redundancy of any kind

Every classical storage system's durability guarantee (eleven nines of durability, N+M redundancy, geographic replication) depends on the ability to copy data. Quantum mechanics forbids this for quantum states. You cannot build a durable storage system on a foundation that prohibits copies.

**QRAM** (Quantum Random Access Memory), the theoretical ability to query classical data in superposition, is a [genuine research topic](https://quantum-journal.org/papers/q-2025-12-02-1922/) with real potential for quantum algorithms (Grover's search, HHL linear system solving, quantum ML). But QRAM is about *accessing* classical data from a quantum computer, not about *storing* data in quantum states. The storage layer remains classical.

### Where Quantum *Actually* Impacts Storage

Quantum computing's real impact on storage is not about replacing it. It's about **breaking its security model.**

Shor's algorithm, running on a sufficiently powerful quantum computer, can factor large integers and compute discrete logarithms in polynomial time. This breaks:
- **RSA** (key exchange, signatures)
- **ECDSA/ECDH** (elliptic curve key exchange, signatures)
- **DSA** (digital signatures)

These are the cryptographic primitives that protect data at rest (AES key wrapping, disk encryption key management), data in transit (TLS), and data integrity (digital signatures on checksums).

The timeline is debated but converging: **as of early 2026, cryptographically relevant quantum computers (CRQCs) are projected for the 2030s**, with nation-state actors potentially arriving earlier. Citi Research published a trillion-dollar security assessment in January 2026 calling this "the trillion-dollar security race." The "harvest now, decrypt later" threat (adversaries capturing encrypted traffic today to decrypt it when quantum computers arrive) is [already considered active](https://www.bcg.com/publications/2025/how-quantum-computing-will-upend-cybersecurity) by intelligence agencies.

NIST responded by finalizing three post-quantum cryptography standards in August 2024:
- **ML-KEM** (formerly CRYSTALS-Kyber, FIPS 203). Lattice-based key encapsulation.
- **ML-DSA** (formerly CRYSTALS-Dilithium, FIPS 204). Lattice-based digital signatures.
- **SLH-DSA** (formerly SPHINCS+, FIPS 205). Hash-based digital signatures.

With a fourth, **HQC**, a code-based backup algorithm for ML-KEM, released in March 2025.

For storage systems, this means:
1. **Encryption at rest must migrate to PQC algorithms.** AES-256 is believed quantum-resistant (Grover's algorithm reduces it to ~128-bit effective security, still infeasible), but the key exchange and signature schemes that protect AES keys are vulnerable.
2. **Object signatures must migrate.** If your storage system signs object checksums with ECDSA (as many do for integrity verification), those signatures become forgeable with a quantum computer.
3. **TLS must migrate.** Every S3 API call over HTTPS uses key exchange and server authentication that quantum computers will break. TLS 1.3 with ML-KEM hybrid key exchange is the path forward.
4. **Larger cryptographic artifacts.** ML-KEM public keys are ~1.2 KB (vs. 32 bytes for X25519). ML-DSA signatures are ~3.3 KB (vs. 64 bytes for Ed25519). Per-object signature metadata grows by 50-100x. Storage systems that embed signatures in object metadata must plan for this space increase.

**Quantum computing doesn't replace object storage. It makes object storage's security model obsolete, and demands a migration to post-quantum cryptography that most storage systems haven't started.**

---

## The Way Forward: Native Object Storage

The path forward is not incremental. You can't bolt object features onto POSIX or slap a POSIX gateway onto object storage and call it done. Clean break.

### 1. S3 API as the Universal Data Interface

The S3 API (PUT, GET, DELETE, HEAD, ListObjects, multipart upload, pre-signed URLs) is the closest thing data infrastructure has to a universal language. Cloud providers speak it natively. AI frameworks read from it. Analytics engines query through it. Kubernetes has [COSI](https://kubernetes.io/blog/2022/09/02/cosi-kubernetes-object-storage-management/) (Container Object Storage Interface) as the native standard for provisioning S3-compatible buckets, complementing CSI for block/filesystem storage.

New storage systems should speak S3 natively. Not through a gateway, not through a translation layer, but as their primary and only data interface. No POSIX shim. No FUSE mount. No NFS gateway. If an application needs POSIX, it can use a local filesystem or a purpose-built network filesystem. The object store should not contort itself to emulate something it isn't.

### 2. Data-Aware, Not Byte-Agnostic

As I wrote in [Storage Is Dead. Long Live Data.](/blog/storage-is-dead-long-live-data), the next storage system must understand its contents: Iceberg tables, vector embeddings, inference context. This is the opposite of POSIX, which treats everything as a bag of bytes with permissions attached.

Native object storage can embed table catalogs, vector indexes, and schema metadata directly into the storage engine. POSIX can't. Its metadata model is fixed by a 37-year-old standard that knows about owners, groups, timestamps, and permission bits. Nothing else.

### 3. Post-Quantum Security from Day One

New storage systems being designed today will be in production in the 2030s, squarely within the CRQC threat window. Building with classical-only cryptography is technical debt with a known, approaching deadline.

The right architecture: ML-KEM for key exchange, ML-DSA for object integrity signatures, AES-256-GCM for data encryption (quantum-resistant at 256-bit key lengths), and crypto-agility built into the wire protocol so algorithms can be rotated without a format migration.

### 4. No Metadata Server, No Gateway, No Translation

The defining architectural choice: **no centralized metadata server** (unlike HDFS's NameNode, CephFS's MDS, or Lustre's MDT). Object placement computed deterministically via consistent hashing. BLAKE3 to a partition, HRW to a node. Metadata travels with the object or lives at computed locations. No gateway process translates between protocols. The storage engine *is* the API server.

This eliminates:
- The metadata server as a scaling bottleneck
- The gateway as a latency floor
- The translation layer as a source of semantic impedance mismatch
- The POSIX compatibility layer as an ongoing maintenance burden

---

## Conclusion: Respect the Legacy, Build the Future

![Fiber optic connections symbolizing modern data infrastructure](/images/blog/network-fiber.jpg)

POSIX earned its place in computing history. It unified Unix, enabled portable software, and provided a stable foundation for 37 years of systems engineering. That's a remarkable achievement for any standard.

But POSIX was designed for a world where storage was a local disk, files numbered in the thousands, users sat at terminals, and "distributed" meant NFS over 10 Mbps Ethernet. It was not designed for petabyte-scale flat namespaces, billions of immutable objects, AI training pipelines that read millions of files per hour, or federated identity systems that span clouds.

The choice for new storage systems is clear:

**Adapt native object storage (no gateway, no metadata server, no POSIX shim) or lose to the systems that did.**

Quantum computing won't save POSIX. It won't replace object storage. What it will do is break the cryptographic foundations that both rely on, forcing a migration to post-quantum algorithms that's easier to do in a clean, modern system than in one dragging 37 years of compatibility baggage.

The river has moved. Stop building bridges to the old bank.

---

*POSIX history from [IEEE Std 1003.1-1988](https://archive.org/details/POSIX.1-1988) and [The Open Group](https://www.opengroup.org/austin/papers/backgrounder.html). POSIX I/O scalability analysis from [The Next Platform](https://www.nextplatform.com/2017/09/11/whats-bad-posix-io/) and [Frontiers in HPC](https://www.frontiersin.org/journals/high-performance-computing/articles/10.3389/fhpcp.2025.1393936/full). NFS locking problems from [apenwarr](https://apenwarr.ca/log/20101213) and [Lennart Poettering](http://0pointer.de/blog/projects/locking.html). CephFS POSIX deviations from [Ceph documentation](https://docs.ceph.com/en/latest/cephfs/posix/). S3FS limitations from [SNIA](https://www.snia.org/sniadeveloper/session/19445). QRAM research from [Quantum Journal](https://quantum-journal.org/papers/q-2025-12-02-1922/). Post-quantum cryptography standards from [NIST](https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards). Quantum security timeline from [BCG](https://www.bcg.com/publications/2025/how-quantum-computing-will-upend-cybersecurity) and [Citi Research](https://www.citigroup.com/rcs/citigpa/storage/public/Citi_Institute_Quantum_Threat.pdf). Kubernetes COSI from [kubernetes.io](https://kubernetes.io/blog/2022/09/02/cosi-kubernetes-object-storage-management/).*
