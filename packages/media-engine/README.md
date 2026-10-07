# Media engine

Everything that runs FFmpeg or ffprobe, plus local transcription.

- `library.ts`: the managed media library. Imports are copied, hashed and probed; sources are never modified.
- `render.ts`: export planning and rendering. Frames and samples are assembled exactly from the sources, composed (zooms, captions, reframing, speed), encoded, then fully decoded and verified before the file is published.
- `lossless.ts`: the FFV1/PCM encoder and decoded-sample verifier.
- `proxy.ts`: display-only playback copies for sources the browser engine cannot decode.
- `transcription.ts`: local Whisper transcription with word timings.
- `process.ts`: bounded, cancellable process execution.
