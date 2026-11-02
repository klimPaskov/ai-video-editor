# ADR 0029: A camera recording and layouts that arrange it with the screen

- Status: Accepted 2026-10-25 (the first working slice of docs/37)
- Scope: camera recording and linking, layout changes, preview, export, tools, planning

## Problem

The product's purpose is a talk recorded as a screen and a face camera, which the editor then makes dynamic: the speaker full screen, in a corner, moved around, zoomed on, or gone when the screen needs the room. Nothing of this existed (docs/37 was a specification only).

## Decision

- **The camera is a second recording.** Recording with a camera writes a second lossless file in the same capture process, cut to exactly the screen recording's frames (same first frame, same count, across pauses), so its sync offset is zero. It is imported into the media library like any source and linked to the project's recording by a small per-project note (`camera-links/<project>.json`, hash-checked on use). A camera video made elsewhere is added with Camera, Add camera video (offset 0, nudged by tenths of a second). The project baseline, its sources and the media library are unchanged; recordings are never modified.
- **Layouts are a draft effect.** `timeline.layouts` holds changes anchored to a moment of the screen recording (`screen`, `camera`, or `pip` with corner, size, shape, face zoom and focus, and move time). Each holds until the next; before the first the picture is the screen alone; a moment cut away applies at the next retained moment. They are undoable like every edit (`set_layout`/`remove_layout`).
- **One model draws preview and export.** `cameraLayersAt` gives the camera as a corner layer and a full layer, dissolving, gliding between corners and fading in or out, so nothing jumps. Export renders each stretch where the camera shows into a lossless alpha file the size of the screen (`camera-layer.ts`: shape masks, face crop, fades, glides) and the compositor draws it over the frames beneath the graphics; frames where the camera is absent stay bit-identical to the recording. The Edit preview plays the camera from its own copy; the frame renderer used by `media.get_frames` draws the same layers.
- **Tools.** Claude gets `layout.plan` (a proposal from where the screen changes and where sentences start: the speaker opens and closes full screen, steps into a corner away from the action while something is shown, takes the picture while explaining, leaves it to the screen when nowhere is clear), `layout.set` and `layout.remove` (Claude inventory twenty-nine). The full-edit playbook has a camera section. The Edit step has Camera tools and timeline markers.

## Not done

Face detection (framing and zooming on the face by hand or by Claude's picture reading), audio cross-correlation for a camera made elsewhere, a side-by-side layout, a border and shadow for the corner camera, short clips with layouts, per-source cameras for multi-recording projects (the first recording's camera only), real camera devices tested on Windows and macOS (the guest records a labelled test pattern).
