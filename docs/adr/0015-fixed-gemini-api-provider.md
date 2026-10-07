# ADR 0015: Fixed Gemini API-key provider

- Status: Accepted implementation decision; live account acceptance pending
- Date: 2026-09-20
- Extends: ADR 0014's initial OpenAI API and DeepSeek provider set

## Decision

Add Google Gemini API as a third explicit key connection beside OpenAI API and DeepSeek. Codex App Server remains the separate ChatGPT subscription path. Users choose a provider and initiate each API-paid turn with Send; entering or selecting a key never triggers generation. Keep the Gemini models and Chat Completions endpoints fixed at Google's documented `generativelanguage.googleapis.com/v1beta/openai/` routes. Do not accept a custom base URL, arbitrary compatibility host, provider plugin, or bundled key. Reuse the main-owned protected-key/session fallback and the same guarded draft transaction service; the API provider gains no filesystem, export, Codex skill or native-subagent authority.

Offer only reviewed text/function model IDs present in that key's live model catalog. Exclude image, Live, speech, embedding, transcription, preview and video model families from the editor selector until a separate reviewed capability path exists. A model's presence in `/models` does not prove its complete tool loop works. If discovery or compatibility fails, show an actionable connection/response error without a fabricated model choice or draft edit.

The non-streaming compatibility endpoint supports function calls, but Gemini 3 may return a `tool_calls[].extra_content.google.thought_signature` that must be replayed on the matching assistant tool-call message with subsequent tool results. Preserve only the exact bounded signature in main memory for that turn; validate and reject malformed metadata. Never put signatures, keys, tool arguments or raw provider responses in the renderer, project conversation, logs, public tests or Git. Keep parallel assistant calls together before their ordered tool results. The transport uses a fixed `x-goog-api-client` identification header and a bounded provider-specific completion limit. No Gemini-specific generated media, search, code execution or platform tools are enabled.

## Evidence and limits

Official endpoint, model-list and function-call contract: https://ai.google.dev/gemini-api/docs/openai . Official signature replay contract: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures . Official client identification guidance: https://ai.google.dev/gemini-api/docs/partner-integration . Current model IDs require fresh review against https://ai.google.dev/gemini-api/docs/models and live account discovery.

Synthetic transport and packaged native fixtures may establish local routing, UI, key redaction and guarded edits; they cannot establish authenticated Gemini catalog membership, accepted completion parameters, actual thought-signature replay or paid editing without an authorized live key. Keep those gates open in P2 and report unavailable access rather than inventing acceptance.
