# ADR 0018: Claude account sign-in as the default AI connection

- Status: Accepted user requirement; implementation and native acceptance pending
- Date: 2026-10-04
- Scope: Default app onboarding/AI connection and continuation in Claude

## User requirement

Add supported Claude account sign-in and make it the application's default AI connection. Keep the existing Codex/ChatGPT and accepted API-provider paths as supported alternatives. ADR 0016's GPT-6-Luna/high preference remains specific to the Codex route; it is not the application-wide provider default or a Claude model choice.

The implementation continues in Claude with independent engineering judgment. Authentication mechanism, SDK/runtime, Claude model selection, migration design and implementation sequence remain open for the next implementer to assess. Verify current supported provider contracts and access before choosing them. Do not represent API-key entry, copied developer credentials or an invented OAuth flow as proven Claude account sign-in.

## Shared requirements

Claude draft edits must use the existing validated active-draft transaction engine, committed-state projection and Undo history. Main owns credentials and provider access; account secrets stay out of renderer state, project files, logs, prompts and public evidence. Preserve source files and existing project/provider history. Distinguish subscription sign-in from API billing and require explicit initiation of paid API turns. Preserve explicit export/cleanup controls.

## Evidence and synchronization

Claude login/default-provider behavior is not implemented or verified. Add the relevant native account/default-selection/edit/restart/failure evidence only after real supported integration works. Update affected runtime/IPC/provider schemas, screens, prompts, skills, routing and tests with the chosen implementation; existing provider contracts are not silently expanded by this requirement.

`CLAUDE.md` and `.claude/` contain documented Claude Code project guidance, skill adapters and optional native role definitions. They enable development continuation and do not establish a working Claude connection inside the app.
