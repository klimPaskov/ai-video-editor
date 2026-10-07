# Source of truth order

When files disagree, use this order:

1. Current user instruction
2. Accepted ADRs
3. `GOAL_PROMPT.md`
4. `PLANNING_PACKAGE.md`
5. `WORKFLOW.md`
6. `TASKS.md` and the active phase prompt
7. Feature and screen specifications
8. Schemas and examples
9. Skills and subagent prompts
10. Visual references

A screenshot may refine visual treatment. It may not remove required behavior, privacy, accessibility, recovery, or testing rules.

## Current requirement resolution

The current name is `ai-video-editor`. ADR 0018 records the latest user requirement: Claude account sign-in is the default AI connection, implemented through the user's Claude Code CLI; signed-in acceptance is pending. The next Claude implementer owns implementation decisions and may revise prior assistant-selected designs with evidence. Lossless-first behavior is defined in `docs/44_LOSSLESS_MEDIA_POLICY.md`. Public development is defined in `docs/45_OPEN_SOURCE_DEVELOPMENT.md`. Screenshot exceptions are defined in `docs/references/IMPLEMENTATION_NOTES.md`.

Current native screenshots guide visual treatment. Previous native screenshots preserve useful earlier states. Neither set overrides current simple-UI, live-Codex, immutable-source, or lossless requirements. No browser-application references or contact sheets belong in the implementation reference set.
