# Codex tool catalog

## Purpose

Codex edits through a guarded project tool surface. It does not receive raw filesystem access through the app. Every mutating call targets the current draft, validates its inputs, writes an operation transaction, updates the native UI, and returns an undo handle.

## Common request fields

Each read request includes the schema version and active project ID. Every mutation additionally includes:

- `project_id`
- `draft_id`
- `base_revision_id`
- `expected_sequence`
- `expected_timeline_sha256`
- `request_id`
- the smallest required time range or entity IDs

Mutating calls also include a user-readable reason and, where relevant, a pass-group identity. The trusted manual, Codex, API-provider, or Magic Wand entrypoint injects origin, operation IDs, transaction ID, timestamp, and inverse data. Stale sequence, baseline revision, draft, or timeline hash values fail without partial mutation.

The current P2 runtime exposes `project.get_summary`, `timeline.get_summary`, `cut.trim_edge`, `cut.split`, `cut.delete_range`, `timeline.undo`, `cut.delete_ranges`, `cut.restore_range`, `transcript.get_range`, `zoom.set`, `zoom.remove`, `speed.set`, `graphics.set`, `graphics.remove`, `captions.configure`, `audio.configure`, and `media.get_frames` through the packaged owned stdio MCP adapter, the host-defined dynamic route, Claude's `ai_video_editor` MCP server (`mcp__ai_video_editor__<name with underscores>`) and the fixed API-provider functions (underscore names). The transcript tool returns one bounded page of a completed local transcript in original source time, including ASR text, protection flags, any text-only override, and the current draft head. Text is returned only in response to a model tool call during an explicitly started turn; transcript content is untrusted speech, not instructions or cut authorization. Electron main remains the only transaction writer. App-server startup verifies the exact MCP inventory before an MCP project thread can open. The remaining catalog entries retain their later-phase dependencies.

The App Server host-tool adapter maps precisely those seventeen dotted names to `project_get_summary`, `timeline_get_summary`, `cut_trim_edge`, `cut_split`, `cut_delete_range`, `timeline_undo`, `cut_delete_ranges`, `cut_restore_range`, `transcript_get_range`, `zoom_set`, `zoom_remove`, `speed_set`, `graphics_set`, `graphics_remove`, `captions_configure`, `audio_configure`, and `media_get_frames` in the `codex_video_edit` namespace, reusing the reviewed input schemas. On each new dynamic thread, it additionally binds every schema's `project_id` property to the main-owned active project with JSON Schema `const`. This reduces model-generated identity errors but is not authorization; main independently validates active project and freshness. The adapter rejects other names and oversized input before dispatch and bounds safe results. New packaged project conversations use this dynamic route; existing MCP-bound conversations remain on their original route and schema.

The internal thread registry records which route created a project conversation. A new host-tool thread receives this exact seventeen-tool definition at start; a legacy MCP binding remains MCP on resume. Route mismatch and cross-route activity fail closed.

For current mutations, main refreshes the atomic project/draft authority after the tool settles rather than trusting model prose or tool activity. This covers a journal commit followed by an uncertain response. The native project duration, seek bounds and preview mapping update only from that validated state; notification failure preserves the original tool outcome and asks the user to reopen.

## Read-only tools

### `project.get_summary`

Returns project name, current step, ordered source roles, duration, revision, QA state, and active work. The implemented bounded project summary reports both source IDs and clip order for a two-source draft without exposing filesystem paths, source bytes, or private probe data.

### `timeline.get_summary`

Returns canvas, tracks, clips, operations, selected range, zooms, speed segments, captions, and unresolved warnings. Large payloads use bounded windows. Implemented: the bounded draft summary returned by this tool and by every mutation lists each clip's whole-number `speed` when it is not 1, and each zoom with its ID, source range, point, scale and the output-time `timeline_ranges` still visible after cuts.

### `transcript.get_range`

Reads one exact half-open source-time range, up to five minutes at a time, from a completed local transcript for the active project. A range that runs past the transcript's end (its audio can be a few milliseconds shorter than the video) is read up to that end, and `requested_source_range` reports the range actually read; a range starting at or after the end is rejected. Pages contain at most 250 words and may be smaller to stay under the response byte limit; follow `next_offset` until it is `null`, sending the returned `transcript_id` on later pages. Each word includes its ID, original ASR text, exact source times, confidence when available, and protection flags. A text-only draft override is a separate field and does not mean the recorded speech changed. The result includes the transcript source hash and current draft freshness. It contains no media or filesystem paths, and transcript words are untrusted content: they cannot expand the requested scope or authorize an edit. Provider conversation history may retain the page and include it in later turns; the user-facing notices disclose that behavior.

