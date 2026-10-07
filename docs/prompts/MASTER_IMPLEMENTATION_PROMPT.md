# Master implementation prompt

Implement the native ai-video-editor described by this package.

At the start of every session:

1. Read `AGENTS.md`, `AUTHORITATIVE_ORDER.md`, `GOAL_PROMPT.md`, `PLANNING_PACKAGE.md`, `WORKFLOW.md`, `TASKS.md`, accepted ADRs, `docs/workflow/active-phase.md`, relevant skills, and touched schemas.
2. Inspect the repository, current tests, phase results, and exact installed tool versions.
3. Find the first incomplete dependency-safe phase and record its task IDs.
4. Research current primary documentation when an external contract may have changed.
5. Implement the smallest complete slice. Do not stop at analysis.

For every slice:

- add or update tests
- validate schemas
- run static checks
- launch the actual Electron app in the isolated environment when UI changes
- use Playwright Electron for repeatable interaction
- use computer use for visual inspection
- render and decode a fixture when media changes
- inspect motion and audio, not only stills
- review security, privacy, accessibility, and source immutability
- update specs, prompts, skills, routing, and traceability
- write `docs/workflow/results/PHASE_ID.json` only after every phase acceptance check passes and the reviewed source revision is verified remotely; otherwise retain truthful progress under `docs/workflow/progress/`

Use browser tools only for research. Never launch or install on the user's host. Never replace the desktop product with a web app. Never fabricate Codex login, capture, render, test, screenshot, or review evidence.

The root is `ai-video-editor`. Apply docs/44_LOSSLESS_MEDIA_POLICY.md, docs/45_OPEN_SOURCE_DEVELOPMENT.md, and docs/references/IMPLEMENTATION_NOTES.md. Default to verified lossless capture and master output, remove redundant UI text and debug indicators, and publish reviewed working slices from P0 onward.

Apply ADRs 0014 and 0015 for optional fixed-endpoint OpenAI API, DeepSeek and Gemini API keys beside the mandatory Codex App Server. Keep paid API turns explicit, keys main-owned and protected, provider capabilities truthful, Gemini function-call signatures bounded and transient in main, and every AI edit under the shared guarded transaction history. Do not mark P2 complete from documentation or fake-provider tests.

## Required editorial capability

Read `docs/47_EDITORIAL_FIRST_CUT.md` and `docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md` when implementing transcription, Magic Wand, cuts, layouts, graphics opportunities, zooms or final QA. They adapt a user-supplied editorial reference into this app; never operate an external editor or invent its API. Preserve conservative spoken-cue interpretation, verified synchronization/protected scope, final complete retakes, whole-transcript coherence checks, separately verified live pass groups, suggestion-only graphics and no automatic export. Implement the associated negative fixtures and contracts in the assigned later phases; no documentation or P1 shell result proves those capabilities.
