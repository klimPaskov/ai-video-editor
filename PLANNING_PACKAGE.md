# Planning package

## Product statement

AI Video Editor is a local-first desktop application for planning, recording, automatically editing, refining, and exporting creator videos. It combines a simple scene workflow with a compact timeline editor, Claude account sign-in as the required default AI connection, retained Codex assistance and explicit API-key provider options.

## Core promise

A user can record or import a video, press Magic Wand, receive a useful non-destructive first edit, make simple manual or natural-language changes, review the result, and export a verified lossless master, with an optional compressed MP4 sharing copy without learning a professional nonlinear editor.

## Product principles

1. **Native and focused.** One desktop window, no localhost UI, no browser product shell.
2. **Step by step.** Home, then Record or Import, Auto Edit, Edit, Review, Export.
3. **Real tools.** Every visible control must work against the project model.
4. **AI as an editor.** Claude, Codex and selected API providers can inspect disclosed context and propose guarded live draft edits.
5. **Manual control remains.** Users can split, trim, restore, zoom, retime, caption, place B-roll, and undo.
6. **Non-destructive.** Source files stay unchanged and revisions remain recoverable.
7. **Quiet interface.** Technical logs are hidden behind Diagnostics.
8. **Evidence before claims.** A process exit is not visual proof.

## Intended users

- tutorial and course creators
- software demo creators
- educators
- product teams
- independent creators who want fast screen and camera videos

## First release platform

Windows 10 and 11 x64. Architecture and project contracts must avoid blocking a later macOS build.

## Required product areas

- project home and recent projects
- optional outline, script, scene plan, and teleprompter
- screen, window, system audio, microphone, and optional camera recording
- scene takes and retry selection
- media import and project ingest
- local transcription and transcript editing
- Magic Wand automatic draft
- simple timeline and transcript editing
- automatic and manual zooms
- automatic and manual speed segments
- cursor and click presentation
- camera layouts and canvas formats
- captions, text, images, local B-roll, music, and sound
- audio cleanup and loudness handling
- preview, undo, autosave, revisions, QA, lossless master export, and optional sharing exports
- supported Claude account sign-in as the default AI connection, with integration/model decisions open under ADR 0018
- retained real Codex login, model selection, chat, skills, and guarded editing tools
- explicit OpenAI API and DeepSeek key connections, provider model discovery and guarded editing through the same draft history

## Acceptance milestone

The final milestone imports the user-provided example video, runs Magic Wand, produces and inspects a complete draft, fixes discovered issues through the app, exports the lossless master, verifies canonical sample equality, and records evidence. Recording features must also pass repeatable virtual-device tests.

## Exclusions for the first release

- cloud collaboration and hosted sharing
- mobile apps
- generic AI provider marketplace and arbitrary custom endpoints
- API-key-only setup that removes ChatGPT-managed Codex sign-in
- remote stock-media purchasing
- generative video or generative B-roll
- unrestricted professional compositing
- advanced colour grading
- arbitrary plugin execution in the renderer

## Fixed product decisions

- Product name: **AI Video Editor**. Working folder and repository slug: `ai-video-editor`.
- Public open-source development starts in P0 and continues through working commits and reviewable pull requests.
- Lossless capture, editing intermediates, and master output are the defaults. Lower-quality modes are explicit opt-ins.
- The normal app has no permanent debug indicators, readiness dashboard, oversized page title, or redundant explanatory subtitle.
- The supplied current and previous reference sets each contain ten individual native-app screens. Use the current set first with the mandatory corrections in `docs/references/IMPLEMENTATION_NOTES.md`.
- Supported AI providers make reversible changes live. Review of the draft does not require a separate approval click for every ordinary editing operation.
- API-key providers are optional, fixed-endpoint connections. Keys stay under main-process control with OS-backed encryption or session-only fallback; paid turns start only on explicit user action.
