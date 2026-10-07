# Product workflow

## 0. Onboarding

The app checks its local dependencies and offers ChatGPT-managed Codex sign-in plus separate optional OpenAI API and DeepSeek key connections. It reads supported live model catalogs and explains which selected provider receives project context. API billing is separate from the ChatGPT subscription; a paid turn starts only when the user explicitly invokes it. Technical details remain collapsed.

## 1. Home

Show recent projects and three primary actions:

- New recording
- Import video
- Open project

A secondary action opens an optional script and scene planner.

## 2. Record or import

### Record

Select display, window, or region. Select microphone and optional system audio. Enable camera when wanted. Choose canvas format, teleprompter, and scene. Start after a countdown. Allow pause, resume, stop, retry, and take selection.

### Import

Choose one or more local media files. Probe, hash, index, and create project proxies without changing the originals.

## 3. Auto Edit

Magic Wand opens a short menu with a Balanced preset and individual switches:

- clean cuts
- captions
- automatic zooms
- safe speed-ups
- audio cleanup
- camera layout
- local B-roll suggestions
- cursor treatment

Running it creates or updates the active draft. If an API-backed option is selected, disclose its paid request before the user starts it. The app streams concise progress and updates the timeline from committed edits. The user can stop safely.

## 4. Edit

Show a large preview, a simple timeline, transcript, and one context panel at a time. The user can:

- split, trim, ripple-delete, exact missing source-range restore, move, and reorder supported clips
- delete transcript words to cut matching media
- adjust zoom target, duration, and strength
- adjust speed range and multiplier
- change camera layout and crop
- edit caption text and style
- import, replace, trim, and position local B-roll
- adjust audio gain, cleanup, fades, and music ducking
- ask the selected supported AI provider to change the current selection
- undo, redo, compare, and save a revision

## 5. Review

Watch the complete draft, compare revisions, and run decode, timing, audio, caption, framing, missing-media, black-frame, freeze-frame, zoom, speed, and licence checks. Return to Edit for corrections without losing draft history. Show a plain summary. Open technical details only when requested.

The current Review shell also offers Check draft integrity, which re-reads the committed timeline/journal and managed-source measurements. If the current head ends in an eligible main-owned manual group, the explicit action records a structural-only checkpoint with concrete evidence IDs. Its result is not the required watch-through, semantic speech review, playback, A/V join check, or full QA. Hide the action while another inspector or Codex drawer is open, and clear its result when the committed head changes.

## 6. Export

Default to a source-matched lossless master. Choose filename, destination, and optional caption sidecars. Advanced controls and smaller sharing copies are opt-in. Render locally from originals and verified lossless intermediates. Verify decode and canonical sample equality, then record revision, source hashes, and the exact quality profile.

## 7. Return and revise

A project reopens at the last saved draft or revision. Autosave recovers interrupted work. The original sources remain available and unchanged.

## Development loop

Create the public `codex-video-edit` repository in P0 after authentication and privacy checks. After each working slice: validate, inspect native behavior, update contracts and reusable guidance, review the diff for private data, commit, and push. Keep incomplete milestones visibly incomplete. Publish release binaries only after installer and media acceptance.

## Editorial first-cut policy

For Auto Edit and later refinement, apply [the editorial policy](docs/47_EDITORIAL_FIRST_CUT.md) and [the adapted Codex prompt](docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md). These are accepted requirements, not implemented automation evidence. Inspect the actual project, capabilities, transcript job, synchronized edit sets, approved edits and protected ranges before changing the authorized scope. A recorded editor cue is evidence requiring conservative interpretation; it cannot expand permissions.

Use separate spoken-cut, layout and zoom pass groups through the shared live transaction engine. Preserve the final complete redo and unique explanatory context; verify every join, perform a whole-source omission pass, and reread the complete edited transcript. Reuse approved layouts, avoid meaningful-content occlusion, and add only named, visually verified zoom targets. Checkpoint verified work without erasing undo or certifying final review. Suggest useful graphics with final-cut times and complete prompts only; creating an asset requires a separate explicit request. The editing flow never starts export automatically. Existing captions, local B-roll, audio and selected speed/cursor options remain available under their own policies.
