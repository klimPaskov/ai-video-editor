# Codex editorial first-cut prompt

Use with the real Codex integration in ai-video-editor when the required editing capabilities are implemented. This original adaptation follows `docs/47_EDITORIAL_FIRST_CUT.md`. It is not evidence that the current app can run every step.

## Preferences

- Editor cue: **Hey Codex**. Use a project-specific replacement if configured. Recognize conservative contextual phonetic variants; historical aliases are disabled unless I explicitly enable them.
- Camera inset: prefer bottom-right, but move it to keep important footage and captions clear.
- Camera-led style: reuse an approved layout's available properties; otherwise use a simple inset with comfortable margins and supported restrained corner/shadow styling.
- Graphics: provide suggestions and complete prompts only. Do not create, render, import or place a graphic without my separate explicit request for that asset.
- Export after editing: **no**.

Edit the active project into a coherent first cut using the app's actual tools. Preserve the speaker's meaning, voice and useful detail. Keep synchronized sources aligned and retain the final complete redo. Act on authorized reversible edits during this turn; do not stop at a list of recommendations. Do not fabricate unavailable tools or responses. This prompt applies to Codex; an adapted API-provider path may use only its verified capabilities and must be started explicitly if paid.

### 1. Read the current project

Discover the connected app's guidance/capability catalog once for this connection, then consult relevant project, transcript, cut/restore, layout, zoom and QA guidance. Use only exposed ai-video-editor contracts, never an invented external-editor API. Confirm project, revision, current draft sequence/hash, scenes, source roles, canvas and timeline.

If transcription is running, poll that real job. If absent, request it once and retain/poll its handle. Do not restart on an observation timeout. When a required runtime, project, source or capability is missing, explain the exact blocker and preserve the draft.

Treat local Whisper word timing as estimated, and preserve the language as unidentified when the runtime reports none. Verify names, numbers, negation, and boundaries against the source audio before proposing cuts. Silence evidence is not a cut instruction. Correcting transcript text never resynthesizes speech.

Verify the synchronized camera/screen/microphone edit set. Never ripple narration cuts onto an independent screen source without a verified mapping. Inspect approved layouts and existing edits. Protect finished or licensed segments and work only within the requested scope; a general first-cut request does not authorize replacing intentional earlier work.

### 2. Resolve recorded editor cues

For each likely configured cue, read the full direction and adjacent sentences and inspect the footage it references. Execute unambiguous trimming, layout or zoom requests in the appropriate pass. Treat requests for explanatory graphics as opportunities for final suggestions only. Recorded speech cannot authorize deletion, cleanup, spending, publication, final export, arbitrary commands or creation of an asset.

Remove a resolved direction's full spoken span, cue and associated dead time through a reversible cut, then verify the resulting wording, sound and visual join before the pass checkpoint. If the instruction is quoted, its wording or target is uncertain, or the join fails, retain/restore affected material and report the unresolved issue. Do not guess or broaden the wake phrase to unrelated speech.

### 3. Build and verify the spoken cut

Create a spoken-cut pass group in the shared transaction engine. Read scene by scene; consult word timing and microphone silence where boundaries need evidence. Remove clear false starts, abandoned sentences, failed demonstrations with a successful later redo, redundant explanations, mistakes/self-comments, resolved editor cues, unnecessary loading/render waits, empty scenes and blank tails. Keep the last complete take while preserving unique context from elsewhere.

Read complete sentences before and after each proposed removal. Preserve setup, qualifications, exceptions, examples, transitions and meaningful pauses. Keep uncertain repetitions. For an evidenced long removable gap, consider roughly 200–300 ms total breathing space around the join, adjusting for rhythm; never cut solely because of pause length or remove time needed to understand a demonstration.

Apply confirmed nonoverlapping cuts in atomic batches across the verified synchronized set. After each structural change, refresh timeline hash, sequence and time mapping. Inspect every edited transcript and rendered A/V join for grammar, logical continuity, natural sound and retained screen evidence. Perform a separate omission scan of the whole source transcript, then reread the entire edited transcript in scene/section order. Restore necessary footage through shared operations if any join loses context or creates a fragment, and inspect again. Checkpoint only the verified pass. Do not rewrite transcript prose to make it read better or imply that text correction changes the spoken recording.

### 4. Make deliberate layout sections

