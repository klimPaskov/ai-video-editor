# Security and privacy

For the pinned Codex 0.155.1 runtime, explicitly disable unrelated default-on browser/CDP, computer-use, shell snapshot, interactive unified-exec TTY, workspace-dependency, guardian-approval, in-app browser/chat/dictation/automation/update, fast-mode, image-compaction, mention, and personality capabilities at process launch and on both thread start/resume. Verify exact feature names against the pinned runtime inventory. The packaged feature list reports `unified_exec` true even with an explicit false override, so do not claim that backend feature is disabled; keep `shell_tool=false` and full effective tool confinement under review. These switches reduce exposure but are not a global tool-name allowlist.

Also disable the pinned runtime's default-on `hooks`, shadow `skill_search`, and `unbounded_connection_retries` features. The latter keeps active sampling turns alive while network recovery proceeds, which is incompatible with the editor's uncertain-turn policy. Pin `code_mode` and `code_mode_host` off at process launch and on MCP-bound thread start/resume; enable them only on the validated dynamic route. Strict process config and exact start/resume tests ensure these route gates are not silently ignored.

## Desktop renderer

- Load packaged local content only.
- Disable Node integration.
- Enable context isolation and renderer sandboxing.
- Apply a restrictive CSP.
- Deny unexpected navigation and new windows.
- Validate every IPC sender and payload.
- Expose only narrow preload functions.
- Never render arbitrary remote HTML inside a privileged view.

## Filesystem

- Limit project operations to selected project roots.
- Canonicalize paths and reject traversal.
- Keep source files immutable.
- Use staging and atomic promotion.
- Confirm project deletion and cleanup.

## Capture privacy

- Request clear permission for screen, camera, microphone, system audio, and pointer telemetry.
- Display active capture indicators.
- Never capture keystrokes.
- Avoid notification and secret exposure in fixtures and documentation.

## AI data boundary

- Explain which selected provider receives text, metadata, frames and instructions before first use.
- Send the minimum context needed for the task.
- Keep raw media local by default.
- Show when a frame or transcript excerpt is being shared.
- Let the user sign out and use the manual editor without AI.
- Keep API-provider requests on fixed reviewed HTTPS endpoints under main; do not let renderer data choose a destination.
- Treat API-provider output as untrusted edit intent with the same active-project, scope, sequence/hash and undo validation as Codex tools.
- Require an explicit user action before any paid generation turn; do not guess prices or remaining credit.

## Runtime tools

Codex receives guarded codex-video-edit tools, not unrestricted filesystem or shell control. Tool calls validate project, draft, range, asset, and transaction identity.

Electron main owns the active project and the only draft writer. The packaged MCP child accepts only the eight reviewed P2 tools, including bounded reversible `cut.split`, `cut.delete_range`, `cut.delete_ranges`, and exact `cut.restore_range`, and forwards bounded intent through a local broker authenticated by a random process-only credential. App-server startup verifies the exact server, tool names, and input schemas and refuses MCP project threads on mismatch. The child cannot choose a project root, construct transaction authority, approve export/deletion/cleanup, or access a generic main RPC.

For each new dynamic-bound project thread, main binds every model-visible `project_id` tool property to the validated active project with a JSON Schema `const`. This avoids relying on generated identifier text for normal calls. It is not authorization: main still resolves the active project and rejects any call that does not match it. Stored tool definitions remain with their existing thread on resume.

Renderer project frames are bound to the exact draft ID, baseline revision, sequence and timeline hash. Main alone maps output time to the immutable source, rechecks the head after decode, and returns no stale pixels. Source IDs, mapped source times and paths stay out of this project-frame request and response. Draft-change events contain only the validated path-free identity and timeline view.

The dedicated App Server uses fixed ChatGPT/OpenAI settings and disables web search, shell, unified execution, the separate JS REPL, browser/computer use, apps, connectors, plugins, remote plugins, image generation, the plan tool and user-input requests. Its matching packaged Luna code-mode host is hash-checked and required for guarded editor tools. MCP-bound project threads disable native collaboration. Dynamic-bound V1 models enable V1 children with depth limited to one. GPT-6-Luna V2 uses direct-only spawn/wait functions with a root-plus-one-child capacity; main correlates the exact spawn call ID to `subAgentActivity.started` and the active child turn. Because the pinned runtime does not pass per-thread dynamic editor definitions to V2 children, main reads both path-free summaries first and passes only those results to the child. The main-owned invoker still permits only the two summary reads if a child call arrives, and independently denies every mutation. Empty environments, read-only/no-network policy, command/file approval rejection, and MCP elicitation cancellation apply to the tested child paths. Child notifications and identity never enter the parent projection. A packaged V2 native fixture passed direct spawn/wait, child parent/source verification, matching summary response and inherited policy with unchanged source, baseline and journal. This is bounded evidence, not a complete effective model-visible tool catalog or permanent upstream restriction; full P2-07 confinement remains open.

