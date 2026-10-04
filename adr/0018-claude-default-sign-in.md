# ADR 0018: Claude account sign-in as the default AI connection

- Status: Accepted user requirement; implementation decided 2026-10-04 (see Decision); signed-in native acceptance pending
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