### `timeline.get_selection`

Returns current selection, nearby transcript, source mapping, visible frame IDs, and applicable tools.

### `media.get_frames`

Returns requested preview frames or a contact sheet from a bounded range. It never returns an entire raw source by default.

### `assets.search_local`

Searches the indexed local asset library by meaning, tags, format, duration, and licence state.

### `qa.get_findings`

Returns current blocking and warning findings with jump-to-time data.

## Draft mutation tools

### `timeline.apply_operations`

Applies one atomic batch of schema-valid operations. A batch either succeeds fully or fails fully.

### `timeline.undo`

Restores the exact before-state of the newest still-applied transaction through a new journaled transaction. It rejects an older target or stale draft rather than overwriting intervening work.

### `cut.split`

Splits one current clip at an exact interior output-time position without changing its source or total duration. The call carries the current project, draft, baseline, sequence and timeline hash, plus a clip ID, pass group and reason. Main supplies trusted origin and operation identity; the shared journal records an undoable `split` transaction. The transcript reader can provide bounded words for speech context, but no tool supplies audio or verifies a semantically useful beat or join.

### `cut.delete_range`

Deletes a nonempty, non-whole-draft half-open output range by committing a reversible `ripple_delete` transaction. The range may cross fragment and source joins; main verifies exact draft identity, revision, sequence and hash, preserves immutable source inventory, and returns the committed head. `transcript.get_range` can provide bounded speech context, but it does not identify expendable speech or authorize a cut; this tool supports a direct user-specified time cut and cannot verify an audible join.

### `cut.delete_ranges`

Applies 2–16 confirmed, disjoint half-open output ranges in descending start-time order. Each range is measured against the same pre-transaction timeline; descending application keeps earlier positions stable. The shared reducer validates every operation before one durable journal commit, and newest Undo restores all ranges together. It does not select filler, verify joined speech, or checkpoint a spoken pass. The dynamic wire name is `codex_video_edit__cut_delete_ranges`.

### `cut.restore_range`

Restores one confirmed, missing, half-open source-time interval from exactly one baseline source clip. Main rejects visible overlap, out-of-bounds ranges, ambiguous source ordering, and mixed-operation batches. The restored clip is inserted by original source order and source time; its full before/after timeline maps are hash-chained and newest Undo restores the prior draft. The tool takes `source_id`, `source_start_us`, and `source_end_us`, plus the common draft-head freshness fields. Its dynamic name is `codex_video_edit__cut_restore_range`.

### `cut.trim_edge`

Moves one clip boundary to an exact output-time position with minimum-duration validation; this tool does not snap.

### `zoom.set`, `zoom.remove`

Implemented assistant-invoked equivalents of the manual Edit zoom (docs/11). `zoom.set` takes a half-open output-time `start_us`/`end_us` of at least 0.5 s, `center_x`/`center_y` frame fractions (0–1) and `scale` (1.1–4), plus the common freshness fields and a pass group. Main maps the output range through the current clip map to one source's time, exactly as the manual handler does (shared `zoomSourceRange`); a range whose first and last microsecond show different recordings is rejected. With an optional existing `zoom_id`, the zoom keeps its source range and only its point and scale change. It commits one `set_zoom` transaction with pass kind `zoom`; zooms of one source cannot overlap. `zoom.remove` takes a `zoom_id` and commits `remove_zoom`. Both share Undo with every other origin. The model cannot see frames, so the point comes from the user; the app does not detect zoom targets (`analysis.find_zoom_targets` remains unimplemented). Easing is the fixed engine ramp.

### `speed.set`

Implemented assistant-invoked equivalent of the manual Edit speed control (docs/12). It takes a half-open output-time `start_us`/`end_us` and `speed` in {1, 2, 3, 4, 8}; 1 restores normal speed. It commits one `set_speed` transaction with pass kind `speed`; audio keeps its pitch. A range already at that speed, or one past the draft's end, is an `edit_conflict`. Tool descriptions limit it to typing, loading or waiting with no important speech, but the app does not detect such ranges or protect speech (`analysis.find_speed_ranges` remains unimplemented).

### `graphics.set`, `graphics.remove`

