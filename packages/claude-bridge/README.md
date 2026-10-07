# Claude bridge

Runs the user's installed Claude Code CLI for the Claude assistant.

- `cli.ts`: finds Claude Code, checks its version, reads sign-in status and the live model catalog. Sign-in itself happens in Anthropic's browser page through `claude auth login`; this package never reads or stores credentials.
- `turn.ts`: one restricted, headless Claude Code process per assistant reply. Built-in tools, settings and slash commands are disabled; only the app's guarded editor tools are allowed, and the tool inventory reported at start-up is enforced.
