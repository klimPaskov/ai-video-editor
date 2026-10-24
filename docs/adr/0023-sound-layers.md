# ADR 0023: Music and sound effects as undoable draft layers

- Status: Accepted; implemented 2026-10-24
- Date: 2026-10-24
- Scope: Audio files in a project, sound layers in the draft, the export mix, the Auto Edit Sound card, preview playback and Claude's sound tools

## Context

The editor could cut, retime, caption and normalise a recording and lay motion graphics over it, but it could not add a music bed or a sound effect. A finished video normally has both, and the assistant (a harness, ADR 0021) had no way to use them. Adding sound must not weaken the non-destructive draft, shared Undo, immutable sources or lossless export, and must not make the app fetch anything from the network.

## Decision

- **Audio files are project assets.** The user adds a file in the Sound card (Auto Edit) (a dialog owned by the main process; no path crosses IPC). Main copies it into `project-store/<project>/sounds/`, hashes it (SHA-256), probes the copy with ffprobe and records `asset_id`, name, duration, sample rate and channels in `index.json`. The same bytes are never stored twice; at most 256 files and 512 MiB each. The original file is only read. The files are never modified, and every use re-verifies size and hash.
- **Sound layers are part of the draft.** `timeline.sounds` holds layers (`music` or `effect`) that name an asset by id and hash, a start (a fixed output time for a bed, or a source moment so an effect follows later cuts and is silent when that moment is cut away), a duration, level in whole dB, fades, a ducking amount and a loop flag. They change only through `set_sound`/`remove_sound` transactions (one operation each, any origin, shared Undo/Redo and replay on reopen).
- **Defaults are shared.** `buildSoundLayer` (domain) gives music a bed from the chosen time to the end of the edit at -18 dB with a 1 s fade in, a 2 s fade out, 12 dB of ducking and looping; an effect is anchored to the source moment at the chosen output time, plays once at -6 dB and does not duck. The Sound card and Claude's tools use the same builder.
- **The export mixes after cleanup.** The export renders the canonical audio, applies the user's cleanup (noise reduction, loudness), then mixes the layers in 32-bit float and returns to the canonical representation, so a lossless master still decodes to exactly the audio that was rendered. Ducking follows the exact speech envelope of the edit's own audio (not the music or effects). A draft with sound layers on a recording without audio is refused with a clear message. Loudness normalisation therefore does not include music added after it; the sound card says levels are relative to the file.
- **Preview.** The preview plays layers beside the video from a read-only app-scheme route (`sounds/<project>/<asset>`, hash-verified once per file version) and follows the playhead. It does not duck; the export is authoritative.
- **Claude only.** Claude gets `sound.list`, `sound.set` and `sound.remove` (inventory twenty-one). Codex and the API providers do not list them. The assistant cannot download, generate or search for sound: it can use only files the user added, so the copyright-free-only asset setting has nothing to gate here and an empty list means leave sound alone.
- **Security.** Layer fields are strictly validated; the asset id and hash tie a layer to bytes; ffprobe and ffmpeg receive only app-created paths; project removal deletes the project folder with its sounds.

## Consequences

- Draft, snapshot and transaction schemas gain `sounds`, `sound_layer` and `sound_operation`; IPC gains `sounds:get|add|update|remove`.
- The manual Sound card exposes volume and "lower under speech" per layer and removal; richer controls (fades, trim, start time) are reachable through the assistant or later UI work.
- Not done: waveform display, per-layer preview ducking, loudness normalisation of the final mix, loop crossfades, audio-only project sources.
