---
name: codex-app-server
description: Integrate real Codex app-server, ChatGPT auth, models, skills, threads, and guarded editing tools.
---

# Codex app-server integration

## Use when

Changing AI login, model selection, skills, threads, streaming, interruption, approvals, or media-edit tools.

## Requirements

- Official Codex app-server for the Codex subscription path; ADRs 0014 and 0015 add separate fixed-endpoint OpenAI API, DeepSeek and Gemini API adapters, never a substitute Codex transport.
- Stdio JSONL transport.
- Initialize handshake before other requests.
- Generate protocol types from the pinned binary.
- Retain exact generation hashes and licensing; normalize imports/formatting reproducibly without changing type shapes. Check nullable/omitted wire fields against the pinned JSON schema rather than assuming TypeScript requiredness is a wire invariant.
- ChatGPT-managed Codex login in the first release, distinct from optional API-provider keys and billing.
- Runtime `model/list` and `skills/list` discovery.
- Codex Settings polls main-owned model, skill, and usage metadata on a bounded cadence while open. Supported account/rate-limit/skill-change notifications trigger immediate refresh. Keep periodic refresh non-generative; it must not start model turns.
- Verify account/logout state in packaged Electron: compare visible plan, model, skills, and usage to the live runtime; invoke Logout explicitly; require signed-out state with no model/usage catalog and confirm it persists after app reopen. This does not prove browser OAuth completion.
- Durable project thread and turn streaming.
- Offer retry only after an authoritative failed terminal turn, as a fresh explicitly user-triggered turn with a new message identity. Never replay interrupted or uncertain requests; reconcile uncertain thread history first.
- Safe restart, resume, interrupt, and rate-limit handling.
- Close must settle startup and process shutdown before reconnecting against the same account directory. Never replay requests whose outcome became uncertain after timeout or disconnection.
- Exercise controller recovery in packaged Electron: identify the exact pinned App Server executable whose parent is the test Electron main, stop only that child, reconnect through Settings, and reopen the same main-owned project thread. Compare thread identity/history and the committed journal, source, and baseline for both idle child loss and loss after a guarded edit commits during a running turn. Require one committed operation and shared Undo after recovery. This does not prove behavior if process loss occurs during transaction persistence; never generalize beyond the observed state.
- Explicit skill input items when a known skill is used.
- Guarded codex-video-edit MCP tools with validated transactions.

Generate the thread/turn/MCP-status closure with the pinned binary's `--experimental`
flag when those methods are consumed. Bind request objects to the generated input types
and validate the security-relevant response fields before projection. Treat the response
`sandbox` as the generated policy object and require `{ type: "readOnly",
networkAccess: false }`; the request-side legacy mode remains `"read-only"`.

The guarded tool layer must resolve its active project and draft in the main process. Tool
arguments contain only bounded edit intent plus exact freshness preconditions; they never
contain project paths, arbitrary operation objects, origin, export, deletion, cleanup,
network, shell, or permission expansion. Read tools return compact editor state. Mutation
tools call the same transaction service as manual and Magic Wand edits, and return the
committed draft sequence and timeline hash. Errors are stable, redacted application errors.

On thread create and resume, append only main-owned validated `project_id` and `schema_version: "1.0"` as JSON read-tool input in developer instructions. For new dynamic-bound threads, also put that project ID in a JSON Schema `const` on each model-visible tool's `project_id` property. Do not inject project paths, titles or a draft snapshot, or ask the user/model to guess the identifier. Test the dynamic schema and create/resume context against the selected project. This constraint is usability defense-in-depth only: the main service must still enforce active-project identity and freshness. Stored dynamic definitions remain with that thread on resume; MCP schemas remain unchanged.

Read project metadata and the active draft in one transaction-store serialization. After every settled mutation, reread and publish the authoritative path-free draft even when journal promotion preceded an uncertain response. Do not derive editor state from model text or MCP activity. Bind project preview requests to draft ID, baseline revision, sequence and timeline hash; map output time to source time only in main, recheck the head after decode, and return no stale pixels.