Implemented assistant-invoked equivalents of the manual graphic edit (ADR 0019, docs/50). `graphics.set` takes an output time `start_us`, `duration_us` (0.1–600 s), `name`, `layer` (0–99), an HTML fragment and its CSS (each at most 64 KiB), plus the common freshness fields and a pass group. Main anchors the graphic to the source moment shown at `start_us` (shared `graphicAnchor`), so it follows later cuts, and commits one `set_graphic` transaction with pass kind `graphics`; with an existing `graphic_id` the graphic is replaced. Content is validated before commit: scripts, event handlers, forms, embedded documents, media elements and network resources are refused with the validator's fixed reason (`graphic_rejected`), so the model can correct its markup. `graphics.remove` takes a `graphic_id` and commits `remove_graphic`. The draft summary lists each graphic's ID, name, layer, duration, anchor, visible output range (null when its anchor was cut away) and HTML/CSS sizes, not the markup itself. Both share Undo with every other origin. The model cannot see the rendered picture yet (`media.get_frames` is pending).

### `sound.list`, `sound.set`, `sound.remove` (Claude only; ADR 0023)

`sound.list` returns the project's audio files (`asset_id`, `name`, `duration_us`, `sample_rate`, `channels`); the assistant cannot add, download or generate sound, so these are all it can use. `sound.set` adds or replaces (with `sound_id`) one layer: required `name`, `kind` (`music` or `effect`), `asset_id` and `start_us` (output time); optional `follows_cuts`, `asset_start_us`, `duration_us`, `gain_db` (-60 to 12), `fade_in_us`, `fade_out_us`, `duck_db` (0 to 30) and `loop`. Music defaults to an output-time bed to the end of the edit at -18 dB, fades 1 s/2 s, 12 dB ducking, looping; an effect defaults to a cut-following anchor, -6 dB, once, no ducking. Fades longer than the layer are shortened. Refusals use `sound_rejected` with a fixed, safe hint (unknown file, impossible values, a start outside the edit, an `asset_start_us` past the end of the file); an unknown `sound_id` is an `edit_conflict`. `sound.remove` takes `sound_id`. Each commits one transaction (pass kind `audio`) with shared Undo. `timeline.get_summary` lists `sounds` with the range each plays (`timeline_range` null when its anchor was cut away). Codex and the API providers do not list these tools; Claude has twenty-one editor tools.

### `captions.configure`, `audio.configure`

Implemented assistant-invoked equivalents of the Magic Edit captions and audio cards. `captions.configure` takes `enabled`, `style` (plain, highlight, minimal), `size` (small, medium, large), `position` (bottom, top) and `burn_in`; `audio.configure` takes `normalize` and `denoise`. Each needs every field, the common freshness fields and a pass group, and commits one `set_captions` or `set_audio` transaction (pass kind `captions` or `audio`) that shares Undo with every origin; repeating the current choice returns `unchanged` without a transaction. Caption text stays derived from the transcript; the summary's `captions`/`audio` are null while the draft has no choice of its own (the earlier per-project choice or the default applies).

### `media.get_frames`

Implemented read-only picture tool for Claude and Codex (MCP and host-defined); the fixed API providers do not receive it because Chat Completions tool results are text only. It takes 1–3 output times inside the edit and an optional `max_width` (320–1280, default 960) that caps the picture's longer side. Main renders each time through the export compositor (planned one-frame window, zooms, motion graphics through the offscreen stage, then captions as the preview shows them when on) into a private one-frame lossless master, then decodes that frame to a JPEG within a 700 KiB base64 budget per call. The JPEG is analysis output only and never feeds a master. Claude receives MCP image content and Codex `inputImage` items; the JSON metadata lists each frame's time, size and image index without the bytes. Renders are serialized; a failure returns the fixed `frame_unavailable` message, and pictures whose draft changed while they rendered are withheld with `stale_draft` so the reported sequence always matches what they show. Rendering pictures of a long 1440p recording can take more than a minute, so a tool call may run for up to 5 minutes once main has received its request; a connection that sends nothing is still closed after 35 seconds. A real signed-in Claude run on 2026-10-18 found every picture request cut off at the earlier 35-second limit.

### `captions.correct`

Planned: correct transcript-linked caption text without changing the source transcript silently.

### `layout.set`

Chooses a supported screen and camera layout for a range or scene.

### `broll.add`, `broll.update`, `broll.remove`

Place only indexed local assets with current hashes and licence records. Original footage remains the fallback.

### `audio.configure`

