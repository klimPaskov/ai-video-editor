# Lossless-first media policy

## Meaning and defaults

Preserve source files byte for byte. The default capture path, reusable video and audio intermediates, and final master must not introduce lossy codec compression. Lossless means exact recovery of the samples supplied to that encoding stage. It does not recover detail absent in imported footage or turn intentional crop, retiming, mixing, or noise reduction into an identity operation.

Maintain three explicit boundaries: immutable source bytes, canonical edited frames and audio samples, and the encoded master. A no-op fixture can compare decoded output to decoded source samples. An edited fixture compares the encoded-and-decoded master to the canonical edited samples. File hashes alone do not prove this equality.

## Master profile

Default to Matroska `.mkv` with FFV1 video and uncompressed PCM audio. FFV1 is a lossless video format [L1]. Select and test a pixel format that preserves the canonical samples and precision [L2]. PCM format must match the canonical sample representation. Do not truncate floating-point samples into integer PCM and still claim exact equality.

FLAC is an optional lossless alternative for compatible integer PCM sources [L3]. Do not convert floating-point audio to integer merely to fit FLAC. A format change or mixed-rate render records its canonical representation and its intended conversion.

Retain native dimensions, timing, colour range, primaries, transfer, channel layout, and sample precision where the edit permits it. Do not silently force 1080p, 30 fps, 8-bit, SDR, stereo, 48 kHz, or 4:2:0. User-selected reframing and timing changes are explicit transformations. Mixed-source projects need a disclosed working format. An unsupported precision or HDR path must be blocked or require an explicit, accurately labelled conversion.

ProRes 422 HQ is described as visually lossless by Apple, not mathematically lossless [L4]. Do not label it Lossless. Ordinary H.264/AAC presets are compressed sharing profiles. A high bitrate or quality slider at maximum is not proof of lossless encoding.

## Recording

In Lossless mode obtain native capture frames and audio samples, persist their timestamps, and encode through verified lossless adapters. A lossy MediaRecorder capture followed by FFV1 transcoding cannot satisfy this mode. If browser capture cannot expose a proven lossless path, add a native capture adapter. Electron still owns the desktop UI and device permissions.

Record screen, camera, microphone, and system audio separately against one clock. A camera or capture API may already supply compressed material. Preserve that material and disclose its upstream limits. Do not promise sensor-level or desktop-pipeline fidelity that has not been measured.

Run a storage and sustained-throughput preflight. If the configured capture cannot keep up, report it and preserve valid data. Never silently lower resolution, drop frames, reduce sample precision, or enable lossy compression. Offer an explicit faster mode or a lower capture setting only after the user chooses it.

## Preview and analysis

Default preview uses source or lossless intermediate data. Lossless quality does not promise real-time playback on every machine. An explicit Faster preview control may create lower-resolution or lossy playback proxies. Its selection is stored separately from master quality and visibly labelled only while relevant.

For tagged 8-bit H.264 YUV 4:2:0, the current native-size still-frame preview decodes the immutable source and explicitly converts limited-range BT.709 to BGRA for display. That color and chroma conversion changes samples; it is not a lossless intermediate or a master input. The imported H.264/AAC file was already compressed, and this path does not recover discarded detail. The original bytes and metadata remain available for a future canonical render. Unknown tags, higher precision/HDR, display transforms, or non-square pixels remain preview unavailable rather than silently downconverted.

Still-frame source seeking uses verified presentation PTS rather than an average-frame-rate guess. Packet PTS is sorted because B-frame packet order is decode order. The final packet's duration defines the exclusive presentation end, including when it exceeds the reported stream duration. The two-source draft maps adjacent output intervals into the corresponding immutable source for display; it rejects incompatible source metadata instead of converting it silently. The display-only seek index and BGRA canvas never feed canonical render or master encoding. Draft playback plays the immutable source through the app's range-capable media route in two alternating `<video>` elements, so audio and video come from Chromium's own decoder for display only; it never feeds export. Sources Chromium cannot decode (for example FFV1 or ProRes) keep frame preview only until an explicit labelled playback proxy exists. The draft master export is described in `docs/18_EXPORT_AND_DELIVERY.md`.

Mono speech extraction, waveform reduction, and thumbnails are analysis-only derivatives. They may not become master audio or video inputs. If Electron cannot play the master codec, use a verified local decode/frame transport or ask for a clearly labelled playback proxy. Never silently substitute the proxy for the export source.

Screen recordings (FFV1 `bgr0`, full range, sRGB) use the native RGB still-frame path: FFmpeg's explicit `scale,format=bgra` copies B, G and R unchanged and fills the unused byte with opaque alpha, which `tests/media/recorder.test.ts` and `tests/native/recording.test.ts` compare against an unconverted `bgr0` decode. Home card pictures are cosmetic 320 px decodes with default scaling and are never shown as review frames.

## Processing

Preserve high precision through compositing. Test the actual decode, pixel transport, GPU or CPU composition, intermediate, and encoding path. An 8-bit browser canvas is not a valid silent fallback for higher-precision material.

Audio cleanup, normalization, ducking, fades, pitch preservation, and zoom interpolation intentionally change samples. Apply them only as selected draft operations. Encode their canonical result losslessly, preserve originals, and make edits undoable. Do not normalize or resample on export unless the project explicitly requests it.

## Opt-in smaller output

Offer two clear choices: Lossless master (default) and Smaller file. The latter may use a compatible H.264/AAC MP4 preset, with resolution and rate choices under Advanced. Explain its quality tradeoff briefly. Use a distinct filename and profile. Never overwrite the lossless master or reuse a proxy as its input. The container extension must match the muxer.

## Required acceptance

- No-op decoded frame and audio-sample equality, with unchanged source hashes
- Canonical edited-frame and audio equality after a lossless encode/decode round trip
- Tests for available RGB and YUV precision profiles, alpha when supported, colour metadata, rational rates, channel layouts, and integer or floating-point PCM
- Explicit unsupported-format failure with no silent downgrade
- Capture throughput, dropped-frame accounting, timestamp and drift checks
- Preview proxy isolation and export independence
- Correctly labelled optional compressed export

Implement these checks in P0, P3, P4, P8, P9, and P10. Store actual evidence, not canned successful numbers. Until a profile passes its fixtures, do not list it as verified.

## Sources

[L1] FFmpeg, FFV1 specification: https://ffmpeg.org/~michael/ffv1.html

[L2] FFmpeg, codec documentation: https://www.ffmpeg.org/ffmpeg-codecs.html

[L3] Xiph.Org, FLAC: https://xiph.org/flac/

[L4] Apple, About Apple ProRes: https://support.apple.com/en-us/102207

Checked 2026-09-05. The technical boundaries above are product requirements, not evidence of an implemented encoder.

Burned-in captions (2026-10-07): the master's canonical render is the source frames with the caption overlay drawn by libass in the same pixel format; untouched frames are bit-identical to the source and the exported master decodes to exactly the composed frames. Without burn-in nothing changes.

Audio cleanup (2026-10-07): when the user turns on noise reduction or volume evening, the canonical audio is the processed audio (exact sample count kept) and a master is verified against it. With both off, audio samples are the sources' samples exactly, as before.