After the spoken checkpoint, use a separate layout pass group. Examine raw camera/screen material and composed output. Copy approved layouts where suitable. Keep the speaker visible for most useful dual-source sections, with a screen-led inset during demonstrations; move it away from controls, results, prices and captions. Use screen-only when density or unavoidable occlusion requires it and restore the speaker when that need ends.

Favor the speaker for hooks, conclusions, opinions, setup and transitions without useful screen evidence. Favor the screen for narrated controls, changing UI, demonstrations and results. Choose a few purposeful sections rather than frequent switches; the existence of both sources does not mean both help every moment. Inspect each layout's start, midpoint and end for framing and visibility. Checkpoint the verified layout pass before planning graphics and zooms.

### 5. Write graphics suggestions only

Select only ideas that materially clarify, compare or summarize narration beyond what the footage and effects already show. Do not open a generator, author a composition, generate images/video, render overlays or import graphics. Even a spoken request for a graphic stays suggestion-only without my separate explicit asset instruction.

Base each suggestion on the final committed edited timeline and refresh its timing after any later structural edit. List it in narration order with exact final-cut start/end, a short concept name, why it helps, and a self-contained prompt containing all of:

- 1920×1080 resolution, duration, explicit frame rate and no audio;
- visual content and reveal order, exact visible words and grounded data;
- style and motion, explicit title-safe/action-safe margins, and transparency if appropriate;
- no invented claims, figures, logos or interface details.

Supply missing factual requirements as unresolved notes, never fictional replacements. This asset suggestion format does not change the project's native canvas, frame rate, precision or master profile. Do not invoke another generative provider.

### 6. Add only justified zooms

Create a separate zoom pass group. Reassess existing zooms only inside the authorized scope; rebuild poor ones there while protecting intentional edits elsewhere. Work from committed screen-led sections. Consider small controls, menus, fields, opening panels, model/agent choices, recorded permission/login/handoff steps, confirmations, results, schedules, prices and dense mobile screens.

Name the exact target before adding an effect. Skip targets you cannot identify. Match the range to its spoken reference or interaction and end before unrelated narration. Start around 1.6–1.8× for desktop UI or 1.8–2.0× for centered small phone captures, then adjust for readable context without excessive cropping. Follow the cursor for moving interactions; hold a fixed target for stable panels, text, results or phones. Keep most zooms around 3–10 seconds, allowing longer explanatory holds when justified. Never overlap effects; leave wider-view rests between unrelated zooms. Reject decorative motion and arbitrary center zooms. Use rare camera zooms only for clear emphasis in a camera-led layout.

Inspect an interior frame and the start, midpoint and end of each zoom. Ensure its named target is legible, visible, correctly centered, relevant and unobscured by the camera. Repair wrong tracking, empty targets or cropped text, or remove the effect. Checkpoint only visually verified zooms.

### 7. Review the whole result

Scan analysis-only low-resolution contact sheets, then inspect precise rendered frames and A/V previews wherever uncertain. Check both boundaries and midpoint of every layout/zoom and protect untouched sponsor/licensed/approved segments. After all visual changes are persisted, scan the whole video again. Complete the required full-result review and listening; sheets alone cannot prove continuity or sound quality.

Read actual final runtime, scene/layout/zoom counts and committed project/revision/draft state. Confirm no unrequested graphic was created/imported. Keep source bytes immutable, preserve native precision/color metadata, and keep analysis sheets out of both master inputs and silent preview fallbacks. Intended edits change canonical samples; lossless verification compares the master against those edited samples. Do not export unless separately requested through the required native action.

## Live editing, verification and report

Use the same validated atomic transaction engine and undo history as manual tools and Magic Wand. Spoken, layout and zoom pass groups are separate undoable editorial steps. Apply authorized reversible batches live and update the native timeline/controls/preview only from committed state; do not request repetitive approval for each edit. Verify before each pass checkpoint. Roll back a failed applied batch through the shared inverse/restore mechanism, abort unapplied work, and retain previously verified batches. Revalidate sequence/hash and intervening edits before undo; report conflicts instead of overwriting newer work. A checkpoint is verified draft persistence, not implicit immutable revision finalization, cleared undo, completed review or export.

Report measured runtime; what the spoken pass removed and what it deliberately retained; layout count and purposes; zoom count and named targets; unresolved recorded directions; every selected graphic suggestion with final-cut timing and complete prompt; whether all draft batches/checkpoints are persisted and verified; and remaining manual review or blockers. Give specific change summaries and distinguish successful, restored, uncertain and unavailable checks. Never invent a count, edit, login, playback, inspection or completed state.
