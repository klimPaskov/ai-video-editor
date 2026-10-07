# P6: simple editor

Task IDs: `P6-01` through `P6-06`

Use `timeline-editor`, `simple-desktop-ui`, `codex-app-server`, `native-app-testing`, and `spec-sync`. Implement selection, split, trim, ripple delete, restore, supported move and reorder, snapping, transcript edits, direct preview handles, fixed semantic tracks, one inspector, undo, redo, autosave, revisions, compare, and recovery. Manual and Codex commands must use one domain command layer and one history.

The current P2 dependency slice exposes playhead trim, playhead split, marked ripple Cut range and newest Undo in Edit through that shared journal. Split and cut fragments preserve ordered immutable source intervals and committed preview mapping; the cut may cross source joins but cannot remove the whole draft. The P5-02 transcript inspector also supports text-only word correction and one explicit selected-word structural cut through shared Undo/Redo. P6 acceptance still requires richer timeline selection, direct transcript restoration beyond Undo, movement, snapping, full redo/history/revision behavior, synchronized A/V ripple semantics and recovery; these partial native controls do not complete this phase.

Do not build an unrestricted professional NLE. Hide empty tracks and inactive panels.

Acceptance:

- mouse, keyboard, transcript, canvas, and history tests pass
- the user can correct the Magic Wand draft completely inside the app
- a Codex request can alter the current selection live and be undone
- revision compare and crash recovery pass
- `docs/workflow/results/P6.json` validates

Use `reference-fidelity`. Read current full-page references and `docs/references/IMPLEMENTATION_NOTES.md`. Remove debug badges, persistent readiness, duplicate headings, and excessive explanations. Default to one relevant panel. Keep working capture indicators, errors, and accessible controls.