For the pinned experimental thread protocol, request experimental capability during
initialize and derive one reviewed feature policy from the stored route and runtime model
on both start and resume. Keep MCP-bound threads in the tested no-code-mode/no-native-agent
path. On the dynamic Codex route, enable V1 children only for V1-capable models and V2 only
for models advertising V2. V2 child functions use a custom namespace marked direct-only,
not nested code-mode tools. Set two concurrent threads because the root occupies one slot,
allowing at most one child. Correlate a V2 `spawn_agent` call ID with the server-owned
`subAgentActivity.started` child ID and active child turn. The parent reads path-free
project/timeline summaries and passes only those snapshots to a V2 child because its
per-thread dynamic editor tools are not inherited. Preserve empty child environments,
read-only/no-network policy and approval rejection; if a child host call is observed, main
permits only the two summary reads and rejects every mutation. Disable the confirmed
unrelated default-mode-input, permission,
approval-rule, exec-approval, web-search, MCP-auth/dependency-install, passive
screen-memory, external-agent-memory, persisted-goal, plugin-sharing/suggestion and
API-key-model-discovery capabilities in the process and thread
configuration. Also explicitly disable the pinned default-on `sleep_tool` and `view_image` features in process arguments and thread start/resume; code-mode-only does not suppress every direct tool. Keep the full upstream effective tool catalog as an open gate. Treat
streamed terminal events as authoritative, correlate them to the active thread and turn,
and make retry a new turn with a new request identity. Feature flags or model text alone do
not prove a current child exists or inherited policy. Require a permitted non-Astra model,
a fresh child turn and correlated owned read-tool call before claiming support. Persisted
rollout `response_item` spawn call/output plus `thread/read` child parent/source and
child-owned tool history can establish this even when `thread/turns/list` omits a
collaboration item. Keep raw rollout private; do not invent a separate spawn RPC.

App Server broadcasts child-thread notifications on the parent transport. Filter ordinary events for another validated thread identity before parent buffering/projection; keep malformed identities and forbidden notification methods fail-closed. The parent drawer may show only generic collaboration activity. Verify parent spawn and child read-tool history from the authoritative server privately; do not project child transcript, IDs, arguments or results into the renderer.

Restore recent project-thread history from the bounded inline full-turn page, with one exact newest-first `thread/turns/list` fallback when the inline page is absent. Validate the page, cursors, unique turn/item IDs, count/byte limits, item unions, required supported resume thread status, inline activity agreement, and newest-only in-progress turn before flushing buffered notifications. Treat a separate fallback page as the later authority so completion between resume and list remains valid. Project only redacted user/agent text and generic owned activity in chronological order under fresh renderer IDs. Preserve known completion state, seed every active-turn item for raced notifications, and ignore validated skill paths. Quarantine command/file/web/image/dynamic/foreign-MCP/unknown or approval-waiting history; never expose raw history, cursors, server IDs, paths, arguments, results, or reasoning through IPC.

Track and validate live user-message echoes without emitting a duplicate message or an empty Codex reply; main already owns the submitted user text. Compare live and resumed message projections in native tests. Label owned summary tools Reading the project and trim/undo Applying an edit; activity is not a commit assertion. Verify actual journal origin/sequence, duration, retained source-frame preview and immutable baseline separately, then complete live timing, Stop, reopen/history and undo checks before claiming the full authenticated flow.

Run the MCP child as a packaged fixed-hash resource. It forwards only tool name/input
to a main-owned active-project broker authenticated by a process-only random secret.
Verify the exact server name, version, eight tool names and input schemas, and empty resources/templates
through `mcpServerStatus/list` before opening a project thread. Never put the broker
secret in app-server arguments, thread configuration, project files, renderer state, or
evidence.

For pinned Codex 0.142.3, the exact six owned server tools and empty resources/templates do not establish absence of built-in MCP resource listing/template/read helpers. The upstream turn router and tool planner register those helpers whenever an MCP server exists, independently of empty environments; no supported disabling switch was found in the pinned schema review. Preserve quarantine for unreviewed items, including those helpers under the current policy. Do not invent a configuration key, silently widen parser acceptance, or treat injected project identity as tool confinement. See `docs/research/P2_RUNTIME_POLICY.md` for pinned sources and the observed failure.

