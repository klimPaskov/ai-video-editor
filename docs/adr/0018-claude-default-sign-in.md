# ADR 0018: Claude account sign-in as the default AI connection

- Status: Accepted user requirement; implementation decided 2026-10-04 (see Decision); real signed-in edit/Undo/Stop/restart passed 2026-10-18; completion through the app's own sign-in button pending
- Date: 2026-10-04
- Scope: Default app onboarding/AI connection and continuation in Claude

## User requirement

Add supported Claude account sign-in and make it the application's default AI connection. Keep the existing Codex/ChatGPT and accepted API-provider paths as supported alternatives. ADR 0016's GPT-6-Luna/high preference remains specific to the Codex route; it is not the application-wide provider default or a Claude model choice.

The implementation continues in Claude with independent engineering judgment. Authentication mechanism, SDK/runtime, Claude model selection, migration design and implementation sequence remain open for the next implementer to assess. Verify current supported provider contracts and access before choosing them. Do not represent API-key entry, copied developer credentials or an invented OAuth flow as proven Claude account sign-in.

## Shared requirements

Claude draft edits must use the existing validated active-draft transaction engine, committed-state projection and Undo history. Main owns credentials and provider access; account secrets stay out of renderer state, project files, logs, prompts and public evidence. Preserve source files and existing project/provider history. Distinguish subscription sign-in from API billing and require explicit initiation of paid API turns. Preserve explicit export/cleanup controls.

## Evidence and synchronization

Signed-out Claude behavior is verified in the isolated guest with the official CLI; a completed real sign-in, signed-in catalog and real Claude edit/Undo/Stop/restart are not yet verified. Add that evidence only from a real user-completed Anthropic sign-in. Update affected runtime/IPC/provider schemas, screens, prompts, skills, routing and tests with the chosen implementation; existing provider contracts are not silently expanded by this requirement.

`CLAUDE.md` and `.claude/` contain documented Claude Code project guidance, skill adapters and optional native role definitions. They enable development continuation and do not establish a working Claude connection inside the app.

## Decision (2026-10-04)

The editor runs the user's own installed, unmodified Claude Code CLI. Anthropic's current terms forbid third-party apps from offering Claude.ai login or handling Claude credentials, direct Agent SDK products to API keys, and permit an end user to sign in to the unmodified Claude Code binary with their own subscription when a product runs Claude Code. Sign-in is therefore `claude auth login --claudeai`, completed in Anthropic's browser flow; the app reads only `claude auth status` JSON and the CLI's live model catalog and never touches the credential store.

- Runtime: user-installed Claude Code 2.1.268 or later, not bundled; a dedicated `CLAUDE_CONFIG_DIR` and empty working directory under app data; inherited Anthropic credential variables are dropped so billing never switches silently.
- Model: the live catalog from the CLI's `initialize` control response; a fresh preference uses the account-recommended `default`, explicit choices are remembered and revalidated.
- Turns: one headless stream-json process per user turn with built-in tools, settings, slash commands and permission prompts disabled, and only the nine guarded editor MCP tools allowed through a Claude-only broker. The authoritative init inventory is enforced; Claude edits use the shared transaction engine with origin `claude` and shared Undo.
- Default: Claude is the first Settings provider section and the default assistant drawer route. Codex and the API-key providers are unchanged alternatives.

Details, evidence and remaining gates are in `docs/48_CLAUDE_CONNECTION.md`.

Addendum (2026-10-07): the guarded editor inventory grew from nine to twelve tools with `zoom.set`, `zoom.remove` and `speed.set`; the init inventory check derives from the same shared tool-name list. A real-CLI init probe of the larger inventory later passed (see the 2026-10-15 addendum).

Addendum (2026-10-15): `graphics.set` and `graphics.remove` raise the inventory to fourteen tools; the init check and allowlist still derive from the shared list. Signed-out Claude Code 2.1.292 on Windows reported exactly those fourteen tools through the production turn code. `captions.configure` and `audio.configure` later raised it to sixteen; a fresh signed-out real-CLI probe confirmed the sixteen-tool inventory. The read-only `media.get_frames` then raised the Claude inventory to seventeen (the API providers keep sixteen); a signed-out real-CLI probe confirmed the seventeen-tool inventory.

Addendum (2026-10-18): with the user signed in (the user completed Anthropic's sign-in for a private guest profile by pasting the code into the waiting, unmodified CLI themselves; no code or credential passed through the app or the agent), the packaged app on Claude Code 2.1.302 made a real Claude split during the turn, shared manual Undo reversed it, Stop left the draft unchanged and the history survived a restart. The first attempt found that Claude Code passes an untyped constant such as `"schema_version": "1.0"` as the number 1, so every editor tool rejected its calls; every constant and choice in the tool schemas now declares `type: "string"`, with a regression test.

Addendum (2026-10-18): ADR 0021 replaces the "built-in tools disabled" turn design. Turns now run in a per-project workspace in Claude Code's restricted mode with the confined `Read`, `Write`, `Edit`, `Glob`, `Grep` and `Task` tools and two read-only helper agents; command execution and web access stay off, and the timeline still changes only through the guarded editor tools. Turns need Claude Code 2.1.302 or later.

Addendum (2026-10-18): the Claude-only `composition.check` (ADR 0021) raises Claude's editor inventory to eighteen tools; Codex keeps seventeen and the API providers sixteen. The init check and allowlist derive from the shared Claude tool list. A real-CLI init with the eighteen tools is still to be confirmed.

Addendum (2026-10-18): following the user's direction that the rough cut runs on Haiku and production on Opus, Settings has two Claude model choices. A fresh production choice is the catalog's Opus model when offered (otherwise the account-recommended `default`, as before), and the rough cut (Magic Edit) defaults to Haiku when offered, otherwise the production model. Both are explicit, remembered and revalidated against the live catalog; IPC adds `claude:select-rough-cut` and the view's `roughCutSelection`.

Addendum (2026-10-19): at the user's direction the fresh production choice is Sonnet, not Opus, when the account offers it (otherwise the account-recommended `default`); the rough cut stays on Haiku. Opus remains selectable in Settings. Sonnet is chosen by catalog name because the `default` entry can itself resolve to Opus. Remembered explicit choices are unchanged.

Addendum (2026-10-24): ADR 0023 adds the Claude-only `sound.list`, `sound.set` and `sound.remove`, raising Claude's editor inventory to twenty-one tools (Codex keeps seventeen, the API providers sixteen). The init check and allowlist still derive from the shared Claude tool list; a real-CLI init with the twenty-one tools is still to be confirmed.

Addendum (2026-10-25): ADR 0025 adds `transition.set` and `transition.remove` to the shared tool list, raising Claude's editor inventory to twenty-three tools (Codex nineteen, the API providers eighteen). The init check and allowlist still derive from the shared Claude tool list; a real-CLI init with the twenty-three tools is still to be confirmed.

Addendum (2026-10-25): the Claude-only `shorts.propose` (docs/49) raises Claude's editor inventory to twenty-four tools (Codex nineteen, the API providers eighteen). A clip-picking run is a Claude run kind that main restricts to reading, looking and this tool. The init check and allowlist still derive from the shared Claude tool list; a real-CLI init with the twenty-four tools is still to be confirmed.

Addendum (2026-10-25, later): Confirmed 2026-10-25: with the user's signed-in private guest profile, the packaged app on Claude Code 2.1.302 initialized with the full twenty-four-tool inventory (including `transition.set`, `transition.remove` and `shorts.propose`) and a real Claude edit committed during its turn with origin `claude` (`tests/native/claude-connection.test.ts --require-signed-in`).
