# ADR 0014: Explicit API-key providers alongside Codex

- Status: Accepted user requirement; implementation and native acceptance pending
- Date: 2026-09-19
- Supersedes: ADR 0002's first-release Codex-only provider limit and API-key exclusion
- Extended by: ADR 0015's fixed Gemini API-key provider and ADR 0018's default Claude account connection

## Decision

Keep the official Codex App Server over stdio with ChatGPT subscription sign-in, threads, skills, streaming and supported native subagents. Also offer explicit API-key connections for OpenAI API and DeepSeek. These are separate account and billing paths: a ChatGPT subscription does not grant API usage, and entering an API key must not be represented as Codex sign-in. Codex remains usable without an API key; manual editing remains usable without any AI account.

The initial API providers use fixed, reviewed HTTPS endpoints and provider-specific request/response adapters. Do not accept a renderer-selected base URL, arbitrary OpenAI-compatible endpoint, plugin, or provider catalog as part of this change. Discover available models from each provider's supported live catalog when available, validate the selected model against that catalog, and report unavailable discovery rather than inventing options. Provider-specific features are shown only where implemented and verified; a generic API connection does not inherit Codex App Server skills, durable threads, native subagents, or subscription usage data.

Main owns key entry, storage, network access and provider calls. Never send key bytes, headers or raw responses to the renderer, projects, logs, prompts, telemetry, screenshots, test evidence or Git. Prefer OS-backed encryption with a documented per-user storage boundary; when secure persistence is unavailable, allow session-only memory or fail clearly, never save plaintext. Revoke/replace keys through explicit controls. Show the destination provider and context disclosure before first use. API-paid turns require an explicit user action; no background model probe should incur a generation charge. Do not infer prices, quota or remaining credit.

Codex, API providers, Magic Wand and manual tools apply authorized reversible edits through the same guarded active-draft transaction engine and undo history. API-provider output is untrusted edit intent, never direct file, shell, network, export or project mutation authority. Validate each operation, freshness preconditions, scope and provider capability in main; update the UI only from committed state. Source deletion, cleanup, publication and final export remain explicit user actions. A paid AI turn requires explicit user initiation even when reversible draft edits may proceed during that turn.

## Migration and evidence

This decision changes requirements, not completion. Historical ADR 0002 and accepted P0/P1 evidence remain true for their dates. P2 gains API-key provider tasks and native security/behavior acceptance; P2 stays incomplete until those and its original Codex gates pass. Update affected specs, schemas, tests, prompts, skills and routing in the implementation slice. Keep credentials and private native evidence outside the public repository.
