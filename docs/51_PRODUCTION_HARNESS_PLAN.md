# Production harness plan

Status: plan agreed with the user on 2026-10-18; owned by the implementer. Decision records: ADR 0020 (AI rough cut), ADR 0021 (Claude harness). This document says where the work is going, in what order, and how we know it is done. Update the status column as milestones land.

## Goal

**On the user's two recordings, the app makes a video that looks like a high-budget production, made for this video and no other.** Concretely:

1. One action makes the rough cut: Claude reads the whole recording and makes a story edit (repeated ideas, retakes, false starts, tangents and dead air removed; the story kept).
2. One action makes the production: Claude designs and builds a visual identity for this video. It writes bespoke motion graphics as HyperFrames compositions with real animation code, adds music and sound design from the user's media, zooms and pacing. It checks its work by watching rendered motion, not only stills, and iterates until the result meets the quality bar.
3. The user keeps directing Claude in the same conversation ("make the intro punchier", "use our blue"); every change is undoable; the recordings are never modified.
4. Preview, Claude's pictures and the lossless export show the same frames, verified.

The goal is met when a signed-in run on the supplied recordings produces such an edit end to end in the packaged app, the result is reviewed by watching it, and the lossless master verifies. No step is done by a fixed rule or a template where a model should decide.

## Principles

- **The app is a harness, not a tool pack.** Claude plans, writes, reviews and iterates in its project workspace with its own file and helper tools and the user's own skills. The app supplies rendering, verification and safety rails: the timeline changes only through guarded, undoable edits; sources are immutable; export, deletion and spending are the user's actions; no shell, code execution on the host or open network.
- **A model is always in the loop where judgement is needed.** Local analysis (pauses, fillers, repeats, beats, loudness) is evidence for Claude, never a decision.
- **No presentation look, no bulk generation.** Graphics are designed for the specific video: a visual concept, a motion language and craft at the level of a professional studio. Stock templates, registry blocks dropped in unchanged, and graphics generated in bulk by a fixed procedure are out. The guides and system prompt demand effort and uniqueness.
- **Best of HyperFrames, Remotion and Claude Motion.** HyperFrames' seekable HTML compositions and runtime protocol, Remotion's frame-as-a-function-of-time model (reachable through the remotion-to-hyperframes skill), and Claude Motion's animation-as-editable-code authoring. Any seekable page works: GSAP, Lottie, three.js and WebGL shaders, anime.js, canvas or Claude's own code.
- **Assets.** Default: Claude may use any audio, image or video the user has in Media, copyrighted material included; monetization is not a concern. A setting switches to copyright-free material only. Claude never downloads media; it uses what the user imports.

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| M0 | Foundations: AI rough cut (ADR 0020), harness workspace and confined Claude Code tools (ADR 0021), the user's own skills, quiet timeline strip, real signed-in acceptance | Done 2026-10-18 |
| M1 | Compositions play everywhere | Core done 2026-10-18; export and preview parity checks open |
| M2 | Composition toolchain for Claude | Motion sheets and `composition.check` done 2026-10-18; real Claude iteration open |
| M3 | Music, sound and asset layers | Asset setting done 2026-10-18; layers planned |
| M4 | Production direction and model routing | Direction rewritten 2026-10-18; model routing planned |
| M5 | End-to-end production on the supplied recordings | Planned |
| M6 | Spec sync, release checks | Continuous |

### M1: Compositions play everywhere

A HyperFrames composition in Claude's workspace becomes a graphic in the edit and plays identically in preview, Claude's pictures and export.

