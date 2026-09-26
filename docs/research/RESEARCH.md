# Research summary

Research date: 2026-09-04

Current foundation review: [P0 research, checked 2026-09-05](P0_FOUNDATION.md). Use that report for current dependency observations, protocol corrections, and explicit limits; the earlier summary below is background research.

## Borumi

Borumi presents a three-part creator flow: ideate, record, and edit. Its public feature set includes scene-by-scene recording, screen, camera, microphone, separate sources, retries, layouts, automatic timeline, transcript editing, noise removal, multiple canvas formats, automatic zooms, system audio, cursor controls, silence removal, teleprompter, and editor shortcuts.

Sources:

- https://borumi.com/
- https://borumi.com/changelog/
- https://borumi.com/alternatives/camtasia/

The product may take inspiration from the simplicity and feature classes. It must not copy Borumi branding, assets, copy, or exact screen composition.

## Comparable patterns

Other current products reinforce these patterns:

- automatic zooms around clicks and cursor activity
- an editable AI-generated timeline
- user control over zoom range and target
- clean screen, camera, and microphone capture
- local or desktop-first export

Sources:

- https://www.vidova.ai/
- https://framevo.app/
- https://screenforge.co/
- https://www.canvid.com/features/auto-manual-zoom
- https://getflowy.app/

## Codex

