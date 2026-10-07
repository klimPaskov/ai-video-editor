# Audio specification

## Sources

Treat microphone, system audio, camera audio, music, and sound effects as separate sources whenever available. The user chooses the production voice track when more than one microphone exists.

## Required controls

- mute and solo where useful
- clip gain
- track gain
- short fades
- noise cleanup
- high-pass filter preset
- dialogue loudness normalization
- limiter
- music ducking under speech
- replace or relink audio

Keep the default panel small. Advanced filter values remain collapsed.

## Magic Audio

Magic Audio may analyze noise floor, clipping, loudness, silence, and speech presence. It can apply a safe preset to the draft and keep the original source available. It must not invent clean audio when a recording is clipped or missing.

## Synchronization

All audio edits must follow the authoritative timeline mapping after cuts and speed changes. Audio and picture derived from one recording source must share the same operation boundaries unless an explicit J-cut or L-cut is created.

## QA

Measure decode, channel layout, sample rate, duration, A/V drift, integrated loudness, peak, clipping, dropouts, abrupt joins, and music-to-speech balance. Warn when source clipping cannot be repaired.

## Lossless master boundary

Default capture and master audio are PCM matching the source or canonical mix representation. FLAC is allowed only for compatible integer PCM. Noise cleanup, normalization, resampling, and gain are explicit reversible operations, not mandatory export processing. Preserve original sample rate, channel layout, and precision unless the edit intentionally changes them. See `docs/44_LOSSLESS_MEDIA_POLICY.md` for exact comparison requirements.

## Audio cleanup (2026-10-07)

The Audio card in Auto Edit offers two per-project choices, stored with `audio:get`/`audio:set` and applied only when exporting (main export and short clips); sources are never changed and preview playback is not processed.

- **Reduce background noise** runs FFmpeg's spectral denoiser (`afftdn`, 12 dB reduction, noise floor tracking) for steady hiss and hum.
- **Even out volume** measures the whole draft with `loudnorm` and then applies the measured correction (linear where the true-peak ceiling allows) to -16 LUFS integrated with a -1.5 dBTP ceiling, a common level for spoken online video.

Cleanup runs on the assembled canonical audio before encoding, is resampled to the working rate and cut or padded to exactly the planned sample count, so sync with the frames is unchanged. The processed audio becomes the canonical audio, so a lossless master still decodes to exactly what was rendered. The export result says "audio cleaned". `tests/media/export-render.test.ts` measures a cleaned export at -16 ± 1.5 LUFS with an exact sample count and a speech-to-hiss gap at least 3 dB wider than the plain export; the native captions test exports with volume evening on. Not yet: music, ducking, fades, gain per clip and a processed preview.