- Done: `graphics.set` accepts `composition_path`; the importer inlines local files, maps pinned jsDelivr libraries (gsap, lottie-web, three, animejs) to a local cache and refuses other network references with a reason; sealed pages are stored by hash and served on the `composition` host under a no-network policy; the vendored HyperFrames runtime (Apache-2.0) and the stage bridge are injected; the stage plays each composition in a sandboxed frame (opaque origin) and drives it by seek messages; export waits for every composition to confirm its seek; render errors go back to Claude.
- Done since: the runtime reports ready and seeks through its player; the frame is transparent over the video; `tests/native/composition.test.ts` passes (the export-path picture at 1 s shows the GSAP box where its timeline puts it, over the video; the preview uses the sealed frame).
- Open: a full lossless export with a composition, frame parity between preview and export, composition audio and video elements, export capture performance.
- Done when: the native test passes, an export with a composition verifies, and frames match between preview, pictures and export.

### M2: Composition toolchain for Claude

What the skills ask of `npx hyperframes`, as app tools that run against the workspace, so the skills work unchanged in spirit:

- `composition.check` (done 2026-10-18): seals the workspace file, plays it in the sealed stage at the video's size and reports readiness, script errors, duration, timelines, canvas size, text cut off, outside the safe area or too small, and frozen motion, with a contact sheet of the audited moments (this also covers snapshots at chosen times). Contrast and overlap are not audited yet.
- Motion review (done 2026-10-18 as `media.get_frames` with `layout: "sheet"`): up to 16 moments through the export path tiled into one picture, so Claude judges motion, timing and easing, not single frames.
- Placement stays `graphics.set`; replacement keeps the graphic ID so iteration is undoable.
- The system prompt maps the skills' CLI commands to these tools (done 2026-10-18 for lint, check and snapshot).
- Done when: a scripted run iterates a composition through check, snapshot and motion and places it; a real Claude run does the same.

### M3: Music, sound and asset layers

- Timeline layers for music, sound effects and image or video overlays from Media, with gain, fades, ducking under speech and loudness, all as undoable draft edits that export losslessly.
- Local analysis as evidence for Claude: beats and downbeats, sections, loudness, speech regions (for music-to-video and pacing).
- The asset setting (any material by default, copyright-free only as the alternative) is passed to Claude with the media list; tools list Media with kind, duration and the user's own labels.
- Compositions can use these assets (images, audio-reactive data) through the workspace.
- Done when: Claude adds a music bed that ducks under speech and a few sound effects, the export verifies, and the setting changes what Claude picks.

### M4: Production direction and model routing

- System prompt and guides rewritten for a high-budget production: work out a visual concept from the content and brief; write a style frame and motion language in notes.md before building; design each graphic for its moment; review motion with the motion tools and the reviewer helpers; iterate until it meets the bar; never use a presentation look, stock templates or bulk generation.
- Reviewer helpers with an explicit quality bar (story, joins, motion, typography, consistency, legibility, sound).
- Per-stage model settings: rough cut defaults to Haiku 5.5, production to Opus 5.5, both changeable and checked against the live catalog.
- Done when: a real production run follows the process (concept, build, review, iterate) visibly in its workspace and conversation.

### M5: End-to-end production on the supplied recordings

- Run rough cut and production in the packaged app on the two recordings; watch the result (computer use and rendered frames); direct changes in the conversation; export the lossless master and verify it; record evidence (aggregate only) and the honest gaps.
- Done when: the Goal above is met.

### M6: Spec sync and release checks (continuous)

- Every slice updates specs, schemas, tests, skills, traceability and the decision records; full check and native tests pass; commits stay local until the user asks to publish.

## Risks and open questions

- GSAP's licence is not clearly written for bundling in a desktop app, so it is fetched from jsDelivr on first use and cached locally rather than vendored. Remotion needs a paid company licence for many teams and is not bundled.
- Capturing compositions frame by frame may make exports slow; measure in M1 and optimize (skip unchanged frames, parallel capture) if needed.
- Real-model runs spend the user's Claude usage; long production runs need limits and resumable work.
- Copyrighted material used by default can lead to claims, muting or blocking on some platforms, not only lost monetization; the user chose this default.
- Windows packaging and the app's own sign-in button remain separate open items (ADR 0018).
