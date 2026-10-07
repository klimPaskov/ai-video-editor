# Live state, transactions, and undo

## Source of truth

The main process owns the canonical project state. The renderer holds a view model and sends typed intents. Codex and manual controls use the same domain command layer.

ADR 0013 brings real project identity, source references, initial timeline/baseline revision and persisted active stage into P1. It brings the transaction core necessary for the real guarded fixture edit into P2. P3 and P6 retain all complete project, editing, revision and recovery acceptance. Earlier prerequisite implementation does not establish those complete features.

Project navigation selects a workspace stage without editing media. Persist navigation state before announcing it, preserve the committed draft and source context, and keep it separate from draft sequence and undo history. Stage changes never manufacture automation, successful review or export. Failed navigation saves retain the previous committed stage.

## Draft sequence

Every accepted mutation increments an integer draft sequence. Requests carry the expected sequence. A stale request is rejected and the caller receives the current sequence plus a compact rebase summary.

## Transactions

A transaction contains one or more operations and has these states:

1. received
2. validated
3. applied
4. persisted
5. announced

No UI patch is announced before persistence succeeds. A failed transaction leaves the prior state intact.

The P2 transaction foundation validates project, draft, baseline revision, expected sequence and exact timeline hash before it derives any operation. Existing trusted adapters inject the manual, Codex or Magic Wand origin plus transaction, operation, and timestamp authority. The engine writes a complete staged record, flushes it, atomically renames it into one ordered hash-chained journal, and returns only the committed state. Reopen deterministically replays every record. Recognized incomplete staging files are retained and ignored; a disconnect after rename reports an unknown outcome so reopening and the stable request ID can discover the one committed result. A stale error carries only the compact current draft identity needed to refresh. ADR 0014 requires a similarly trusted API-provider adapter; its integration is not established by existing transaction evidence.

The bounded reducer trims one edge of a committed clip, splits it at an interior playhead position, or ripple-deletes one marked output-timeline interval. Split retains the left clip ID and derives the right ID from trusted operation authority. A middle cut can similarly derive a surviving right fragment ID, and a cut may cross source joins or remove a source's entire visible interval while retaining its immutable inventory entry. Ordered fragments map to immutable source intervals. Each operation stores exact prior state for deterministic journal replay and newest-transaction undo. The range cut rejects empty, reversed, out-of-bounds and whole-draft intervals, and validates the same exact draft sequence/hash as other edits. Source immutability is tested on one- and two-source drafts. Standalone restore beyond newest Undo, general move and reorder, redo, group undo, externally concurrent writers, directory durability after power loss, and full P3/P6 recovery remain incomplete.

## Live Codex changes

During a Codex turn, valid transactions may be committed to the active draft as tools complete. The current trim, split, range-cut and newest-undo slice rereads the atomic draft after every settled mutation and updates project duration, seek bounds, committed fragment map and preview source mapping from that sequence/hash. It also reconciles a transaction that committed before an uncertain tool response. The native Edit stage exposes manual trim, split, marked range cut, exact source-range restore, transcript word correction, selected-word ripple cut, and newest Undo/Redo through shared committed state. Broader selection, grouped undo and Codex/API transcript analysis remain dependent on later editor surfaces; transcript operations require a user-selected range and the current local transcript. Guarded `cut.split` and `cut.delete_range` give Codex and the fixed API-provider adapters the same reversible reducers with exact committed-head preconditions; these structural tools do not provide transcript analysis or synchronized A/V review.

Guarded `cut.delete_ranges` applies 2–16 confirmed, nonoverlapping half-open output intervals in descending order under one head precondition and one durable transaction. Its two or more operation records preserve each before/after clip map; newest Undo restores the pre-batch map in one step. Reopen replay, stale rejection, and immutable sources are tested. This batch is a structural cut primitive, not a verified spoken pass checkpoint.

Project frame reads include the expected committed head. Main maps output time through the current clip, decodes the immutable source, and checks the head again. A concurrent edit returns the newer path-free draft without stale pixels. Duplicate events at the same sequence/hash are ignored; a lower sequence is stale and an equal sequence with a different hash is an integrity failure.

The UI must not stream raw protocol traffic into ordinary screens. Diagnostics can show the full event sequence.

## Stop and interruption

Stopping a Codex turn prevents new tool calls. Transactions that already reached the persisted state remain in history. The user can undo the latest transaction or the whole turn batch. Interrupted analysis without applied transactions leaves no timeline mutation.

## Unified history

Manual, Magic Wand, and Codex edits share one ordered history. Each history item records:

- origin
- summary
- affected range
- transaction and operation IDs
- before and after state
- timestamp
- undo and redo payload
- dependency invalidations

A Magic Wand run or Codex turn appears as a collapsible group. Undoing a group reverses its transactions in reverse order after dependency validation.

## Verified pass checkpoints

A trusted verification service may record a pass checkpoint only against the exact current sequence, timeline hash, head transaction hash, pass ID/kind, and complete set of still-applied transactions in that newest pass. Every check in the record has status `pass`, a bounded method, and evidence IDs. The checkpoint is separately hash-bound, file-synced, and atomically renamed; it does not increment the edit sequence or clear undo. Any later edit or undo makes it historical rather than current. The storage contract rejects a checkpoint for another pass, a stale state, missing transactions, failed checks, duplicate IDs, or a corrupted record. This proves checkpoint identity and process-crash persistence only; the caller must still perform the stated transcript, render, audio, or visual checks. Power-loss durability for the containing directory remains unproven.

## Revision commit

Autosave protects the active draft. A named revision freezes a validated timeline snapshot, operation list, source hashes, and relevant settings. Later changes create a new draft from that revision. Existing revisions never change in place.

## Recovery

Persist transaction intent to staging, validate, flush, then promote atomically. On restart, recover only fully persisted transactions and checkpoints. Incomplete staging records become diagnostic evidence and are not replayed without validation. Full power-loss and external-writer recovery remain P3 work.
