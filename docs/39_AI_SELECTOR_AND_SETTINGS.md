# AI selector and provider settings

## Latest user requirement, 2026-10-04

ADR 0018 adds supported Claude account sign-in as the default AI connection. This is unimplemented and expands the open P2 scope. The next Claude implementer independently selects a supported authentication/runtime/model and integration strategy; prior Codex-specific designs below apply to the retained Codex route, not automatically to Claude. Update the detailed contracts/tests with the chosen implementation and preserve existing user data/provider behavior.

## First release

The AI settings area offers Codex with ChatGPT sign-in plus explicit OpenAI API, DeepSeek and Gemini API key connections under ADRs 0014 and 0015. Do not show fake providers, disabled marketing cards or an arbitrary provider marketplace. Packaged isolated native tests cover disconnected API settings, key rejection, authenticated OpenAI API model discovery/selection with session-only restart, protected remembered-model restoration, and separate synthetic-transport OpenAI, DeepSeek and Gemini drawer edit/undo flows. Gemini's synthetic turn also checks transient thought-signature replay. No successful paid provider edit or authenticated DeepSeek/Gemini key has been tested.

## Provider row

For Codex show:

- Codex
- signed-in account state
- ChatGPT plan when returned by the current protocol
- connection state
- Sign in, Sign out, or Reconnect

Reconnect is shown when the Codex connection is unavailable or has an actionable connection error. It starts a new main-owned app-server session and preserves the selected account/model preference; opening the project conversation afterward resumes its main-owned thread binding. Packaged authenticated tests cover idle child loss and loss after a guarded edit committed during an active turn, with one journal entry and shared Undo after recovery. The tests do not cover loss during transaction persistence.

For each supported API provider, show only a main-owned key connect/replace/remove action, connection state, live-validated model choice and clear separate API-billing label. Do not imply a ChatGPT subscription covers API usage or display guessed prices/credit. The key must never return to renderer state; persist it only with OS-backed protection, or use a clearly session-only fallback. A model choice saved with a remembered key must be revalidated against that provider's live catalog after restart; replacing or removing the key clears the choice.

## Model selector

Populate Codex from the current app-server model catalog and each API provider from its supported live model discovery. For a ChatGPT account with no saved Codex choice, prefer the live-listed `gpt-6-luna` model with `high` reasoning. Preserve a valid explicit saved choice. If GPT-6-Luna/high is not offered, leave the default empty and show an actionable Settings message; if another metadata refresh also fails, keep both the model-selection guidance and reconnect recovery visible. Never substitute a model silently or make Luna the only selectable model. The model-list endpoint is account membership, not an endpoint-capability declaration: intersect OpenAI IDs with the reviewed GPT-4.1/GPT-4o text Chat Completions families, DeepSeek IDs with its reviewed chat/V4 names, and Gemini IDs with reviewed stable text/function models. Show an actionable error when no supported model remains. Show friendly labels and reasoning choices only where that provider returns them. Validate the choice against its own provider catalog; report unavailable discovery rather than fabricate choices. Save a project default and allow a per-turn override when supported.

While Codex Settings is open, main revalidates live model, skill, and usage metadata on a bounded cadence and refreshes immediately on supported account, rate-limit, or skill-change notifications. This allows a changed local skill to appear without restarting the app.

## Skills

Skills are not a user-facing plugin marketplace. Use the label Available skills for the compact discovered list. It may include bundled runtime guides as well as project guides; discovery does not establish that every referenced tool is exposed by the editor. Refresh when the app-server reports skill changes.

## Usage and limits

Show a simple remaining-usage or rate-limit state only when the protocol supplies it. Never estimate subscription allowance from guesses.

If an explicitly started API turn receives HTTP 429, show a fixed rate-or-quota message in its conversation and direct the user to check that provider's API account before retrying. Do not infer the account's balance, reset time or billing state from the status alone.

If that turn receives HTTP 401/403 after a previously successful connection, show a separate fixed message to check the key and API-account access in Settings. Keep the request for review and do not imply an edit committed. In the editor, bound the chosen drawer and let its conversation scroll so the composer and any recovery message remain visible at common desktop sizes.

## Context disclosure

Before first use, explain which selected provider may receive project instructions, transcript excerpts, timeline state, requested preview frames and local tool results. Do not send full raw recordings by default. Require an explicit start action for any paid API turn.

## Failure states

- signed out
- app-server unavailable
- unsupported protocol version
- no compatible model
- rate limited
- turn interrupted
- tool validation failed
- API key unavailable or rejected; secure storage unavailable with session-only fallback
- provider model discovery unavailable or provider request failed
- remembered model choice could not be saved; keep the previous selection and offer retry

