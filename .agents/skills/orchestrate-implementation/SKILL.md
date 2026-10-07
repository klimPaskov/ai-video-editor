---
name: orchestrate-implementation
description: Select and complete the first dependency-safe implementation phase with evidence.
---

# Orchestrate implementation

## Use when

Starting or continuing any implementation session.

## Procedure

1. Read the authoritative order and all mandatory sources in `AGENTS.md`.
2. Inspect `docs/workflow/results/`, repository state, tests, fixtures, and active phase.
3. Find the first incomplete phase whose dependencies are complete.
4. State exact task IDs and the smallest complete product result.
5. Route bounded specialist work through `docs/development/SUBAGENT_ROUTING.md`.
6. Add or update tests before treating code as complete.
7. Launch and inspect the native app when UI or media behavior changes.
8. Validate media outputs and schemas.
9. Run security, privacy, accessibility, and source-immutability checks.
10. Run `spec-sync`.
11. Write the phase result only after acceptance passes.

## Rules

- Do not skip an earlier failure.
- Do not stop at an assessment.
- Do not let a subagent mark the phase complete.
- Never spawn a GPT-6 Astra implementation subagent or select Astra for a native Codex child test. Honor the user's preferred runtime-discovered Luna/high Codex subscription default and report its unavailability rather than silently switching models.
- Do not claim visual success from process output.
- Preserve failed evidence that helps diagnosis.

For Claude continuation, `CLAUDE.md` and `.claude/skills/` provide the native entry points to these canonical guides; optional Claude role definitions are under `.claude/agents/`. ADR 0018 records the unimplemented default Claude-account requirement. The main implementer owns supported runtime/model/architecture decisions and may revise prior assistant-selected choices with evidence and synchronized contracts.