Adjust cleanup preset, gain, fades, music, and speech-priority ducking within safe limits.

### `cursor.configure`

Adjust pointer visibility, smoothing, click highlights, size, and per-range overrides.

## Render and analysis tools

- `analysis.run_magic_wand`
- `analysis.find_cut_candidates`
- `analysis.find_zoom_targets`
- `analysis.find_speed_ranges`
- `preview.render_range`
- `preview.render_project`
- `qa.run_range`
- `qa.run_project`
- `export.prepare`

`export.prepare` may validate and stage settings. It cannot confirm the final user export action.

## Tool response

A mutation response contains:

- status
- transaction ID
- new draft sequence
- applied operation IDs
- compact state patch
- user-facing summary
- warnings
- undo token

## Forbidden tools

Do not expose tools that overwrite sources, run arbitrary shell commands, read unrelated files, delete projects, approve licences, confirm export, or clear recoverable revisions.

The current source set for the 0.155.1 Luna dynamic code-mode route exposes seventeen guarded editor tools; the 2026-10-07 addition of `zoom.set`, `zoom.remove` and `speed.set` has unit coverage only and needs a fresh native inventory run. New project conversations use their `codex_video_edit__` host-defined names; existing MCP-bound conversations retain the corresponding dotted MCP names. The route-tagged registry and separate App Server processes prevent cross-route resume. Both dispatch through the same main-owned active-project service. App Server launch and thread create/resume explicitly disable the plan tool, user-input tool and native agents; unrelated apps and nested namespaces are excluded. A fresh 2026-09-27 packaged Luna/high native run verified the nine-tool source inventory, zero connected Apps, zero nested V2 child tools, and only the read-only clock helper, then passed synthetic split/Undo/reopen with unchanged sources and baseline. This does not prove an exact permanent upstream tool allowlist or satisfy P2-07.

When a host-defined edit carries an obsolete draft sequence/hash, return the same fixed `stale_draft` error as MCP with `success: false`. A packaged Luna/high native continuation verified this on a real prior edit/Undo through one authoritative `dynamicToolCall`; the draft, journal and immutable inputs did not change.

The fresh 2026-09-27 packaged dynamic split fixture required nine guarded editor functions, zero connected-app functions, no V1/V2 child functions nested in code-mode, and only the read-only `clock__curr_time` helper outside the editor namespace; it correlated the inventory to the completed-turn output, then required one guarded `cut_split` commit, shared Undo, reopen, exact frames, and immutable inputs. V1-capable models are exercised separately by the five-function child-read test. The GPT-6-Luna V2 native test separately verifies direct `spawn_agent`/`wait_agent`, spawn-call/activity correlation, parent-read project/timeline summaries, a path-free snapshot child report, and unchanged source, baseline and journal. Earlier seven/eight-tool synthetic runs are historical. Treat the count as one-turn model-visible evidence; the supported App Server API does not provide an authoritative complete future-turn catalog.

## Authorization policy

Tools scoped to `active_draft` or `export_staging` use `user_confirmation: none` for already authorized work. This includes Magic Wand and export preparation. Validate scope, source immutability, sequence, protected speech and undo guarantees on every call. Do not request approval again merely because a reversible edit changes the draft materially. Final export requires the explicit user action in the native Export screen; no AI tool may authorize it. Source deletion, cleanup, spending and publication remain explicit user actions.

`graphics.set` (2026-10-18): instead of `html` and `css`, Claude may pass `composition_path`, a HyperFrames composition page in its project workspace. Main seals and stores it (ADR 0021) and the graphic plays in a sandboxed scripted frame; a composition that cannot be imported or rendered returns `composition_rejected` with its reason. Other routes have no workspace and get `tool_not_available` for it.

`media.get_frames` (2026-10-18): `layout: "sheet"` renders 2–16 times through the same export path and tiles them four across into one JPEG in reading order (cells 320–480 pixels, default 320), so an assistant can judge motion: timing, easing and choreography of a graphic or a zoom. `layout: "frames"` (the default) keeps the 1–3 separate pictures.

