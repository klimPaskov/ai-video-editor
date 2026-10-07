# Workspace contents

Everything lives directly under `ai-video-editor/`, the working project root.

- Root agent instructions, concise goal, workflow, phase backlog, licence, contribution and security guidance
- `HANDOFF_PROMPT.md` and `CLAUDE.md`: Claude continuation and project context; machine-local context remains ignored
- `.claude/`: Claude Code project settings, skill adapters and native role definitions
- `docs/workflow/`: active phase, ordered implementation prompts, progress notes, and accepted result records
- `docs/`: full baseline feature specifications plus final lossless and public-development policies
- `.agents/skills/`, `.codex/agents/`, `docs/prompts/`, `docs/templates/`: reusable implementation guidance consumed by the workflow
- `docs/contracts/`, `docs/schemas/`, `docs/examples/`: versioned planning contracts and examples
- `docs/references/screenshots/current/`: ten individual current native-app references
- `docs/references/screenshots/previous/`: ten individual earlier native-app images
- `docs/references/index.html`: one-image-at-a-time viewer
- `.github/`: source-review guidance and planning-contract CI
- `apps/`, `packages/`, `tests/`: the packaged Electron desktop application, evolving media/Codex services, and deterministic and native test suites; remaining product scope is tracked by phase

Generated evidence belongs in ignored `test-results/`; private machine-local inputs belong in ignored `local-data/`. Neither directory is part of the public package. No contact sheets, multi-screen collages, browser-app reference sets, model weights, font binaries, private media, or credentials are included. Original reference image bytes are preserved. Screen coverage gaps are explicit in `docs/references/SCREEN_COVERAGE.md`.