A separate direct 0.155.1 App Server probe in `tests/native/codex-dynamic-tools-probe.test.ts` found that a namespaced host-defined dynamic tool can be called without an MCP server, with one owned-only bounded `ALL_TOOLS` inventory. `item/tool/call.params.tool` used the bare function name even though code mode used the namespace-qualified identifier. Treat this as protocol feasibility only. Before routing production project threads through dynamic tools, validate the exact namespace/name mapping, active thread and turn, arguments, response bounds, persisted resume behavior, existing MCP-backed thread compatibility, shared transaction commit/Undo and packaged native behavior. Do not remove the functioning MCP path or claim P2-07 complete from this direct probe.

The separate direct `codex-dynamic-tools-resume.test.ts` passed one exact-thread restart/resume with a second owned host call. The generated resume request has no `dynamicTools` field; the observed definition survived for that fresh thread. Continue to require old MCP-backed thread compatibility, full history, guarded transaction and packaged native checks before production routing.

The host-call adapter uses pinned generated request/response types, maps only the reviewed eight tool schemas into one namespace, binds each new dynamic definition's `project_id` to the main-owned active project, bounds arguments/results, and allows only configured owned calls and redacted stream/history items. A validated owned `turn/started` notification may provisionally correlate a call before the RPC response; buffered activity stays hidden until the response confirms the same ID. Reject missing, completed or contradictory turns. Product main supplies the guarded invoker for new dynamic-route conversations, while old registry bindings retain MCP. Packaged native shared transaction/Undo/reopen passed; continue probing effective upstream-tool confinement.

The direct `codex-dynamic-tools-timing.test.ts` probe passed one Luna/high read-only call after `turn/start` supplied the trusted turn ID using the pinned package's matching code-mode host. A later direct `CodexClient` probe passed one owned read using the actual optional project-client route without MCP; it did not establish early-call timing. Calls before any validated start notification still fail closed. An older binary lacking its host led to no calls in two setup attempts; verify both matching executables before interpreting a no-call result.

The project-thread registry writes route-tagged v2 bindings. Decode every strict v1 binding as MCP without mutating its file on read; only a later serialized write migrates it. A new dynamic thread sends exactly eight reviewed definitions at start, while resume follows the stored route and cannot silently switch an MCP thread. Reject mixed or incompatible process routing before an App Server RPC, and reject cross-route stream items or server calls. Isolated native dynamic edit/Undo/reopen and legacy MCP read passed; keep full tool-boundary acceptance separate.

An isolated packaged Luna/high MCP regression passed trim, same-thread reopen, Codex Undo, interruption and guest-only window inspection. A separate synthetic v1 registry file for that real thread reopened and completed a read-only guarded turn without a write; another product-created binding migrated the file to v2 and preserved its old ID. A second broad edit harness failed a post-turn assertion after a correct trim, so count only the migration observations from it. A later separate dynamic-route package passed guarded trim/Undo/reopen; do not relabel the earlier failed MCP harness.

## Runtime boundary

Codex receives project context and edit tools. It does not receive unrestricted access to the installation, source repository, raw source mutation, project deletion, or export confirmation.

## Validation

- fake transport unit tests
- protocol compatibility tests
- real authenticated smoke test when access exists
- verify a Codex edit changes only the active draft
- verify stop, undo, reconnect, stale transaction, and rate-limit behavior

## Never

Simulate successful Codex output in a production path or hardcode one current model name as the catalog.

