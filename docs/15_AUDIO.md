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

The Audio card in Auto Edit offers two choices, read and set with `audio:get`/`audio:set` and applied only when exporting (main export and short clips); sources are never changed and preview playback is not processed. Since 2026-10-15 the choices are part of the draft (`timeline.audio`, a `set_audio` transaction), so changing them is undoable with every other edit and assistants can set them with `audio.configure`. A draft without its own choice still uses the per-project choice saved by earlier versions (read only) or the default; the card re-reads the choice whenever the draft head changes.

- **Reduce background noise** runs FFmpeg's spectral denoiser (`afftdn`, 12 dB reduction, noise floor tracking) for steady hiss and hum.
- **Even out volume** measures the whole draft with `loudnorm` and then applies the measured correction (linear where the true-peak ceiling allows) to -16 LUFS integrated with a -1.5 dBTP ceiling, a common level for spoken online video.

Cleanup runs on the assembled canonical audio before encoding, is resampled to the working rate and cut or padded to exactly the planned sample count, so sync with the frames is unchanged. The processed audio becomes the canonical audio, so a lossless master still decodes to exactly what was rendered. The export result says "audio cleaned". `tests/media/export-render.test.ts` measures a cleaned export at -16 ± 1.5 LUFS with an exact sample count and a speech-to-hiss gap at least 3 dB wider than the plain export; the native captions test exports with volume evening on. Music and sound effects are described below; not yet: gain per clip and a processed preview of the cleanup.

## Music and sound effects (2026-10-24, ADR 0023)

The Sound card in Auto Edit (below Audio) adds music (a bed from the start of the edit) or a sound effect (at the playhead) from an audio file the user chooses (mp3, wav, flac, ogg, m4a, aac, opus). The file is copied into the project, hashed and probed; the original is never changed. Each layer shows its name, where it plays, a volume slider and "Lower under speech", and can be removed; every change is one undoable draft transaction (`set_sound`/`remove_sound`) shared with every other edit, including the assistant's (`sound.set`, `sound.remove`).

- A music bed repeats to fill the rest of the edit at -18 dB, fades in over 1 s and out over 2 s and lowers 12 dB while the edit's speech plays. An effect is anchored to the moment shown at the playhead so it follows later cuts (and is not heard if that moment is cut away), plays once at -6 dB and does not duck.
- Export order: canonical audio, then the cleanup choices above, then the mix. Each layer is resampled to the working rate, trimmed, looped if asked, faded, ducked from the exact speech envelope of the edit's own audio, scaled and summed in 32-bit float, then returned to the canonical representation (cut or padded to the planned sample count) so the lossless master still decodes to exactly what was rendered. Loudness evening is not re-measured after the mix. A recording without audio cannot take sound layers.
- Preview plays the layers beside the video, following the playhead; it does not duck. Export is authoritative.
- Evidence: `tests/media/sound-mix.test.ts` (envelope, ducking, fades, looping, exact length), `tests/media/sound-assets.test.ts` (import, dedupe, hash check), `tests/media/export-render.test.ts` (a mixed export with decoded-equals-canonical), `tests/media/sound-view.test.ts` and `tests/media/codex-tools.test.ts` (defaults and refusals), `tests/foundation/test_desktop_ipc.py` (IPC contract).
