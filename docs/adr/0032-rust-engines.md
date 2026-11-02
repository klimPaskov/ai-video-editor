# ADR 0032: Heavy engines are written in Rust, one sidecar per job

- Status: Accepted user requirement (2026-11-02); first module (short clips) implemented and measured on the Windows host; packaged-app and Linux-guest verification pending
- Date: 2026-11-02
- Scope: Where heavy, deterministic media work runs; how the Electron app talks to it; how modules migrate

## User requirement

"All engines must be written in Rust." Short-clip creation must be fast and reliable, and the app must stay minimal.

## Decision

1. **What is an engine.** Everything heavy and deterministic that does not need Electron: media probing and presentation timing, hashing and library import, frame extraction, audio energy and silence analysis, screen-activity analysis, the render and export pipeline, join fades, graphics and camera layer orchestration, short clips, recording supervision and the transcription pipeline. Engines are Rust.
2. **What stays TypeScript.** Electron main, preload and renderer; the timeline, transaction, undo and domain logic; the provider and assistant code (Claude, Codex, API providers); IPC schemas. They are interactive, change often and are already covered by the transaction engine; moving them would add risk without a speed or reliability benefit.
3. **One sidecar, one job per process.** A Cargo workspace under `engine/` builds one executable, `urushi-engine`. Main spawns it per job and speaks NDJSON over standard input and output (`docs/58_RUST_ENGINE_PLAN.md`). A cancel line, closing the pipe, or killing the process stops the job; a crash cannot take the app down; outputs are staged and cleaned up by the engine.
4. **FFmpeg stays a separate process.** The engine drives the pinned FFmpeg and ffprobe executables; it does not link libav. Licence boundaries, codec choice and the lossless policy (`docs/44`) stay where they are.
5. **ONNX inference: `tract`.** Pure Rust, MIT or Apache-2.0, no shared library to package, no network at build time beyond crates. Measured on the pinned YuNet face model, it matched ONNX Runtime's outputs to four decimals and ran in about 70 to 170 ms per frame on one thread, against about 7 ms with ONNX Runtime's multi-threaded runtime; the engine runs frames on several threads, which keeps face analysis of a 30 s clip near two seconds. Whisper, whose decoder uses dynamic shapes, is decided separately when it is ported (`ort` is the likely choice there).
6. **Migration is behind the same TypeScript interface.** A module ships beside the TypeScript implementation. The Rust output must match the TypeScript output on shared fixtures, every existing test stays green at every step, and the TypeScript implementation is deleted only after parity is shown and the packaged app has run it.
7. **Distribution.** The engine is a version-pinned binary in the app's resources with a manifest of size, hash, version and protocol, verified at start like the Codex and MCP sidecars. It makes no network requests; models are fetched and verified by main and handed over by path, and the engine checks the pinned hash again before loading.

## Consequences

- The Windows host builds the exe directly with Rust 1.97. The Linux test guest has no Rust or C compiler and needs them before it can build the engine (listed in `docs/58`).
- Dependency licences for the engine are recorded in `THIRD_PARTY_NOTICES.md`; all resolved runtime crates are permissive (MIT, Apache-2.0, Zlib, Unlicense, BSD-2-Clause, BlueOak).
- The YuNet face model keeps its own MIT notice and is pinned by hash like the Whisper weights.
- The TypeScript short-clip pipeline remains the fallback and the parity reference until the engine is accepted in the packaged app.
