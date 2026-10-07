# Automatic zoom specification

## Goal

Guide attention to meaningful screen actions without constant motion.

## Evidence order

1. Recorded click and pointer telemetry
2. Declared scene or user markers
3. Visible cursor and UI change analysis
4. Codex review of sampled frames and transcript context

Low-confidence imported footage uses fewer or no automatic zooms.

## Candidate generation

Create candidates around clicks, text entry, menu selection, key reveals, and small controls that would otherwise be hard to see. Exclude ordinary cursor travel, long narration over a static screen without a continuing readability need, and repeated nearby actions that would cause zoom pumping.

## Motion rules

- Target a visible UI region, not an arbitrary point.
- Add padding around the target.
- Keep target inside safe bounds throughout motion.
- Use smooth easing in and out.
- Hold long enough to understand the action.
- Avoid overlapping zooms.
- Merge nearby candidates when one stable shot works better.
- Return to a useful wider view after the action.

## Manual control

The user can add a zoom block, drag its edges, move or resize the target rectangle, set strength, choose follow-cursor or fixed target, and remove it.

### Implemented (manual zoom, first slice)

- **Adding.** In Edit, Zoom uses the marked range, or two seconds from the playhead when nothing is marked. The user then clicks the picture where the zoom should point; Esc cancels. A zoom needs at least 0.5 s within one recording.
- **Model.** A zoom is a draft edit anchored to source time (`zoom_effect` in `timeline.schema.json`): source ID and range, a fixed point `center_x`/`center_y` as frame fractions and a strength of 1.1–4× (the menu offers 1.5–3×). Zooms of one source never overlap. Because they are anchored to source time they follow cuts; a cut inside a zoom holds the magnification across the join instead of easing out and in.
- **Editing.** While the playhead is inside a zoom, its strength menu, Move target and Remove zoom appear. Changing an existing zoom keeps its source range, including parts hidden by cuts. Every change is one `zoom` operation through the shared transaction engine with its own Undo/Redo.
- **Motion.** Magnification eases in and out with smoothstep over at most 0.4 s (a third of a short zoom) at the zoom's real edges. The visible window is centred on the point and kept inside the frame. Preview and export use the same functions (`packages/domain/src/zoom.ts`).
- **Export.** A per-frame FFmpeg `scale`/`crop` stage in the draft's own pixel format runs before burned-in captions and before short-clip reframing. Outside zooms the magnification is exactly 1 and frames pass through bit-identical, which media and packaged native tests verify; the lossless master is verified against the composed frames.
- **Timeline.** Zoom blocks appear on the timeline strip with their strength.
- **Assistants (2026-10-07).** Claude, Codex and the API providers can call the guarded `zoom.set` and `zoom.remove` tools (docs/30). They are the manual zoom's equivalents, not automatic zooms: the same output-to-source mapping (shared `zoomSourceRange`), limits, exact draft-head freshness, transaction engine and Undo, with the assistant's origin. Each assistant's draft summary lists zooms with their visible output ranges. The model cannot see frames, so the point comes from the user; tool descriptions limit zooms to briefly making a small on-screen detail readable. Covered by media tests; native assistant runs are pending.

Not yet implemented: dragging zoom edges, target rectangles, follow-cursor mode and automatic zooms (P7-01).

## QA

Check target visibility, centering, edge coverage, text readability, motion stability, timing against action, overlap, and frequency. Render proof frames at start, peak, hold, and end.

## Editorial targeting and scope

Apply [47_EDITORIAL_FIRST_CUT.md](47_EDITORIAL_FIRST_CUT.md), particularly its zoom and protected-edit rules. Plan from the committed screen-led sections after verified cuts/layouts. Reassess existing effects only inside the authorized scope; preserve approved/protected material. Name the exact target internally and record its evidence and source/layer. Skip generic center zooms and decorative motion. Use cursor-follow for moving interactions and fixed targets for stable panels, results, prices and phone screens.

Desktop scale around 1.6–1.8×, centered-phone scale around 1.8–2.0× and durations around 3–10 seconds are adjustable starting preferences, not unconditional limits. Longer holds need a readability reason. End before unrelated narration, leave short wider-view rests between unrelated targets, and never overlap zooms. Camera zooms require a clear rhetorical reason in an already camera-led section.

Use a dedicated undoable zoom pass. Inspect an interior frame, midpoint and both boundaries of every effect, including target legibility, camera/caption occlusion and protected-range integrity. Repair or remove failures before checkpointing. Tests must cover wrong-cursor tracking, empty targets, clipped text, timing/overlap, inappropriate camera zooms and stale timeline hashes. Target identity/mode/layer/verification contracts must be implemented before claiming these behaviors; the existing rectangle alone does not establish editorial intent.
