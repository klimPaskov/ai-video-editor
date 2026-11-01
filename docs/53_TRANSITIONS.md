# Transitions

User requirement (2026-10-25): an edit full of hard cuts needs transitions, by hand and from the assistant. This document records what a transition is in this app, how it behaves, and what it does not do. The decision is ADR 0025.

## What a transition is

A transition is a styled overlay centred on a cut that hides the jump between two moments. It is a draft effect like a zoom or a graphic: stored in the draft, changed only through undoable transactions, followed by preview and export identically.

| Style                  | Look                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Dip (to a colour)      | The picture fades to a flat colour at the cut and back. Black and white are offered; the assistant may pass any `#rrggbb`. |
| Wipe right / Wipe left | A colour panel sweeps across, covers the frame at the cut and leaves; a lighter trailing panel follows it.                 |
| Iris                   | A circle of colour opens from the centre until it covers the frame at the cut, then closes.                                |

The overlay is fully covering at the first frame of the incoming clip, which is what hides the cut; before and after, the picture shows through. Length is 0.2 to 2 s in total (default 0.6 s), centred on the cut. The window never reaches into a third clip: it is limited to the shorter of the two neighbouring clips.

## A cut, and where a transition lives

A cut is a boundary where the next clip does not continue the previous one unbroken: a different recording, or a jump in the same recording. A split or a speed change inside one stretch of a recording is not a cut and takes no transition. The first frame after a cut has an output time; that time is what the Edit control and the assistant tool name.

A transition is anchored to the source moment where the incoming clip starts (`source_id`, `source_us`), so it follows later cuts the same way graphics and zooms do. When the cut it belongs to disappears (the two parts are joined again, or the incoming part is cut away) the transition becomes dormant: it stays in the draft, draws nothing, and returns if Undo brings the cut back. A cut holds one transition; setting another replaces it.

## Edit step

In Edit, More tools has a style choice (Dip to black, Dip to white, Wipe right, Wipe left, Iris), a length (0.3, 0.6, 1 s) and Add transition. The control acts on the cut nearest the playhead:

- With no cut yet it is off, and its name says there is no cut.
- Add transition puts the chosen style and length on that cut; the player moves to the start of the transition.
- On a cut that has one, the button reads Change transition and Remove transition appears. Changing the style or length applies at once.
- Every change is one undoable edit that shares Undo and Redo with all others.

The timeline strip marks each transition on its cut with a small hatched marker.

## Assistant tools

`transition.set` and `transition.remove` are offered on every route (Claude, Codex and the API-key providers), bringing Claude's editor inventory to twenty-three tools, Codex's to nineteen and the API providers' to eighteen.

- `transition.set` takes `at_us` (the output time of the first frame after the cut; the timeline summary lists every real cut in `cuts`, with `transition_id` when one is set), `kind`, optional `duration_us` (default 0.6 s) and `color` (default black), and optionally a `transition_id` to change one. A time that is not a cut is refused.
- The summary also lists `transitions` with their output time and visible range (null while dormant).
- The playbooks tell the assistant to use them sparingly, on the cuts that start a new section, scene or idea, with the kind and colour taken from the video's visual identity, and to look at a few cuts with `media.get_frames`. Tidy adds none.

## Rendering and the lossless boundary

A placed transition expands to a graphic interval above every graphic (layer 100) and is drawn by the same stage page the preview and the export already use, seeked frame by frame. Frames outside a transition's window are untouched and stay bit-identical to the cut footage; frames inside it are drawn over exactly as graphics are. Audio is not changed: it keeps its hard cut. Short clips and rendered pictures include the transitions inside their window.

## Limits and what is not done

- Overlay transitions only: there is no true cross-dissolve, because it would need frames beyond the cut from both sides and would change the lossless frame planning. A dissolve could follow as a separate decision.
- No audio crossfade or sound effect on a transition.
- One transition per cut; no "apply to every cut" command (each would be a separate undo step).
- The window is centred on the cut and symmetric; asymmetric windows are not offered.

## Evidence

- `tests/media/transitions.test.ts`: validation, cut detection (splits and speed changes are not cuts), centred windows clamped to the neighbouring clips, dormant transitions, markup of every style passing the graphic content rules, graphic intervals on layer 100.
- `tests/media/draft-transactions.test.ts`: set, replace on the same cut, refusals, remove, Undo and replay after reopen.
- `tests/media/*` tool, MCP, dynamic-tool, Claude and API-provider tests for the nineteen, twenty-three and eighteen tool inventories; foundation tests and `scripts/validate_package.py` for the schemas and examples (`draft_transaction_transition`, `desktop_ipc_manual_transition`).
- `tests/native/transitions.test.ts` (packaged app, isolated guest): the control is off without a cut, a time that is not a cut is refused, a dip added in Edit is drawn in the live preview (opacity 1 at the cut, partial before it, absent outside its window), every style covers the centre of the preview in its colour at the cut, a verified lossless master differs from the cut footage only inside the window and its first frame after the cut is black, Remove and Undo restore the draft, and the source file is unchanged.
