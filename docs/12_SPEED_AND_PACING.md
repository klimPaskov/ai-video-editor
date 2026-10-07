# Speed and pacing specification

## Automatic candidates

Safe candidates include:

- visible typing with little or no explanation
- loading or build progress
- repetitive setup actions
- long pointer travel
- waiting where the screen state remains understandable

## Protected ranges

Do not automatically speed up:

- important spoken explanation
- warnings or conclusions
- dense UI changes
- camera delivery where facial expression matters
- uncertain audio or transcript regions

## Segment model

A speed segment records source range, output range, multiplier, audio mode, pitch policy, reason, confidence, and origin.

## Audio modes

- Preserve and time-stretch speech with pitch protection.
- Lower or mute nonessential audio when the user chooses.
- Keep system sound when it conveys useful feedback.

## Manual control

The user can create and resize a speed block, choose a multiplier, preview it, and change audio behavior. Supported common values should be simple buttons, with a precise field under Advanced.

## QA

Check exact boundaries, expected duration, source-to-output mapping, A/V synchronization, pitch, clipped words, duplicate frames, and abrupt speed changes.

## Implemented: manual speed (first slice, 2026-10-07)

- **Control.** In Edit, the Speed menu (Normal, 2×, 3×, 4×, 8×) applies to the marked range, or to the part under the playhead when nothing is marked. It shows the current speed of that range, or "Mixed speeds". The change is one undoable `speed` operation through the shared transaction engine.
- **Model.** Speed is an optional whole-number `speed` on a draft clip (omitted at normal speed). A sped-up clip lasts ceil(source length / speed). Whole numbers keep the output-to-source mapping exact, so split, trim, range cut, zoom placement, captions and short-clip windows work inside sped-up parts. Setting a speed splits clips at the range edges and leaves parts already at that speed unchanged; the same speed again is not an edit.
- **Preview.** Playback sets the video's playback rate with pitch preservation. The timeline strip marks sped-up parts with a hatched block and a badge, and its summary shows output length separately from the footage kept.
- **Export.** A sped-up clip keeps every Nth decoded source frame. Its audio is time-stretched with FFmpeg `atempo` (pitch kept) and fixed to the exact planned sample count. Normal-speed parts stay bit-identical. A lossless master is verified against this render. Media tests check frame selection, exact audio length and a 440 Hz tone staying at 440 Hz; the packaged native test checks the clip map, playback rate, Undo and every exported frame.
- **Assistants (2026-10-07).** Claude, Codex and the API providers can call the guarded `speed.set` tool (docs/30) with an output-time range and speed 1, 2, 3, 4 or 8. It is the manual control's equivalent, not automatic pacing: one `set_speed` transaction with pass kind `speed`, exact draft-head freshness, the assistant's origin and shared Undo. Its description limits it to typing, loading or waiting with no important speech; the app does not detect such ranges or protect speech for it. Covered by media tests; native assistant runs are pending.
- **Limits.** Selecting transcript words to cut is unavailable inside sped-up parts (word times map exactly only at normal speed). The segment metadata above (reason, confidence, origin, audio mode), muting, protected-speech checks and automatic candidates (P7-04) remain open.
