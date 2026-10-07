---
name: security-privacy
description: Review Electron, files, capture, Codex, assets, and deletion boundaries.
---

# Security and privacy review

## Review areas

- packaged local renderer and CSP
- sandbox, context isolation, IPC sender validation
- path canonicalization and project root limits
- source immutability and atomic writes
- screen, camera, microphone, system audio, and pointer consent
- no keystroke capture
- Codex minimum-context disclosure
- credential ownership by official Codex client
- separate API-provider key entry, fixed HTTPS destinations, OS-backed protected persistence or session-only fallback, key replacement/removal, and no key exposure in renderer or project data
- encrypted remembered-model selection bound to its key; legacy key-only migration, live revalidation, replacement clearing and no plaintext model preference
- explicit user initiation before paid provider generation and provider-specific context disclosure
- guarded tool permissions and transaction validation
- asset provenance
- cleanup and uninstall preservation

## Method

For pinned Codex 0.155.1, verify process and thread feature gates against the packaged `codex features list`. Disable unused default-on browser/CDP, computer-use, shell-snapshot, interactive TTY, workspace-dependency, guardian-approval and in-app utility surfaces. Do not claim `unified_exec` is disabled when the runtime reports it true; `shell_tool=false` is the separate shell-registration gate. Feature switches are not a generic model-visible tool allowlist.

Also disable hooks, skill-search shadow work and unbounded connection retries; the last feature can keep a sampling turn alive through network recovery. Pin Code Mode and its host off at process launch and on MCP-bound threads; enable them only for the validated dynamic route. Verify these gates in the pinned packaged feature list and exact start/resume tests, while keeping complete effective-tool confinement open.

Verify every process and thread feature key against the pinned registry. Open JSON config objects can accept unsupported names; external integrations must use the supported Apps gate and per-server MCP policies.

Build a threat list for each changed boundary. Add abuse and failure tests. Verify secrets and raw logs do not enter renderer state, project files, screenshots, or crash output.

For OpenAI API, DeepSeek and Gemini API, test that malformed keys and malicious model output cannot choose a URL, escape edit scope, invoke Codex/MCP privileges, or bypass draft sequence/hash checks. Gemini function-call thought signatures are bounded opaque turn-local metadata in main; reject foreign/malformed metadata and never persist or expose a signature. Treat a network model response as untrusted, not as an authorized tool call.

For native remembered-key evidence, require packaged Electron, a real secure OS backend (the isolated Linux GNOME Secret Service path uses `gnome_libsecret`), private input and protected-file permissions, live model revalidation after restart, no key in renderer state or plaintext protected bytes, and explicit removal. Keep the credential and screenshots outside Git. This one backend does not establish Windows/macOS keyring behavior or paid provider editing.

For synthetic native turns for all three API providers, inject only into the isolated main process and reject every URL outside the selected fixed reviewed provider routes. Assert source/baseline preservation, stale rejection, shared undo and key/raw-response redaction in persisted conversation. For Gemini 3, assert exact thought-signature replay with matching tool results and no signature in persisted state. Do not treat synthetic model output as an authenticated provider edit or permit renderer-supplied transport overrides.

Map provider 429 to fixed rate-or-quota recovery text without persisting raw response bodies, headers, account data or credentials. A live-key test may keep status codes only in ignored private evidence; delete any transferred mode-600 key file before launching Electron. Never publish the live project, screenshot or test transcript.

Map provider 401/403 on a started turn to separate fixed API-connection recovery text; do not infer a particular account, key or model-access cause. Keep the failed request in the local thread, but no raw response, credential or fictitious edit. Synthetic native assertions must check both renderer projection and unchanged journal for each provider.

## Stop condition

Block the phase on unrestricted renderer privileges, source mutation, silent capture, token leakage, path escape, or unconfirmed deletion.

