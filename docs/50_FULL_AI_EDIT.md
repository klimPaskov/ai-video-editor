# Full AI edit

The full AI edit hands a video to an assistant (Claude by default) that edits it from start to finish, or improves an existing edit. Decision record: [ADR 0019](adr/0019-full-ai-edit.md).

## User flow

1. In a project, the user chooses **Edit with Claude** and writes a short brief: what the video is for, who watches it, the style (for example calm and clean, or energetic), and how far to go (**Tidy**, **Polished** or **Bold**). Defaults work without a brief.
2. The assistant works through the video: it reads the transcript and timeline, looks at frames, tightens pacing, and adds zooms, speed-ups, captions, titles, lower thirds, callouts and transitions. Progress shows as plain steps ("Reading the transcript", "Adding a title card at 0:00").
3. **Stop** ends the run at any time; everything done so far stays and can be undone.
4. When it finishes, the assistant summarises what it changed. **Undo all** reverts the whole run. **Polish with Claude** starts another run on the current edit.

## Motion graphics

A graphic is stored in the draft as:

- `graphic_id`, `name`
- an anchor: a source recording and a time in it; the graphic starts where that moment plays in the edit, so it follows later cuts
- `duration_us`: how long it stays on screen, in output time
- `html` and `css`: one HTML fragment and its stylesheet, each at most 64 KiB
- `layer`: its stacking order among graphics

The stage is the output size (for example 1920×1080) with a transparent background; graphics draw over the video and under captions. CSS custom properties give the size (`--stage-width`, `--stage-height`) and a safe area. A graphic's animations start at its own start time; the renderer seeks each animation to the exact frame time, so preview and export match.

Content rules: no `<script>`, event-handler attributes, `javascript:` URLs, iframes, forms or external resources. Images are inline `data:` or inline SVG. The stage page's Content Security Policy enforces this; the validator rejects such content before it is saved.

## Assistant tools

Existing: project, timeline and transcript reads; split, trim, range cuts, restore, transcript corrections; zooms and speed.

Added for the full edit:

- `graphics.set` / `graphics.remove`: add, replace or remove a graphic.
- `media.get_frames`: rendered pictures of the edit at chosen output times, with zooms, captions and graphics, so the assistant can check its work.
- `captions.configure` and `audio.configure`: the same choices as the Auto Edit cards.

Every edit checks the current draft head and is one undoable transaction; the full-edit run uses one pass group so it can be undone together.

## Editing playbook

The full-edit mode gives the assistant a written playbook (`docs/prompts/FULL_AI_EDIT_PLAYBOOK.md`, bundled with the app). It covers: understanding the video before editing; pacing (remove dead air, keep breathing room); readable text (on screen long enough to read twice, high contrast, inside the safe area); a small consistent visual system (one or two typefaces, the brand colour, the same easing and durations); motion that guides attention rather than decorates (enter 300–600 ms, eased; hold; exit); zooms only where detail matters; transitions only between sections; no overlap with captions or important on-screen content; and checking each graphic with `media.get_frames` before moving on.

## Status

In progress. Implemented parts are listed below as they land.

## Implemented: graphics rendering (2026-10-07)

- **Stage.** `stage.html` is served with its own Content Security Policy (inline styles and `data:` images only; no scripts, network, frames or forms). `stage-control.ts` keeps one shadow root per graphic and seeks each graphic's CSS animations to the time since it started. It reports whether the picture can have changed, so unchanged frames are reused.
- **Preview.** A transparent, pointer-transparent iframe of the stage sits over the displayed picture, scaled from the output size, above zooms and below captions. The timeline strip shows each graphic as a labelled block.
- **Export.** In main, an offscreen window renders the stage frame by frame at the output size. Captures are premultiplied BGRA. Frames with graphics are grouped into segments (gaps under 2 s are joined with transparent frames), and each segment is encoded losslessly (FFV1). The compositor overlays each segment after zooms and before captions; for short clips, before reframing. The overlay runs in the video's own layout (`yuv420`, `yuv422`, `yuv444`, their 10-bit forms, or RGB), so frames without graphics stay bit-identical. Videos at other precisions are refused with a clear message. Each segment's overlay draws only while it has frames, because the overlay's frame counter in `enable` expressions proved unreliable.
- **Editing.** `projects:manual-graphic` and `projects:manual-graphic-remove` add, replace and remove a graphic at an output time; main anchors it to the source moment shown there.
- **Evidence.** `tests/media/graphics.test.ts`, the graphics cases in `tests/media/draft-transactions.test.ts` and `tests/media/export-render.test.ts` (BGRA and 4:2:0: only the segments' frames change and the drawn box is correct), and packaged `tests/native/graphics.test.ts` (unsafe content refused, preview shows the seeked graphic, timeline block, verified master with exactly the 45 frames under the graphic changed and the box in place, Undo).