Account type alone does not prove managed-token provenance. Restrict the actual login entrypoint and account-directory ownership. Before enabling turns, verify the pinned no-environment/tool policy and route-specific guarded editor boundary. Keep native collaboration disabled for MCP-bound project threads. Dynamic Codex selects V1 or V2 only from live model metadata. V1 children require a correlated server-owned spawn and active child turn before main permits the two summary reads. V2 direct tools stay outside nested code-mode; main correlates `spawn_agent` to `subAgentActivity.started`, reads both summaries in the parent, and passes only those snapshots to one child. A packaged V2 child test verified its parent/source lineage, matching summary report, inherited policy and unchanged source, baseline and journal. Neither child path proves a complete upstream tool catalog. Bootstrap stdio tests cannot replace native sign-in and authenticated reversible-edit evidence.

ADR 0006 records the user's explicit authorization to seed this session's private app-owned guest account with only the official runtime credential file, mode 600. This test setup exception does not change production managed ChatGPT onboarding, add a credential-import feature, permit renderer token input, or authorize copying configuration/history or mounting a host account directory. Never expose credential bytes, account identifiers or private locations. A seeded connected/signed_in probe with runtime model/skill/usage discovery is authenticated discovery evidence, not browser-login completion. Real private-fixture turns, guarded reversible edits, interruption, history reopen, stale rejection, shared undo and native child-policy checks remain separate acceptance tests.

A packaged signed-out test opens the real OpenAI login page in isolated guest-local Chromium and returns to signed out after cancellation. Count that as opener/cancel evidence. A separate packaged Electron test uses the real 0.155.1 App Server callback listener: a wrong state is rejected without finishing the attempt, and a matching `access_denied` callback returns a generic error, leaves the account signed out, redacts the private provider description, and permits retry/cancel. This is negative-path evidence, not a successful browser login. The optional official `chatgptDeviceCode` path uses a fresh App Server login attempt and exposes only the fixed `https://auth.openai.com/codex/device` page and bounded one-time code in the active Settings panel. Main owns the fixed external page action; the renderer cannot supply a destination. Clear the code on cancellation, completion, failure, reconnect and panel close. A separate inspected packaged guest attempt received official completion after the user verified externally, reconciled to signed in, cleared the code, and reopened with authoritative account, plan, model and skill reads. This verifies managed device-code completion in the tested runtime. Successful browser OAuth callback completion remains unverified, and the authorized credential seed must never be counted as proof of either managed route.

## Authorized live operations

Apply authorized reversible active-draft transactions during the turn without repeated material-change confirmation. Magic Wand, Codex and manual edits share undo history. Export preparation may stage settings without confirmation but cannot start final export. Keep source deletion, cleanup, spending, publication and final export under explicit user action; handle native server approvals separately. Test both authorization and forbidden-effect boundaries.

For an API-provider turn, require an explicit user start action because that call may incur provider charges. Once started, validated reversible edits may commit during the turn without repeated per-edit approval. API-provider output is untrusted intent; only main's shared transaction service commits it. Do not infer Codex skills, threads, subagents or subscription usage for another provider. Keep provider model catalogs and capability labels separate. A `/models` listing proves account membership, not Chat Completions or tool compatibility: intersect live IDs with the adapter's reviewed model families, and report an empty supported subset instead of offering base, embedding, audio, or untested reasoning models.

For a remembered API key, save its selected model in the same OS-protected key record and revalidate that ID against fresh provider discovery on restart. A key replacement must clear the previous selection even when the new account offers the same model. Keep session-only model selection in memory only, and migrate older key-only ciphertext without exposing the key. Do not count fake secure-storage tests as native OS-keyring acceptance. The packaged Linux GNOME Secret Service test in `tests/native/api-provider-remembered-model.test.ts` verifies this one backend and live OpenAI catalog only; retain separate evidence gates for other OS backends and providers. A separate session-only DeepSeek run proved one paid guarded edit, not remembered-key behavior.

The synthetic packaged API-provider draft fixture must run OpenAI, DeepSeek and Gemini separately. It may replace `fetch` only inside isolated Electron main after startup; each run must assert its fixed destinations, a synthetic key, the real imported project, committed journal/preview/undo and no external completion. Gemini 3 fixtures must assert exact thought-signature replay within the tool loop and absence from persisted/renderer state. Label visible responses as synthetic and keep authenticated paid-provider edit acceptance separate. API providers do not inherit Codex skills, threads, or native children. Codex MCP-bound threads disable native collaboration; the dynamic Codex subscription route uses bounded native children only for main-validated summary reads. Require authoritative parent/child effective tool specifications and retain the full effective-tool restriction gate for P2-07.

