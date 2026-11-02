# Native UI visual review prompt

Launch the actual Electron application in the isolated desktop environment. Do not use a browser-hosted substitute.

Review these states at 1280x720, 1440x900, and 1920x1080 when available:

- onboarding
- home
- capture setup
- recording
- import progress
- Magic Wand menu and progress
- editor with no selection
- editor with cut, zoom, speed, caption, camera, and B-roll selections
- Codex drawer idle, active, interrupted, and failed
- QA summary
- export and export complete

Check hierarchy, clutter, text clipping, spacing, focus, tooltips, keyboard flow, panel count, empty states, error messages, timeline readability, preview size, and whether technical data leaked into normal screens. Capture screenshots and list concrete defects. Fix defects and rerun the same states. Do not approve a screen based on a successful render alone.

Inspect each mapped original image separately. Do not use a contact sheet as the sole reference. Apply the mandatory corrections: no Ready footers, oversized titles, obvious descriptions, repeated status, or all-panels-open layout. Check the Codex drawer, manual controls, and canvas at common desktop sizes.

Verify the five project steps (Import, Magic Edit, Refine, Clips, Export) and the Done screen after an export (ADR 0031). Refine is the simple screen; the full editor opens from it and has a Done button back. Test that changing stages preserves draft and undo state and that already authorized reversible edits do not trigger repeated confirmation. Final export still requires an explicit user action.
