# ADR 0020: The rough cut is always an AI story edit

- Status: Accepted user requirement (2026-10-18); first slice implemented
- Scope: Magic Edit (the rough cut in Auto Edit) and its relation to local analysis

## User requirement

The rough cut must never be deterministic. An AI model always sits between the analysis and the cut, because the rough cut is a story edit: it removes ideas said twice, retakes, false starts and tangents, not only pauses and fillers. A later, separate pass (the full AI edit, ADR 0019) turns the rough cut into a polished production, and the user can keep directing Claude in the conversation.

## Decision

1. **Magic Edit is a Claude run.** Main transcribes locally and runs the existing pause, filler and repeated-wording analysis, then starts a rough-cut turn in the project's Claude conversation with a rough-cut playbook (`apps/desktop/src/rough-cut-playbook.ts`, adapted from docs/47's spoken-cut pass): read the whole transcript first, work out the story, cut repeated ideas, retakes, false starts, tangents and dead air on sentence boundaries, reread the result and restore anything lost.
2. **Analysis is evidence, never a cut list.** The local findings are mapped to output time and listed in the request as places to look. Magic Edit itself makes no cut; with no signed-in Claude it says so instead of falling back to rules.
3. **Only cutting tools.** While a rough cut runs, main refuses every tool except reading, transcript pages, pictures, trim, split, range cuts and restore. Zooms, speed, captions, audio and graphics belong to the production pass.
4. **A fast model.** The rough cut uses Haiku when the account's live catalog offers it, otherwise the model chosen in Settings. A per-stage model setting is a later step.
5. **Shared history.** Claude's cuts are ordinary `claude`-origin transactions with shared Undo; the conversation shows the run and Claude's summary; Stop interrupts the turn and keeps committed cuts.

## Consequences

- Magic Edit needs Claude sign-in and spends the user's Claude usage; its messages say so.
- The deterministic planner (`packages/domain/src/magic-wand.ts`) now only produces evidence.
- Tests use a labeled test double of the Claude Code CLI for the packaged path; real-model quality needs signed-in runs on real footage.
- Codex and the API providers do not run the rough cut yet.
