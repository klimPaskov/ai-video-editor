# Native app architecture

## Chosen shell

Use Electron for the first release. It provides a desktop window, access to display and media capture, a mature packaging path, and direct Playwright Electron automation. The shipped product is a standalone desktop app even though the renderer uses packaged web technology internally.

## Process model

ADR 0012 brings a minimum actual product shell into P0-04/P0-06 so native media acceptance has a product to exercise. `apps/desktop` owns packaged local content, main/preload isolation and validated task-based IPC; `packages/domain` and `packages/media-engine` own the bounded media-library contract and ingestion/frame adapter. The append-only library retains source bytes and probe metadata locally and is distinct from project storage, drafts, and revisions. This bootstrap does not complete the architecture below.

Its frame path transports native-dimension BGRA full-range GBR BT.709 SDR samples without resampling or lossy proxies, within explicit dimensions/payload bounds. A second, narrow display-only path decodes tagged 8-bit H.264 YUV 4:2:0 limited-range BT.709 at native dimensions through an explicit BT.709-to-BGRA conversion. The latter changes the display samples and does not feed canonical rendering or master export. Source seeks use a verified presentation-PTS index, including variable-cadence gaps, rather than deriving frame position from the average rate. Unknown tags, higher precision/HDR, display transforms, and non-square pixels remain preview unavailable; import still preserves their bytes. Frame inspection and seek are not smooth playback, audio review, a complete multi-source timeline, or an export/compositor path; those remain later acceptance work.

ADR 0013 moves the minimum real project foundation into P1: stable project identity, immutable source references, a source-matched initial canonical timeline, a real baseline revision, create/open/reopen, and persisted active stage. Main owns this state behind validated task-based IPC. Five-stage navigation selects a workspace view only after persistence succeeds; it does not mutate media operations or claim stage completion. The renderer must retain the committed project/draft context while changing stage presentation.

The partial P3 two-source extension adds a versioned initial baseline with two ordered immutable sources, measured presentation-end evidence and two adjacent clips. Main verifies both source hashes and probes on reopen, dispatches frame reads to the active clip, and exposes only path-free source summaries through a typed `projects:create-two` task. The same draft journal reflows later fragments after a trim, inserts a new boundary after a split without changing duration, ripples surviving fragments after a marked range cut, and restores the prior map through undo. A split keeps the left fragment's clip ID and derives the new right ID from a trusted operation. A cut may cross a fragment/source join or omit a source's entire visible span; it retains both immutable sources in the project inventory and baseline. It does not join or delete source files on disk or provide synchronized A/V playback or master rendering.

P2 adds the common draft transaction core needed for authenticated edits: sequence validation, durable journal, atomic persistence, inverse/undo and committed-transaction recovery. This core is shared by manual, Magic Wand, Codex and API-provider actions. It must not become a second AI-only state store. P3/P6 still complete their full project, playback, editor, history and recovery requirements; implementing prerequisites earlier does not waive their acceptance.

The partial native Edit controls send only a strict draft head and bounded trim, interior split or half-open output-time range intent through typed IPC. `projects:manual-range-cut` carries the two marked microsecond boundaries; it cannot carry a trusted origin or source path. Main binds each request to the active project, assigns the manual origin and generated operation identity, commits through the same journal as assistant tools, and returns a path-free committed head with fragment boundaries. The range reducer rejects empty, reversed, out-of-bounds and whole-draft cuts, preserves surviving source spans, reflows the output timeline and stores an exact inverse. Undo targets the current newest transaction. Neither renderer nor model input can supply a trusted origin, a new fragment ID, or write project files directly.

### Electron main process

Owns:

- application lifecycle and windows
- safe file dialogs
- project locks and privileged filesystem access
- capture permissions and source selection
- child processes for Codex, FFmpeg, ffprobe, and transcription
- fixed-endpoint OpenAI API, DeepSeek and Gemini API network adapters, key storage and request redaction
- typed IPC validation
- installer and update integration

