# ADR 0016: Luna/high subscription default with a current Codex runtime

- Status: Accepted implementation decision; P2 acceptance remains open
- Date: 2026-09-20
- Scope: Codex App Server subscription path only

## Decision

Prefer `gpt-6-luna` with `high` reasoning for a signed-in ChatGPT account that has no saved Codex model preference. Resolve both the model ID and supported effort from the current App Server `model/list` result before selecting it. Keep the full live catalog available for an explicit user choice, and preserve a valid saved choice. If GPT-6-Luna/high is absent, leave the default unselected and show a recovery action in Settings rather than silently changing models. This preference does not apply to the separate API-key providers.

Update, 2026-09-26: the authenticated Codex 0.155.1 `model/list` catalog exposed `gpt-6-luna` with `high`; the subscription default therefore advances from the former GPT-5.6-Luna pair to GPT-6-Luna/high. Existing explicit valid choices remain preserved.

Pin the official Codex App Server package and packaged binary to `0.155.1`. Generate the consumed experimental TypeScript closure from that exact binary, retain its source hashes and Apache licence, and verify the packaged version and hash before launching. The earlier `0.142.3` runtime returned only `gpt-5.5` for the signed-in isolated test account; an isolated read-only `0.155.1` probe returned Luna/high. A fresh-account packaged native Settings run confirmed the selected preference and restart behavior. Treat that as model discovery and native selection evidence, not proof of an editing turn.

No GPT-6 Astra implementation subagents or native Codex child tests are authorized by this decision. If a test cannot select a permitted model, run it directly or leave that test unverified. An upgrade does not by itself resolve the effective forbidden-tool inventory issue under P2-07; protocol, policy, guarded edit, interruption and native regression checks remain required.

## Evidence and limits

Official release: https://github.com/openai/codex/releases/tag/rust-v0.155.1 . The runtime catalog and packaged Settings observations are private isolated test evidence. No credential, source recording, account path or native screenshot is published with this decision.
