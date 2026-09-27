# User workflow

## Navigation model

The app uses a top stepper with five project stages:

1. Record or Import
2. Auto Edit
3. Edit
4. Review
5. Export

Only the current stage is expanded. Completed stages can be revisited. Future stages remain compact and show their blocking condition.

## Home

Home contains recent projects and three large actions:

- New recording
- Import video
- Open project

Settings, Help, and Diagnostics use small secondary actions.

## New recording

The user chooses a screen source, microphone, optional system audio, optional camera, aspect ratio, and scene. A short readiness view shows only blocking issues. The recording overlay remains minimal.

## Import video

The user picks one or more local media files and sees one plain processing view. For a sequential import, the chosen order is visible and adjustable before project creation; the initial draft appends each immutable source in that order. File probing, proxy creation, transcription, and analysis appear as a short progress list. Detailed commands remain hidden.

## Auto Edit

The current Auto Edit action is Transcribe locally. On the first explicit start, the app downloads the pinned Whisper model weights into private application storage, then produces local word timing and separate silence evidence. Source audio remains on this device. The app preserves one live job identity across repeated Start requests and polling, offers Stop, caches results by immutable source hash and model revision, and restores completed transcripts when the project reopens. Model word times are estimates; the local model does not identify a language in this runtime, so the view labels language as unidentified. These results do not change the draft.

The planned Magic Wand remains the main editorial action. It will offer a small preset menu and clear switches, stream validated edits to the active draft, and retain completed reversible work when stopped. Edit now supports text-only correction of a locally transcribed word. Transcript-linked cuts, captions, and automatic effects are not implemented yet.

Optional OpenAI API, DeepSeek and Gemini API assistance under ADRs 0014 and 0015 uses a separately connected key and provider-validated model. A paid generation turn starts only when the user explicitly selects it. Local deterministic work does not silently incur API usage.

## Edit

The default layout contains:

- large preview
- compact tool rail
- simple timeline
- optional transcript tab
- one inspector at a time
- collapsible AI drawer, with real Codex conversation and only verified capabilities for optional API providers

The user can click an AI change in the history to see its reason and undo it. Edit supports source selection, word search and one-word transcript correction in the shared draft journal; recorded audio is unchanged. Transcript-linked cuts remain in progress.

The current Edit transcript controls can correct one locally transcribed word. That correction uses the shared draft journal and is undoable and redoable. It changes transcript text only; the original transcript and recorded audio stay unchanged. Transcript-selected cuts and restore are not implemented yet.

## Review

Watch the whole draft, compare revisions, and inspect actionable quality findings. QA is an internal screen within Review. Jump back to Edit to correct an issue with shared undo history preserved; continue to Export when ready. Review does not require approval of every ordinary reversible edit.

## Export

The final screen shows a preview summary, required warnings, a small set of export presets, and one Export button. Advanced codec settings are hidden.

## Returning users

Reopening a project restores the last autosave. If an interrupted draft exists, the app explains what was recovered and what needs to be rerun.
