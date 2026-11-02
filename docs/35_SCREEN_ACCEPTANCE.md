# Screen acceptance criteria

## S01 Onboarding

- The user understands that media stays local unless the selected AI provider is asked to inspect disclosed context.
- ChatGPT sign-in can begin and recover from cancellation.
- Dependency problems have one plain repair action.
- Protocol logs are hidden.

## S02 Home

- New Recording and Import Video are the dominant actions.
- Recent projects show thumbnail, name, state, and modified time.
- Opening a project restores its last safe draft.
- No editor panels are visible.

## S03 Capture setup

- Screen or window, microphone, system audio, and camera choices are clear.
- Camera controls disappear when camera is off.
- Permission denial explains the exact missing permission.
- Start is disabled until required sources are valid.

## S04 Recording

- Countdown, pause, resume, stop, elapsed time, source state, scene, and teleprompter remain readable.
- Editor and diagnostics chrome stay hidden.
- Source failure cannot silently produce a complete take.

## S05 Take review

- Preview, Confirm, Try Again, and previous takes are clear.
- Discarding a take requires a deliberate action.
- Confirming creates or updates the automatic timeline.

## S06 Import processing

- One progress surface shows copy or reference, probe, proxy, waveform, transcript, and analysis status.
- Cancel is safe and leaves recoverable evidence.
- A corrupt file gives a specific repair route.
- A tagged H.264/BT.709 import shows a native-size frame only after decode; unknown color or higher-precision paths remain explicitly unavailable. Source bytes stay unchanged. This still-frame check does not satisfy smooth A/V preview or multi-source append acceptance.

## S07 Magic Edit

- Magic Wand is the primary control.
- Presets and switches are understandable without technical terms.
- Live changes appear in the draft and history.
- Stop and Undo remain visible.

## S08 Refine and the full editor

- Refine: the video uses the available width (no small box with black bars), the six tools are never cut off at 800 px window height, and Open full editor opens every existing tool with a Done button back.
- Preview is visually dominant.
- The timeline shows only tracks that contain content.
- One tool or inspector is open.
- Split, trim, delete, restore, zoom, speed, captions, B-roll, layout, audio, and cursor controls work on the selected object.
- Codex can receive the current selection and apply validated changes to the same history.

## S09 Compare

- Linked playback makes changed ranges obvious.
- The user can keep current, restore prior, or return to editing.
- Restoring creates a new draft and does not rewrite history.

## S10 What Magic Edit did

- Review is not a step (ADR 0031). The list in Refine shows plain one-line rows built from the draft's own transaction records.
- The draft check runs by itself when exporting and speaks only on a problem; a failed check stops the export with one plain message.
- Technical evidence is optional.

## S11 Export

- The step and its Export button stay fully visible with the assistant open (docked beside the page, narrower below 1100 px, a slide-over at 760 px and below that never covers the action bar).
- The draft check runs by itself; nothing is shown unless it fails.

- Common options fit without scrolling at normal window size.
- Destination and overwrite behavior are explicit.
- Export requires a user action.
- Progress can be cancelled safely.

## S12 Done

- Success appears only after full decode and output hash verification, then the app moves to the Done screen.
- Show in folder, Play, Make short clips, Edit another video, Back to Home and Keep editing each work on real state.

## S13 Settings

- Codex remains available with managed ChatGPT sign-in; implemented OpenAI API, DeepSeek and Gemini API rows show separate key and billing states with no exposed key bytes.
- A provider rejection after Send leaves the request visible and shows a fixed recovery message wholly inside the selected drawer. At 1366×768 the message is in the viewport, the conversation retains a usable scroll area, and the preview remains readable. An HTTP 401/403 cannot appear as a successful edit.
- At 200% interface scale, the selected drawer keeps at least 80 CSS px of independently scrollable conversation history and reveals a changed error. Test preview and drawer after scrolling between them; simultaneous full visibility is not required in a small window.
- Each provider lists only live-validated models and verified capabilities; a paid API turn starts only on explicit user action.
- Runtime-discovered Codex models can be selected.
- Only one settings section opens at a time.
- Diagnostics remain separate.

## Layout audit (2026-10-24)

Every screen and dialog must pass `tests/native/layout.test.ts --enforce` in the packaged app for every theme at 1440x900, 1200x800 and 1000x700 (100%), and 1200x800 at 150% and 200%: no sideways page scroll, no control cut off by the window or by a container, no controls drawn over each other, no text cut off without an ellipsis, no target smaller than 20 px, and every text at least 4.5:1 (3:1 for large text) against what is behind it. A person also looks at the screenshots; the audit finds breakage, not taste.