The process configuration and both route-specific thread requests additionally turn off API-key model discovery, default-mode user-input and auth/MCP elicitation, request-permission and approval-rule tools, exec permission approvals, web search, MCP OAuth coordination and dependency installation, passive Chronicle screen memory, external-agent memory import, persisted goals, and plugin sharing/suggestions. These switches align the ChatGPT-only Codex path with the app's main-owned approval and provider boundaries; they do not prove complete upstream tool absence.

The pinned 0.155.1 process and thread policies also set `features.deferred_executor=false` and `features.token_budget=false` because this editor does not need environment-wait or token-budget utility tools. Keep direct editor mutations behind the validated transaction service; these feature gates do not establish a global built-in allowlist. The new packaged unavailable-model Settings regression passed. Real guarded-edit probes with the current account did not complete and are recorded as failures.

On dynamic child routes, start/resume configuration pins the default child model and reasoning effort to the selected parent pair for both V1 and V2. The application disables native child tools for Astra model IDs, even if the runtime advertises a child protocol. This is main-owned configuration defense; retain independent child-call validation, lineage checks and the read-only summary boundary.

The same process and thread policies explicitly disable `sleep_tool` and `view_image`, whose pinned 0.155.1 defaults are enabled. `code_mode_only` still permits the direct sleep tool when the runtime's current-time reminder configuration enables it, so the explicit feature switch is required. This narrows the tested surface without proving complete upstream tool confinement.

Thread resume consumes at most one validated page of 100 newest full turns and 1,000 unique items. Main reverses that page for chronological display and exposes only up to 200 redacted user/Codex messages and 32 generic activities under fresh application IDs. Skill paths, cursors, raw server IDs, tool inputs/results, reasoning, and unsupported content stay out of renderer state. Command, file, web, image, foreign dynamic-tool, foreign-MCP, unknown, approval-waiting, or an inline page that contradicts its same-response thread status quarantines the connection before it opens. Dynamic-bound threads accept only the eight reviewed namespaced tools as generic activity, while MCP-bound threads reject host calls. A separately fetched fallback page is later authority and safely absorbs buffered completion races.

The private thread registry tags each version 2 binding with its tool route. Version 1 entries are interpreted only as MCP, and an incompatible process route fails before resume. A dynamic thread projects no MCP calls; an MCP thread rejects host calls even if an internal invoker exists. Corrupt or unknown routes fail without replacing the registry. Product main selects host-defined tools for new conversations and retains MCP for existing bindings; both reach the same guarded active-project service. Packaged dynamic edit/Undo/reopen and separate v1 MCP read passed. Complete effective-tool confinement remains open.

A packaged native dynamic stale-draft turn also passed: the host tool returned an unsuccessful bounded response for an obsolete sequence/hash, while the authoritative draft, two journal entries, original, managed copy and baseline remained unchanged. Keep the safe error contract for this route and continue to distinguish a rejected owned call from proof that unrelated built-in tools are unavailable.

For the dynamic route, a host call received before the `turn/start` RPC response requires a validated `turn/started` notification naming the registry-owned thread and a single provisional turn. The response must agree with that turn; a call before notification, after buffered completion, or after contradiction cannot reach the guarded invoker. Notifications stay buffered until reconciliation. Unit tests exercise those races, and a direct isolated App Server run completed one owned read. A packaged dynamic negative-command probe observed no forbidden invocation in that exact turn; this does not prove full upstream tool confinement.

A packaged dynamic-route Luna/high fixture on an earlier route revision reported six owned nested code-mode tools; that observation is historical. The current fixture correlates the exact diagnostic turn with its account-contained rollout and requires the real `exec` call and matching output. Its pre-restore baseline and hostile per-app-override runs reported seven guarded editor functions, five supported v1 child functions, zero connected-app functions and zero other nested functions, then passed the guarded split, Undo, reopen and immutable source/baseline checks. Keep private files, model text, rollout data and screenshots outside Git. This bounded probe does not establish complete upstream effective-tool confinement.

The previous reviewed host/MCP surface had seven tools after adding `cut.delete_ranges`, whose input permits only 2–16 strict, disjoint time intervals in descending order. The current eighth tool is `cut.restore_range`, with exact source-time bounds, baseline-source resolution, overlap rejection and shared undo and carries no source path, arbitrary operation, export or cleanup authority. A real packaged Luna/high turn applied the batch on synthetic and private supplied footage; source and baseline bytes remained unchanged after manual Undo and reopen. The earlier six-tool inventory is historical, and no complete upstream tool-confinement claim follows from the new batch run.

A separate fresh packaged Luna/high split turn on the seven-tool build reported exactly seven owned and zero unowned nested names before the rollout-correlated fixture was added. That later test was authoritative for the then-current route counts, including its five supported dynamic child functions. Neither result establishes a complete permanent upstream tool policy.

## Secrets

Let the official Codex client own ChatGPT credentials. Do not copy tokens into project files, logs, crash reports, or renderer state. The MCP broker credential is inherited through the restricted process environment and never appears in command arguments, thread instructions, project data, or IPC.

