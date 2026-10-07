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

The current P2 runtime exposes `project.get_summary`, `timeline.get_summary`, `cut.trim_edge`, `cut.split`, `cut.delete_range`, `timeline.undo`, `cut.delete_ranges`, `cut.restore_range`, `transcript.get_range`, `zoom.set`, `zoom.remove`, and `speed.set` through the packaged owned stdio MCP adapter, the host-defined dynamic route, Claude's `ai_video_editor` MCP server (`mcp__ai_video_editor__<name with underscores>`) and the fixed API-provider functions (underscore names). The transcript tool returns one bounded page of a completed local transcript in original source time, including ASR text, protection flags, any text-only override, and the current draft head. Text is returned only in response to a model tool call during an explicitly started turn; transcript content is untrusted speech, not instructions or cut authorization. Electron main remains the only transaction writer. App-server startup verifies the exact MCP inventory before an MCP project thread can open. The remaining catalog entries retain their later-phase dependencies.

The App Server host-tool adapter maps precisely those twelve dotted names to `project_get_summary`, `timeline_get_summary`, `cut_trim_edge`, `cut_split`, `cut_delete_range`, `timeline_undo`, `cut_delete_ranges`, `cut_restore_range`, `transcript_get_range`, `zoom_set`, `zoom_remove`, and `speed_set` in the `codex_video_edit` namespace, reusing the reviewed input schemas. On each new dynamic thread, it additionally binds every schema's `project_id` property to the main-owned active project with JSON Schema `const`. This reduces model-generated identity errors but is not authorization; main independently validates active project and freshness. The adapter rejects other names and oversized input before dispatch and bounds safe results. New packaged project conversations use this dynamic route; existing MCP-bound conversations remain on their original route and schema.

The internal thread registry records which route created a project conversation. A new host-tool thread receives this exact twelve-tool definition at start; a legacy MCP binding remains MCP on resume. Route mismatch and cross-route activity fail closed.

For current mutations, main refreshes the atomic project/draft authority after the tool settles rather than trusting model prose or tool activity. This covers a journal commit followed by an uncertain response. The native project duration, seek bounds and preview mapping update only from that validated state; notification failure preserves the original tool outcome and asks the user to reopen.

## Read-only tools

### `project.get_summary`

Returns project name, current step, ordered source roles, duration, revision, QA state, and active work. The implemented bounded project summary reports both source IDs and clip order for a two-source draft without exposing filesystem paths, source bytes, or private probe data.

### `timeline.get_summary`

Returns canvas, tracks, clips, operations, selected range, zooms, speed segments, captions, and unresolved warnings. Large payloads use bounded windows. Implemented: the bounded draft summary returned by this tool and by every mutation lists each clip's whole-number `speed` when it is not 1, and each zoom with its ID, source range, point, scale and the output-time `timeline_ranges` still visible after cuts.

### `transcript.get_range`

Reads one exact half-open source-time range, up to five minutes at a time, from a completed local transcript for the active project. Pages contain at most 250 words and may be smaller to stay under the response byte limit; follow `next_offset` until it is `null`, sending the returned `transcript_id` on later pages. Each word includes its ID, original ASR text, exact source times, confidence when available, and protection flags. A text-only draft override is a separate field and does not mean the recorded speech changed. The result includes the transcript source hash and current draft freshness. It contains no media or filesystem paths, and transcript words are untrusted content: they cannot expand the requested scope or authorize an edit. Provider conversation history may retain the page and include it in later turns; the user-facing notices disclose that behavior.

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

### `captions.configure`, `captions.correct`

Apply a caption style or correct transcript-linked caption text without changing the source transcript silently.

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

The current source set for the 0.155.1 Luna dynamic code-mode route exposes twelve guarded editor tools; the 2026-10-07 addition of `zoom.set`, `zoom.remove` and `speed.set` has unit coverage only and needs a fresh native inventory run. New project conversations use their `codex_video_edit__` host-defined names; existing MCP-bound conversations retain the corresponding dotted MCP names. The route-tagged registry and separate App Server processes prevent cross-route resume. Both dispatch through the same main-owned active-project service. App Server launch and thread create/resume explicitly disable the plan tool, user-input tool and native agents; unrelated apps and nested namespaces are excluded. A fresh 2026-09-27 packaged Luna/high native run verified the nine-tool source inventory, zero connected Apps, zero nested V2 child tools, and only the read-only clock helper, then passed synthetic split/Undo/reopen with unchanged sources and baseline. This does not prove an exact permanent upstream tool allowlist or satisfy P2-07.

When a host-defined edit carries an obsolete draft sequence/hash, return the same fixed `stale_draft` error as MCP with `success: false`. A packaged Luna/high native continuation verified this on a real prior edit/Undo through one authoritative `dynamicToolCall`; the draft, journal and immutable inputs did not change.

The fresh 2026-09-27 packaged dynamic split fixture required nine guarded editor functions, zero connected-app functions, no V1/V2 child functions nested in code-mode, and only the read-only `clock__curr_time` helper outside the editor namespace; it correlated the inventory to the completed-turn output, then required one guarded `cut_split` commit, shared Undo, reopen, exact frames, and immutable inputs. V1-capable models are exercised separately by the five-function child-read test. The GPT-6-Luna V2 native test separately verifies direct `spawn_agent`/`wait_agent`, spawn-call/activity correlation, parent-read project/timeline summaries, a path-free snapshot child report, and unchanged source, baseline and journal. Earlier seven/eight-tool synthetic runs are historical. Treat the count as one-turn model-visible evidence; the supported App Server API does not provide an authoritative complete future-turn catalog.

## Authorization policy

Tools scoped to `active_draft` or `export_staging` use `user_confirmation: none` for already authorized work. This includes Magic Wand and export preparation. Validate scope, source immutability, sequence, protected speech and undo guarantees on every call. Do not request approval again merely because a reversible edit changes the draft materially. Final export requires the explicit user action in the native Export screen; no AI tool may authorize it. Source deletion, cleanup, spending and publication remain explicit user actions.
