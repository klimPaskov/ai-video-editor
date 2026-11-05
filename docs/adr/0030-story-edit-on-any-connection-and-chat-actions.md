# ADR 0030: The story edit runs on the chosen connection; chats can start app actions

- Status: Accepted user requirement (2026-11-01, play test); implemented, native run pending
- Scope: Magic Edit's story pass (ADR 0020, 0026), the assistant's tool inventories (ADR 0018, 0025), Auto Edit's Edit my video
- Supersedes: the Claude-only parts of ADR 0020 ("Codex and the API providers do not run the rough cut yet")

## User requirement

1. With Claude Code 2.1.288 the user got "This Claude Code version is too old" whenever they used the AI button in Auto Edit. Magic Edit must degrade gracefully: the deterministic tightening still applies and is reported, with a plain message saying what was done, what was skipped and why.
2. "Magic edit should be able to run on any provider, but obviously Claude will give the best results."
3. "The chat assistant should be able to do actions in the app." A Codex chat answered that it could not start Magic Edit because its tools did not include that action.

## Decision

### Graceful Magic Edit

Order is unchanged: local transcript, deterministic tightening of pauses and fillers as one undoable transaction (ADR 0026), then the story pass. Before the story pass main asks the chosen connection whether it is ready (`blocked`): Claude not installed, too old (2.1.302 or newer; the message points to the installer at claude.com/claude-code, because `claude` is often not on the PATH so `claude update` cannot be run), signed out or without a model; Codex signed out or not connected; an API provider without a key or model. When it is not ready the story pass is skipped, the tightening stays, and the result is `completed` (or `failed` when nothing at all could be done) with one of the fixed messages in `magicWandIssues` (for example "The story edit was skipped. Claude Code is too old (2.1.302 or newer is needed): install the latest from claude.com/claude-code, choose Check again in Settings, then run Magic Edit again."). The summary line still reports what the tightening removed. "Edit my video" does the same: with Claude not ready it runs the rough cut on the connection chosen in the assistant drawer and says that step 2 (graphics, captions, sound) needs Claude and how to fix that.

### The story pass on any connection

- **How main learns the choice.** `magic:start` carries a required `provider` (`claude`, `codex`, `deepseek`, `openai`, `gemini`), validated in preload and main (`assertMagicWandStartRequest`) and in `docs/schemas/desktop_ipc.schema.json`. The renderer sends the assistant drawer's selected provider (Claude is the default). Chat actions use the connection of the chat that called them.
- **Claude** (best results, unchanged): a `rough_cut` run in the project's Claude conversation, Haiku by default, `claude` origin.
- **Codex**: one turn in the project's Codex thread. The thread's developer instructions are fixed when it opens, so the rough-cut playbook is sent in the turn text. `codex` origin.
- **API providers**: one bounded API turn (`ApiProviderThreads.send` with turn options): the playbook is appended to the system message, only the cutting tools are offered and accepted, and the budget is 24 completions and 48 tool calls instead of 4 and 8 because a story edit reads the transcript page by page. The picture tool is not offered to API providers, so their playbook says to judge from the transcript. `api_provider` origin. Starting Magic Edit is the explicit initiation of a paid turn; the Magic Edit note says the story edit is billed to the user's API account.
- **Same guards.** While a story pass runs on any route main refuses every tool except `roughCutTools` (read, transcript pages, pictures, trim, split, range cuts, restore); that excludes every app action, so a story pass cannot start another one. Transcript text stays untrusted source content in every playbook. Undo is the shared draft history; Stop interrupts the turn on its route and keeps committed cuts.

### App actions for chats

New tools, run by main through the same code as the buttons and answered in plain words:

- `app.start_magic_edit` (preset gentle, balanced or tight), `app.stop_edit`, `app.go_to_step` (record_import, auto_edit, edit, review, export): on every route (Claude, Codex MCP and dynamic, API providers).
- `app.start_edit_my_video` (level tidy, polished or bold): Claude only, because the full production edit is a Claude run.
- A chat calls a tool during its own turn, and that conversation cannot take a second turn until the reply ends, so Magic Edit and Edit my video are queued and start when the reply is finished (`DeferredActions`); the tool result says so, and the assistant is told to say "started", never "finished". Stop cancels a queued start, stops Magic Edit, or stops a full edit. Starting moves the app to Auto Edit first because the transcript tools need Auto Edit or Edit.
- Navigation uses the step bar's code (`projects.navigate`) and refuses the same cases (local transcription running) plus leaving Auto Edit or Edit while Magic Edit runs; main pushes the new stage to the renderer (`projects:stage-changed`).
- **Not offered:** export, cleanup, deleting projects or sources. Per AGENTS.md these stay explicit user actions; `go_to_step` may show the Export step, and nothing is exported until the user presses Export. A full-edit run (Claude) cannot call app actions either.

### Inventories

Claude 33 editor tools (was 29: three shared plus `app.start_edit_my_video`), Codex 22 (was 19), API providers 21 (was 18, no `media.get_frames`). The init check, allowlist, dynamic tool names and API definitions derive from the shared lists; the API client's tool definition limit rises from 20 to 24.

## Consequences

- A Claude Code older than the required version no longer blocks the deterministic part of Magic Edit.
- Quality differs by connection: Claude can look at pictures and use its workspace; Codex can look at pictures; API providers work from the transcript only. None of the Codex or API story passes has been run against a real model yet (see docs/48 and docs/19 for the pending native checks).
- The chat shows the story pass as a conversation turn on the chosen connection; for Codex that user message carries the playbook text.
