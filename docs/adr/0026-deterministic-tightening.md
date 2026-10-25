# ADR 0026: Pauses and fillers are tightened by the app, confirmed by the audio

- Status: Accepted 2026-10-25 (partly supersedes ADR 0020)
- Scope: Magic Edit / rough cut pacing

## Problem

ADR 0020 made pause and filler analysis advisory: Claude saw at most 300 hints, could delete 16 ranges per call, and was told to keep when unsure. In a real six-minute edit most pauses and fillers stayed, which the user rejected.

## Decision

- Pacing is deterministic. Before Claude starts, the app plans pause and filler cuts, then applies them as one undoable transaction (up to 1024 ripple deletes; the 64-operation cap in `draft-transaction.ts` and its schema is raised for this).
- A pause is a gap between neighbouring words (or before the first / after the last word) longer than the preset threshold. It is shortened to the preset's kept length. The cut is placed in the quietest part of the gap using a 10 ms loudness track of the source (`decodeEnergyTrack`), and is refused when that stretch is not clearly under the recording's speech level (`isQuietSpan`), so speech the transcript missed is never cut. Without loudness data a gap must also be mostly detected silence.
- Presets: Natural (>0.8 s shortened to 0.5 s), Balanced (default; >0.45 s to 0.3 s), Tight (>0.3 s to 0.2 s). All remove clear fillers.
- Repeated wording and everything editorial stay with Claude, which is told how many pauses and fillers were already tightened and must not redo them.
- The summary reports real pause, filler and left-for-review counts.

## Consequences

Cuts that never touch speech are no longer at the model's discretion. Over-cuts are undone with the normal Undo or `cut.restore_range`. A crossfade at joins and a Pacing choice in Auto Edit follow in later slices.