For a live API-key fixture, make the explicit Send through packaged Electron and record only bounded HTTP status classifications in private evidence. A 429 may mean rate or quota; map it to fixed redacted recovery text, require no journal commit unless a validated tool succeeds, and stop paid retries until account state changes. Synthetic 429 injection can verify native error presentation but cannot satisfy authenticated edit acceptance.

Classify generation-time 401/403 as a separate API-connection failure after a key was initially connected. Show fixed key/account-access recovery text without inferring its precise provider cause, preserve the submitted request, and keep raw response material out of the thread. The live fixture harness accepts OpenAI, DeepSeek or Gemini only with that provider's private mode-600 key file; a synthetic 401/403 native pass is not authenticated edit evidence. Gemini 3 live acceptance also requires exact transient thought-signature replay with no signature bytes in evidence. No Gemini key has been supplied.

## Packaged account/settings validation

Resolve only main-owned fixed packaged resources and verify the pinned runtime manifest, binary and licence before connection. Keep the official runtime outside ASAR and out of Git; preserve licensing in private packaged builds. A content hash is not a release signature. Test missing, damaged and redirected resources without launching test fixture bytes.

Managed browser-login URLs stay in main and require exact pinned origin/path and OAuth parameter checks before external launch. Device-code login returns only the exact fixed verification page and bounded code from the official runtime; opening that page is a second main-owned action. Correlate attempt/connection identity; reconcile account state after completion, cancellation and replacement. Cancel incomplete login when the browser cannot open. Never expose raw errors, login URLs, codes or credentials outside the active Settings attempt or in public evidence. Signed-out start/cancel checks do not prove authentication. Require the official completion, reconciled signed-in account and a packaged reopen before claiming the managed route. Isolated tests must never open the user host browser.

Keep Appearance and Codex settings in one modal with one selected section. Persist model/reasoning choices only after runtime validation, distinguish application preferences from later project/turn settings, and show usage only from actual returned limits. Verify native focus, cancellation, reconnect, persistence and failure states before claiming the settings slice works.

A live stale-draft native check must distinguish an MCP tool rejection from an RPC failure: the pinned server records a rejected guarded call as a failed `mcpToolCall` item whose result contains the safe application error. Require that persisted call, the obsolete sequence/hash, unchanged draft/journal/source/baseline, and a completed turn before marking live relay verified. A direct guarded-service call proves only the service boundary.

Do not infer tool-search or v1 spawn non-use from `thread/turns/list`: the pinned `v2/ThreadItem` union omits search items, and rollout policy filters v1 collaboration events while persisting function calls and outputs. For a negative native policy probe, correlate the exact turn ID to a bounded account-confined private rollout and classify all raw response-item call and unknown variants without exposing payloads. This can establish no invocation in that turn, not complete catalog unavailability. Correlate a private parent rollout's completed `spawn_agent` call/output with the child ID, `thread/read` parent/source, child-owned tool history and parent/child turn policy. A missing collaboration item alone proves neither presence nor absence. Never expose raw payloads through renderer IPC or claim a complete model-visible catalog from request flags or model metadata.

The pinned runtime is official Codex 0.155.1 with the matching `codex-code-mode-host` companion. For a fresh ChatGPT account without a saved preference, select `gpt-6-luna` and `high` only when the live runtime catalog offers that exact pair. Preserve a previously saved, still-valid user choice. If Luna/high is unavailable, leave the selection unset and present an actionable Settings message; never invent catalog entries. V1-capable models may use V1 children at depth 1. GPT-6-Luna V2 uses direct-only top-level spawn/wait functions; nested code-mode remains limited to the eight guarded editor tools and the read-only clock helper. The parent validates both summaries and passes only their path-free JSON to one child. Packaged V2 native-child, hostile-app surface and synthetic split/Undo/reopen tests passed; one turn is not a complete effective-tool allowlist. Disable unrelated apps and external tool namespaces. Keep native agents disabled on the MCP route. Do not spawn Astra agents.