### Sandboxed renderer

Owns:

- visual interface
- timeline interaction
- preview player
- transcript editing
- tool panels
- user-facing Codex activity

The renderer loads only packaged local assets. Disable Node integration. Enable context isolation, renderer sandboxing, CSP, navigation blocking, and window-creation blocking.

### Preload bridge

Expose small task-based methods. Never expose raw `ipcRenderer`, filesystem, process, shell, or unrestricted command execution.

### Media services

Use typed service boundaries around FFmpeg, ffprobe, local transcription, thumbnail generation, waveform generation, rendering, and QA. Every process call uses argument arrays, timeouts, cancellation, bounded output, stable errors, and redaction.

The first local transcription path runs only after an explicit Auto Edit action. Main verifies project sources and runs FFmpeg against immutable managed media to create a private analysis-only 16 kHz mono float32 proxy. The pinned Apache-2.0 Whisper model weights are downloaded into app userData, size/hash checked, and loaded by an isolated worker with a reduced environment. The worker receives only a proxy path and path-free job identity, then returns bounded word timing. Main stores transcript and silence evidence separately from project baselines and drafts. No user audio is sent over the network; the only network use in this path is fetching the fixed model assets. Proxies are temporary and never feed preview or master rendering.

Manual transcript correction is a `transcript_edit` operation in the same hash-chained draft transaction as timeline changes. It records the source/transcript/word identity, original wording, corrected text and inverse in private draft metadata. The project view overlays the correction on the local transcript; the ASR source record, media bytes and audio samples stay unchanged. Shared Undo/Redo and journal replay apply to that text operation; correction cannot resynthesize speech or imply a cut. A separate `transcript_cut` operation accepts a head-bound, ordered word range from the unchanged local transcript, maps its exact source times to one continuous currently visible clip, and records a ripple delete with transcript evidence in the same journal. Undo/Redo and reopen apply to the cut, but the explicit structural action does not assess meaning, verify audible joins, or render synchronized A/V.

### Codex bridge

The main process owns a long-running official `codex app-server` child over stdio. A typed adapter handles JSONL framing, request IDs, notifications, server requests, reconnect, version discovery, and schema generation.

### API-provider adapters

Separate main-owned OpenAI API, DeepSeek and Gemini API adapters use reviewed fixed HTTPS endpoints and provider-specific catalog/turn contracts. Key material is protected by OS-backed per-user storage or kept in session memory; it never enters project data or the renderer. A remembered model ID is encrypted in the same per-user key record, bound to that credential, and checked again against live model discovery after restart. Session-only choices remain in memory. Gemini function-call thought signatures are bounded, validated and replayed only in the active main-process turn; they never enter persisted conversations or IPC. Generated edit intent is validated through the same transaction service as Codex, Magic Wand and manual actions. A generic API adapter does not acquire Codex App Server threads, skills, native subagents or MCP authority by analogy.

The main-owned adapter classifies later generation-time HTTP 401/403 separately from rate/quota failure, and the conversation service publishes only fixed recovery text through the strict typed view. The drawer bounds its conversation scroll independently of the preview and keeps the selected provider's Send controls and alert readable at common window sizes. These failures never grant direct project-file access or bypass committed transaction checks.

### App-specific MCP server

Expose only validated AI Video Editor project operations. Runtime Codex does not receive unrestricted access to the app installation or source repository.

## Product identity compatibility

ADR 0017 sets the visible product name to AI Video Editor and the package/executable/local URL-scheme slug to `ai-video-editor`. Main chooses a prior per-user data directory when it exists, and otherwise creates the new-slug directory before readiness. It does not copy, merge or delete private projects during startup. The owned MCP server and dynamic-tool wire identities stay stable so stored Codex threads can reopen. The packaged native identity fixture is designed to check import and restart in both new and existing stores, with exact synthetic preview pixels and unchanged source/baseline data. That fixture has not yet been run for the identity slice.

