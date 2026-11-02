# Rust engine plan

Decision record: [ADR 0032](adr/0032-rust-engines.md). First module: short clips (`engine-clips`). Background and goals of that module: [57](57_CLIPS_ENGINE_PLAN.md).

## Target architecture

```
Electron main (TypeScript)  --spawn per job-->  urushi-engine (Rust)  --spawn-->  ffmpeg / ffprobe (pinned LGPL builds)
        |   one NDJSON request line on stdin          |  progress and one result/error line on stdout
        |   optional cancel line, or close stdin      |  diagnostics on stderr (hidden from users)
```

`engine/` is a Cargo workspace:

| Crate | Role |
| --- | --- |
| `engine-core` | The protocol, job errors and cancellation, supervised external tools (time limit, stall limit, cancellation, bounded stderr), staging and publishing of output files, hashing |
| `engine-clips` | Short clips: face model, framing, single-pass render, checks (first module) |
| `urushi-engine` | The executable: reads the request, dispatches by method name, reports exactly one result or error |

Later engines are further crates behind the same executable and the same protocol (names are plans, not commitments): `engine-media` (probe, presentation timing, frame extraction, hashing and import), `engine-audio` (energy, silence), `engine-activity` (screen activity), `engine-render` (export, fades, graphics and camera layers), `engine-record` (capture supervision), `engine-speech` (transcription).

### Protocol (version 1)

One job per process, newline-delimited JSON. Types: `crates/engine-core/src/protocol.rs`; client: `packages/media-engine/src/engine-client.ts`.

- Request: `{"v":1,"id":"job","method":"clips.render","params":{...}}`. Methods: `engine.hello` (version, protocol, methods), `clips.render`, `clips.frame` (plan the framing only, for diagnostics and tests).
- Events: `ready`, `progress {phase, fraction}` (throttled to about 8 per second), then exactly one `result {result}` or `error {code, detail}`.
- Cancel: a `{"method":"cancel"}` line, or closing standard input, or killing the process. The engine stops its FFmpeg children, removes its staged file and answers `CANCELLED`; the client kills the process after a grace period if it does not.
- Error codes (stable, mapped to plain messages in TypeScript, `detail` never shown): `INVALID_REQUEST`, `UNSUPPORTED` (valid but not handled here, so the caller uses another path), `CANCELLED`, `TIMEOUT`, `TOOL_UNAVAILABLE`, `TOOL_FAILED`, `OUTPUT_INVALID`, `DISK_FULL`, `MODEL_UNAVAILABLE`, `INTERNAL`. The client adds `CRASHED` when the process dies or speaks nonsense.
- Crash isolation: a panic is caught and reported as `INTERNAL`; a hard crash is only a failed job.
- Paths in requests are absolute. The engine opens no network connection.

### What stays TypeScript

Electron main, preload, renderer; the timeline, transactions, undo and revision logic; project store; provider and assistant code; IPC schemas and validation; the planning of a job (for a clip: which source frames and samples, the zoom filter, captions as an ASS script, graphics tracks). The engine executes plans; it does not decide edits.

### Packaging and integrity

The engine is built with `cargo build --release --locked` in `engine/` and placed in the app's resources as `engine/urushi-engine` (`.exe` on Windows) beside `manifest.json`:

```json
{ "schemaVersion": 1, "version": "0.1.0", "protocol": 1, "platform": "linux", "executable": "urushi-engine", "size": 0, "sha256": "..." }
```

`scripts/build_desktop.mjs` copies a prebuilt binary named in `URUSHI_ENGINE_BINARY` and writes the manifest; without it the app is built without an engine and uses its TypeScript path. At start, `resolveEngine` (`engine-client.ts`) checks the manifest's protocol, executable name, size and SHA-256 and refuses a binary that does not match, like the Codex and MCP sidecars. For development, `URUSHI_ENGINE` names a binary (honoured only when the app is not packaged).

Models are fetched by main on first use (`face-model.ts`, pinned URL, size and SHA-256, atomic rename), kept under the app data folder and passed to the engine by path. The engine recomputes the hash before loading.

### Build requirements

| Target | Status |
| --- | --- |
| Windows x64 (`x86_64-pc-windows-msvc`) | Builds on this host with Rust 1.97.1 and the MSVC build tools. The release exe is about 24 MB (tract included); a clean release build takes about five minutes, an incremental one about two. |
| Linux x64 guest (`x86_64-unknown-linux-gnu`) | **Not buildable yet.** The guest has neither Rust nor a C compiler. One crate in the tree (`tract-linalg`) compiles assembly kernels through the `cc` crate at build time, so a C toolchain is needed in addition to Rust. |

What the Linux guest needs, as a one-time install (sizes are estimates from typical Debian and rustup packages, not measured in the guest: about 1 GB of disk, a few hundred MB to download):

1. `build-essential` (gcc, binutils, make, libc headers): about 250 to 350 MB installed.
2. Rust through `rustup` with the minimal profile and the 1.97.1 toolchain (`rustc`, `cargo`, `rust-std`): about 600 MB installed (`rustfmt` and `clippy` add about 60 MB and are only needed to run the checks).
3. Network access to crates.io for the first `cargo fetch` (123 runtime crates plus build-time crates). After that, `cargo build --release --locked --offline` works from the vendored registry cache. `cargo vendor` can freeze the sources into the repository's ignored build area if the guest has no network.