New project conversations now use the eight reviewed host-defined tools; existing MCP-bound conversations keep MCP. Resolve the main-owned registry route before opening a project, reconnect with a route-specific App Server client when it changes, and use the exact model-visible names in route-specific developer instructions. Both routes must invoke the same active-project guarded service and committed-draft refresh. The isolated packaged Luna/high synthetic dynamic trim/Undo/reopen and separate legacy v1 MCP read passed; complete upstream effective-tool confinement and safe native-child inheritance remain open.

For live freshness on the host route, inspect an authoritative `dynamicToolCall`, not an MCP item or model assertion. A packaged Luna/high continuation from a real trim/Undo fixture passed one unsuccessful `cut_trim_edge` call with obsolete sequence/hash and the fixed stale-draft result. It preserved the current draft, both journal records and immutable media/baseline. Keep this separate from complete effective-tool confinement.

The route-aware native split fixture can require `--require-dynamic --probe-surface --require-luna` to check the model-visible code-mode inventory and a guarded split in one packaged turn. On a V1 model, require eight guarded editor functions plus five supported V1 collaboration functions, with no connected-app tools. For GPT-6-Luna V2, require eight editor functions, zero nested child functions, and only the read-only `clock__curr_time` helper; verify the direct V2 spawn/wait functions separately in a packaged native-child fixture. Confirm the exact nested turn by matching its `exec` `custom_tool_call` and correlated output in the bounded, account-contained private rollout. Do not treat the assistant's final text as authoritative inventory evidence. The synthetic baseline and hostile `apps._default.enabled=true` plus `apps.adobe.enabled=true` profile passed, including committed split/Undo/reopen. This is bounded to one pinned-runtime turn, not a permanent complete upstream-tool allowlist.

The current tool catalog has eight names, including bounded source-time restore. GPT-6-Luna uses the guarded V2 native child route; V1 children remain available only on V1-capable models. V2 functions are direct-only top-level tools and stay out of nested code-mode. The parent reads path-free project/timeline summaries and passes only those snapshots to one V2 child because per-thread dynamic editor tools are not inherited. `cut.delete_ranges` / `codex_video_edit__cut_delete_ranges` takes 2–16 confirmed disjoint half-open output ranges in descending start order, one exact draft head, and one spoken-cut pass group. The main-owned shared reducer commits them atomically with one Undo; it never infers filler or certifies speech joins. The native `codex-range-cut.test.ts --batch` flow passed on synthetic and private supplied footage in packaged Electron, including committed preview, manual Undo, reopen and immutable inputs. The older six-tool inventory is historical; rerun the inventory against eight for any current claim.

The current public-main `ThreadStartParams` also includes an experimental named `permissions` profile, but that profile is not a model-visible tool-name allowlist; the inspected request declares no general `allowed_tools` field. The current App Server README says `disabledPluginIds` does not filter plugin capabilities. Treat these as unpinned source observations and keep complete effective-tool confinement open until a version-pinned enforcement boundary and packaged evidence exist.

Before spawning App Server on the 0.155.1 route, enumerate configured MCP servers with the pinned CLI's `codex mcp list --json`. Apply an explicit `mcp_servers.<name>.enabled=false` override to every discovered name and verify the same complete list is disabled. Do not assume `mcp_servers={}` clears user entries; upstream merges empty tables. Validate `mcpServerStatus/list` against this inventory before opening the project thread and again scoped to the active thread before allowing a turn. Require every external server to stay disabled with zero tools/resources/templates; reject changed inventory, malformed names, or an owned-name collision. Put `features.apps=false`, `features.plugins=false`, and `features.remote_plugin=false` on both `thread/start` and `thread/resume`; process-only settings did not suppress authenticated host-owned Apps. A packaged synthetic hostile-config native child test passed this bounded boundary. Keep the claim limited to that tested runtime, and leave complete built-in-tool confinement open.

