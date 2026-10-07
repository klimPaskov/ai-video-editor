# Recording engine specification

## Sources

Support these independent sources:

- display, window, or region video
- system audio when the platform permits it
- microphone audio
- camera video
- pointer and click telemetry with explicit consent

## Synchronization

- Create one recording session ID and monotonic start time.
- Start each source through a coordinated barrier.
- Record start offset, pause intervals, dropped frames, device changes, and end time.
- Preserve each source as a separate managed file.
- Build an automatic timeline from the shared session clock.
- Do not infer synchronization only from container duration.

## Recording quality

- Default to a verified lossless source-native capture profile under `docs/44_LOSSLESS_MEDIA_POLICY.md`.
- Preserve actual capture timestamps and source precision. Record every dropped or duplicated frame.
- Do not transcode a lossy capture and call it lossless. Add a native frame/audio capture adapter if the basic browser capture path cannot prove fidelity.
- Lower-resolution or compressed capture is an explicit user-selected mode, never a silent fallback.
- Create fixed-rate preview proxies only as separate labelled derivatives when requested. Keep source capture timing authoritative.
- Keep original capture data and all takes unchanged.

## Scene workflow

A project may contain ordered scenes. Each scene can have an outline or script and multiple takes. Stopping a take returns to a simple choice:

- Use take
- Retry
- Keep both and decide later

Prior takes remain available.

## Teleprompter

- Optional and hidden when empty.
- Adjustable text size, width, alignment, speed, and opacity.
- Manual scroll first.
- Voice-following mode may ship only after repeatable accuracy tests.

## Pointer telemetry

Record pointer position and button clicks only when enabled. Never record typed keys or clipboard data. Store telemetry locally in a versioned event file.

## Failure handling

- Detect device removal, permission denial, disk exhaustion, encoder failure, and source loss.
- Preserve valid partial recordings.
- Explain the recoverable result without dumping logs into the main UI.

## Native capture adapter (2026-10-07)

`packages/recorder` captures through FFmpeg in main, never through the browser's lossy MediaRecorder. One process per take segment captures the display (x11grab on Linux/X11, gdigrab on Windows, avfoundation on macOS) and an optional microphone (PulseAudio/ALSA, DirectShow, avfoundation) into Matroska with FFV1 video at a constant frame rate and 16-bit PCM at 48 kHz. FFmpeg's frame, duplicate and drop counters are kept as evidence. Each input's wall-clock start is read from FFmpeg's input headers; on Stop every segment's audio is shifted to its first video frame with exact samples (zero padding or trimming) and cut to exactly one video duration, then segments from Pause/Resume are joined without re-encoding. A `session.json` records segments, offsets, pauses, counters and the output hash; segment files are kept.

Evidence: `tests/media/recorder.test.ts` covers argument construction per platform, progress/device/start parsers, and a real paused-and-resumed take using a labelled test pattern and test tone, which becomes one FFV1/PCM file with exactly 1600 samples per 30 fps frame that the exporter accepts. Not yet available: the recording screen, real microphone/screen hardware tests, Windows and macOS runs, system audio, camera, separate per-source files, pointer telemetry, device-latency compensation and Wayland.

## Recording screen (2026-10-07)

Home offers **New recording**. The dialog lists displays from Electron in physical pixels (Linux X11 and Windows) and microphones (PulseAudio sources on Linux, DirectShow on Windows), plus "No microphone". The renderer sends only opaque ids (`display-1`, `pulse-1`); FFmpeg device names, coordinates and file paths stay in main. Start runs a 3-2-1 countdown that Stop can cancel, then records at 30 fps through the capture adapter. The live view shows elapsed time, Pause/Resume and Stop, and reports missed frames from FFmpeg's duplicate/drop counters only when there are any. Escape does not end a running take.

Stop joins the take, names it `Recording YYYY-MM-DD HH.MM.mkv`, imports it into the media library like any source and opens a new project from it. The working media files are then removed; the take folder keeps `session.json` as sync and dropped-frame evidence. Recordings are FFV1 `bgr0`, full range, tagged sRGB; the still-frame preview shows their B, G, R samples unchanged with opaque alpha.

macOS screen indices and Wayland are not supported yet; the dialog says so instead of offering a broken Start. With `AI_VIDEO_EDITOR_TEST_CAPTURE=1` the only devices are a labelled test pattern and test tone, paced in real time so the counters mean the same as for a screen.

Evidence: `tests/media/recording-service.test.ts` (device projection without FFmpeg names, Wayland/macOS messages, unknown device, a paused and resumed synthetic take imported with exact preview and only `session.json` left), `tests/media/recorder.test.ts` (adapter, alignment, exact preview of the take) and the packaged `tests/native/recording.test.ts` (dialog, countdown, Escape kept, pause holds the clock, stop opens a project whose preview equals an unconverted decode of the managed FFV1 file). These use synthetic devices only; no real screen or microphone run is claimed. Open: Chromium cannot play FFV1, so recorded projects preview frame by frame until labelled playback proxies exist (P3-05); window/region capture, system audio, camera, global shortcuts, crash recovery, scenes and takes, pointer telemetry, Windows and macOS runs.
