# User workflow

## Navigation model

The app uses a top stepper with five project steps (ADR 0031):

1. Import
2. Magic Edit
3. Refine
4. Clips
5. Export

After a finished export the app shows a Done screen (not a step). Only the current step is expanded. Completed steps can be revisited. The AI does the bulk of the editing; Refine is for a quick check and small changes.

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

## Magic Edit

The current Magic Edit action is Transcribe locally. On the first explicit start, the app downloads the pinned Whisper model weights into private application storage, then produces local word timing and separate silence evidence. Source audio remains on this device. The app preserves one live job identity across repeated Start requests and polling, offers Stop, caches results by immutable source hash and model revision, and restores completed transcripts when the project reopens. Model word times are estimates; the local model does not identify a language in this runtime, so the view labels language as unidentified. These results do not change the draft.

The planned Magic Wand remains the main editorial action. It will offer a small preset menu and clear switches, stream validated edits to the active draft, and retain completed reversible work when stopped. Edit supports text-only correction of a locally transcribed word and a selected-word ripple cut. Captions and automatic effects are not implemented yet.

Optional OpenAI API, DeepSeek and Gemini API assistance under ADRs 0014 and 0015 uses a separately connected key and provider-validated model. A paid generation turn starts only when the user explicitly selects it. Local deterministic work does not silently incur API usage.

## Refine

Refine is one big screen: the video, a play bar, a slim timeline, a "What Magic Edit did" list with Undo per kind of change, and six simple tools (Trim, Split, Delete part, Captions, Music, Volume). Open full editor opens the complete editor below over the whole window; its Done button returns here.

## Full editor

The default layout contains:

- large preview
- compact tool rail
- simple timeline
- optional transcript tab
- one inspector at a time
- collapsible AI drawer, with real Codex conversation and only verified capabilities for optional API providers

The user can click an AI change in the history to see its reason and undo it. Edit supports source selection, word search, one-word transcript correction and a selected-word ripple cut in the shared draft journal. Transcript corrections change metadata only. A selected word range can be cut only when its source times map continuously onto one currently visible clip; the operation records the exact source and output interval. Undo restores the prior clip map. This draft operation does not process or render synchronized A/V, determine whether speech is safe to remove, or resynthesize audio.

The Edit transcript controls can correct one locally transcribed word or cut a selected word range. Correction uses a text-only override; the original transcript and recorded audio stay unchanged. A cut uses the immutable source/transcript word IDs and the current draft head, commits through the shared journal, and can be undone or redone. Transcript text restoration and speech-aware cut approval are not provided here.

## Clips

Optional. Short vertical clips cut from the best moments, chosen by the user, with Skip. It has its own step after Refine.

## Export

The export step shows the video, two quality choices (Lossless master, Smaller file), the destination and one Export button. The draft check runs by itself before an export starts and speaks only when something is wrong. Advanced codec settings are hidden.

## Done

After a finished export: a check mark, "Your video is ready", the file's thumbnail, name, length, size and folder, Show in folder, Play, and Make short clips, Edit another video, Back to Home and Keep editing.

## Returning users

Reopening a project restores the last autosave. If an interrupted draft exists, the app explains what was recovered and what needs to be rerun.

After local transcription completes, Magic Edit offers deterministic speech-cue review with original-transcript context excerpts and a still-frame seek through the committed clip map. Reviewing cues and seeking a frame do not cut or otherwise change the draft; Magic Wand remains the only automatic edit action and is still under implementation.
