# Claude Code project guidance

`CLAUDE.md` loads the shared project instructions and latest Claude-default requirement. `CLAUDE.local.md` carries ignored machine context. Project skills in `skills/` point to canonical `.agents/skills/` guides; native agents in `agents/` carry bounded role entry points. Choose implementation methods, models and delegation from the current session's capabilities and user requirements.

`settings.json` supplies the official schema reference for future reviewed project settings. It contains no account, model, endpoint, hook or permission override. Local settings, credentials, sessions and worktrees stay outside publication.

These files prepare Claude Code development. In-app Claude sign-in remains the unimplemented requirement in ADR 0018.

Formats checked against official [project memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents) and [settings](https://code.claude.com/docs/en/settings) documentation on 2026-10-04. No Claude session was launched to verify discovery in this handoff slice.
