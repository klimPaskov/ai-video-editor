# Screen specifications

The P0 bootstrap in ADR 0012 implements only an actual Home import/library surface and bounded per-frame inspection/seek. Library entries are imported media, not recent projects or draft timelines. Show real import, cancel, selection and seek controls; report unavailable preview for unverified color/precision inputs. Do not display nonfunctional recording, project, Codex, edit, playback or export actions to imitate the complete screens below. P0 bootstrap and P1 shell acceptance are recorded in their phase results; later phases retain their complete screen and accessibility requirements.

The subsequent P1 project prerequisite now adds actual project create/open/reopen and five-stage navigation to the bootstrap. Home lists Projects and Source library separately, and retained source entries have a working Create project action. Successful import creates an actual project with a baseline revision. Stage selection saves through main before changing the active control, retains source/frame position, and preserves prior state on failure. P1 is accepted in `docs/workflow/results/P1.json`, including packaged native tests and guest-only visual inspection. Later editing, capture and export controls remain separate implementation work. The complete screen requirements below remain authoritative.

## S01: onboarding

Before ordinary screens, missing required packaged files show a native error with reinstall guidance and Close app. An unexpected renderer failure offers one Reopen window or Close app choice; another failure requires closing. Reopen means loading persisted work, not guaranteeing recovery of unsaved changes. Unreadable interface settings retain their bytes, use 100% presentation and report the failure. These native failure paths are part of P1 lifecycle acceptance and do not expose technical diagnostics in the renderer.

Purpose: establish local readiness and real Codex sign-in.

Visible:

- product mark
- Sign in with ChatGPT
- setup action only if a required dependency is missing
- short context disclosure
- Continue

Hidden under Details: exact versions, paths, protocol events, logs, and repair commands.

## S02: home

Visible:

- New recording
- Import video
- Open project
- recent project thumbnails, names, and modified times
- small Settings and Help actions

No editor tools or empty project panels appear.

The current P1 slice adds Settings to the working import/library Home. Keyboard source selection opens frame inspection with focus on Back; Back returns focus to the selected source card. Source information opens one inspector with actual imported metadata. The accepted P1 shell also lists actual projects separately and implements persisted five-stage navigation; visiting a stage does not execute its later editing or export workflow.

The partial P3 two-source path offers Add footage on an unedited single-source project in Record or Import. The action uses the native picker, shows import/project progress, retains a successfully imported source if project creation fails, and opens the new combined project after commit. Home identifies the source count. Source details shows both ordered parts in one inspector; seeking across their join updates the native preview from committed clip mapping. The original project remains available. This is an import/preview affordance, not a continuous playback or export control.

## S03: capture setup

Visible:

- screen, window, or region picker
- microphone picker
- system audio toggle
- camera toggle and picker
- live camera preview only when enabled
- aspect ratio
- optional scene and teleprompter entry
- countdown and Start recording

Advanced camera and audio settings are collapsed.

## S04: recording

Visible:

- selected screen or window preview
- elapsed time
- pause, resume, and stop
- current scene and teleprompter
- microphone, system audio, and camera state

No editor or diagnostics chrome is visible during capture.

## S05: take review

Visible:

- recorded take preview
- Confirm take
- Try again
- previous takes
- source health and sync warning only when needed

Confirming the take adds it to the automatic timeline. Previous takes remain recoverable.

## S06: import and processing

Visible:

- selected file or take set
- one progress surface
- plain labels for reading media, preparing preview, transcribing, and analyzing
- Cancel safely

Do not show raw FFmpeg, transcription, or protocol logs.

## S07: Auto Edit

The later editorial flow follows docs/47_EDITORIAL_FIRST_CUT.md. Show meaningful current pass progress and actionable unresolved directions from real persisted work, with separate spoken-cut, layout and zoom undo groups. Do not turn the detailed QA requirements into persistent dashboards or extra panels. The configured cue and protected scope belong to relevant project/edit settings.

Visible:

- video preview
- Magic Wand as the main action
- preset menu and simple feature switches
- optional natural-language instruction
- concise live activity
- Stop and Undo

## S08: editor (Edit stage)

Visible:

- large preview
- compact tool rail
- simple timeline with non-empty tracks only
- transcript mode
- one inspector
- collapsible Codex drawer

Direct canvas handles appear for the selected zoom, camera, or B-roll item.

The current P2 conversation slice implements the compact Codex drawer beside the existing project preview. Opening it closes the source inspector so only one panel is visible. It renders only projected user/Codex text, generic work/subagent/edit activity, Stop while a turn runs, and an actionable failure or uncertainty. Reopening restores the bounded redacted recent history of the real project thread before live notifications; an authoritative newest in-progress turn remains running and interruptible. It requires a real selected project and signed-in runtime selection, contains no sample messages, never exposes server item identities or pagination cursors, and updates from the authoritative thread view returned through typed IPC. Leaving a project performs an idle unsubscribe and refuses while a turn is active.

