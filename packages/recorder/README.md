# Recorder

Lossless screen and microphone capture through FFmpeg.

- `capture.ts`: command lines per platform (x11grab, gdigrab, avfoundation) and parsers for progress, devices and input start times.
- `session.ts`: one take. Pause and resume start new segments; Stop aligns each segment's audio to its first video frame with exact samples and joins them without re-encoding. A `take.json` progress record makes interrupted takes recoverable.
- `capture-supervisor.ts`: runs each capture so that FFmpeg finishes when the app quits or crashes.