The guest does not need Rust at runtime: it only needs the built binary. Alternative that avoids installing anything in the guest: build the Linux binary on a machine that has the toolchain and copy `urushi-engine` and its manifest in through `URUSHI_ENGINE_BINARY`.

Build output must not go into the repository: set `CARGO_TARGET_DIR` outside it (`engine/target/` is also ignored).

### Dependency and licence checks

- Runtime crates are recorded in `THIRD_PARTY_NOTICES.md`; at the time of writing 123 crates, all permissive.
- `cargo audit --no-fetch` runs offline against the cached advisory database (`cargo deny` is not installed). On 2026-11-02 it scanned `Cargo.lock` (134 crates including build-time ones) against 1,352 cached advisories and reported none; that database was last updated on 2026-10-03, so refresh it before a release. `Cargo.lock` is committed.
- `unsafe_code` is forbidden in all engine crates; clippy runs with `-D warnings`; `cargo fmt` is required.

### FFmpeg

The engine runs the pinned FFmpeg and ffprobe as separate processes, without a shell and without a window, under a watchdog (overall limit, stall limit, cancellation). It does not link libav, so FFmpeg's licence and codec set stay a packaging matter (`docs/24`). The H.264 encoder is chosen from what the FFmpeg build reports: libx264, else OpenH264, with hardware encoders (NVENC, QuickSync, AMF) only on request and only after a trial encode succeeds.

### ONNX inference: tract or ort

Measured on the pinned YuNet model (232 KB, 640x640 input, 12 outputs) on this host (Ryzen 5 7500F, 6 cores, shared with other work, so absolute times vary by about 2x between runs):

| | `tract` 0.23.9 (pure Rust) | ONNX Runtime 1.2x via `onnxruntime-node` (what `ort` wraps) |
| --- | --- | --- |
| One frame, one thread | 70 to 170 ms | 13 ms |
| One frame, runtime's own threads | single-threaded kernels; frames run in parallel instead (5 to 6 threads: about 35 ms per frame effective) | 7 to 8 ms |
| Output equality | sums over four heads agree with ONNX Runtime to four decimals | reference |
| Load time | 70 to 260 ms | 75 to 280 ms |
| Packaging | linked into the engine; no extra files; exe about 24 MB | needs `onnxruntime.dll` or `.so` (about 10 to 20 MB, shipped with the app) plus a binding crate pinned to a specific runtime version; `ort` downloads or loads that library |
| Licence | MIT or Apache-2.0 | MIT |
| Other input sizes | the model's fixed shapes make other sizes fail in tract | same model constraint |

Decision: `tract` for the face model. At two samples per second a 30 s clip needs 60 frames, so analysis costs about one to three seconds of wall time in parallel with decoding; the saved packaging risk (no native library to locate, hash and load on two operating systems) is worth more than the 5x to 10x per-frame gap. If a later model needs more throughput than frames-in-parallel can give (Whisper's encoder and decoder, a larger detector), reconsider `ort` with a loaded library hashed in the same manifest.

### Lossless policy

`docs/44` is unchanged. The clips engine produces a compressed share format (8-bit 4:2:0 H.264 and AAC in MP4) like the "Smaller file" export; it never writes a master and never reads a proxy. Source media is only read. Future engines that touch masters (`engine-render`) must keep exact canonical-frame and audio-sample hashing and are held to the existing lossless tests before the TypeScript pipeline is retired.

## Migration order

By value and risk. Each step: port behind the existing TypeScript interface, add Rust unit tests and a shared-fixture parity test against the TypeScript output, keep all existing tests green, ship both, delete the TypeScript version only after parity and a packaged-app run.

| # | Module | Why this position | Parity check |
| --- | --- | --- | --- |
| 1 | Short clips (done on the Windows host) | Highest user value (clip time cut 2x to 6x), self-contained, share-format output so no lossless risk | Frame counts, durations, PSNR against the TypeScript pipeline (`tests/media/short-engine.test.ts`) |
| 2 | Audio energy and silence analysis | Pure computation, large speed win for Magic Edit, no media output | Same segments and timings on the shared speech fixtures, within one analysis frame |
| 3 | Screen-activity analysis | Pure computation on decoded frames, same pattern as the face sampler | Same activity intervals on synthetic and recorded fixtures |
| 4 | Probing, presentation timing, hashing and library import | Many small spawns today; deterministic; blocks every later render | Identical probe records and timing tables for the existing fixtures |
| 5 | Frame extraction (stills, thumbnails, waveform) | Shares the sampler and the process supervisor | Byte-equal decoded frames for the lossless fixtures |
| 6 | The export pipeline (canonical frames, audio, verification) | Highest risk: the lossless contract. Port last of the render work, after 4 and 5 provide its inputs | Existing decoded-sample equality, hash and metadata tests, unchanged |
| 7 | Join fades, graphics and camera layers | Depend on 6 | Frame-hash equality with the TypeScript compositor |
| 8 | Recording supervision | Operational, needs a real-hardware pass | Existing recorder tests with fake devices |
| 9 | Transcription pipeline | Heavy and dynamic shapes; decide the inference runtime by measurement first | Word timings and text on the speech fixtures |

## Current state

Done: workspace, protocol, supervisor, short-clips module (face model, framing, single-pass render, checks, retry, cleanup), TypeScript client and wiring behind `DesktopShortClips`, tests, measurements. Not done: packaged-app and Linux-guest runs, the packaged resource copy has not been exercised, modules 2 to 9, and screen-activity analysis does not exist on this branch to port.