The project preview shows current and total output time. Its frame and seek bounds come from the current committed draft head. A committed trim, split, cut or restore refreshes the ordered fragment map, remaps output time through retained immutable sources, and discards stale decoded pixels; split preserves total duration while cut and restore change it according to their interval. The Edit stage offers compact Trim start, Trim end, Split, Mark in, Mark out, Cut range, Restore source range, Clear, Undo and Redo actions around the preview. Trim and Split require an interior playhead position and are disabled at boundaries or during a pending save. Marks are output-time microseconds bound to the exact draft head; a changed head invalidates them so a later cut cannot use stale positions. Cut range needs a valid nonempty, non-whole-draft `[in, out)` interval and may cross a fragment or source join. It ripples remaining fragments while keeping all imported sources available in Source details. Restore source range accepts one exact missing half-open interval in a selected immutable source; main rejects visible overlap and reflows the remaining map. It does not infer missing content. Save failure stays actionable, and shared-history Undo may reverse a manual or assistant edit; Redo reapplies the latest undone transaction through the journal. Source library inspection remains clearly labelled as source position. Tagged 8-bit H.264/BT.709 imports can show converted display frames at native dimensions, with source seek positions resolved against presentation PTS instead of average frame rate. The two-source path crosses its join, but remains still-frame inspection without audio playback or master rendering.

## S09: revision compare (Review stage)

Visible:

- prior revision and current draft
- linked playhead
- changed-range list
- Keep current
- Restore prior as a new draft
- Continue editing

## S10: review and quality summary (Review stage; internal screen `qa`)

The current Review shell offers one **Check draft integrity** action. Main re-reads the committed project, draft journal and managed-source measurements, then returns the validated draft head. If the current head ends in a main-owned manual edit group, the same explicit action may record a structural-only checkpoint with evidence derived from the validated reads. AI-origin groups cannot use that checkpoint path. The success message is limited to structure and managed-source integrity; it does not assess spoken meaning, rendered joins, playback, or whole-result review. A changed draft invalidates the displayed result. This check does not create an editorial pass checkpoint or enable export. The action and result hide while the Source inspector or Codex drawer is open, preserving the single-panel rule.

The full editorial report exposes measured changes, unresolved cues and selective graphics suggestions at final-cut times. Each suggestion contains its complete prompt and remains distinct from an imported asset; viewing it never triggers generation or export. Keep this in the selected review surface or Codex drawer, respecting the single-panel rule. A pass checkpoint does not certify whole-result review.

The remaining bullets below are target screen requirements. Only Check draft integrity is currently implemented in Review.

Visible:

- actionable warnings or blockers, otherwise one enabled Continue action
- short issue list with jump-to-time
- Fix with Magic Wand when supported
- full-draft watch-through and jump-to-time playback
- Return to Edit and Continue to Export actions

Technical evidence opens only from Details.

## S11: export

Visible:

- file name and destination
- Lossless master by default, Smaller file only by explicit choice
- captions and sidecar choices
- Export
- cancellable progress after export begins

Advanced codec settings are collapsed.

## S12: export complete

Visible:

- final thumbnail
- filename and Open folder action, with path and technical verification under Details
- Open video
- Open folder
- Return to project

## S13: settings

Sections:

- AI providers: Codex account, optional OpenAI API, DeepSeek and Gemini API keys, and provider-validated models
- recording devices and shortcuts
- project and cache locations
- default captions and export
- privacy
- diagnostics

Only one settings section opens at a time. Codex and the API providers section (with OpenAI API, DeepSeek and Gemini API choices) are implemented; packaged tests cover the disconnected/rejected-key state, authenticated OpenAI and DeepSeek model discovery, and protected remembered-model restoration with real GNOME Secret Service. Authenticated Gemini remains a native acceptance gap. A remembered model choice appears only after live catalog validation; a session-only key's choice ends with its session. Key bytes never appear in renderer state, and no provider row may imply a paid API turn already started.

Separate packaged native synthetic-transport runs open OpenAI API, DeepSeek and Gemini API conversations from imported projects. Send starts the bounded tool chain; each window shows a committed trim while its turn is running, then the same draft rejects a stale edit, accepts a shared-history undo, and reopens with original pixels. The Gemini 3 fixture checks exact transient thought-signature replay and no persisted signature. Visible provider responses are test data, not authenticated model evidence. The drawer shows only the chosen provider and keeps its billing/context notice adjacent to Send.

When the selected provider returns HTTP 429, the same drawer shows a fixed rate-or-quota message with an API-account recovery action. The UI never displays raw provider response bodies, credentials or account identifiers. A packaged native synthetic OpenAI run showed the message in the actual drawer; a live OpenAI turn returned 429 before any edit committed, so live successful editing remains unverified.

When a connected API account is later rejected with HTTP 401 or 403 during Send, the drawer shows a fixed key/account-access recovery message and keeps the submitted request without claiming an edit. The conversation scrolls independently so the notice, composer and failure remain readable together. A packaged 1366×768 native check asserts the alert is wholly inside the drawer and visible; default-size OpenAI, DeepSeek and Gemini runs check the same recovery state. Their 401 responses are synthetic, not authenticated provider edits.

