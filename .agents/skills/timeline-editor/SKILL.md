---
name: timeline-editor
description: Implement the operation-based simple timeline, transcript edits, history, and revisions.
---

# Timeline editor

## Use when

Changing edit operations, timeline UI, snapping, undo, autosave, or revisions.

## Requirements

- canonical operation schema
- select, split, trim, ripple delete, restore, move, and supported reorder
- transcript-linked edits
- fixed semantic tracks
- direct on-canvas manipulation for spatial items
- shared manual and Codex history
- atomic transactions
- deterministic inverse or before state
- autosave journal and snapshot recovery
- immutable revisions

For the P2 transaction foundation, start with one strict canonical operation that can be
proved end to end before widening the reducer. Persist append-only transaction envelopes
with the prior sequence and timeline hash, the complete before/after state, a deterministic
inverse, origin injected by the trusted entrypoint, and a self/prior hash chain. Rebuild the
draft from the immutable baseline and committed journal on reopen. Stable request IDs are
idempotent only when their canonical requests match exactly; a reused ID with different
content is a conflict. A verification checkpoint is a separate hash-bound record for the
current pass and does not commit a revision or clear undo history. Every passing check must
cite at least one concrete evidence ID; never record verified status with an empty evidence list.
The P2 structural-checkpoint helper is limited to the current manual-origin group and validates
stored timeline/journal/managed-source state only; never use an AI-selected pass label or mark
spoken, layout, zoom, or A/V review as complete with it.

The Review integrity action may call the main-owned helper only after a user explicitly chooses
the check. Return a checkpoint indication only when the persisted record still matches the
returned committed head. If no current manual group exists, report structural integrity without
manufacturing an empty transaction or claiming a checkpoint.

Keep transaction and navigation writes on the same project-root serialization boundary.
Pending same-directory files may be ignored during recovery, while a corrupt committed
journal entry fails closed. Do not expose filesystem paths or let renderer or model input
supply a trusted edit origin.

The completed P5-02 slice adds `transcript_edit` and `transcript_cut` to the same hash-chained
draft transaction. Main binds a correction to an existing local transcript/source/word,
verifies the expected current text, and records only a draft metadata override. For a cut,
main binds the ordered start/end word IDs to the same source and transcript, resolves their
exact source times from the immutable transcript, and requires one continuous mapping onto
the current visible clip before committing the ripple delete. Both operations survive
Undo/Redo and reopen without altering the original ASR transcript or recorded audio. Undo
is the current restoration path; do not claim that transcript text changes speech, that a
word cut is meaning-preserving, or that the clip-map edit verifies synchronized A/V joins.

For the partial two-source baseline, preserve the two ordered clip/source identities and
half-open contiguous timeline intervals. A trim on the first clip must reflow the second
through the same transaction and undo journal. Do not mutate either immutable source or
the baseline, and do not treat this still-frame map as synchronized A/V playback or export.

The native Edit controls use exact head-bound manual trim and newest undo through the
same store as Codex. Redo appends a separate hash-chained transaction for the newest
undone edit, rebuilds its stack on reopen, and clears that stack on a newly applied edit.
Main injects the manual origin and operation identity; renderer input carries only
bounded intent. Return the committed clip map and Undo/Redo targets with every draft
refresh so an assistant edit cannot leave the next manual target stale. Disable trims at
clip boundaries and keep failure/uncertain outcomes truthful.

For the partial split tool, require an interior playhead position on the currently
committed fragment. Keep its left ID and derive the new right ID from the trusted
operation rather than renderer input. Preserve half-open timeline/source intervals,
source order, total duration and the immutable baseline. Bound the fragment count,
store the exact inverse in the shared journal, and refresh the committed fragment map
before another manual or assistant edit. Split must be undoable and replay identically
after reopen; it is not a ripple delete or an audio/video render.

Expose the same split reducer to the guarded Codex and fixed API-provider adapters only with exact draft-head freshness, current clip ID, interior output time, pass group and reason. Main supplies origin and journal IDs; the AI tool must return committed state and refresh the native fragment projection. Without transcript or audio evidence, the call can honor an exact requested split but cannot infer a meaningful speech boundary.

For a confirmed range batch, require 2–16 disjoint half-open output intervals in descending start-time order. Apply every interval against the same pre-transaction coordinates through one prepared transaction, persist once, and return one newest Undo. Reject overlap, ascending order, malformed ranges, stale heads and whole-draft removal without a partial journal entry. Do not label structural cuts as verified speech cleanup without transcript context and rendered A/V join checks.

For the partial marked range cut, bind both marks to the current committed head and
send only a strict `projects:manual-range-cut` output interval. Reject empty, reversed,
out-of-bounds and whole-draft intervals. The half-open interval may cross fragment or
source joins and may remove one source's complete visible span. Keep the immutable
source inventory and baseline, reflow surviving fragment positions, derive any new
right fragment ID from trusted operation authority, and store an exact inverse in the
shared durable journal. Refresh preview and tool targeting from the committed map;
newest Undo must restore the previous map after reopen. This output-time
`ripple_delete` is distinct from `transcript_cut`, which also records source/transcript/word
IDs and requires a continuous local transcript mapping. Neither operation is a
synchronized A/V render or a model-visible Codex transcript tool.

For guarded `cut.restore_range`, accept exactly one confirmed missing half-open
source-time interval per transaction, identified by `source_id`, `source_start_us` and
`source_end_us`. Resolve it against exactly one immutable baseline source clip; reject
unknown or ambiguous sources, out-of-bounds/reversed intervals, visible overlap, and
mixed-operation requests before any journal write. Insert the clip using baseline source
order and source-time position, then reflow output positions. Persist the complete
before/after clip maps and their hash-bound inverse in the same manual/Codex/API/Magic
Wand transaction store. Reopen must replay deterministically; newest Undo and Redo must
restore the adjacent maps without touching source files or the baseline. Test later
trim before restore, restoring a fully removed earlier source ahead of a later source,
overlap/ambiguity rejection, stale freshness, reopen, undo/redo and immutable inputs.

The native manual Edit form sends the same strict source interval without source paths,
transaction IDs, pass groups or origins. Main injects manual authority and the shared
journal IDs, validates the active Edit stage and returns only the committed path-free
draft. Parse displayed decimal seconds to exact integer microseconds; never pass a
rounded floating-point time into the reducer.

## Validation

Test zero and final boundaries, overlapping operations, ripple mapping, speed mapping, zoom blocks, transcript restore, batch undo, stacked undo/redo replay, clearing redo after new work, crash recovery, stale dependencies, and revision compare. The first bounded reducer must also test immutable source/baseline bytes, reopen replay, postcommit-unknown recovery, strict input rejection, stale-head concurrency, and checkpoint invalidation. For split, test exact interior/boundary behavior, fragment IDs/order/limits, seek equivalence on both sides, trim-after-split, undo and replay. Use Playwright Electron for pointer and keyboard flows once the transaction path changes native UI behavior.

## Simplicity rule

Do not add professional editor complexity unless a named requirement needs it.
