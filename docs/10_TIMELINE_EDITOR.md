# Simple timeline editor

## Model

The timeline is non-destructive and operation-based. Media time uses integer microseconds. Display frames use rational frame-rate conversion with tested rounding.

## Required tools

- select clip or range
- split at playhead
- trim left or right edge
- ripple delete selection
- restore deleted range
- move supported clips
- change clip order inside supported scene groups
- snap to playhead, cuts, transcript words, clicks, scene boundaries, and markers
- undo and redo

## Fixed tracks

1. Main video
2. Camera
3. Production audio and system audio
4. B-roll and image overlays
5. Text and captions
6. Effects markers for zoom and speed

Do not expose arbitrary track creation in the first release. Empty tracks stay hidden.

## Transcript edit

Full transcript-text editing should create linked cut operations when the user deletes source words, and restoring deleted text should restore linked media when no later operation conflicts. Highlight uncertain words and prevent accidental deletion without review; this semantic text-to-media restoration path is not part of the current manual word-range cut control.

The current P5-02 slice lets a user search for and correct one locally transcribed word or select a word range to cut in Edit. A correction is stored as text-only metadata in the draft timeline and commits through the shared transaction journal, so Undo, Redo and project reopen preserve it. A selected-word cut binds the source, transcript and word IDs to the current draft head, maps the inclusive word range to exact source and output times, and commits a ripple delete only when it lies in one continuous visible clip. Undo restores the previous clip map; there is no separate transcript restoration control yet. Both operations leave the original ASR transcript and recorded audio unchanged. A selected-word cut does not establish that the speech is expendable, verify A/V joins, or render a synchronized result. Never imply that changing transcript text changes speech.

## Direct manipulation

- Drag cut edges.
- Drag zoom and speed blocks.
- Select a zoom to show target handles in the preview.
- Select camera or B-roll to move and resize it on canvas.
- Keep numeric controls available in the inspector for precision.

## History

Manual actions and Codex actions share one ordered history. Each item shows origin, short reason, affected time, and Undo. The committed journal records Redo as a new hash-chained transaction. Redo applies the latest undone edit in stack order, remains available after reopening, and clears when a new edit is committed. Batch operations can be expanded.

P2's shared foundation implements strict start/end trimming, interior splitting and a marked ripple range cut for one or two ordered immutable sources. It maps requested output-timeline boundaries back to source time, reflows following fragments after a trim or cut, inserts a boundary without changing duration after a split, and persists exact before/after and inverse state in the common hash-chained journal. A split retains the left fragment's ID and derives the right fragment's ID from the trusted operation; a cut retains surviving spans and derives a right fragment ID when it cuts the middle of one. Both preserve source order and are bounded to 4096 fragments. A cut uses a nonempty, non-whole-draft half-open `[in, out)` interval; it may cross fragment/source joins or remove a source's complete visible span without deleting that source from the immutable inventory. The Edit stage exposes playhead-based Trim start, Trim end, Split, Mark in/out, Cut range, Clear, Undo and Redo through trusted manual IPC. Marks are tied to the current committed head and invalidated when it changes. Manual Redo reapplies the most recently undone transaction through the same durable journal, and a newly applied edit clears the redo stack. Codex and API-provider turns can also submit `cut.split` and a bounded `cut.delete_range` to those reducers with exact draft-head freshness, through the same undo history. This exposes exact user-specified structural edits, not automatic transcript or audio-based editorial selection; Magic Wand must join them later. General range selection, restore beyond newest Undo, move, broader clip movement and complete multi-track A/V ripple semantics remain P3/P6 work.

The guarded `cut.delete_ranges` tool now submits 2–16 confirmed disjoint ranges measured on one current output timeline. It requires descending start-time order, applies them in one atomic transaction and presents one newest Undo. A later invalid operation leaves no partial journal entry. Codex/API providers can honor exact requested time ranges; their present read tools still cannot identify filler or certify that speech and A/V joins are coherent.

The guarded `cut.restore_range` operation restores one exact, confirmed half-open source-time interval from one immutable baseline source clip. The Edit stage exposes the same operation through a small source and time form for a user-confirmed missing interval. Main rejects ambiguous or unknown sources, invalid bounds, overlap with visible material and mixed operations. The clip returns in baseline source order at its source-time position; output timing is then reflowed. The complete before/after maps and inverse share the existing journal, freshness rules, reopen replay and newest Undo/Redo. This is explicit structural restoration and does not infer missing speech. Generalized transcript-linked restoration remains future work.

## Preview

Preview must match the timeline within declared tolerances. Proxy playback may use lower quality, but timing, crop, layout, and text placement must remain representative.
