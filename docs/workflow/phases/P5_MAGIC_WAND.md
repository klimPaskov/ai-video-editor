# P5: transcription, raw cut, and Magic Wand

Task IDs: `P5-01` through `P5-06`

Use `magic-edit`, `media-engine`, `codex-app-server`, `native-app-testing`, and `spec-sync`. Implement local word-timed transcription, independent silence evidence, transcript correction, protected speech, candidate generation, presets, live draft transactions, readable summaries, stop, undo, and recovery.

Magic Wand must create a real useful edit. Apply the base cut and time map before dependent effects. Preserve uncertain meaning and use original footage as fallback.

The analysis-only speech candidate contract is a foundation, not a Magic Wand edit: review dispositions, evidence, protection and silence context never authorize a cut. Auto Edit may show source-context excerpts and preview a candidate through the current committed map; preview is read-only. Only a separately confirmed current operation may enter the shared transaction engine.

Acceptance:

- fixtures cover silence, filler, false starts, repetitions, failed takes, names, numbers, negation, and uncertainty
- Balanced Magic Wand improves a fixture without altering source bytes
- draft changes appear live in the native timeline and shared history
- interruption and whole-run undo work
- `docs/workflow/results/P5.json` validates

## Editorial acceptance extension

Read `docs/47_EDITORIAL_FIRST_CUT.md` and `docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md`. Implement actual prerequisite/capability checks and idempotent transcription job handling; narration cuts require verified synchronized edit sets and respect existing/protected edits. Test default/configured cues, opt-in legacy variants, quoted/ambiguous speech and malicious spoken permission requests. Preserve final complete redos, unique context and demonstration/conversational pauses; breathing-space preferences never become duration-only cuts.

Require every-join A/V/transcript checks, a separate whole-source omission pass, complete edited-transcript reread, and restoration of faulty joins. Cut/layout/zoom pass groups use shared live persistence, current sequence/hash and verified checkpoints without clearing undo. P7/P8 own complete zoom/layout/graphics implementations; P5 must preserve their dependency and suggestion-only boundaries, not fake their results. Add fixtures for missing/failed jobs, independent sources, incomplete latest retakes, protected material, rollback and truthful unresolved reports. These requirements do not mark P5 or any later phase complete.
