# ADR 0002: Real Codex only

- Status: Accepted starting decision
- Date: 2026-09-04
- Superseded in part by ADR 0014 on 2026-09-19: Codex remains mandatory, while its first-release provider exclusivity and API-key exclusion no longer apply.

## Decision

Use the official Codex app-server over stdio as the only AI provider in the first release. Authenticate through ChatGPT-managed login.

## Consequences

- No fake assistant, canned response layer, or API-key-first setup.
- Discover models and skills from the active app-server.
- Keep protocol types tied to the installed Codex version.
- App-specific media edits occur through guarded MCP tools and draft transactions.
- The manual editor remains usable when the user is signed out.