Each state has a direct recovery action and preserves the project draft.

## Current P2 implementation and acceptance boundary

Settings offers browser sign-in and a compact Sign in from another device action. The latter starts the official ChatGPT device-code flow, shows the fixed verification page and one-time code for that attempt, and clears them on cancellation, success, failure, reconnect or closing Settings. Clicking the page link asks main to open only that fixed destination; the renderer cannot navigate or choose a URL. The user can instead open the displayed page on their own device and enter the code. A packaged isolated native run proved real initiation, page opening and cancellation, with guest-only visual inspection. In a separate live attempt, the user completed verification externally; the same native app reconciled to signed in and cleared the code, and a packaged reopen recovered the signed-in plan, live models and skills. Browser OAuth callback completion is a distinct unverified path.

Settings now includes Codex beside Appearance and one API providers section that selects OpenAI API, DeepSeek or Gemini API. Main resolves the fixed packaged Codex runtime, owns its dedicated account/context directories, validates browser-login URLs and exposes only bounded account/settings replies through typed IPC. Sign in, Cancel sign-in, Sign out and Reconnect use the real Codex client. API keys enter through typed main-owned provider IPC, never as Codex login or renderer-returned state. Browser sign-in opens externally from main; it does not replace packaged renderer content. Automated browser opening and native app tests must remain inside the isolated guest.

The signed-in packaged Settings test checks that Logout reconciles to a connected but signed-out account state, hides model and usage data, exposes sign-in actions, and remains signed out after the app is reopened. This is account/logout coverage; it does not establish successful browser OAuth callback completion. The separate official device-code route has a successful completion and signed-in reopen pass.

The Codex model and reasoning selection is currently an application preference saved immediately after an explicit change, validated against the active runtime catalog. A fresh preference uses the live-validated Luna/high default without writing an artificial saved choice. The official `0.142.3` runtime offered only `gpt-5.5` to the isolated test account, so that package displayed the unavailable message. An official `0.155.1` read-only probe offered Luna/high, and a fresh-account packaged Electron Settings run selected it across restart. A later packaged Luna/high synthetic split and a separate private two-source edit passed committed preview, shared Undo, reopen and immutable-source checks; the current restricted tool-surface rerun is recorded separately. An API-provider choice stays in memory for a session-only key; for a remembered key it is stored inside the OS-protected key record and restored only if the live catalog still offers that model. Legacy saved keys without a model remain usable and prompt for selection. None of the API-provider paths has a project default or per-turn override yet. Remaining usage comes from returned Codex windows, with supplied reset times; absent data is not estimated. Skills appear in Advanced within the selected Codex section. Errors offer recovery without exposing raw protocol, email, URLs, codes or account paths. A separate packaged Linux guest with real GNOME Secret Service passed remembered OpenAI model selection, live-catalog reopen, empty key field, protected file inspection and explicit removal. Authenticated DeepSeek/Gemini discovery and successful paid provider editing remain untested.

Packaged Linux signed-out connection, login initiation/cancellation, reopen and scale checks passed with guest-only visual inspection; that test suppressed external browser launching. A separate browser-equipped isolated guest then opened the real OpenAI login page from packaged Electron's Settings sign-in action. Guest-only visual inspection showed Chromium in front of the native editor; cancellation restored signed out and the test-owned browser exited. A later device-code attempt completed through the official runtime and reconciled to signed in in the native app; a packaged reopen confirmed the account and live catalogs. The project view now includes the path-free Codex drawer and typed open/send/interrupt IPC. Production wiring preserves the runtime model identity, durable project thread, bounded redacted recent history, streaming, interruption, compact activity, and idle unsubscribe. A restored newest in-progress turn reopens as running and remains interruptible; forbidden or contradictory history fails closed before the drawer opens. The fixed developer instruction requires current project/timeline summaries and committed tool results before claiming edits. After any bounded Codex trim, split, range cut or undo settles, main rereads the committed draft and sends its exact head and timeline to the renderer; uncertain postcommit outcomes receive the same refresh without being replayed. The preview requests frames against that head and discards stale decode results. A private signed-in packaged Settings run matched the actual returned ChatGPT plan, runtime model choice, usage window/reset time and discovered skills across restart, with guest-only visual input. Earlier authenticated fixture turns also passed bounded trim/undo, history reopen and Stop. Browser OAuth callback completion remains unverified; the authorized private credential seed and browser opener are not evidence of that path. Selecting a model never fabricates an edit preview.
