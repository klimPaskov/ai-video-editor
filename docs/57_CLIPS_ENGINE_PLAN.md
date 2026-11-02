# Clips engine plan

Requirement (2026-11-02): the Clips step reuses the ideas of the open-source BridgeClip project, stays minimal, and must be very fast and reliable. Scope change the same day: all engines are written in Rust (ADR 0032, [58](58_RUST_ENGINE_PLAN.md)), so this is the first Rust engine module. Product behaviour is in [49](49_SHORT_CLIPS.md).

Inspiration and study source: BridgeClip (https://github.com/bridge-mind/bridgeclip, MIT), read at commit `b996820` on 2026-11-02. It was only read: none of its scripts, installers or Python were run, and **no BridgeClip code, text or tests were copied**. The implementation below is written from the techniques, not from the source, so there is nothing of BridgeClip to attribute.

## What BridgeClip does that is worth having

| Technique | How it works there (understanding, not code) | Our take |
| --- | --- | --- |
| Face-following 9:16 | A small face detector (YuNet through OpenCV) on frames sampled at about 4 per second at 640 px width, score threshold around 0.7, detection on a few threads while FFmpeg keeps decoding | Adopted: YuNet, sampled frames, threads overlapped with decoding. Run by `tract` instead of OpenCV |
| Calm camera | Samples resampled to a grid, median filter, dead zone of about 12% of the crop width, speed cap near 0.9 crop widths per second, path simplified to at most about 40 keyframes and written as a piecewise-linear `crop` expression | Adopted as an idea, written independently: median of three, 10% dead zone, 0.6 widths per second, hold through gaps and release after 4 s, at most 40 keys |
| Webcam bubbles | Small faces in corners are treated as an overlay, not the subject | Adopted: a face under 20% of the frame height whose centre is in an outer corner is ignored |
| One decode, one encode | One FFmpeg process per clip, one filter graph, reading limited to the window (`-t` before the input), long graphs passed through a file | Adopted |
| Fallback ladder | A failed render drops to a simpler layout and then to natural timing instead of losing the clip | Adopted in the form: one retry with a software encoder and fixed crop |
| Encoder choice | Platform encoders (VideoToolbox), else OpenH264 with a bitrate, else x264 with a CRF; 2 s key frame interval | Adopted: x264, OpenH264 fallback, optional hardware after a trial encode, 2 s key frames |
| Process hygiene | Minimal environment, bounded stderr, kill on timeout, output size limits, no shell | Adopted: no shell, no window, bounded stderr, overall and stall limits, cancellation |
| Output checks | After encoding: stream start times and durations, continuity of audio packets | Adopted and strengthened: exact frame count, size, codec, audio duration, and a full decode before the file is published |
| Progress | Measured stage progress, indeterminate when there is no denominator | Adopted: analysis, render (frames done of frames planned), checking |
| Failure classes | Plain, stable messages without exception details, disk-full detection through the error chain | Adopted: stable codes in the engine, plain messages in TypeScript, `DISK_FULL` mapped from OS errors and FFmpeg output |
| Speed 1x to 2x, dead-air cuts, captions with several styles | Part of its render | Already ours: the draft's own speed ranges and cuts are rendered as planned; captions use our caption path |

## What we deliberately do not take

The app must stay minimal, and most of BridgeClip is a different product (a clip factory for long videos from the web).

| Not taken | Why |
| --- | --- |
| Python runtime and its package set | All engines are Rust (ADR 0032); a Python runtime would add hundreds of megabytes and a second runtime to secure |
| Video downloaders (YouTube, Twitch) | The app edits the user's own recordings; downloading others' videos is out of scope and a legal risk |
| OpenRouter planner and judge, source research, "Jev" reviews | Our AI connections act through guarded editor tools (Claude by default); clip proposals use the transcript rules and the Claude-only `shorts.propose` tool |
| Social publishing, webhooks, S3 upload | Export and sharing stay explicit user actions; no accounts to manage |
| Chat assistant, library, bookmarks, automation queue | We already have the assistant drawer and project history |
| Layout analysis of every shot (split screens, screen plus camera stacks), camera-change scan, manual crop editor | Heavy and rarely needed for our input; camera layouts are a separate feature (P8-02). A plain follow crop or a fitted screen covers the common cases |
| Nine caption styles with layered effects | We keep one caption style from the project and the existing caption path |

## What we compared against

Before this work (`packages/media-engine/src/render.ts` through `apps/desktop/src/short-clips.ts`): every clip went through the master-grade export pipeline: decode the whole audio to raw PCM, decode frames in a separate process into a pipe, a second process for the reframe and captions through another pipe, a third process to encode, a SHA-256 of every composed frame, and a full decode check at the end. That is right for a lossless master and wasteful for a share clip. "Fill" scaled the whole frame up to about 3400 px tall and then cropped; "Fit" blurred a full-size copy. Framing was a fixed crop, never a face. The Claude-only `shorts.propose` tool and `packages/domain/src/short-clips.ts` (which clips) are unchanged: this work changes how a chosen clip is rendered, not which clips are found.

## What was built

| Piece | Where |
| --- | --- |
| Protocol, job errors, cancellation, supervised tools, staged output, hashing | `engine/crates/engine-core` |
| YuNet decode and duplicate removal on `tract` (checked against ONNX Runtime) | `engine/crates/engine-clips/src/yunet.rs` |
| Sampling frames and parallel detection overlapped with decoding, zoom-aware | `.../analyse.rs` |
| Crop path (subject choice, dead zone, speed limit, hold and release, key budget), FFmpeg crop expression, fixed fallback | `.../framing.rs` |
| One-pass filter graph: cut and join ranges, speed, one early colour conversion, zoom, graphics, framing, captions | `.../graph.rs` |
| Encoder detection, trial encode for hardware, arguments | `.../encoder.rs` |
| Render ladder, retry, staging and cleanup, progress | `.../render.rs` |
| Output checks | `.../verify.rs` |
| Client, request builder, model fetch, integrity of the packaged binary | `packages/media-engine/src/engine-client.ts`, `short-engine.ts`, `face-model.ts` |
| Wiring with fallback to the TypeScript pipeline | `apps/desktop/src/short-clips.ts` and `main.ts` |
| Cheaper reframe filters for both paths | `packages/domain/src/short-clips.ts` |

Behaviour: "Fill the frame" follows the speaker when a face is found (coverage of at least 30% of the samples) and otherwise keeps the fixed crop at the chosen position. "Fit" is unchanged. Face analysis is never a requirement: a missing model, a model failure or no face leaves the fixed crop. Audio cleanup (two-pass loudness) still goes through the TypeScript pipeline.

### Reliability behaviours

| Behaviour | Where it is tested |
| --- | --- |
| Overall and stall limits per tool; the watchdog kills a hung FFmpeg | `engine-core` tests; `engine-client.test.ts` (client timeout) |
| Cancellation by a cancel line, by closing the pipe, or by killing; FFmpeg is stopped and the partial file removed | `engine-clips/tests/render.rs`, `short-engine.test.ts`, `engine-client.test.ts` |
| Output is staged beside the target under a hidden name, checked, then renamed; stale partials from a crashed run are swept | `engine-core/files.rs`, `render.rs` |
| One retry on a safer path (software encoder, fixed crop) | `render.rs` (retry test) |
| Verification before publishing: exact frame count, size, codec, pixel format, audio length, full decode | `verify.rs` tests; every render |
| Plain failure messages; technical detail never shown; disk full and timeout have their own text | `short-clips.ts`, `short-clips-view.ts` |
| Integrity of the engine and the model (size and SHA-256), refusal on mismatch | `engine-client.test.ts` |
| A broken or missing engine leaves the TypeScript pipeline in charge | `short-clips.ts` |

## Licence handling

- No BridgeClip code, text or tests were copied, so no BridgeClip notice is needed; this document credits it as an inspiration and study source.
- The YuNet model has its own notice: MIT, Copyright (c) 2020 Shiqi Yu, from the OpenCV Zoo. `licenses/YUNET-MIT.txt` holds the text; `THIRD_PARTY_NOTICES.md` records source, size (232,589 bytes) and SHA-256; `packages/media-engine/src/face-model.ts` and `engine-clips/src/yunet.rs` pin the same values. The file is not in the repository and is fetched on first use.
- Rust dependencies (123 runtime crates, permissive) are listed in `licenses/ENGINE-CRATES.md`.

## Goals and measured results

Goals: a 30 s vertical clip from 1080p and from 1440p sources renders in well under a minute on this machine, never leaves a half-written file, can be cancelled within seconds, and falls back instead of failing when the face step or the encoder misbehaves.

Measured on the Windows host (Ryzen 5 7500F, 12 threads, Radeon RX 7700 XT), clip of 30 s (900 frames, 30 fps) from a synthetic 40 s source (testsrc2 and a sine tone) to 1080x1920 H.264 and AAC with burned captions, other work running on the machine (so times move by up to 2x; the best and the median of three interleaved runs are given):

Seconds for the whole clip, best / median of three interleaved runs (all lines are the same clip and captions):

| Source and framing | Before (TypeScript pipeline, old filters) | TypeScript pipeline, cheaper filters | Rust engine | Rust engine, face following |
| --- | ---: | ---: | ---: | ---: |
| 1080p H.264, Fit | 25.0 / 32.0 | 16.4 / 23.1 | **9.0 / 11.1** | not used for Fit |
| 1080p H.264, Fill | 19.4 / 19.6 | 17.5 / 21.8 | **6.3 / 6.5** | 7.5 / 8.2 |
| 1440p lossless FFV1 RGB, Fit | 43.5 / 56.1 | 43.7 / 45.6 | **14.1 / 15.0** | not used for Fit |
| 1440p lossless FFV1 RGB, Fill | 85.9 / 92.0 | 44.9 / 57.9 | **15.3 / 24.7** | 32.5 / 42.0 |

Best-of-three, the engine is about 2.8x (1080p Fit), 3.1x (1080p Fill), 3.1x (1440p Fit) and 5.6x (1440p Fill) faster than before. A first, quieter single run of the old pipeline gave 22.6 s, 51.1 s, 50.0 s and 52.8 s for the same four cases, so the old "Fill" numbers in the table are inflated by load and the true gains are somewhat smaller than the best-of-three ratios for those rows; the engine's own single runs on that quieter machine were 10.7, 8.1, 15.3 and 11.9 s. Where the engine's time goes (one 1080p Fit run): render 8.4 s, checks 2.2 s; (1080p Fill) render 6.7 s, checks 1.0 s. Face following adds one sampling pass: about 1 s of wall time on 1080p H.264 (60 frames at 2 per second, detected on up to six threads while FFmpeg decodes) and about 10 to 17 s on 1440p FFV1, because decoding lossless intra-coded 1440p frames is itself about 5 s per pass and the machine was busy.

What the numbers do not show: the 30 s goal "well under a minute" is met in every case without face following and for 1080p with it; 1440p lossless Fill with face following is the slowest case (32 to 47 s here).

## Limits

- Timings are synthetic and from a shared machine. Real recordings (screen content, webcam) compress and decode differently, and the face path has only been checked on one generated face and on faceless synthetic video, not on a recorded talking-head clip.
- Hardware encoding (AMF here) is supported and trial-tested but off by default: in these runs it was not faster than libx264 `veryfast` because the filter graph, not the encoder, is the bottleneck.
- The face path needs the model download on first use; offline, "Fill" keeps the fixed crop.
- The engine has not run in the packaged Linux app or in the Linux guest (no Rust there yet); the packaged resource copy in `scripts/build_desktop.mjs` has not been exercised.
- Zoom and graphics are rendered in the same pass but the engine path was only compared with the TypeScript path without them in the parity test; their filters are the app's own and are unit-tested for order in `graph.rs`.
