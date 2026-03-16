---
title: "Why Every Go Storage System Ends Up Fighting Go"
date: 2026-03-13
description: "Why Go's runtime model is fundamentally at odds with storage system requirements, why migrating to Rust is no longer the cliff it once was, and why AI-generated binary is not the future."
tags: ["storage", "rust", "go", "infrastructure"]
type: "standard"
featured: false
image: "/images/blog/vintage-terminal.jpg"
readTime: "16 min read"
---

![Vintage computer terminal](/images/blog/vintage-terminal.jpg)

*A case for Rust (and a reality check on AI-generated binaries).*

---

## Part I: Go Was Never Designed for Storage

Go is a phenomenal language for API servers, CLI tools, DevOps infrastructure, and network services. Google built it to solve a specific problem: *getting networked services written and deployed quickly with large teams*. And it nailed that.

But storage systems aren't network services with a database behind them. They *are* the database. They sit at the bottom of the stack, one abstraction layer above raw disk and kernel syscalls. At that layer, the same design choices that make Go productive start working against you.

### The Garbage Collector: Your Latency Enemy

Go's garbage collector is impressive engineering. It's concurrent, it's low-pause, and it's gotten better with every release. But "low-pause" is not "no-pause," and storage systems care about tail latency at percentiles that web services don't.

Consider a storage node handling 10,000 concurrent object GETs. Each request allocates:
- A buffer for reading from disk (4 KB to 1 MB)
- A checksum computation context
- HTTP response headers and framing
- Metadata structs loaded from the object index

Under sustained load, this creates millions of small, short-lived allocations per second. The GC must trace and collect all of them. Even with Go 1.22+'s improved pacer, GC pauses of 0.5-2ms are common under memory pressure. At the p99.9 level, these compound into visible latency spikes.

This is why every serious Go storage system ends up building its own memory management layer on top of Go's runtime. NVIDIA's AIStore has `memsys`, a slab allocator that pre-allocates large chunks and manually manages sub-allocations to reduce GC pressure. CockroachDB built a custom arena allocator. Badger uses `mmap` to sidestep the GC entirely for its value log.

When you're building a framework *on top of your language's memory model* to avoid using your language's memory model, that's the language telling you it wasn't designed for your workload.

**Rust's answer:** No GC. Period. Memory is allocated and freed deterministically via ownership and borrowing. When a buffer goes out of scope, it's freed immediately. No tracing, no pausing, no surprises. A storage node under identical load has flat, predictable latency because memory reclamation is woven into the control flow, not running as a parallel process competing for CPU time.

### goroutines: Convenient, Uncontrollable

Go's goroutine scheduler is a cooperative, M:N threading model. It's elegant for request-handling workloads where thousands of goroutines block on network I/O. But storage systems have a different concurrency profile: they mix **CPU-bound** work (checksumming, erasure coding, compression) with **I/O-bound** work (disk reads, network transfers), and they need precise control over which cores do what.

Problems that emerge at scale:

1. **No CPU pinning.** You can set `GOMAXPROCS`, but you can't pin a goroutine to a core. For NUMA-aware storage (where reading from a locally-attached NVMe is 10x faster than crossing a NUMA boundary), this is a dealbreaker. The scheduler freely migrates goroutines across OS threads, destroying cache locality.

2. **Cooperative scheduling gaps.** A goroutine running a tight Reed-Solomon encode loop won't yield until the next function call or channel operation. If the loop is pure computation over a large buffer, it holds its OS thread hostage, potentially starving I/O-bound goroutines waiting to serve requests.

3. **Stack growth overhead.** Goroutines start with a small stack (2-8 KB) that grows dynamically via stack copying. For storage paths that recurse through codec, compression, encryption, and I/O chains, repeated stack growth and copying adds measurable overhead that doesn't exist with fixed-size stacks or async state machines.

**Rust's answer:** `tokio` gives you an async runtime where CPU-bound work can be explicitly offloaded to `spawn_blocking` pools, I/O tasks run on dedicated reactor threads, and you control thread affinity, pool sizes, and scheduling priorities. You're not fighting a general-purpose scheduler. You're configuring one built for your workload.

### The Safety Illusion

Go advocates often cite "no unsafe" as a safety advantage. But Go achieves memory safety by *hiding* low-level operations behind a runtime, not by *proving* their absence. The result:

