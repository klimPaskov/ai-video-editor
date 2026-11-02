# Architecture decisions

Files in this directory are accepted starting decisions. Revisit them only with evidence and update dependent specifications in the same change.

- 0001: Electron native shell
- 0002: real Codex only
- 0003: step-based UI
- 0004: non-destructive timeline
- 0005: local-first media
- 0006: isolated native testing
- 0007: separate recording sources
- 0008: reference synchronization
- 0009: lossless-first media
- 0010: public development from P0
- 0011: individual reference corrections
- 0012: minimum actual native media bootstrap prerequisite for P0

- 0013: real project shell and shared transaction prerequisites
- 0014: explicit OpenAI API and DeepSeek API-key providers alongside Codex (supersedes 0002's exclusivity)
- 0015: fixed Gemini API-key provider
- 0016: Luna/high Codex subscription default and current official runtime
- 0017: AI Video Editor product and repository identity
- 0018: Claude account sign-in as the default AI connection through the user's unmodified Claude Code CLI; signed-in edit/Undo/Stop/restart passed, app-button sign-in completion pending
- 0019: full AI edit with motion graphics
- 0020: the rough cut (Magic Edit) is always an AI story edit; local analysis is evidence only
- 0021: the editor is a harness for Claude: a per-project workspace and Claude Code's confined file and helper tools (amends 0018)
- 0022: Windows release: cross-packaged win32-x64, bundled LGPL FFmpeg, Windows Codex client, per-user NSIS installer, release fuses, unsigned until a certificate exists
- 0023: music and sound effects as undoable draft layers from project audio files, mixed at export
- 0024: a minimal interface with selectable themes (Light Canvas default; Cinematic changes the layout)

- 0025: transitions as undoable draft effects (dip, wipe, iris) anchored to cuts and drawn like graphics, manual and on every assistant route
- 0026: pauses and fillers tightened by the app, confirmed by audio loudness, as one undoable transaction (Natural / Balanced / Tight)
- 0027: zooms need on-screen evidence (`zoom.targets`) and gain push, pan and ease options
- 0028: a library of six designed graphic components placed with `graphics.component`
- 0029: a camera recording linked to the screen recording and layouts (screen, camera, corner) as an undoable draft effect
- 0030: Magic Edit's story edit runs on the chosen connection (Claude, Codex or an API provider) and degrades to the deterministic tightening; chats get guarded app actions (Magic Edit, Edit my video on Claude, Stop, go to a step; never export or cleanup)
- 0031: five steps (Import, Magic Edit, Refine, Clips, Export) and a Done screen; Review is removed (saved projects open in Refine); Refine is one big simple screen with a What Magic Edit did list and an Open full editor; the draft check runs by itself on export; the assistant is docked beside the page