Thread feature flags are selected from the persisted route on both start and resume. MCP must keep code_mode_only false, omit dynamic-only code-mode enable fields, exclude multi_agent_v1 and multi_agent_v2, and disable native agents. Dynamic Codex may enable code mode and the packaged host only with in-process fallback disabled; V1-capable models may use the supported V1 child path at depth 1 with main-owned spawn/turn correlation and read-only summaries. GPT-6-Luna uses V2 direct-only child functions, correlates spawn IDs through server-owned subAgentActivity, and passes only parent-read project/timeline snapshots to one child. Set supported unrelated browser, app, connector, plugin, shell, search, image, memory, hook, remote-control and commit features false on both routes. Also disable request-permission and rule tools, MCP OAuth elicitation and dependency installation, API-key model discovery, passive Chronicle screen memory, external-agent memory import, persisted goals, and plugin suggestions. Do not disable the supported v1 child route as a blanket response to an incomplete upstream catalog. Exact protocol/runtime tests and a packaged synthetic dynamic split fixture passed. These flags and the tested inventory do not establish a complete effective upstream tool catalog.

For guarded `cut.restore_range`, bind one user-confirmed missing half-open interval to the exact active `source_id`, `source_start_us`, and `source_end_us`. Resolve it against exactly one immutable baseline source clip; reject unknown or ambiguous identity, invalid bounds, visible overlap, stale head and any mixed-operation request before persistence. Insert by original source order and source-time position, persist complete before/after maps and the hash-bound inverse, and refresh from committed state. The Codex and API-provider adapters share the same transaction and Undo history; restoration never mutates or deletes source media.

For the pinned Codex 0.155.1 editor route, disable `features.deferred_executor` and `features.token_budget` at launch and on both start/resume configs when environment-wait and context-budget tools are not used. Assert those exact keys in process and protocol tests. Do not infer a complete effective tool allowlist from the resulting narrower surface.

For dynamic V1 and V2 child routes, pin `agents.default_subagent_model` and `default_subagent_reasoning_effort` to the selected parent model and effort on start/resume. Suppress native child protocols for Astra model IDs. This avoids a server-default child model drifting from the user's selected model; child lineage and read-only checks remain required.

Pinned 0.155.1 may register asynchronous user-input functions from model metadata separately from the standard user-input setting. Treat the resulting `item/tool/requestUserInput` server request as unsupported, quarantine the thread, reject subsequent notifications, and keep question content out of renderer events. Test both payload non-projection and that the quarantined client cannot resume event projection. Do not claim this means the function was absent from the upstream model-visible catalog.

When restoring a project thread, derive the user-facing terminal state from the newest validated history turn. Restore Retry only when that turn is server-confirmed `failed` and its valid saved user request remains in the bounded projected history; completed, interrupted, active, and truncated-request histories stay non-retryable. The UI retry must send the saved request as a fresh turn and never auto-replay it during resume.

For failed turns, project only the pinned `turn.error.codexErrorInfo` category. Map `unauthorized`, explicit rate/usage-limit categories, and service categories to fixed user recovery text; never forward `message` or `additionalDetails`. Do not infer authentication failure from an ambiguous HTTP 401/403 connection code.

For pinned Codex 0.155.1, verify process and start/resume feature gates against the exact packaged `codex features list`. Disable unused default-on browser/CDP, computer-use, shell-snapshot, interactive TTY, workspace-dependency, guardian-approval, and in-app utility surfaces. If the packaged feature list keeps a requested toggle true, remove that claim and record the unresolved boundary. Feature gates are not a global model-visible tool allowlist.

When building CLI arguments, pair every `-c` with exactly one following config expression. Tests must assert there is no dangling or consecutive `-c` anywhere in the argument list and check adjacency for every feature override, not just the presence of value strings. Rebuild the packaged Electron app and run the real stdio bootstrap regression after changing App Server arguments.
