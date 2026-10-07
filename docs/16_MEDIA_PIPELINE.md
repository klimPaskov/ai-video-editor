# Media pipeline

## Time model

- Store media time as integer microseconds.
- Store frame rates as rational numerator and denominator.
- Convert to preview or render frames through one tested library.
- Never use floating-point seconds as the authoritative edit clock.

## Ingest

1. Hash and probe source.
2. Persist stream metadata.
3. Use source or lossless edit media by default. Create a lower-quality playback proxy only for an explicit Faster preview setting.
4. Create mono speech proxy.
5. Create thumbnails, waveform, and contact sheets.
6. Record every artifact hash and tool version.

The current still-frame preview decodes only verified BGRA or tagged 8-bit H.264 limited-range BT.709 profiles at native dimensions. H.264 uses an explicit BT.709/range conversion to BGRA for display; these bytes are never a canonical render or master input. The original compressed source remains byte-identical. Reject unsupported color/precision/display metadata for preview while retaining a valid import. For these profiles, a bounded ffprobe packet timestamp index sorts decode-order PTS and maps a requested source microsecond to the preceding presented frame; its cache is keyed by verified source identity. The final presentation boundary uses the last sorted packet's PTS plus its duration, rounded up to integer microseconds, and may exceed the reported stream duration. Synthetic B-frame, fractional-tick, variable-cadence gaps and a two-source clip join are covered. The draft maps output time into either source's verified presentation interval. This is still-frame seeking only. It does not establish continuous synchronized audio/video playback, a canonical variable-frame-rate render, or multi-source master export; those remain open P3/P9 work.

## Render layers

- FFmpeg handles probing, trimming, retiming, audio, codecs, muxing, and decode QA.
- A declarative composition layer handles camera layouts, backgrounds, text, captions, B-roll, crops, zooms, and canvas transforms.
- Preview and export consume the same canonical timeline.

## Stages

Every stage key includes input hashes, configuration, implementation version, and model identity when relevant. Write to staging, validate, then promote atomically.

## Cache

Reuse artifacts only when their stage key and stored output hash match. Tampered or partial artifacts are not cache hits.

## Failure evidence

Keep concise structured diagnostics and the last failed staging artifact when it helps repair. Do not surface raw FFmpeg output in ordinary UI.

## Supported export baseline

- Default lossless master: Matroska, FFV1, and representation-matched PCM
- Native dimensions and timing unless an explicit canvas or retiming operation changes them
- Source or canonical colour metadata and sample precision preserved
- Optional SRT and WebVTT
- Optional user-selected compressed MP4 sharing copy
- No silent fallback to a low-precision compositor or encoded proxy

See `docs/44_LOSSLESS_MEDIA_POLICY.md` for the capture-to-master fidelity boundary and exact decoded comparison tests.

## Draft playback (2026-10-07)

`apps/desktop/renderer/playback.ts` plays the committed draft. Main serves an active project's managed source at `ai-video-editor://app/media/<project>/<source>` with byte ranges; nothing else is served and the renderer's CSP allows media from the app only, with no `connect-src`. Two `<video>` elements alternate: one plays the current clip while the other waits at the next clip's first frame, and a frame callback swaps them at the clip's last frame. Joins can be one frame early or late in preview; export is exact. Play/Pause sits between the frame-step controls, Space toggles it when focus is on the preview or position control, and stopping returns to the exact still frame. Any draft change, stage change, seek or leaving the project stops playback. A source Chromium cannot decode shows a fixed message and keeps frame preview.

Evidence: `tests/native/playback.test.ts` cuts the second of a red/green/blue/yellow source in the packaged app and plays across the cut: the visible frames were red, blue, yellow and never green, audio bytes were decoded, playback stopped at the end on the still frame, Pause kept the position and Space toggled; the media route returned 206 for the project's source and 404 for other paths. Not covered: audio listening, playback proxies for undecodable sources, sustained 4K throughput.

## Card pictures (2026-10-07)

`MediaLibrary.thumbnail` decodes one frame about a tenth of the way in (at most 1 s), scales it to at most 320 px wide with FFmpeg defaults, forces opaque alpha and caches it per source hash. Main allows four requests at a time and the renderer asks one at a time. The result is decorative and is never used for review, analysis or rendering.

## Playback copies (2026-10-07)

Sources Chromium cannot decode (any video codec other than H.264, VP8, VP9 or AV1, or audio other than AAC, Opus, Vorbis, MP3 or FLAC, which includes lossless FFV1/PCM recordings) play through a display-only copy. Main makes it in the background, one source at a time, keyed by source hash under the app's data folder: H.264 without B-frames, a key frame every second, BT.709 limited range, and AAC in MP4, or VP9 and Opus in WebM when libx264 is missing. Frames are passed through at their source times, so preview positions map one to one; `tests/media/playback-proxy.test.ts` compares every frame time against the source. The copy is written to a `.partial` file and renamed when complete, so the media route never serves part of one. While it is being made, the player bar shows "Preparing playback N%" and Play waits; still frames remain exact. The copy is never used for still frames, analysis or export. Copies are not yet removed when their sources are no longer used.
