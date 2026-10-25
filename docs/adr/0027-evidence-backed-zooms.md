# ADR 0027: Zooms need evidence and have more than one motion

- Status: Accepted 2026-10-25
- Scope: Zoom model, `zoom.targets`, zoom guidance for Claude

## Problem

Zooms were a fixed point with a fixed 400 ms ease, chosen by the model from one or two small pictures. In the user's six-minute edit they felt random, all alike, and distracting (2026-10-25).

## Decision

- **Evidence.** The app finds where something happens on a screen recording: it reads five small grayscale pictures a second, compares neighbours on a 16×9 grid and reports local changes (a dialog opens, text appears, a panel updates) as rectangles with a time range. Changes across much of the picture (scrolling, scene changes, a playing video) and one-frame flickers are ignored (`packages/domain/src/screen-activity.ts`, `packages/media-engine/src/screen-activity.ts`). Claude reads them through the Claude-only `zoom.targets` (inventory twenty-five) and is told to zoom only at a target, rarely, and never as decoration. For new recordings, pointer and click telemetry (docs/36) will be a stronger signal; it is not recorded yet.
- **Motion.** `ZoomEffect` gains optional fields, so older drafts are unchanged: `motion` (`hold`, the old behaviour, or `push`, a slow growth across the whole zoom), `end_center_x/y` (pan to a second point across the zoom, eased) and `ease_in_us` / `ease_out_us` (100 ms–1.5 s). Preview, export, short clips and frame rendering share the same math (`zoomAt`, `zoomFilter`); a zoom cut in two by a cut keeps its progress across the join.
- **Policy** lives in the full-edit playbook and the tool descriptions: few zooms, varied motions, a rendered picture checked for each, and removal of any that does not earn its place.

## Not done

Cursor/OCR-based targets, automatic placement without Claude, face-aware crops (camera work, docs/37), a zoom-density cap enforced by the app.
