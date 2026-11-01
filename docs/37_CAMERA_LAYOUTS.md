# Camera and layout specification

**Implemented (2026-10-25, ADR 0029):** recording a camera with the screen (a second lossless file with the screen's own frames), linking a camera video in Edit, layouts `screen`, `camera` and corner (`pip`; circle, rounded or rectangle; four corners; size; face zoom and focus; eased changes), the live preview, export, the Camera tools and timeline markers, and Claude's `layout.plan`, `layout.set` and `layout.remove`. Side by side, presenter with inset, border and shadow, background, per-canvas overrides, face detection and automatic sync for a camera made elsewhere are not built. The sections below remain the specification.

## Source policy

Camera is optional. When enabled during recording, keep it as a separate synchronized source. Imported camera media may be linked manually.

## Built-in layouts

- Screen only
- Camera only
- Camera bubble over screen
- Side by side
- Presenter with screen inset
- Screen with camera strip
- Custom position within bounded controls

The first release does not expose arbitrary node compositing.

## Per-layout controls

- camera shape: rectangle, rounded rectangle, circle
- position and size
- crop and fit
- border and shadow
- entrance and exit fade
- background colour or local image
- scene or range scope

## Automatic behavior

Magic Wand may choose a layout only when both sources exist and the preset enables camera layout. It should favor screen visibility during demonstrations and larger camera presence during introductions or direct explanation. Every switch creates a visible layout marker.

## Manual behavior

Select the camera on canvas or its timeline clip to open the layout inspector. Drag and resize directly, with safe-area guides and numeric controls.

## Synchronization

Camera and screen share the recording session clock. The preview and final renderer use the same source-to-output map. Frame drops or offset beyond policy become a QA finding.

## Reframing

Layouts must adapt to 16:9, 9:16, 1:1, 4:5, and custom canvas. Do not simply crop the speaker or important screen content. Save per-canvas overrides when needed.

## Editorial layout pass

Apply [47_EDITORIAL_FIRST_CUT.md](47_EDITORIAL_FIRST_CUT.md). Inspect raw sources and composed output, approved layouts and authorized/protected ranges before editing. Copy the exact available properties of an approved talking-head treatment; otherwise use a clean inset with comfortable margins and supported restrained corners/shadow.

Prefer screen-led PiP during demonstrations, starting bottom-right but moving away from important controls/results/captions. Use screen-only framing when density or unavoidable occlusion requires it and restore the camera when that need ends. Favor camera-led framing for introductions, conclusions, opinions, setup and transitions where the screen contributes little; return to screen-led framing for demonstrated evidence. Keep the speaker visible when helpful, not merely because a camera source exists. Avoid frequent gratuitous switches.

Use an undoable layout pass after the spoken-cut checkpoint. Inspect both boundaries and midpoint of every section for synchronization, usable face framing, meaningful screen visibility and protected-material preservation. Only verified sections reach a checkpoint. Tests cover exact approved-property reuse, preferred-corner collisions, screen-only-to-camera return, rhetorical sections, excessive switching and verification failures. This does not assert implemented automatic layout selection.
