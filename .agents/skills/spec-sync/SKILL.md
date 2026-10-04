---
name: spec-sync
description: Keep workflow specs, tasks, schemas, tests, prompts, skills, routing, and references consistent.
---

# Specification synchronization

## Use when

Any user-facing or workflow behavior changes.

## Procedure

1. Name the changed requirement.
2. Find affected feature and screen specs.
3. Update domain schemas, examples, and migrations.
4. Update task IDs, dependencies, and acceptance evidence.
5. Update tests and fixtures.
6. Update Codex tools and prompts when AI behavior changes.
7. Update relevant skills and subagent routing.
8. Update traceability.
9. Update reference manifest when images changed.
10. Search for stale terms and conflicting instructions.
11. Run package validation.

## Completion output

Write a short spec-sync section in the phase result listing every changed contract and every intentionally unchanged contract.

Use the phase-result writer only after acceptance and remote revision verification. It requires a clean source/index, all phase tasks, passing checks, and native evidence. Keep partial work and blockers under `docs/workflow/progress/`; ignored evidence may remain local in `test-results/`. Public progress records must not contain private source paths or transcripts.

When fidelity, native UI, or publishing changes, include docs/44_LOSSLESS_MEDIA_POLICY.md, docs/45_OPEN_SOURCE_DEVELOPMENT.md, docs/references/IMPLEMENTATION_NOTES.md, their tasks, skill routes, and contract examples in the sync pass.

Public package validation checks accepted record structure and repository-contained artifact references without requiring private evidence in CI. This does not rerun or prove native/media acceptance. The phase-result writer always requires the actual nonempty local artifacts before writing, and reviewed source/remote revision checks remain mandatory. Never publish private artifacts to satisfy public CI.

Include `CLAUDE.md` and the relevant `.claude/` skill/agent/rule entry points in synchronization when their guidance is affected. Recording a new provider requirement is not runtime implementation; identify the remaining schema, onboarding, prompt and native-test frontier explicitly.
