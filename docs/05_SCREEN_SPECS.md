# Screen specifications

> Current look and layout (2026-10-24): see `docs/04_SIMPLE_UI_SPEC.md` "Current interface" and ADR 0024. The screen purposes below still apply; where a control is described as always visible, it may now sit under a "More options" or "More tools" disclosure.

The P0 bootstrap in ADR 0012 implements only an actual Home import/library surface and bounded per-frame inspection/seek. Library entries are imported media, not recent projects or draft timelines. Show real import, cancel, selection and seek controls; report unavailable preview for unverified color/precision inputs. Do not display nonfunctional recording, project, Codex, edit, playback or export actions to imitate the complete screens below. P0 bootstrap and P1 shell acceptance are recorded in their phase results; later phases retain their complete screen and accessibility requirements.

The subsequent P1 project prerequisite now adds actual project create/open/reopen and five-stage navigation to the bootstrap. Home lists Projects and Source library separately, and retained source entries have a working Create project action. Successful import creates an actual project with a baseline revision. Stage selection saves through main before changing the active control, retains source/frame position, and preserves prior state on failure. P1 is accepted in `docs/workflow/results/P1.json`, including packaged native tests and guest-only visual inspection. Later editing, capture and export controls remain separate implementation work. The complete screen requirements below remain authoritative.

## S01: onboarding

Before ordinary screens, missing required packaged files show a native error with reinstall guidance and Close app. An unexpected renderer failure offers one Reopen window or Close app choice; another failure requires closing. Reopen means loading persisted work, not guaranteeing recovery of unsaved changes. Unreadable interface settings retain their bytes, use 100% presentation and report the failure. These native failure paths are part of P1 lifecycle acceptance and do not expose technical diagnostics in the renderer.

Purpose: establish local readiness and supported Claude account sign-in as the default, with retained Codex and API alternatives. Under ADR 0018 the Claude control runs the user's Claude Code sign-in; Settings hosts it until a dedicated onboarding screen exists.

Visible:

- product mark
- Sign in with Claude (default; starts Claude Code's own Anthropic browser sign-in, see docs/48_CLAUDE_CONNECTION.md)
- Sign in with ChatGPT (retained alternative)
- setup action only if a required dependency is missing
- short context disclosure: Codex may receive prompts, project metadata, requested preview frames and bounded local transcript text during a user-started turn; transcript pages may remain in thread history and be included in later turns, while source audio/video stay local
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

The partial P3 two-source path offers Add footage on an unedited single-source project in Import. The action uses the native picker, shows import/project progress, retains a successfully imported source if project creation fails, and opens the new combined project after commit. Home identifies the source count. Source details shows both ordered parts in one inspector; seeking across their join updates the native preview from committed clip mapping. The original project remains available. This is an import/preview affordance, not a continuous playback or export control.

Implemented look (2026-10-07): two action tiles, **New recording** and **Import video**; when a take was interrupted, one notice row ("A recording from … was interrupted") with **Discard** and **Recover** (docs/06); then a Projects grid of cards with a small decoded picture, name, duration and current step, then a compact Media list with the same picture, size, duration and **Create project**. Each project card has a small options button over its picture that opens one dialog: the name field (Save renames; the name is one line of up to 160 characters without slashes) and **Delete project…**, which asks again in place, says the recordings stay in Media and exported videos are untouched, and focuses Cancel. Deleting is only offered on Home, for a closed project. Card pictures come from `library:thumbnail`, a cosmetic 320 px decode that is never used for review or export; a source that cannot be decoded keeps a neutral placeholder. Card durations are whole seconds; the editor keeps millisecond positions.

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

Implemented subset (2026-10-07): one modal dialog. Setup shows a screen choice (radio cards with resolution), a microphone menu and Start recording. Live shows a countdown, then a pulsing record dot with elapsed time, a single status line (Recording, Paused, missed-frame count, Saving) and Pause/Resume and Stop. Stop opens the new project in Import. An Area choice (Whole screen or Part of the screen) opens an area picker over the chosen display: drag a rectangle, then Enter or Record this area; Escape cancels. The dialog then shows the area's size. A Camera menu (No camera by default; with a camera a note says it is saved as its own video, kept on this device) records the camera as a second lossless file with the screen's frames (ADR 0029); the project opens with it linked. Scenes, teleprompter, system audio and window choices are not implemented. See docs/06.

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

## S07: Magic Edit

The current implemented surface is a user-started local transcription action. First use downloads the pinned approximately 76 MiB Whisper weight set from Hugging Face into app-private storage; source audio is processed on device. Show download or transcription progress, Stop, a read-only transcript, the word-count summary, and warnings that timestamps are estimates and language was not identified. Completed results survive project reopen. Fixed actionable failures distinguish audio preparation, model inference, missing or invalid word times, source-bound violations, and invalid transcript structure without exposing worker logs. The transcription action does not edit the draft or create cuts.

After local transcription completes, a compact Review speech cues action appears inside the transcript disclosure. It shows configured transcript-derived candidates, original local-transcript context, source times, protection/disposition labels and fixed warnings; quotes and long silences remain context-only. An exact repeated-segment cue shows the later excerpt and a separate earlier-occurrence excerpt. Preview selects the source frame only when its source point maps through a currently committed clip. It does not play audio or cut, write a transaction or claim semantic approval.

The planned editorial flow follows docs/47_EDITORIAL_FIRST_CUT.md. Show meaningful current pass progress and actionable unresolved directions from real persisted work, with separate spoken-cut, layout and zoom undo groups. Do not turn the detailed QA requirements into persistent dashboards or extra panels. The configured cue and protected scope belong to relevant project/edit settings. Manual text-only transcript correction and explicit selected-word structural cuts are available in Refine. Magic Wand presets, automatic meaning-aware cuts, captions, and layout/effect actions remain unimplemented.

Visible:

- video preview
- Transcribe locally and Stop controls
- relevant model-download or transcription progress
- read-only transcript and concise word-count summary
- optional transcript-derived review cues and source-mapped preview action
- timing and unidentified-language disclosure

Magic Edit step (2026-10-18, ADR 0020): a preset menu (Natural, Balanced, Tight) with a one-line note on how far the assistant goes and which connection makes the story edit (the one chosen in the assistant drawer, Claude by default; an API provider is noted as billed to its API account), **Rough cut only**, an open-ended progress bar with "<connection> is cutting…" while it works (transcription first shows its own progress), Stop, and afterwards one line such as "Removed 13.1 s in 1 cut. Undo in Refine reverses each step." The assistant's own summary appears in its conversation. When the chosen connection is not ready (Claude Code out of date or missing, signed out, no model or key) the deterministic pause and filler tightening still applies and the card says what was skipped and how to fix it (ADR 0030). The assistant can start Magic Edit, stop an edit and move to a step from its chat (ADR 0030). The intended complete S07 adds Magic Wand, preset menu, simple feature switches, optional natural-language instruction, concise live edit activity, Stop and shared Undo after their operations and acceptance evidence exist.

## S08: editor (Refine stage)

### Refine (ADR 0031, 2026-11-02)

Refine is one simple screen. The video uses the available width in the video's own shape (no small box with black bars). Under it: the play bar (play, position, time, full screen) and a slim timeline strip with a clearly visible playhead (an accent line with a ring) and small pins for where a zoom, a graphic or the captions begin; a pin carries its label only where there is room to read it. A row of six simple tools follows: **Trim** (a small menu: cut everything before here, cut everything after here), **Split**, **Delete part** (the whole part under the playhead, as a range cut), **Captions**, **Music** and **Volume** (pop-overs holding the caption choices, the music and sound-effect controls and the loudness and noise choices). A tool that cannot act now (for example Split with the playhead on a cut) stays readable and explains why in a tooltip and a short notice when pressed. The tool row is never cut off at 800 px window height: the picture gives way first, and the page scrolls only below its smallest size.

Beside the picture, **What Magic Edit did** lists plain one-line rows built from the draft's own transaction records (origin Claude, Codex, an API provider or Magic Edit; manual edits are never listed and only what is still in the draft is counted): Cut 14 parts, 5 zooms, 3 graphics, Captions on, Music added, sound effects, parts sped up, transitions, camera changes, Sound cleaned up. Each row has **Undo**. Draft transactions can be undone only newest first and an effect transaction holds one operation, so a single older item cannot be undone safely; Undo therefore removes the whole kind: main commits one ordinary manual transaction per item (restore the cut source part, remove the zoom, graphic, transition, camera change or sound, turn captions off, back to normal speed, put the sound settings back) in one pass group. They are normal journal entries; the shared Undo and Redo still work, and the row is replaced by "5 zooms removed" with **Put back**, which undoes exactly those entries while they are the newest change. Under the list, **Undo last change** and **Redo** use the shared history. IPC: `edit-summary:get`, `edit-summary:undo` (a kind), `edit-summary:put-back`.

The action bar at the bottom of the page holds **Open full editor** (left) and **Continue** (right). The full editor is the complete editor described below (every tool, the transcript tools, Undo and Redo, restore) over the whole window with a **Done** button back to Refine; the step bar is hidden meanwhile.

The audio, sound and caption cards that Magic Edit's More options used to hold are now Refine's Volume, Music and Captions tools.

Visible:

- large preview
- compact tool rail
- simple timeline with non-empty tracks only
- transcript mode with word search, source selection, text-only word correction, selected-word ripple cut, and shared Undo/Redo
- one inspector
- collapsible Codex drawer

The transcript correction view changes draft metadata only and states that the recorded audio is unchanged. Word selection for a cut requires start and end words from the same transcript and a continuous current clip mapping; the resulting draft operation is undoable. The operation is a source-time mapping edit, not speech understanding, A/V rendering, or proof that removing the selected speech preserves meaning.

Direct canvas handles appear for the selected zoom, camera, or B-roll item.

The current P2 conversation slice implements the compact Codex drawer beside the existing project preview. Opening it closes the source inspector so only one panel is visible. It renders only projected user/Codex text, generic work/subagent/edit activity, Stop while a turn runs, and an actionable failure or uncertainty. Reopening restores the bounded redacted recent history of the real project thread before live notifications; an authoritative newest in-progress turn remains running and interruptible. It requires a real selected project and signed-in runtime selection, contains no sample messages, never exposes server item identities or pagination cursors, and updates from the authoritative thread view returned through typed IPC. Leaving a project performs an idle unsubscribe and refuses while a turn is active.

The project preview shows current and total output time. Its frame and seek bounds come from the current committed draft head. A committed trim, split, cut or restore refreshes the ordered fragment map, remaps output time through retained immutable sources, and discards stale decoded pixels; split preserves total duration while cut and restore change it according to their interval. The Refine stage offers compact Trim start, Trim end, Split, Mark in, Mark out, Cut range, Restore source range, Clear, Undo and Redo actions around the preview. Trim and Split require an interior playhead position and are disabled at boundaries or during a pending save. Marks are output-time microseconds bound to the exact draft head; a changed head invalidates them so a later cut cannot use stale positions. Cut range needs a valid nonempty, non-whole-draft `[in, out)` interval and may cross a fragment or source join. It ripples remaining fragments while keeping all imported sources available in Source details. Restore source range accepts one exact missing half-open interval in a selected immutable source; main rejects visible overlap and reflows the remaining map. It does not infer missing content. Save failure stays actionable, and shared-history Undo may reverse a manual or assistant edit; Redo reapplies the latest undone transaction through the journal. Source library inspection remains clearly labelled as source position. Tagged 8-bit H.264/BT.709 imports can show converted display frames at native dimensions, with source seek positions resolved against presentation PTS instead of average frame rate. The two-source path crosses its join, but remains still-frame inspection without audio playback or master rendering.

Project shell (2026-10-07), shared by all five steps: a top bar with the project name, the step selector as one segmented control (a menu below 820 px), the assistant toggle and an icon button for source details. Under the preview sits one player bar (previous frame, play, next frame, position slider, time) and a compact timeline strip: one continuous bar coloured by recording with a hairline at each cut and no part labels (an automatic edit can leave a hundred parts), the current part slightly lighter, In/Out marks or the marked range, the playhead, and, when the edit is shorter than the recordings, one quiet "edited of original" length such as "16:38 of 21:28". Clicking the strip seeks; the slider remains the keyboard control. The current step's tools sit in one panel below; the preview yields space to it and the panel scrolls only when the window is too short. While a new frame decodes the previous frame stays on screen and a small "Reading frame…" notice appears only if decoding is slow. Edit's tools are one icon toolbar (trim, split | undo, redo | mark in/out, cut range, clear, zoom | restore). Zoom uses the marked range or two seconds from the playhead, then asks the user to click the picture where it should point (a hint over the preview; Esc cancels). While the playhead is inside a zoom, a small group shows its strength menu, Move target and Remove zoom; zoom blocks sit on the timeline strip with their strength. The preview shows zooms exactly as export renders them. A Speed menu (Normal, 2×, 3×, 4×, 8×) sets the speed of the marked range or of the part under the playhead; sped-up parts are hatched with a badge on the timeline strip (docs/12). Edit shortcuts: I/O marks, S split, Z zoom, Ctrl+Z undo, Ctrl+Shift+Z redo, Left/Right frame step (docs/22). These are the **full editor**, opened from Refine's **Open full editor** over the whole window (ADR 0031); Refine itself is the simple screen described in the next section.

## S09: revision compare (opened from the full editor)

Visible:

- prior revision and current draft
- linked playhead
- changed-range list
- Keep current
- Restore prior as a new draft
- Continue editing

## S10: What Magic Edit did (Refine; internal screen `qa`)

ADR 0031 removed the Review step. Its draft check, **Verify draft**, now runs by itself before every export: main re-reads the committed project, draft journal and managed-source measurements and returns the validated draft head. If the current head ends in a main-owned manual edit group it may record a structural-only checkpoint with evidence derived from the validated reads; AI-origin groups cannot use that path. The check says nothing when it passes; when it fails the export does not start and one plain message is shown. It does not assess spoken meaning, rendered joins or playback, create an editorial pass checkpoint, or enable export. The summary of what the automatic edit did is Refine's "What Magic Edit did" list (S08).

The full editorial report exposes measured changes, unresolved cues and selective graphics suggestions at final-cut times. Each suggestion contains its complete prompt and remains distinct from an imported asset; viewing it never triggers generation or export. Keep this in the selected review surface or Codex drawer, respecting the single-panel rule. A pass checkpoint does not certify whole-result review.

The remaining bullets below are target screen requirements. Only the duration summary and Verify draft are currently implemented in Review.

Visible:

- actionable warnings or blockers, otherwise one enabled Continue action
- short issue list with jump-to-time
- Fix with Magic Wand when supported
- full-draft watch-through and jump-to-time playback
- Return to Refine and Continue to Export actions

Technical evidence opens only from Details.

## S11: export

Visible:

- file name and destination
- Lossless master by default, Smaller file only by explicit choice
- captions and sidecar choices
- Export
- cancellable progress after export begins

Advanced codec settings are collapsed.

Update (2026-11-02, ADR 0031): Export is one centred column, the picture and then the two quality choices side by side; **Export** is in the action bar at the bottom right (accessible name "Export video", because "Export" is also the step's name). The assistant is docked beside the page, so Export and the whole step stay visible and the page scrolls on its own; the draft check runs by itself before an export starts. A finished export goes to Done. Short clips are no longer here (Clips is step 4).

Implemented (2026-10-07): the Export step shows two stacked, selectable quality options with radio dots (Lossless master by default, Smaller file), a one-line note about the choice and Export…; the file name and destination come from the system save dialog. While exporting it shows only progress, Rendering/Verifying and Cancel. Caption sidecars are not available yet.

## S12: Done (after a finished export; ADR 0031)

A check mark, "Your video is ready", then a card with the final thumbnail, file name, length, size and folder; **Show in folder** (primary) and **Play**; the cards Make short clips (when Clips was skipped), Edit another video and Back to Home; and Keep editing, which returns to Export. The step bar reads every step as finished. Path and technical verification are not shown.

Implemented (2026-11-02): a finished and verified export moves the project to the `done` stage by itself (only a running export that completes does this; reopening a project in Done with no result in memory shows Export). The card reads the file name, then "0:48 · 214 MB · saved to Videos" from the export result (`folderName` is the folder's own name, never a path). **Show in folder** and **Play** use the same main handlers as before (`export:reveal`, `export:open`). Make short clips goes to Clips and is hidden once a clip exists; Edit another video goes Home and opens the import dialog; Back to Home goes Home; Keep editing returns to Export, where the verified details (profile, captions, audio) are still listed. The Done screen has no assistant button and no action bar.

Earlier text (2026-10-07), kept for the detail it records:

- final thumbnail
- filename and Open folder action, with path and technical verification under Details
- Open video

Implemented (2026-10-07): file name, duration, size and "verified lossless" for a master, with Open video, Show in folder and Export again. The final thumbnail and Details are not shown yet.
- Open folder
- Return to project

## S14: short clips (Clips step; ADR 0031)

Its own step between Refine and Export, with **Skip**. The step shows the picture compactly (Preview on a card plays that moment in it), the two ways to find clips (Find clips, Pick with Claude), "Clip options" (format, framing, captions, title, speed) folded away, and the clips as cards: a picture of the moment, a choice box (new clips start chosen), the title and length, Preview, Discard and Save only this. **Make N clips** (the action bar, right) exports the chosen clips to one folder through `shorts:export-all` with an optional `clip_ids` list (absent means every clip); once a clip is saved the left button reads Continue instead of Skip. Skipping never blocks Export; Done offers Make short clips while none exists.

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

Appearance, Claude, Codex and API providers sections are implemented within the existing Settings modal, with one section visible at a time. Claude shows its status line, one privacy disclosure while not signed in, Sign in with Claude, Cancel sign-in while Claude Code's browser sign-in waits, Sign out, Get Claude Code when it is missing, Check again for an actionable issue, and Production model/Effort and Rough cut model only for a signed-in live catalog (a fresh production choice is Sonnet when offered, otherwise the account default; the rough cut defaults to Haiku when offered, otherwise the production model; both choices persist through main immediately). With Claude idle, the drawer also offers a collapsed **Edit the whole video** brief (purpose, audience, style, Tidy/Polished/Bold) that starts a full AI edit, becomes **Polish with Claude** after a finished run, and shows **Full edit: N changes** with **Undo all** while the run's edits are the newest (docs/50). The assistant drawer defaults to Claude; its Open conversation gate names the missing setup, sign-in or model step, and a Console API-billing sign-in shows a paid-turn notice. The API providers section selects OpenAI API, DeepSeek or Gemini API. Appearance retains the saved interface-scale behavior. Codex provides real runtime connection, managed ChatGPT browser sign-in, cancellation, sign-out and reconnect actions. Reconnect appears for an unavailable connection or actionable connection message and invokes the main-owned pinned runtime through typed IPC. Login URLs and account storage stay in main; the packaged renderer never navigates to authentication content. Codex model and reasoning controls appear only for a signed-in account with runtime-discovered choices. A fresh account preference selects Luna/high only when the live catalog offers both; otherwise Settings explains the unavailable choice and allows an explicit different selection. An explicit selection is persisted immediately through main, separately from Appearance Save. While the Codex Settings section remains open, main refreshes runtime models, skills and usage on a bounded cadence; supported account, rate-limit and skill-change notifications refresh immediately. API models appear only after provider catalog validation; a remembered choice is bound to the protected key, while a session-only choice ends with the session. Usage is shown only from returned Codex limits; discovered skills remain under the single Advanced disclosure.

Packaged Linux signed-out settings, login initiation/cancellation, reopen and 200% scale checks passed, with guest-only visual inspection at 100% and 200%; that earlier test suppressed external browser launching. A separate browser-equipped isolated guest opened the real OpenAI login page from packaged Settings, then cancelled to signed out. Guest-only visual inspection showed Chromium over the native editor; no host browser or input was used. Another browser-equipped packaged attempt completed the official device-code flow with the user verifying externally; the native window cleared the code and showed the reconciled ChatGPT plan, and reopen recovered signed-in account, live models and skills. A later signed-in packaged Settings test matched plan, live model/reasoning, usage/reset values and skills, then explicitly signed out, hid models and usage, and reopened in signed-out state. The project drawer, production thread lifecycle and owned MCP inventory are implemented. Bounded authenticated fixture turns passed trim/undo, history reopen and Stop. A packaged synthetic parent spawned one native child that completed the two approved read tools under the inherited read-only policy; private rollout, App Server child identity/history and the native window were checked. A Luna/high packaged recovery test now covers both idle App Server child loss and loss after a guarded end-trim committed during an active turn; reconnect restored the same thread with one trim, and shared manual Undo returned the baseline. Loss during the transaction persistence boundary and visual inspection of that particular run remain unverified. Browser OAuth callback completion remains unverified. Project-level model defaults and renderer-selected per-turn overrides are not implemented. Preserve the modal focus/scale/one-panel rules while testing these surfaces.

Refine step additions (2026-10-25): More tools has a Camera group (Add camera video; then a layout from the playhead: camera in a corner with corner, size and shape, camera only, or screen only; Remove layout change; the camera moved against the screen by 0.1 s; Remove camera), layouts show as green bars on the timeline strip and in the live preview (ADR 0029), and Add transition and Zoom (with evidence, ADR 0027) are unchanged in place.
