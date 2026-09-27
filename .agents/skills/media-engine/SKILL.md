---
name: media-engine
description: Implement deterministic ingest, transcription, rendering, audio, timing, and media QA.
---

# Media engine

## Use when

Changing FFmpeg, ffprobe, transcription, proxies, render, mux, export, or media validation.

## Rules

- Integer microsecond authoritative time.
- Rational frame rates.
- Typed process adapter with argument arrays, timeouts, cancellation, redaction, and stable errors.
- Hash all important inputs and outputs.
- Stage to temporary paths, validate, then promote atomically.
- Reuse cache only when keys and output hashes match.
- Preserve source bytes.
- Start local speech-model downloads only after a visible user action. Pin the model revision and each model-weight hash; verify before inference. Never send source audio or transcripts to the model host. Keep analysis audio proxies private, temporary, and out of preview/master inputs.
- Store word timing as integer microseconds with model-estimate warnings. Preserve `und` when language is not reported by the runtime. Silence ranges are separate evidence and never authorize a cut by themselves.
- Persist transcript results under source-hash and model-revision cache keys. Reuse one live job identity across repeated starts and polling; never restart a job merely because status polling timed out.
- For source-frame seeks, sort verified presentation timestamps; packet order can be decode order. Use exact rational time-base comparisons rather than average frame rate, and do not use packet duration as each displayed frame's interval without validation.
- For a two-source project, validate the last presented packet's duration and compare its end to the source probe. Persist timing evidence with both immutable source identities; use half-open adjacent output intervals and select the source before display decode. Nominal frame rate is only a navigation grid for variable-cadence media. Reject mixed metadata until an explicit working-format adapter is implemented. Keep the display index out of master rendering.

## Required checks

- decode
- streams and codecs
- duration and frame count
- source-to-output mapping
- A/V drift
- caption timing
- loudness and clipping
- black and frozen frames
- missing media
- output hash

## Evidence

Render a short fixture whenever media behavior changes. Inspect frames and audio. A successful FFmpeg exit is not enough.

For a new still-frame import profile, assert the exact ffprobe pixel, range, primaries, transfer, aspect and display-transform tags before enabling preview. Use an explicit FFmpeg conversion to the renderer format, compare frames at several times and after project reopen, and keep that display transport out of canonical render/master inputs. An H.264/AAC input may already be lossy; byte-preserving import and native-size preview do not make it lossless. Test long footage and multi-source timing separately from a short still-frame fixture.

The current local transcription adapter pins `Xenova/whisper-base` q8 on CPU. The model weights are downloaded only from a user-started Auto Edit operation, verified by size and SHA-256, then loaded locally. It emits path-free word-timed transcript and independent silence evidence without modifying the draft. Model timing is estimated; the current runtime does not report language. Do not promote the proxy or transcript into any lossless master claim.