## Suggested repository layout

```text
apps/desktop/              Electron main, preload, renderer
packages/domain/           project and timeline models
packages/project-store/    autosave, revisions, migrations
packages/media-engine/     FFmpeg and transcription adapters
packages/recorder/         capture and synchronization
packages/codex-bridge/     app-server client and MCP tools
packages/editor/           operations, history, snapping
packages/ui/               design system and screens
packages/test-fixtures/    deterministic media and fake devices
docs/schemas/                   versioned contracts
.agents/skills/                    Codex and implementation skills
.codex/agents/                 bounded agent prompts
docs/                      product and engineering specs
```

## P1 project shell implementation

`packages/project-store` now implements the ADR 0013 prerequisite behind Electron main. Creation consumes a verified library source, publishes a project folder with an immutable baseline and separate mutable navigation metadata, and returns an actual committed project. Open/list/navigation revalidate references, source hashes and the complete reprobed stream/format metadata. Source library entries remain independently identifiable media.

The renderer receives a path-free `ProjectView`: project identity/name/stage, resolving baseline revision ID, source summary, current draft ID/sequence/hash/undo identity, and committed timeline identity/duration/rational frame rate. One root-queue transaction-store read returns validated project and draft state together, so navigation and edit commits cannot create a torn view. Strict project list/create/open/navigate IPC uses the existing trusted-sender boundary. Runtime source paths and full probe data never cross preload.

Project preview uses a separate head-bound IPC request. The renderer supplies the active project, draft, baseline, sequence and timeline hash plus output time; main resolves the committed fragment at that position and maps output time to immutable source time. Main verifies the same head again after decode and returns pixels only while it still matches. A changed head returns its validated path-free draft view without pixels, letting the renderer clamp the playhead and request the current frame. Direct Source library preview remains source-time inspection.

The renderer separates Projects from Source library, creates a project after successful import, and offers Create project for existing sources. Five-stage controls persist before their selected state changes; stale responses cannot reopen a screen after Home or overwrite a newer selection. Stage changes retain the preview position and current source. Headless and current packaged native tests passed, including all five stages, immutable baseline/source checks, failed-save preservation, reopen and security/focus at 100/125/150/200%. Guest-only native visual review also passed. It does not complete P1 or implement later stage features.

## Startup and renderer failure handling

Preflight nonempty packaged HTML, JavaScript, CSS and preload before creating the product window; serve the verified local renderer bytes from main memory. Missing required assets produce an actionable native error and a nonzero exit after dismissal. Production content still uses the restricted custom protocol, sandbox and IPC sender checks.

Apply the latest committed interface scale after loading and the first render, before showing the window, including an explicit 100% fallback when preferences cannot be read. Chromium's persisted origin zoom is not authoritative. Preserve unreadable preference bytes and report the load failure.

An unexpected renderer loss cancels pending media work and offers one explicit Reopen window or Close app choice. Reopen loads saved project state with the same security boundaries and never promises unsaved work survived. A second failure closes through an actionable native dialog; failure during recovery ends the attempt without reopening a shutdown dialog. These behaviors require packaged lifecycle tests and actual guest dialog inspection before phase acceptance.

## Version policy

Research and pin compatible stable versions at P0. Do not encode an unverified version in the product spec. Regenerate Codex protocol types from the installed official binary and record its version.

## Claude connection

`packages/claude-bridge` resolves the user's Claude Code CLI, builds the restricted child environment, parses `auth status`, reads the live catalog through one `initialize` control request, runs `auth login --claudeai`, and projects one headless stream-json turn while enforcing the init tool inventory. `apps/desktop/src/claude.ts` owns sign-in state, the remembered model, per-project conversations and the per-turn MCP config. A second `CodexMcpBroker` instance with its own token serves the packaged editor MCP script to Claude, and its tool service attributes transactions to the `claude` origin. See `docs/48_CLAUDE_CONNECTION.md`.