The official Codex app-server is intended for rich clients. It uses bidirectional JSON-RPC, supports stdio, threads, turns, streamed events, model discovery, skills, ChatGPT-managed login, and rate-limit state. The package chooses stdio for the required local child-process integration. The [current official documentation](https://learn.chatgpt.com/docs/app-server) also lists WebSocket and Unix transports; the previous claim that WebSocket is unsupported is stale. Validate protocol types against the exact installed executable before implementing P2.

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

## Native stack

Electron provides desktop capture and system-audio loopback interfaces. Playwright can launch Electron apps, automate their windows, and capture screenshots. Electron security guidance requires current releases, context isolation, sandboxing, restricted navigation, validated IPC, and local trusted renderer content.

Sources:

- https://www.electronjs.org/docs/latest/api/desktop-capturer/
- https://www.electronjs.org/docs/latest/tutorial/security
- https://playwright.dev/docs/api/class-electron

## Gemini API provider model filter, 2026-09-25

Google's current [function-calling model table](https://ai.google.dev/gemini-api/docs/generate-content/function-calling) lists the stable text/function families used by the editor's reviewed allowlist. The [OpenAI compatibility guide](https://ai.google.dev/gemini-api/docs/openai) describes the fixed OpenAI-compatible endpoints as beta and supports model listing; live account membership alone does not establish the full completion/tool-loop contract. Google release notes dated September 15 and 22 add 3.8 Live and 3.8 Flash TTS variants. The app continues to exclude Live, speech/TTS, image, embedding, transcription, video, and preview families per ADR 0015. New negative model-filter cases cover 3.8 Live, TTS, and Gemini 3.1 Pro Preview. See [P2 provider contract notes](P2_API_PROVIDERS.md#current-gemini-model-review-2026-09-25). No Gemini key was available for authenticated discovery or generation tests.

Sources:

- https://ai.google.dev/gemini-api/docs/generate-content/function-calling
- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/changelog

## Codex App Server 0.156.0 confinement review, 2026-09-25

Reviewed the current official release after the pinned 0.155.1 runtime's full tool-catalog gate remained open. The tagged 0.156.0 thread-start contract still offers `dynamicTools`, but the reviewed app-server request and configuration types expose no complete model-visible tool allowlist. The release notes add no such boundary. The product remains pinned to the already verified 0.155.1 package; upgrading would require generated-protocol and packaged native regression checks and does not, by itself, close P2-07.

Sources:

- https://github.com/openai/codex/releases/tag/rust-v0.156.0
- https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/config/src/config_toml.rs

## Codex app-tool default override review, 2026-09-25

The pinned Codex 0.155.1 configuration types document `apps._default.enabled=false` as disabling apps unless a per-app setting overrides it. A later packaged native fixture seeded both `[apps._default].enabled=true` and `[apps.adobe].enabled=true`; its exact completed-turn rollout still showed zero connected-app functions on the dynamic editor route, and the guarded split/Undo/reopen checks passed. This closes that specific hostile per-app configuration edge for the tested thread and pinned runtime. It does not establish the complete effective tool catalog; P2-07 remains open.

Source:

- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/config/src/types.rs#L2904-L2910

## Codex browser OAuth callback failure path, 2026-09-25

The pinned official Codex 0.155.1 login server binds a local callback listener, includes its selected port and OAuth state in the authorization URL, rejects a mismatched state with HTTP 400, and reports a matching provider denial as a failed login. The new packaged Electron regression uses that actual listener with a fresh signed-out account: an incorrect state leaves the attempt pending; a matching `access_denied` callback returns the app to signed out with fixed recovery text; a private error description and authorization state/URL stay out of the renderer; and a subsequent login can be canceled. This is negative callback and redaction evidence only. It does not exchange an authorization code, create an authenticated account, or prove successful browser OAuth completion. Keep the successful browser-login gate open until a real completion and reconciled account are observed.

Sources:

- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/login/src/server.rs#L2470-L2865

## Codex 0.155.1 route-specific thread features, 2026-09-25

The pinned official 0.155.1 configuration schema (https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json) defines the feature fields used by the thread builder, including code_mode_only, code_mode.enabled, code_mode_host.enabled, disable_in_process_fallback, browser/computer-use, apps/connectors, image, memory, hooks, plugins, remote-control and commit switches. The route-aware builder applies only dynamic code-mode enablement to dynamic-bound Codex threads and keeps it off for existing MCP-bound threads; both routes disable the supported unrelated feature flags and disable in-process host fallback. Exact start/resume unit tests passed. A packaged Luna/high synthetic dynamic split run passed its bounded seven-editor/five-v1-child inventory, zero app/other counts, shared Undo/reopen and immutable-source/baseline checks after the real Electron window was inspected inside Docker. These schema fields and one tested nested surface do not establish a complete or permanent upstream effective-tool allowlist; P2-07 remains open.

Source:

- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json

## Codex 0.155.1 additional capability gates, 2026-09-25

The pinned [feature definitions](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/features/src/lib.rs) identify API-key model discovery, passive Chronicle screen-context memory, external-agent memory import, persisted goals, permission/rule requests, MCP OAuth elicitation and MCP dependency installation as separate capabilities. The pinned [feature schema](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json) accepts explicit false values for these switches. The project now disables them at App Server launch and in both route-specific thread policies, along with web search and plugin suggestions. This is account-default defense in depth; it does not expose or prove the complete effective tool catalog. The dynamic v1 child route remains available only with its existing depth-one main-process checks.

The pinned [tool planner](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/spec_plan.rs) selects v1 collaboration tools from the runtime's resolved `MultiAgentVersion::V1` and applies the configured spawn-depth limit. The added gates leave that model-resolved, already-tested path unchanged. Exact route request tests and native split/child fixtures are required after the policy change; P2-07 remains partial until the effective upstream catalog boundary is proven.

Sources:

- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/features/src/lib.rs
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/spec_plan.rs

## Current upstream App Server tool-boundary review, 2026-09-26

Inspected the official `openai/codex` main-branch `ThreadStartParams`, app-server README, and tool planner after the pinned 0.155.1 complete-catalog gate remained open. The current public `thread/start` shape includes host-supplied `dynamicTools` and selected capability roots, but the inspected request type has no general allowed-tools field. The README says `disabledPluginIds` records a selection but does not filter plugin capabilities. The planner composes core, MCP, extension, dynamic, and hosted tool sources, so adding host tools is not by itself an allowlist. This main-branch review is not a released package and does not describe the exact pinned runtime; it is a reason not to upgrade or claim stronger isolation without a version-pinned contract and packaged regression. Retain the 0.155.1 tested configuration gates, per-thread routes, MCP inventory verification, sandbox boundaries, and owned-call validation. P2-07 remains open until supported runtime enforcement or stronger pinned evidence establishes the complete effective surface.

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs

## Current App Server permissions profile and tool allowlist, 2026-09-27

Inspected the current public-main `ThreadStartParams` after the pinned 0.155.1 tool-surface gate remained open. The typed request exposes host-supplied `dynamicTools`, selected capability roots and an experimental named `permissions` profile. The profile is documented as mutually exclusive with the legacy `sandbox` field; it is a permission-profile selector, not a declared list of model-visible tool names. No general `allowed_tools` or `allowedTools` field appeared in the inspected request type. The current App Server README also states that saved `disabledPluginIds` do not filter plugin capabilities. These source observations do not prove the effective runtime catalog and are not from the pinned 0.155.1 release. Keep the product on its pinned, tested feature gates and host-tool validation; do not upgrade or claim a complete allowlist from the profile, dynamic tool definitions, or plugin selection.

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

## Pinned Codex 0.155.1 thread tool-boundary schema, 2026-09-27

Inspected the exact `rust-v0.155.1` tagged `ThreadStartParams` and `ThreadResumeParams` source used to generate the app's pinned protocol closure. `ThreadStartParams` has `dynamicTools` and `selectedCapabilityRoots`; its `permissions` field is documented as a named profile ID mutually exclusive with the legacy sandbox field. The typed start/resume request contains no general `allowed_tools` or `allowedTools` list. The same release's config schema scopes `enabled_tools` allowlists to plugin-provided MCP servers and `direct_only_tool_namespaces`/`excluded_tool_namespaces` to the nested Code Mode surface. Its top-level `tools` settings cover specific built-ins such as plan, user-input and web-search, not a global direct-tool name allowlist. Those narrower controls do not enumerate every runtime-selected direct/deferred tool or establish that feature gates form a complete allowlist. Keep the guarded app-owned tool adapter, route checks, child policy and tested feature gates; the full effective surface remains open.

Sources:

- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L59-L155
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L323-L395
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json#L496-L523
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json#L3169-L3204
- https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json#L3932-L3950
