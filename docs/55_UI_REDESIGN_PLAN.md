# UI redesign plan: a simpler flow, one finished look

Status: proposal for the owner's approval (2026-11-02). Nothing here is built yet except the silent-video fix below. Previews are in `docs/design/ui-previews/`; they show layout and mood, not final pixels.

## What the owner reported

Playtest of the Windows build: Refine is confusing and its editor is broken; Review has no clear purpose; Export is hidden when the assistant is open; after exporting there is no end; short clips belong in their own step; the UI still looks unfinished and inconsistent; copy is too long and technical; silent videos produce errors; the logo should follow the theme and not appear twice.

## The new flow: five steps and an end screen

The AI does the bulk of the editing. The app is not a manual editor; people only touch up.

| # | Step | What it is for | Main action |
| --- | --- | --- | --- |
| 1 | **Import** | Record or bring a video. | Continue |
| 2 | **Magic Edit** | The AI makes the whole edit: pacing, zooms, graphics, captions, sound. | **Edit my video** |
| 3 | **Refine** | One big screen to check the result and make small changes. Replaces Refine and Review. | Continue |
| 4 | **Clips** | Optional short vertical clips cut from the best moments. Its own step. | Make clips, or Skip |
| 5 | **Export** | Pick the quality and where it goes. | Export |
| end | **Done** | The finished video, what to do next. | Show in folder |

**Review is removed.** What it did becomes automatic or moves into Refine: the full watch-through is Refine's big player (with full screen), and "Verify draft" runs by itself when you export, and only speaks up if something is wrong.

### Refine: one big screen, very simple tools

- The video fills the screen, with a play bar and a thin timeline strip (zooms, graphics and cuts as small marks; no filmstrip to fight).
- A **What Magic Edit did** list on the side, one plain line each ("Cut 14 pauses", "5 zooms", "3 graphics", "Captions on"), each with **Undo** or **Keep**. This is the review.
- A row of only simple tools: **Trim ends, Split, Delete part, Captions, Music, Volume.** Nothing else on this screen.
- **Open full editor** (secondary button) opens the complete timeline editor full screen for anyone who wants more, with **Done** to return here. The existing tools stay, but they are no longer the step itself.
- The assistant can do anything on this screen by chat ("remove the third zoom", "make the music quieter").

### Done: an end, not a dead end

After exporting, the app moves to **Done**: a check mark, "Your video is ready", a card with the thumbnail, file name, length and size, and these actions: **Show in folder** (primary), **Play**, then **Make short clips** (if skipped), **Edit another video**, **Back to Home**, and **Keep editing**. Nothing is stuck.

### Export: always visible

The assistant panel is **docked**: the page makes room for it and scrolls on its own, so Export, Refine and every step stay visible beside it. On narrow windows it becomes a slide-over with a close button, never covering the primary action.

## One finished look

The screens feel rough because each was styled on its own. They will share one set of rules:

- **Spacing** on a 4/8/12/16/24/32 scale; **radius** 12 (controls) and 20 (cards); one card style; one shadow.
- **Type**: three sizes (title, body, small) and two weights. No all-caps labels, no hero titles.
- **Buttons**: one big primary pill per screen at the bottom right of the step, one quiet secondary, and ghost buttons for the rest. Icons on one 24 px grid, one stroke weight.
- **Layout**: each step is one centred column with the video card on top and the action below it. The same header, stepper and action bar everywhere. No disclosure ("More options") menus for things people need.
- **Themes** change only colour tokens, so every theme stays consistent. Cinematic keeps its floating-glass layout.

## Words

Short sentences, no jargon, one idea per line. Examples:

- Codex privacy note, now: a long paragraph about transcript pages, threads and later turns. New: "Codex sees your project details, the transcript and a few preview frames. Your video and audio stay on this device." Claude and the API providers get the same shape, plus "Billed to your API account" where true.
- "Edit my video", "Continue", "Export", "Show in folder": verbs people already use.
- Errors say what happened and what to do, with **Try again**, never internal reasons.

## Errors that should not exist

- **Silent or no-speech video:** done in this round. Odd word timings from the speech model (the "word times outside this source" error) now mean "no speech found", and Magic Edit finishes with "No speech found, so there was nothing to cut." instead of failing. The visual edits still run.
- Still to do: a video with no audio track at all should skip the transcript step quietly, and the Magic Edit card should say what it did instead of offering a rough cut that cannot work.

## The logo

- The header mark becomes an inline vector that reads theme colours: gold stroke on the dark lacquer tile in the dark themes and Cinematic; black stroke on an ivory tile in Light Canvas and Paper; accent-tinted in Custom.
- **Duplicate logo:** I read "not needed in the corner" as the Windows title bar repeating the icon and name that the app header already shows. The plan is to merge them: a custom title bar (the header is the title bar, with the window buttons at the right in theme colours). If you meant a different corner, tell me.
- The taskbar and installer icons stay.

## The editor in Refine ("broken"): what testing found

I ran the real packaged app on a 60-second clip of the owner's own recording and used Refine like a person would. The editing functions work (timeline click moves the playhead, play advances, split makes two clips, trim shortens, Undo and Redo reverse), so what is broken is the screen, and probably something Windows-specific I cannot see from here. Concrete problems found:

- **The video is tiny.** In the standard layout the preview is capped at about 250 px tall, so a 16:9 recording sits in a small box with wide black bars. The reference layouts use a large video.
- **The tool bar is cut off.** At 800 px window height the floating tools and "More tools" are partly below the screen.
- **Tools look disabled** (grey) at the start of the clip with no explanation, and there is no visible playhead on the timeline strip, only a separate slider above it.
- **An empty Transcript bar** sits between the video and the tools.
- **Imports with unusual frame timing fail.** A clip with irregular timing (cut by stream copy) imported but could not become a project, with only "This operation could not finish". The real cause is a strict frame-timing check in `packages/domain/src/project.ts`. Fix: accept more videos by making a constant-rate working copy when the timing is irregular, and say so plainly when a file really cannot be used.

The redesign above replaces this screen, so these are fixed by the new Refine rather than patched. I still need one thing from the owner: what exactly happened on Windows (empty timeline, buttons doing nothing, video not playing, a message?), with a screenshot if possible.

## Work plan, in order

1. **Flow and stages** (largest): replace `review` with the new Refine; add `clips` and `done` stages; migrate saved projects (`review` becomes `edit`, `export` stays); update the step bar, IPC schemas, store, assistant "go to step" tool, docs 04/05/33/35, ADR 0031, and every test that names a step.
2. **Refine screen**: the What Magic Edit did list (from the draft's own records), the simple tools row, Open full editor.
3. **Done screen** and the export-complete hand-off.
4. **Clips as a step.**
5. **Docked assistant**; fix the hidden Export; narrow-window slide-over.
6. **Design system pass**: tokens, buttons, cards, icons, copy; custom title bar; themed logo.
7. **Silent-video path** end to end.
8. Layout audit and native tests on all five themes; rebuild the Windows installer for the next test.

## Open questions for the owner

1. Is five steps plus a Done screen right, with Review removed and Clips as its own step?
2. Should Clips always be offered after Refine, or only when the video is long enough to have good moments?
3. Is the title-bar merge what you meant by the corner logo?
4. What exactly was broken in Refine?
