# Transcript and captions

## Transcription

- Run locally by default.
- Produce stable word IDs and integer microsecond times.
- Store model identity, language, confidence evidence, and raw result hash.
- Detect reversed, overlapping, negative, and out-of-range timing.
- Support explicit language choice and re-transcription.

## Transcript editing

- Clicking a word seeks the preview.
- Text correction changes caption text without changing audio.
- Deleting words creates linked media edits.
- Uncertain words are marked quietly.
- Search supports words and timestamps.

## Captions

- Generate phrase groups from word timing.
- Support plain, current-word highlight, and minimal subtitle styles.
- Control font, size, weight, line length, position, background, and safe area.
- Avoid covering active UI and camera faces when possible.
- Reflow after canvas or crop changes.
- Export SRT and WebVTT sidecars when requested.

## QA

Check order, bounds, readability, safe areas, line breaks, collisions, missing words, duplicate words, and synchronization after cuts and speed changes.

## Editorial instructions and coherence

Apply [47_EDITORIAL_FIRST_CUT.md](47_EDITORIAL_FIRST_CUT.md). Transcript processing reuses the actual job handle; request transcription once only when absent, and do not restart merely because an observation times out. Configured editor cues identify candidates, not unconditional commands. Inspect neighboring sentences and visuals, accept conservative variants, require opt-in legacy aliases, and retain quoted or ambiguous cues and affected content as unresolved items.

Use word-level timing and microphone silence as supporting evidence for semantic cuts within verified synchronized edit sets. Never cut an independent screen source merely because narration was removed. Preserve the final complete retake, unique setup and qualifications, meaningful pauses and protected material. Verify every resulting transcript/A/V join; perform a separate whole-source omission pass and a complete edited-transcript reread in scene order. Restore necessary wording when a join fragments a sentence or loses context. Resolved spoken directions may be cut only after their edits and joins are verified.

Do not polish transcript text to disguise an awkward recording edit. Text/caption correction remains distinct from audio cuts and never resynthesizes speech. Tests include quoted/phonetic false cues, ambiguous scope, incomplete final retakes, independent screen layers, retained demonstration pauses, full-reread omissions and successful restoration.

## Implemented captions (2026-10-07)

Captions are derived, not stored: `packages/domain/src/captions.ts` takes the local transcript words with the user's text corrections, keeps only words wholly visible in the current clip map, and maps them to output time, so captions follow every cut, Undo and Magic Edit. Words are grouped into captions at pauses of 0.7 s or more, at sentence ends once a caption has been up for 0.8 s, when two lines of 42 characters are full, or after 6 s. Two lines are balanced, preferring a break after a comma. A caption stays up 0.4 s after its last word unless the next one starts sooner, and never overlaps the next.

The Captions card in Auto Edit turns captions on and chooses Plain (text on a dark box), Highlight words (the spoken word in yellow), Minimal (shadowed text), three sizes relative to frame height, and bottom or top placement. Only these choices are stored, per project (`captions:get`/`captions:set`). The preview draws the caption over the displayed frame in every step and while playing. When captions are on, export writes `<video name>.srt` beside the verified video (SubRip, CRLF); WebVTT is available in the domain but not offered yet.

Evidence: `tests/media/captions.test.ts` (punctuation joining, cuts and partly cut words, pauses/sentences/length/duration, balanced lines, exact SRT and WebVTT text) and packaged `tests/native/captions.test.ts` (a real public speech sample transcribed locally, captions inside the frame at bottom and top, the spoken word highlighted, a cut word gone from the caption, and an exported .srt whose last cue ends within the edited duration). **Burn into export** (stored with the other choices) also draws the same captions into the exported frames. Export writes an Advanced SubStation script (Arial, the preview's size fraction of frame height, the same box, highlight colour and placement) and passes the canonical frames through one FFmpeg `ass` stage before encoding. libass draws in the frames' own pixel format, so frames without a caption stay bit-identical; this was checked for BGRA, BGR0, YUV 4:2:0, 10-bit 4:2:2, planar RGB and 16-bit RGB. The composed frames are the canonical render, so a master still passes the decoded-sample equality check. `tests/media/export-render.test.ts` confirms only the covered frames change; the native test exports with burn-in on. Glyphs come from the system's fonts, so the exact letter shapes can differ between machines.

Not yet: per-caption text editing beyond transcript corrections, collision avoidance with camera or screen content, and reflow for other canvas shapes.
