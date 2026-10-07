# Agent instructions

## Mandatory reading

Before implementation, read:

- `AUTHORITATIVE_ORDER.md`
- `GOAL_PROMPT.md`
- `PLANNING_PACKAGE.md`
- `WORKFLOW.md`
- `TASKS.md`
- accepted files in `adr/`
- the active prompt in `docs/workflow/active-phase.md`
- relevant files in `.agents/skills/`
- schemas touched by the phase

State directly when a required source could not be read. Do not imply completion without evidence.

## Execution rule

Find the first incomplete dependency-safe phase. Record its task IDs. Implement the smallest complete slice. Add or update tests before claiming it works. Launch and inspect the native app in the isolated test environment whenever UI or media behavior changes. Write `docs/workflow/results/PHASE_ID.json` after all acceptance checks pass.

Do not stop at planning. Do not replace the product with a browser app, static mockup, command-line demo, or fake AI transcript.

## Product rules

- The app is a standalone Electron desktop app.
- Browser use is for research only.
- The renderer loads packaged local content only.
- Claude account sign-in is the default AI connection under ADR 0018, implemented through the user's unmodified Claude Code CLI (`docs/48_CLAUDE_CONNECTION.md`); never handle, copy or seed Claude credentials. Signed-in acceptance is pending. Real Codex app-server and the existing API-key providers remain supported alternatives.
- Source media is immutable.
- AI and manual edits target the same non-destructive draft timeline.
- Every edit is undoable until revision commit.
- Logs and technical data stay hidden from ordinary users.
- Only the current workflow step and selected tool panel are visible.
- Export and cleanup require explicit user action.

## Change synchronization

Any workflow change must update all affected:

- product and feature specs
- screen specs
- tasks and dependencies
- schemas and examples
- unit, integration, media, and native UI tests
- prompts, skills, and subagent routing
- traceability table
- reference manifest when screenshots are involved

Run the `spec-sync` skill before completing a phase.

## Testing boundary

Never launch the app on the user's host. Launch it in the agent's isolated desktop environment. Use Playwright Electron for deterministic automation and computer use for visual inspection of the actual native window. Use fake capture devices for repeatable tests and label any missing real hardware test honestly.

## Final workspace requirements

The project name and repository root are `ai-video-editor`. Read `docs/44_LOSSLESS_MEDIA_POLICY.md`, `docs/45_OPEN_SOURCE_DEVELOPMENT.md`, and `docs/references/IMPLEMENTATION_NOTES.md` before implementation. They resolve the latest quality, publishing, and screenshot requirements.

Default media operations must not add lossy encoding. Verify the lossless boundary instead of trusting codec names. The renderer must not quietly reduce precision for a master. Preview quality and export quality are separate settings.

Remove persistent Ready, All systems operational, project-status footers, hero titles, repeated headings, and decorative explanations. Useful control labels, capture indicators, save failures, and relevant progress remain.

Use current reference images before previous images. Their layout inspiration does not authorize reproducing their incorrect codec labels, contradictory timings, excessive panels, or sample conversation claims. All shipped buttons operate on real state.

Create or verify the public repository during P0 and publish reviewed working slices throughout development. Do not claim remote publication without a verified remote commit. Keep private media, credentials, and private test evidence out of Git.

Use `lossless-media`, `reference-fidelity`, and `open-source-development` skills for these surfaces. The main agent owns integration and reviews all subagent changes. Delegate bounded tasks with explicit files, constraints, expected output, and checks. Do not invent a runtime-specific subagent API.

Do not spawn GPT-6 Astra implementation subagents or choose Astra for native Codex child tests. The Codex subscription path defaults to a runtime-discovered Luna model with high reasoning; if unavailable, show an actionable selection state instead of silently choosing another model.