For Codex 0.155.1 Luna code mode, App Server launch, thread create and resume must disable app defaults, the supported plan and user-input tools, and unrelated code-mode namespaces. The matching packaged `codex-code-mode-host` is required and hash-checked. Keep native agents disabled on MCP-bound threads. On dynamic-bound V1 models, native V1 children are enabled only at depth 1 and main must correlate the server-owned spawn and active child turn before permitting only the project/timeline summary tools. GPT-6-Luna uses a V2 direct-only child route. Correlate the exact spawn call ID to server-owned subAgentActivity and child parent/source; pass only parent-read path-free project/timeline snapshots because per-thread editor tools are not inherited. Preserve empty child environments, read-only/no-network and never-approval policy. Keep child content out of renderer state, and reject every child edit independently in main. Packaged V1 and V2 child fixtures passed their bounded lineage and summary checks, but do not prove a complete upstream tool catalog. Never spawn Astra agents. Test the visible tool surface in bounded native turns, and do not generalize one successful probe into a permanent allowlist guarantee. Treat a lost Codex connection as a failed run, preserving only redacted private evidence.

If evaluating App Server host-defined dynamic tools as an MCP-free boundary, bind every `item/tool/call` to the active trusted thread and turn, exact bare tool name, reviewed schema and main-owned project before reaching the existing transaction service. Validate the bounded response and never echo raw arguments or rollout content into renderer state. A direct owned-only code-mode inventory without MCP is only a single-turn observation; production migration must retain old project threads and pass packaged native edit, Undo, reopen and forbidden-tool tests.

One direct dynamic-tool thread retained its owned tool over App Server restart and exact-thread resume. That result does not authorize unvalidated resume requests or model-selected thread IDs in the product. Keep the main-owned registry and per-turn correlation checks, and test legacy MCP-backed threads separately.

The dynamic adapter rejects unreviewed namespace/name, extra fields, oversized arguments and stale known turns before invoking an app-owned callback. During `turn/start`, require a validated owned `turn/started` notification before any provisional host-call dispatch; reject a completed or contradictory turn and defer renderer projection until RPC reconciliation. Only fixed safe errors or bounded results reach the model; renderer projection omits arguments and results. New packaged conversations use this route after native guarded edit/Undo/reopen proof; existing MCP-backed bindings continue on MCP. Complete effective confinement and safe child inheritance remain open.

The main-owned registry records an exact MCP or dynamic tool route in v2. Treat v1 as MCP, leave it unchanged on read, and reject unknown or conflicting routes without replacing evidence. A dynamic thread must neither project MCP items nor accept an MCP-only process on resume; an MCP thread must reject host calls even when an internal invoker is present. The same new package passed a legacy v1 MCP read without rewriting its binding. A bounded dynamic forbidden-command turn showed no forbidden invocation; this is not complete upstream confinement.

For a stale dynamic edit, require the fixed bounded unsuccessful host response and independent checks of the authoritative draft, complete journal, original, managed source and baseline. A real packaged Luna/high continuation passed this for obsolete sequence/hash after trim/Undo. Never infer that a safe owned-tool rejection proves unrelated upstream tools are unavailable.

For a current model-visible inventory claim, correlate the exact diagnostic turn to its account-contained rollout and verify the `exec` `custom_tool_call` plus matching output; assistant prose is not inventory evidence. On the current source route require nine guarded editor functions and zero connected-app functions; the fresh 2026-09-27 packaged Luna/high probe has since verified the nine-tool source set, zero connected Apps, zero nested V2 child functions, and only the read-only clock helper; this is one bounded turn. V1 models expose five reviewed V1 child functions; GPT-6-Luna declares V2. Its native child functions are direct-only and absent from nested code-mode; the nested surface contains only the read-only clock helper beyond the nine source-defined editor tools. A separate packaged V2 child test verifies direct calls, child lineage, parent-read summary snapshots and unchanged source/baseline/journal. The MCP route exposes no native child functions. The pre-restore seven-tool synthetic baseline and hostile per-app override runs passed the dynamic inventory and guarded split, Undo, reopen and source/baseline integrity checks. This is one pinned-runtime surface observation, not a complete upstream allowlist or proof of every future tool.