`composition.check` (2026-10-18, Claude only; ADR 0021, docs/51 M2): checks a HyperFrames composition in Claude's project workspace without adding it to the edit, standing in for the skills' `npx hyperframes lint`, `check` and `snapshot`. It takes `composition_path`, optional `times_us` (2–16 increasing composition times; otherwise eight moments spread over its duration, first and last frame included) and `max_width` (320–480, default 320). Main seals and stores the file exactly as `graphics.set` does, loads it in the stage page in an offscreen window at the exported video's size, seeks it through its runtime at each moment and asks the composition's bridge to audit the page there. The result reports `ok`, whether it became ready, its duration, the root's declared size against the video's, its registered timelines, how many intervals between moments changed the picture, and findings: `runtime_not_ready`, `runtime_error`, `no_duration`, `no_timeline`, `canvas_size`, visible text cut off by the frame edge (`text_cut_off`), outside the 6% title-safe margin (`text_outside_safe_area`) or under about 2.2% of the shorter side (`text_too_small`), a picture that never moves (`motion_static`) and a second half that holds still (`motion_settles_early`). A text finding held across moments is an error (cut off) or warning; one seen at a single moment is info. Colour contrast, overlap between elements and audio are listed as not checked. The audited moments come back as one contact sheet over a checkerboard, as image content. Codex and the API-key providers have no workspace and do not list it: the shared MCP server lists it only when Claude's configuration starts it (`AI_VIDEO_EDITOR_MCP_TOOLS=claude`), so Claude has eighteen editor tools and the other routes keep seventeen and sixteen.

`media.get_frames` fix (2026-10-18): a picture partway through a graphic rendered every graphic frame from the graphic's start up to that moment (the windowed graphic starts before the one-frame window, and its segment was not clamped at frame 0), so a picture 40 s into a 53 s composition at 2560×1440 took minutes and often outlasted the five-minute tool limit during the real production run. Segments are now clamped to the window, and each picture or composition check stops at the tool-call limit, so a request the assistant gave up on no longer holds up the next one.

`graphics.set` and `composition.check` (2026-10-19): a composition is any page that draws itself for a given time, not only a HyperFrames composition. Free-form pages define `window.__seek(seconds)` and `window.__duration` (or use only CSS, Web or SVG animations, which the app seeks itself); HyperFrames pages keep `data-composition-id` and a paused GSAP timeline. Any exact-version npm package file on jsDelivr may be used, including ES modules through an import map, and the check reports a script, stylesheet or image that fails to load. `composition.check` needs no timeline for a free-form page that defines `__seek`; its `no_duration` finding says to set `window.__duration`.

### `transition.set`, `transition.remove`

Implemented on every route (2026-10-25; ADR 0025, docs/53). `transition.set` puts a transition on a real cut: `at_us` is the output time of the first frame after the cut (the draft summary lists each cut in `cuts`, with the `transition_id` of one already there), `kind` is `dip`, `wipe_right`, `wipe_left` or `iris`, `duration_us` is 0.2 to 2 s (default 0.6 s) and `color` is `#rrggbb` (default black); with a `transition_id` the transition is changed in place, and a cut holds one transition. The service refuses a time that is not a cut (`invalid_request`) and a stale head, and commits one `set_transition` transaction with pass kind `graphics`. `transition.remove` takes a `transition_id` and commits `remove_transition`. The summary lists `transitions` with their output time and visible range (null while the cut is gone). Both share Undo with every other origin. Audio is not changed.

With these two tools Claude's editor inventory is twenty-three tools, Codex's nineteen (MCP and host-defined route) and the API providers' eighteen (they do not list `media.get_frames`); the API client's definition limit is twenty. Earlier counts in this document describe the inventory at the time they were written.

### `shorts.propose`

Claude only (2026-10-25; docs/49). It proposes up to six short clips for the Short clips panel and does not touch the draft. It takes `clips`, each `start_us` and `end_us` (edit time in microseconds, read from `edit.md`), a `title` (1 to 120 characters) and up to four `reasons`. The app snaps each edge to the nearest sentence edge within 3 s, refuses a clip that is not 15 to 60 s long, has no sentence edge near an edge, overlaps one already chosen or has no title, keeps the rest in place of the panel's earlier set and answers with `accepted`, the plain `rejected` reasons and a summary. During a clip-picking run main allows only `project.get_summary`, `timeline.get_summary`, `transcript.get_range`, `media.get_frames` and this tool. Codex and the API providers do not list it, so Claude's inventory is twenty-four tools (Codex nineteen, the API providers eighteen).

### `zoom.targets` (Claude only; ADR 0027)

