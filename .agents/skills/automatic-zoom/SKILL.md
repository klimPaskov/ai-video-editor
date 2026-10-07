---
name: automatic-zoom
description: Plan, render, adjust, and validate purposeful zoom and speed effects.
---

# Automatic zoom and pacing

## Use when

Changing zoom candidates, cursor focus, speed segments, reframing, or their editor controls.

## Zoom evidence

Prefer click and pointer telemetry. Use scene markers and visible UI changes next. Use sampled-frame Codex analysis for context, not as sole geometric proof when confidence is low.

## Zoom rules

- visible target
- padded bounds
- stable centering
- smooth easing
- relevant start and end
- no overlap or pumping
- original wide view fallback
- direct target rectangle editing

## Speed rules

- safe typing, loading, waiting, and repetitive action ranges
- protect important speech and dense UI changes
- exact source and output mapping
- pitch-safe audio mode
- direct block and multiplier editing

Assistants can already apply user-directed zooms and speed-ups through the guarded `zoom.set`, `zoom.remove` and `speed.set` tools (docs/30). They reuse the manual semantics; automatic target and range detection is still unimplemented, and any detector must commit through those same transactions.

## QA

Render proof frames and short previews. Check purpose, target, edges, text readability, motion, range, frequency, duration, A/V sync, and speech continuity.

## Editorial zoom extension

Read `docs/47_EDITORIAL_FIRST_CUT.md`. Name the exact target and record source/layer, evidence and fixed/cursor mode before proposing a zoom. Work from committed screen-led sections and authorized scope; preserve approved/protected effects elsewhere. Desktop 1.6–1.8×, phone 1.8–2.0× and typical 3–10 s ranges are adjustable readability preferences. Require a reason for longer holds, wider-view rests between unrelated targets, no overlap and no decorative center motion. Use camera zooms sparingly in camera-led sections with a rhetorical reason.

Inspect each zoom's interior, midpoint and both boundaries for target legibility, camera/caption collisions, wrong-cursor tracking and timing. Use a separate verified pass group with current sequence/hash and shared undo. Test failed verification and protected-range rejection; proof frames and real native motion review are required before declaring success.
