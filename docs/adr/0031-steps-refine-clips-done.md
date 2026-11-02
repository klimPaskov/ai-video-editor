# ADR 0031: Five steps and a Done screen; Review removed; Refine is one simple screen

- Status: Accepted user requirement (2026-11-02, play test of the Windows build); implemented, native run pending
- Scope: the project flow and stage ids (ADR 0003, 0024, 0030), Refine, Clips, Export, the assistant drawer, the shared look (docs/55)
- Supersedes: the Review step of ADR 0003 and the Review parts of docs/02, 04, 05 and 35

## User requirement

The owner played the Windows build and reported: Refine is confusing and its editor is broken; Review has no clear purpose; "the editor is not meant for manual editing, only very simple stuff, AI does the bulk"; Export is unfinished and is hidden when the chat is open; "short clips should be its own step"; after exporting "nothing appears really, I'm just stuck at the end"; the screens still do not match the references; copy is long and technical.

## Decision

### Stages

The project's stages (`workflow_step`, the `stage` of a project view, the `projects:navigate` payload) are now `record_import`, `auto_edit`, `edit`, `clips`, `export` and `done`:

| Stage | Name in the app | What it is |
| --- | --- | --- |
| `record_import` | Import | Record or bring a video. |
| `auto_edit` | Magic Edit | The AI makes the whole edit (Edit my video). |
| `edit` | Refine | One big screen to check the result and make small changes. |
| `clips` | Clips | Optional short clips from the best moments, with Skip. |
| `export` | Export | Quality and destination; an explicit Export. |
| `done` | (a screen, not a step) | After a finished export: the video is ready and what to do next. |

`review` is removed. A project saved in `review` opens in `edit` (Refine): the project store maps the saved value when it reads `project.json` (`migrateProjectStage`), nothing else in the file changes, and the next navigation writes the new value. No saved project is lost. The step bar shows five steps; on `done` all five read as finished. `done` is reached only by a completed export (never by an assistant: `app.go_to_step` accepts `record_import`, `auto_edit`, `edit`, `clips`, `export`).

### What happened to Review

- "Verify draft" (the structure and managed-source check) now runs by itself before every export, in main (`projects:verify-draft-integrity` is still available to the renderer but has no button). It says nothing when the draft is fine; if it cannot be verified the export does not start and the user sees one plain message (`exportIssues.integrity`).
- The full watch-through is Refine's big player with Full screen.
- The summary of what the automatic edit did is Refine's "What Magic Edit did" list (below).

### Refine

A large video with a play bar, a slim timeline strip with a visible playhead and small markers for zooms, graphics and captions, a **What Magic Edit did** list, and only six tools: Trim, Split, Delete part, Captions, Music, Volume. **Open full editor** opens the complete existing editor (every tool, the transcript tools, Undo/Redo, restore) over the whole window with a **Done** button back to Refine. The assistant can still do anything by chat.

The list is built in main from the draft's own transaction records (origin of the AI connections; manual edits are not listed). Draft transactions can be undone only newest first, and an effect transaction (a zoom, a graphic, a caption change, ...) carries exactly one operation, so a single item of an older kind cannot be undone safely. Each row therefore has **Undo** for the whole kind ("Cut 14 pauses", "5 zooms"): main commits one ordinary manual transaction per item that removes it (restore a cut interval, remove a zoom, remove a graphic, turn captions off, remove a sound layer, reset a speed range, remove a transition or layout), in one pass group. They are normal journal entries, so shared Undo and Redo still work, and the row then offers **Put back**, which undoes exactly those entries while they are the newest. Nothing is hidden from history and the engine is unchanged.

### Done

A check mark, "Your video is ready", a card with the thumbnail, file name, length, size and folder, **Show in folder** (primary), **Play**, and the cards Make short clips (when Clips was skipped), Edit another video, Back to Home, plus Keep editing (back to Export). Every button acts on real state (the same main handlers as before: reveal and open the exported file).

### Clips

The short-clips panel moves out of Export into its own step 4 with **Skip**. Choosing clips and Make N clips use the existing short-clip export (ADR 49) with an optional list of clip ids.

### Layout

The assistant drawer is docked beside the page: the page makes room and scrolls on its own, and Export and every step stay fully visible with the assistant open (the old rule that hid the step's panel while a drawer was open is gone). The page is a column (header, step bar, the scrolling page, then the action bar as a normal item that never overlaps the page). The drawer stays docked, a little narrower below 1100 px, down to 760 CSS px; below that it is a slide-over with a close button that ends above the action bar, and the page behind it waits, so nothing is drawn under it and the primary action is never covered (the real-window layout audit found controls drawn under an overlaying slide-over). One set of spacing, radius, type and button rules (docs/33) applies to every screen and theme; the header mark is an inline vector that takes the theme's colours.

## Consequences

- Specs, schemas and tests that named `review` are updated (docs 02, 04, 05, 33, 35, 27, 30, ADR 0003; desktop IPC, project, ui-state and screen-manifest schemas; the foundation tests; the media and native tests listed in the change). Native tests need a run in the isolated guest.
- `ProjectStage` gains `clips` and `done`; code that switched over the stages handles both.
- The inventories of assistant tools are unchanged; the step names in their descriptions are updated.
- A custom title bar is not part of this decision.