The earlier six-tool result is historical. The earlier seven-tool catalog added only bounded `cut.delete_ranges`; the prior eight-tool catalog added `cut.restore_range`. The current nine-tool source catalog also includes bounded read-only `transcript.get_range`, which returns transcript words for one source-time interval without paths or edit authority. Provider conversation history may retain those words and include them in later turns, as the visible Codex/API notices disclose. The fresh 2026-09-27 packaged probe verifies nine names, with complete upstream confinement still unproven. The prior synthetic and private supplied-footage batch edit passed packaged native source/baseline integrity and shared Undo/reopen. These runs do not establish complete upstream-tool confinement.
For packaged Codex threads, inspect configured MCP names through the pinned CLI and explicitly disable every one with a per-server override before App Server starts. Emit one empty `mcp_servers={}` base table before those overrides and the owned server definition; never append a duplicate reset later in the argument list. An empty MCP table is not a clear operation. Verify the exact disabled inventory both process-wide and for the active thread; fail closed if a server connects, exposes tools/resources/templates, disappears, or is added. Disable Apps, plugins and remote plugins on each start/resume request so the authenticated host-owned `codex_apps` server is absent. A packaged signed-out hostile-config fixture now verifies one synthetic enabled server stays disabled and its command never runs. This does not prove a complete or future upstream tool catalog.

Bind the model-visible `project_id` property in each new dynamic tool definition to the main-owned active project using JSON Schema `const`. Keep the active-project check in main even if a caller bypasses or violates that schema. This is not a new authority source and must not replace freshness checks.

For thread/start and thread/resume, derive the supported feature flags from the validated stored route. Preserve MCP-bound thread compatibility by keeping code_mode_only=false, explicitly disabling Code Mode and its host, excluding multi_agent_v1, and disabling native agents. Dynamic Codex may use code mode only with the packaged matching host and in-process fallback disabled; enable depth-1 V1 children only for V1-capable models behind main-owned correlation and read-only summary enforcement. For GPT-6-Luna V2, keep native child functions direct-only outside nested code-mode, limit capacity to the root plus one child, correlate server-owned spawn/activity lineage, and pass only parent-read project/timeline snapshots. Both routes explicitly disable the pinned supported unrelated browser, app, plugin, shell, search, image, memory, hook, remote-control and commit features, plus the default-on `sleep_tool` and `view_image` features. `code_mode_only` alone does not suppress sleep. One bounded native surface pass is not a complete upstream allowlist.

The eighth `cut.restore_range` tool accepts only an exact source-time interval and immutable source identity under the active draft freshness tuple. It must reject ambiguous baselines, overlap, invalid ranges and mixed requests before writing the journal. It grants no path access, source changes, cleanup, export or publication authority; its complete timeline maps and inverse remain in the shared local undo journal.

The manual Edit Restore source range control follows the same boundary: renderer input is a main-validated source ID, exact half-open times and current draft head, never a filesystem path or operation authority. Main resolves the source through the immutable baseline, injects manual origin and generated journal IDs, and rejects overlap, invalid timing, stale heads and non-Edit stage access. Keep source bytes and baseline unchanged through restore, Undo, Redo and reopen.

For pinned Codex 0.155.1, disable `features.deferred_executor` and `features.token_budget` at launch and on both thread routes when the editor does not need environment-wait or context-budget utility tools. Verify exact process/start/resume configuration; these flags narrow the surface without proving a global allowlist.

When native children are enabled, pin the default child model and reasoning to the selected parent pair in both start and resume configuration. Disable the native child route for Astra model IDs. Validate the server-owned child lineage and restrict child authority independently of this model pin.

For pinned Codex 0.155.1, model metadata may enable async user-input functions outside the standard input-tool toggle. The project thread client must reject `item/tool/requestUserInput`, quarantine the thread, reject subsequent notifications, and never project question payloads. Test the quarantine as well as payload redaction. This proves host-side denial, not model-visible unavailability.

For failed Codex turns, expose only the pinned `codexErrorInfo` category through fixed recovery text. Keep raw error messages, additional details, account identifiers, and credential fragments out of the renderer. Treat explicit `unauthorized` as the pinned refresh-token category; do not infer reauthentication from ambiguous HTTP 401/403 connection variants.
