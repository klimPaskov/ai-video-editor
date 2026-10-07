---
name: claude-code-connection
description: Maintain the default Claude connection through the user's unmodified Claude Code CLI, its Anthropic sign-in, live catalog and guarded editor turns.
---

# Claude Code connection

## Use when

Changing Claude sign-in, model selection, the Claude assistant drawer, Claude turn streaming/interruption, or the tools Claude can call.

## Requirements

- Read ADR 0018 and `docs/48_CLAUDE_CONNECTION.md` first. Recheck Anthropic's current "Legal and compliance" and "Authentication" pages before changing authentication; record the date and what changed.
- Run only the user's installed, unmodified Claude Code CLI. Never bundle, patch or wrap it, never embed the Agent SDK for subscription use, never implement OAuth, and never read, copy, seed or log Claude credentials or session tokens. Sign-in is `claude auth login --claudeai`; the app reads only `claude auth status` JSON. Do not read the CLI's printed fallback URL or type into its code prompt: completing sign-in goes only through the page the CLI opens, which returns to its own loopback listener.
- Keep main as the only owner of executable discovery, the dedicated `CLAUDE_CONFIG_DIR`, the empty working directory and the restricted child environment (no inherited Anthropic credential variables).
- Discover models with the stream-json `initialize` control request; it must not send a user message. Strip API list prices from labels. Fresh preference: `default`; remembered choices are revalidated.
- Every turn keeps `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--permission-mode dontAsk`, `--permission-prompts none` and the exact nine-tool `--allowedTools` list. Enforce the `system/init` inventory and stop on any other tool use. Verify flag behavior against the real pinned CLI before relying on a new flag; `--safe-mode` drops `--mcp-config` servers.
- Claude edits go only through the shared transaction engine with origin `claude`, through the Claude-only broker.
- Renderer views carry fixed status/issue strings, price-free model names and bounded conversation text only; keep the IPC schema enums equal to `packages/domain/src/claude-view.ts`.
- Distinguish subscription sign-in from Console API billing and show the paid-turn notice for API billing; turns start only on explicit Send.

## Tests

- Host: `tests/media/claude-bridge.test.ts` (uses the labeled test double `tests/media/support/fake-claude-code.ts`, never packaged), `tests/foundation/test_desktop_ipc.py`, transaction-origin tests.
- Native, isolated guest only: `node tests/native/claude-connection.test.ts <packaged-executable> <claude-bin-dir> [--hold-sign-in] [--require-signed-in] [--profile <dir>] [--inspect]`. Signed-in acceptance requires the user to complete Anthropic's sign-in from a browser inside the same guest; never substitute copied credentials, an API key or a developer session (including a cloud VM's hosting credential) for account sign-in evidence.
