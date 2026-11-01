# ADR 0025: Transitions as undoable draft effects drawn like graphics

- Status: Accepted; implemented 2026-10-25
- Date: 2026-10-25
- Scope: Transitions in the draft, the Edit control, the assistant tools on every route, preview and export rendering

## Context

The editor could cut, zoom, retime, caption and overlay motion graphics, but every cut was a hard cut. After a full AI edit the user found the result had no transitions. Claude could draw a graphic at a cut, but that was not a feature: it was not tied to the cut, did not follow later edits, could not be set by hand and left no record that a cut had been treated.

The render path streams the exact source frames through one compositor that draws zooms, graphics and captions. A real cross-dissolve needs frames from beyond the cut on both sides, which the lossless frame planner does not carry.

## Decision

- **A transition is a draft effect** (`timeline.transitions`): `transition_id`, `source_id`, `source_us` (where the incoming clip starts), `kind` (`dip`, `wipe_right`, `wipe_left`, `iris`), `duration_us` (0.2 to 2 s) and `color` (`#rrggbb`). It is anchored to the source moment like graphics and zooms, so it follows later cuts, and is dormant while its cut is gone.
- **One per cut; cuts are real jumps.** A cut is a boundary where the next clip does not continue the previous one unbroken. Splits and speed changes within a stretch are not cuts. Setting a transition on a cut that has one replaces it.
- **Drawn as an overlay above every graphic.** A placed transition expands to a graphic interval (layer 100, HTML and CSS built from fixed templates, passing the graphic content rules) centred on the cut and clamped to the neighbouring clips. The preview and export already draw graphic intervals frame by frame from the same stage page, so the two cannot differ, and frames outside the window stay bit-identical. No change to the frame planner, the compositor or the lossless boundary.
- **No true cross-dissolve in this decision.** Overlay styles (dip, wipe, iris) hide the cut without frames from either side. A dissolve that blends the outgoing and incoming footage would need handle frames and a change to the frame planner and audio; it is left as a possible later decision.
- **Audio is unchanged.**
- **Operations share the transaction engine.** `set_transition` and `remove_transition` are single-operation transactions with a `transition` operation record and a `restore_transitions` inverse; they use the existing pass kind `graphics`. Undo, Redo, replay on reopen and origin tracking work as for graphics.
- **Manual and assistant paths.** IPC `projects:manual-transition` and `projects:manual-transition-remove` resolve the cut from the draft in main and refuse a time that is not one. The tools `transition.set` and `transition.remove` are offered to Claude, Codex (MCP and dynamic) and the API-key providers, so the inventories become twenty-three, nineteen and eighteen. The timeline summary lists the real `cuts` and the `transitions`. The API client's tool limit rises from sixteen to twenty.
- **Guidance.** The full-edit playbook and the Codex, API and Claude prompts tell the assistant to use transitions sparingly on section changes and to look at the cut with `media.get_frames`; Tidy adds none.

## Consequences

- Draft, timeline, transaction and IPC schemas gain `transitions`, `transition_effect`, `transition_operation` and the two manual channels, with examples.
- The Edit step's More tools gains a style and length choice with Add, Change and Remove; the timeline strip marks each transition on its cut.
- Not done: true cross-dissolves, audio crossfades, an "apply to all cuts" command, asymmetric windows.
- A project written by this version carries `timeline.transitions`; an older version would reject the unknown field, as for other draft additions.
