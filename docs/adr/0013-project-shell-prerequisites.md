# ADR 0013: Project shell and transaction prerequisites

- Status: Accepted dependency correction
- Date: 2026-09-06

## Decision

Bring the minimum real project foundation into P1-03 and the shared draft transaction foundation into P2-05/P2-06. Retain every later phase's complete acceptance requirements. This decision establishes implementation order; it does not claim implementation or phase completion.

P1 creates and reopens an actual project from imported media, with stable identity, immutable source references, a source-matched initial canonical timeline, an actual baseline revision, and persisted active stage. Project and timeline records must satisfy their existing versioned contracts and referential invariants. An ingestion-library record alone is not a project. A revision identifier must resolve to a real immutable revision; never invent a placeholder revision to satisfy validation.

The five navigation controls select Record or Import, Auto Edit, Edit, Review, or Export in the main-owned persisted project state. Navigation preserves the active draft, source references, selection and playhead as applicable. It does not execute a stage, append media edits, discard history, certify review, or start export. Persist successfully before announcing the changed stage. Expose only implemented stage actions; do not imitate later features with fake activity, disabled tool grids, fabricated findings, or an export action that does not export. The shell may disclose that a stage action is unavailable while retaining working project navigation and source inspection.

P2 adds the common validated transaction engine needed for a real Codex fixture edit: expected draft sequence, atomic persistence, deterministic inverse/undo, a durable journal, and recovery that replays only complete committed transactions. Manual controls, Magic Wand and Codex must use this same engine as their features arrive. Do not build a separate AI-only mutation path. Navigation state is distinct from draft sequence and operation history.

## Reason

P1's project navigation depends on project state previously assigned entirely to P3. P2's durable project threads and reversible authenticated draft edit depend on project and transaction foundations previously assigned to P3 and P6. Strict phase ordering without these prerequisites would require fake projects or skipped acceptance. Moving the necessary foundations forward resolves those dependencies while preserving the actual product behavior required by ADRs 0003 and 0004.

## Boundaries and verification

- P1 verifies create/open/reopen, real baseline revision references, source-matched rational timing, stage persistence, failed-save behavior, and preservation of source/draft state across all five stages. Use synthetic media in the actual packaged isolated native app, with Playwright and computer-use evidence.
- P2 verifies real runtime discovery and an authenticated guarded edit through the shared engine, including stale sequence rejection, undo, interruption and committed-transaction recovery. A test transport or UI-only state change cannot satisfy this phase.
- P3 retains the complete project store, source manifests, import formats, autosave/locks/recovery, deterministic timing, derivatives, smooth A/V preview, and project-management acceptance. P6 retains the complete manual editor, shared undo/redo interaction, revisions, comparison, and crash-recovery acceptance. Reuse earlier tested foundations rather than duplicate them.
- P4 capture, P5 Magic Wand, P7/P8 effects and composition, P9 review/export/installer, and P10 user-video acceptance remain required. Merely visiting their stages proves none of their features.
- Do not silently derive a rational frame rate from a rounded display value, invent a working canvas, lower source precision, or convert preview data into master input.
- Schema changes, migrations, routing and tests needed by implementation must be synchronized before acceptance. This dependency decision does not itself change existing persisted schema versions or waive validation.

This extends the limited bootstrap correction in ADR 0012. The secure native shell, immutable sources, explicit final export control and private-evidence restrictions remain unchanged. ADR 0014 later supersedes the historical Codex-only provider policy without changing the shared transaction prerequisite.