- **Data races compile fine.** Go's race detector is a runtime tool, not a compile-time guarantee. A storage system with a race condition in its metadata index passes `go build` without a whisper and corrupts data silently in production.
- **`interface{}` / `any` is an escape hatch.** Type assertions at runtime can panic. In a storage system's hot path, a panicking type assertion means a crashed node and an interrupted I/O operation.
- **`sync.Mutex` is advisory.** Nothing in the type system prevents you from accessing shared state without holding the lock. You just have to remember. Across a 200-file codebase with 15 contributors, "just remember" is not a strategy.

**Rust's answer:** `Send`, `Sync`, ownership, and borrowing are *compiler-enforced*. A data race is a compile error, not a runtime crash. `Arc<RwLock<T>>` makes locking *structural*. You literally cannot access the inner `T` without acquiring the lock. The type system is the audit tool.

### cgo: The Performance Cliff

Storage systems frequently need to call into C libraries: `liburing` for io_uring, ISA-L for SIMD erasure coding, OpenSSL or BoringSSL for encryption. Go's `cgo` makes this possible but painful:

- **Each cgo call costs ~200ns** of overhead (goroutine stack switch to a system thread). For a storage system making millions of small I/O calls per second, this adds up to seconds of overhead per second of wall time.
- **cgo defeats escape analysis.** Any pointer passed to C is forced to the heap, eliminating stack allocation optimizations that Go relies on for performance.
- **cgo binaries are harder to cross-compile and statically link**, complicating deployment.

**Rust's answer:** FFI is zero-cost. Calling a C function from Rust has the same overhead as calling it from C. No stack switches, no heap escapes, no runtime coordination. And increasingly, pure-Rust implementations (ring, aws-lc-rs, reed-solomon-simd) eliminate the need for C entirely, with equivalent performance thanks to LLVM's optimizer and explicit SIMD intrinsics.

---

## Part II: The Great Migration, Go to Rust Is Now Feasible

Three years ago, rewriting a Go storage system in Rust was a multi-year, multi-team bet. That's no longer true.

### AI-Assisted Translation Is Real (and Getting Better)

Modern LLMs can translate Go to idiomatic Rust with surprising fidelity. Not line-for-line transliteration, but actual idiomatic translation:

- Go's `interface` becomes Rust's `trait`
- Go's `goroutine + channel` becomes Rust's `tokio::spawn + mpsc`
- Go's `sync.RWMutex` becomes Rust's `Arc<RwLock<T>>`
- Go's `error` returns become Rust's `Result<T, E>`
- Go's `defer` becomes Rust's `Drop` trait

We're not talking about toy examples. Teams are using Claude, Copilot, and specialized tools to translate entire packages (HTTP handlers, serialization logic, test suites) and then manually auditing the output for correctness. The audit step is critical, but it reduces a 6-month rewrite to a 6-week effort for a moderately-sized codebase.

### The Rust Ecosystem Caught Up

The "Rust doesn't have libraries" argument died somewhere around 2023:

| Capability | Go | Rust |
|-----------|-----|------|
| HTTP server | net/http, gin, chi | axum, actix-web, hyper |
| Async runtime | goroutines (built-in) | tokio, async-std |
| Serialization | encoding/json, protobuf | serde, bincode, prost |
| Crypto | crypto/*, boring | ring, aws-lc-rs, rustls |
| Object storage SDK | aws-sdk-go | aws-sdk-rust |
| Metrics | prometheus/client_golang | prometheus-client |
| CLI | cobra, pflag | clap |
| Testing | testing (built-in) | cargo test, proptest, criterion |

For every Go library a storage system depends on, there's a mature Rust equivalent, often with better performance characteristics because it doesn't carry a runtime.

### Incremental Migration Is Possible

You don't have to rewrite everything at once. The practical path:

1. **Start with the data plane.** Rewrite the hot path (the code that reads/writes bytes, computes checksums, encodes erasure shards) in Rust. Expose it as a C-compatible library. Call it from Go via cgo. Yes, cgo has overhead, but it's localized to the boundary, and the Rust code runs at native speed.

2. **Migrate the I/O layer.** Replace Go's `os.File` and `io.Reader` chains with Rust's `tokio::fs` and `io_uring` wrappers. This is where the biggest performance gains live.

3. **Migrate the server.** Replace `net/http` with `axum` + `hyper`. This is the largest change but also the most mechanical. HTTP handlers are structurally similar across languages.

4. **Delete the Go.** Once all components are in Rust, remove the cgo bridge and ship a single, statically-linked binary with no runtime dependencies.

---

## Part III: No, AI Will Not "Just Generate Binary"

Elon Musk recently predicted that by late 2026, AI will bypass programming languages entirely and generate optimized machine code directly from natural language prompts. As he put it: *"Create optimized binary for this particular outcome"*. No source code, no compiler, no programming language involved.

He's wrong, and it's worth explaining why.

### Compilers Already Do This (Deterministically)

The translation from human intent to machine code is a *solved problem* with 70 years of engineering behind it. LLVM, GCC, and the Rust compiler transform high-level code into optimized machine instructions using:

- **Register allocation algorithms** with mathematical proofs of optimality
- **Instruction scheduling** tuned to specific microarchitectures (Zen 4, Sapphire Rapids, Graviton 3)
- **Auto-vectorization** that maps scalar loops to SIMD instructions
- **Link-time optimization** across translation units
- **Profile-guided optimization** from real-world execution traces

An LLM generating binary would need to *replicate all of this*, not approximately, but exactly, because a single wrong instruction in a storage system's I/O path means silent data corruption. LLMs are stochastic. Compilers are deterministic. Replacing a deterministic system with a stochastic one is a regression, not progress.

### You Cannot Iterate on Binary

Software engineering is 10% writing new code and 90% reading, modifying, debugging, and reviewing existing code. Binary is opaque:

- **You can't diff two binaries** meaningfully. Code review is impossible.
- **You can't set a breakpoint** in the "intent" that generated the binary. There's no source map.
- **You can't audit for security vulnerabilities.** Was there a buffer overflow in that AI-generated binary? A timing side-channel in the crypto path? Without source code, you'd need to reverse-engineer every output.
- **You can't version-control it.** Git stores text diffs efficiently. Binary blobs are opaque, non-mergeable, and storage-expensive.

### Platform Portability Doesn't Exist in Binary

Source code compiles to any target: x86-64, ARM64, RISC-V, WASM. A single Rust crate supports all of them via `cargo build --target`. An AI generating binary would need to produce separate, verified outputs for every architecture, every operating system, and every ABI version. The combinatorial explosion is precisely why we invented compilers and portable languages in the first place.

### What AI *Actually* Does Well for Code

AI isn't replacing compilers. It's replacing *boilerplate and translation labor*:

- **Language migration** (Go to Rust, Python to TypeScript). Structurally mechanical work.
- **Test generation.** Producing property tests and edge cases from function signatures.
- **Documentation.** Explaining what code does in natural language.
- **Code review.** Catching common patterns like unchecked errors, missing locks, SQL injection.
- **Scaffolding.** Generating project structure, CI configs, deployment templates.

These are real productivity gains. A good engineer with AI tools is easily 2-5x more effective than without them. But they work *because source code exists*. There's a human-readable, machine-parseable, version-controllable artifact that both humans and AI can reason about.

AI won't replace compilers. It'll make engineers faster at writing code in languages like Rust where the compiler has enough information to optimize aggressively.

### The Real Disruption

If Musk's prediction has a kernel of truth, it's this: the barrier to entry for systems programming is dropping fast. Writing a storage system in Rust in 2023 required deep expertise in ownership, lifetimes, async patterns, and unsafe abstractions. In 2026, an engineer with Go experience and access to AI tools can produce correct, idiomatic Rust, with the AI handling the mechanical translation and the engineer focusing on architecture and correctness.

That's not the death of programming. It's the opposite. Systems programming is becoming accessible to a much wider pool of engineers. And that makes Rust more relevant, not less, because it's the language where the compiler catches your mistakes before they ever hit production.

---

## Conclusion

Go gave us a generation of storage systems that were quick to build and easy to maintain. That was the right call at the time. But data volumes keep growing, latency budgets keep shrinking, and Go's runtime overhead has become a ceiling that no amount of clever engineering can punch through.

Rust removes that ceiling. With AI-assisted migration cutting the cost from "multi-year rewrite" to "one quarter," the question isn't *whether* to migrate anymore. It's *when*.

As for AI generating binary directly: we'll believe it when we see a storage system handling petabytes of production data from AI-generated machine code with no source, no debugger, and no way to audit what it's doing. Until then, we'll keep writing Rust.

---

*References: Elon Musk's comments on AI-generated binary from his [post on X](https://x.com/elonmusk/status/2021745508277268824) (February 2026). Technical counterarguments draw from [Adam Holter's analysis](https://adam.holter.com/elon-says-ai-will-generate-binary-by-2026-heres-why-thats-a-terrible-idea/) and decades of compiler engineering literature.*