Read-only. `start_us`/`end_us` (edit time, or null for the whole edit) limit the range. The app reads the recording at five small grayscale pictures a second, compares neighbours and reports up to 40 places where something changes locally (a dialog opens, text appears, a panel updates): each has the changed rectangle (`x`, `y`, `width`, `height`, fractions of the frame), `center_x`/`center_y`, a `suggested_scale` (1.3–2.4), a `score` and the edit-time range. Changes across most of the picture (scrolling, scene changes) are not reported. This replaces the unimplemented `analysis.find_zoom_targets` for Claude: a zoom needs a target, and a range with none gets no zoom. Analysis runs once per recording per app run and never changes or keeps a picture.

### `graphics.component` (Claude only; ADR 0028)

Places one graphic from the app's component library as one undoable `set_graphic` transaction (pass kind `graphics`). The app renders a finished, animated layout; the model supplies the moment (`start_us`, `duration_us` ≥ 1.5 s), the `kind`, the words and an `accent` (#RRGGBB). Kinds: `lower_third` (title = name, subtitle = role), `chapter_card` (title, subtitle = kicker), `stat_callout` (title = value, subtitle = label), `highlight_box` (`x`, `y`, `width`, `height` frame fractions, title = tag text), `keyword` (title = phrase) and `step_badge` (subtitle = step number 1–99, title = step). Optional `side` (left/right), `place` (top/middle/bottom), `layer` (default 20) and `graphic_id` (replace). Text is escaped and limited (60/90 characters); the generated HTML and CSS pass the same validator as every graphic and use container units, so they scale with the video and keep to the title-safe margin. Content errors come back as `graphic_rejected` with a reason. Custom compositions through `graphics.set` remain for hero moments.

### `layout.plan`, `layout.set`, `layout.remove` (Claude only; ADR 0029)

`layout.set` changes how the camera and the screen share the picture from `at_us` (edit time) until the next change: `kind` `screen`, `camera` (the camera fills the picture) or `pip` (a corner camera: `corner`, `size` 0.12–0.5 of the width, `shape` circle/rounded/rect), optional `face_zoom` 1–2.5 with `focus_x`/`focus_y` and `move_us` (default 600 000). Main anchors the change to the recording's moment, so cuts keep it; one change per moment (setting another there replaces it); `layout_id` updates one. Camera kinds need a linked camera recording (error `layout_rejected` otherwise). One `set_layout` transaction, pass kind `layout`, shared Undo. `layout.remove` takes a `layout_id`. `layout.plan` is read-only: it returns proposed changes (`at_us`, `kind`, `corner`, `size`, `shape`, `reason`) from the screen's activity and the sentence starts. The timeline summary lists `layouts` with `at_us` (null when the moment was cut away).

### `app.start_magic_edit`, `app.stop_edit`, `app.go_to_step`, `app.start_edit_my_video` (ADR 0030)

App actions for chats, run by main through the same code as the buttons. They change no timeline themselves (the edits they start are ordinary guarded transactions) and every answer is `{ schema_version, project_id, status, message }` with a plain-words `message` (`status` is one of `started`, `queued`, `stopped`, `nothing_running`, `moved`, `busy`, `not_available`).

- `app.start_magic_edit` takes `preset` (`gentle`, `balanced`, `tight`) and starts Magic Edit with the connection of the chat that called it: the app transcribes locally, tightens pauses and fillers as one undoable transaction, then that connection makes the story edit with the rough-cut tools. It is queued and starts when the assistant's reply has finished (the conversation cannot take a second turn before), moving the app to Magic Edit first.
- `app.stop_edit` cancels a queued Magic Edit or Edit my video, stops a running Magic Edit and (Claude) a running full edit; it says plainly when nothing was running.
- `app.go_to_step` takes `step` (`record_import`, `auto_edit`, `edit`, `clips`, `export`; ADR 0031 removed `review` and the Done screen is reached only by exporting) and moves the app like the step bar, with the same refusals. It only shows the step; export and cleanup stay actions the user takes with the buttons, and no tool exports, deletes or cleans up.
- `app.start_edit_my_video` (Claude only) takes `level` (`tidy`, `polished`, `bold`) and runs the Edit my video sequence: the rough cut, then the full production edit if the rough cut completed.

None of these is available during a rough-cut, clip-picking or full-edit run (main refuses them, as it refuses every tool outside the run's list). The shared list gains the first three, so Claude's editor inventory is thirty-three tools, Codex's twenty-two (MCP and host-defined route) and the API providers' twenty-one (they do not list `media.get_frames`); the API client's definition limit is twenty-four. Earlier counts in this document describe the inventory at the time they were written.