The message history keeps a minimum usable scroll area at 200% interface scale. In the tested small native window the preview and full drawer are reviewed after scrolling between them; the error is brought into view when it changes. This is a bounded usability check, not a claim that every editor control fits simultaneously at enlarged scale.

The initial working Settings modal contains Interface size at 100%, 125%, 150%, and 200%, persisted by main through validated preference get/set IPC. Open it with Settings or Ctrl+,. Cancel/Escape leaves unsaved choices unapplied. Save reports success only after persistence succeeds; failures remain actionable. The dialog owns focus while open and restores the invoking control on close. Any selected source-information inspector is hidden during the modal and restored afterward when still applicable. Only implemented settings sections are exposed; do not add inactive controls to imitate later sections. The earlier settings/focus slice passed packaged native tests and computer-use inspection at 150%; the 200% packaged native and guest-only visual checks passed. P1 is accepted in `docs/workflow/results/P1.json`.

## P2 Codex implementation boundary

When signed out, the selected Codex Settings section also offers Sign in from another device. Its one-time verification page and code appear only after the official runtime starts that attempt; Cancel sign-in and closing Settings clear them. The page link opens through a fixed main-owned external-browser action, never renderer navigation. A packaged Linux guest run confirmed the compact code view, fixed link, guest browser page and cancellation, with guest-only visual inspection. In a separate live attempt the user completed verification externally; the same native window reconciled to signed in and cleared the code, and packaged reopen recovered the signed-in account and runtime catalogs. This verifies managed device-code completion, not the browser OAuth callback route.

In the Codex conversation drawer, Retry request appears only after the App Server reports a failed terminal turn and the latest user request remains in the bounded history. On reopen, restore this action only when the newest server history turn is failed and contains a valid saved user request. It explicitly resends that request as a new turn. Show only fixed recovery text for recognized authentication, rate-limit, or service categories; the pinned `unauthorized` code directs the user to Reconnect in Settings, while ambiguous HTTP 401/403 connection errors remain generic. Never display raw provider details. The failure message asks the user to review already committed draft edits first. Completed, interrupted, rejected-before-acceptance, or uncertain turns have no retry control; the user must reopen and reconcile an uncertain thread before sending again.

Appearance, Codex and API providers sections are implemented within the existing Settings modal, with one section visible at a time. The API providers section selects OpenAI API, DeepSeek or Gemini API. Appearance retains the saved interface-scale behavior. Codex provides real runtime connection, managed ChatGPT browser sign-in, cancellation, sign-out and reconnect actions. Reconnect appears for an unavailable connection or actionable connection message and invokes the main-owned pinned runtime through typed IPC. Login URLs and account storage stay in main; the packaged renderer never navigates to authentication content. Codex model and reasoning controls appear only for a signed-in account with runtime-discovered choices. A fresh account preference selects Luna/high only when the live catalog offers both; otherwise Settings explains the unavailable choice and allows an explicit different selection. An explicit selection is persisted immediately through main, separately from Appearance Save. While the Codex Settings section remains open, main refreshes runtime models, skills and usage on a bounded cadence; supported account, rate-limit and skill-change notifications refresh immediately. API models appear only after provider catalog validation; a remembered choice is bound to the protected key, while a session-only choice ends with the session. Usage is shown only from returned Codex limits; discovered skills remain under the single Advanced disclosure.

Packaged Linux signed-out settings, login initiation/cancellation, reopen and 200% scale checks passed, with guest-only visual inspection at 100% and 200%; that earlier test suppressed external browser launching. A separate browser-equipped isolated guest opened the real OpenAI login page from packaged Settings, then cancelled to signed out. Guest-only visual inspection showed Chromium over the native editor; no host browser or input was used. Another browser-equipped packaged attempt completed the official device-code flow with the user verifying externally; the native window cleared the code and showed the reconciled ChatGPT plan, and reopen recovered signed-in account, live models and skills. A later signed-in packaged Settings test matched plan, live model/reasoning, usage/reset values and skills, then explicitly signed out, hid models and usage, and reopened in signed-out state. The project drawer, production thread lifecycle and owned MCP inventory are implemented. Bounded authenticated fixture turns passed trim/undo, history reopen and Stop. A packaged synthetic parent spawned one native child that completed the two approved read tools under the inherited read-only policy; private rollout, App Server child identity/history and the native window were checked. A Luna/high packaged recovery test now covers both idle App Server child loss and loss after a guarded end-trim committed during an active turn; reconnect restored the same thread with one trim, and shared manual Undo returned the baseline. Loss during the transaction persistence boundary and visual inspection of that particular run remain unverified. Browser OAuth callback completion remains unverified. Project-level model defaults and renderer-selected per-turn overrides are not implemented. Preserve the modal focus/scale/one-panel rules while testing these surfaces.