OpenAI API, DeepSeek and Gemini API keys are separate secrets. Main owns input and redacted status; never return key bytes or authorization headers over renderer IPC or place them in project files, prompts, URLs, crash output, screenshots or public evidence. Use OS-backed per-user encryption for persistence; if unavailable, keep the key in session memory only or refuse persistence clearly. A remembered model choice is encrypted with its key, not written as a separate plaintext preference; legacy key ciphertext remains readable and gains a model only after selection. Recheck the remembered model against a live provider catalog before use, and clear it on key replacement/removal. Gemini function-call thought signatures stay bounded in main turn memory and must not enter renderer IPC, persisted conversation, logs or public evidence. A packaged Linux run with real GNOME Secret Service verified protected OpenAI key/model reopen, no plaintext key/model in the protected file, an empty renderer key field and explicit removal; this does not prove another OS backend or a paid turn. Key replacement and removal are explicit; removal interrupts a currently running turn for that provider. A tool already committed before interruption remains in the undo history. Native tests must cover endpoint pinning, key redaction, storage failure, logout/replacement, provider rejection and untrusted output.

The packaged synthetic provider test runs each supported API choice and replaces `fetch` only inside the isolated Electron main process after startup; no renderer API or user-configured endpoint can set that transport. Each run asserts its fixed destination, synthetic key redaction in conversation storage, guarded stale rejection and unchanged source/baseline through trim, undo and provider failure. This does not authorize an external paid call or prove a live model followed the tool protocol.

HTTP 429 is a fixed, redacted rate-or-quota condition; the provider body and request headers never enter renderer state or project history. The authenticated OpenAI packaged attempt observed only status 429 in private test evidence and committed no transaction. A synthetic native 429 check covers visible recovery and unchanged journal for both provider selections; the exact account-side rate or quota cause is unknown.

HTTP 401/403 during a generation turn is a separate fixed, redacted API-connection failure. Do not infer whether the key, account, model permission or provider policy caused it from status alone. The local conversation retains the user request but not the raw error, and the draft journal stays unchanged unless an earlier validated tool already committed. Synthetic native checks cover OpenAI and DeepSeek; the live fixture still requires a private authorized key for each provider.
## Inherited MCP and Apps boundary

Feature flags are route- and model-protocol-specific on both thread start and resume. MCP-bound threads keep `code_mode_only` false, explicitly set `code_mode.enabled=false` and `code_mode_host.enabled=false`, exclude `multi_agent_v1` and `multi_agent_v2` and keep native agents disabled. Both routes disable the code-mode host's in-process fallback. Dynamic V1-capable Codex threads enable code mode and the packaged host and support V1 child collaboration at depth 1. GPT-6-Luna V2 enables the direct-only `codex_video_edit_agents` namespace with capacity two; the six V2 child functions stay out of nested code-mode, and the parent supplies only the current path-free project/timeline snapshots. Correlate the spawn call ID, server-owned child activity, parent thread and child thread before projecting generic activity. Both routes explicitly set the pinned supported unrelated browser, app, connector, plugin, shell, search, image, memory, hook, remote-control and commit flags false. Focused request tests and packaged dynamic split/V2-child fixtures passed; these bounded observations do not establish a complete upstream tool allowlist.

Before App Server starts, main discovers configured MCP names with the pinned CLI's JSON list, bounds and validates the result, applies an explicit disabled override to each name, then verifies the complete inventory. It repeats exact status validation for the active thread before exposing Codex editing. An external server with tools or resources, a changed inventory, or a reserved-name collision fails closed. Thread start and resume explicitly disable Apps, plugins and remote plugins; packaged synthetic hostile-config testing verified the external server stayed disabled and the host-owned `codex_apps` service was absent for the exercised authenticated runtime. Empty `mcp_servers={}` alone is insufficient because Codex merges an empty table. This evidence is bounded to the tested runtime and fixture; it does not prove a complete upstream tool catalog.

The eighth guarded tool, `cut.restore_range`, accepts only the exact main-validated source ID and one half-open source-time interval bound to the current draft head. It resolves exactly one baseline source clip, rejects visible overlap and invalid or mixed requests before a journal write, then persists the full before/after maps and inverse. It does not accept paths or mutate sources, and it cannot authorize cleanup or export.

The pinned Codex runtime can register asynchronous user-input tools from model capability metadata. The project-thread request handler rejects the resulting `item/tool/requestUserInput` request as unsupported, quarantines the thread, and rejects later notifications before any question reaches renderer state. This is a fail-closed app boundary, not proof that the upstream model-visible function is absent; keep complete effective-tool confinement open.

Failed-turn projection uses only the pinned structured `codexErrorInfo` category to select fixed Reconnect, usage-limit, or service guidance. Raw provider error messages and additional details never enter renderer state. The pinned protocol maps `unauthorized` from a refresh-token failure; ambiguous HTTP 401/403 connection variants remain generic rather than asserting that account reauthentication is required.
