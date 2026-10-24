# Import and project specification

## Project creation

A project has one stable ID, display name, creation time, platform, canvas, source list, active draft, saved revisions, render cache, and Codex thread identity.

Under ADR 0013, P1 implements the minimum project foundation needed by its actual project shell: create from imported media, open/reopen, stable identity, immutable source references, an initial source-matched canonical timeline and real baseline revision, and persisted active stage. Existing ingestion-library records remain separate media records. Project revision IDs must resolve to immutable snapshots, and source IDs must resolve to preserved media; placeholder identities are invalid.

Read rational timing and canvas metadata from the actual source contract. Do not reconstruct the working frame rate from rounded UI text or silently choose a lower-precision working format. Unsupported project/preview paths must be reported honestly. P3 retains the complete import-format, project-management, locking, autosave/recovery and smooth A/V preview requirements below.

The current still-frame adapter additionally previews tagged 8-bit H.264 `yuv420p` limited-range BT.709 with square pixels and no display transform. Its explicit color conversion serves the renderer only; source and project records retain the original bytes and probe metadata. Source still-frame seeks use sorted presentation timestamps, including variable-cadence gaps and the verified last packet duration. This does not establish a canonical variable-frame-rate render, full-length A/V playback, or a mixed-source working format. A versioned two-source initial project places two independently imported, compatible sources as adjacent clips in one draft. Both source files remain immutable and the original single-source project remains available. The Add footage action is offered only for an unedited single-source project in Record or Import; it creates a new combined project rather than rewriting an edited draft.

## Project navigation

The five navigation controls select Record or Import, Auto Edit, Edit, Review, or Export on the active project. Main validates and persists the stage before returning the committed state. Reopen restores the saved stage without implying its feature ran. Stage selection preserves the active draft, source references, selection and playhead as applicable, and does not append edits or advance draft sequence. A save failure leaves the previous committed stage intact.

Stage actions appear only when implemented. No navigation action may fabricate AI edits, certify watch-through/QA, or start export. A stage with unavailable actions may disclose that limitation and retain working navigation/source inspection. Final export remains a separate explicit user action. P1 tests shell navigation; later phases prove the corresponding stage features.

## Import

- Use a native file picker.
- Accept common MP4, MOV, MKV, WebM, WAV, MP3, PNG, JPEG, and supported camera formats.
- Probe before use.
- Reject unreadable media with an actionable message.
- Copy or reference media according to an explicit project policy.
- Hash imported and recorded sources.
- Never change source bytes.

When the user selects multiple sequential recordings, preserve each as a distinct immutable source and build one draft timeline in selection order. Appending means the next clip starts at the preceding clip's committed timeline end; it does not create a lossy concatenated replacement or erase source boundaries. Project reopen must restore the source order and exact clip mapping. Mixed timing, precision, color, or audio formats require an explicit compatible project adapter or an actionable rejection; they must not trigger a silent downgrade.

The implemented two-source path checks both managed hashes and complete probes, ordered source identities, compatible display and audio metadata, and measured presentation ends on create and reopen. The last displayed frame occupies its packet duration even if that exceeds the container's rounded stream duration. Its two clip boundaries use integer microseconds; nominal rational rate is a navigation grid, not a constant-frame-rate assertion. Trim and undo reflow the second clip through the common draft journal. The current path accepts exactly two compatible sources; wider import selection and format conversion remain future work.

During ingestion, Importing video offers Cancel. After ingestion succeeds and project creation begins, show Creating project and hide the import-only Cancel control; it cannot cancel committed source ingestion or project creation. A project-creation failure preserves the imported source for a later Create project retry.

## Project folder

The current P1 implementation publishes a managed project directory containing `baseline.json` and `project.json`. The baseline contains actual versioned project/source/timeline/revision records with referential checks; navigation replaces only the committed project's stage/update metadata. This limited physical store is a prerequisite to the complete P3 folder model below, not an implementation of every listed directory or draft service.

Creation and reopening verify the immutable managed media hash and compare the complete ffprobe result, including stream and format metadata, against the retained source probe. Staged creation is published only after validation. Failed creation preserves source-library media; unpublished creation directories remain for explicit recovery/cleanup. Source paths and raw probe data stay main-only. The renderer receives a strict path-free project DTO and distinguishes actual projects from imported sources.

```text
project/
  project.json
  sources/
  drafts/
  revisions/
  transcript/
  assets/
  previews/
  exports/
  cache/
  recovery/
  logs/
```

Logs are not part of the normal UI.

## Autosave

- Append validated operations to a draft journal.
- Snapshot periodically and before render.
- Recover by replaying only complete transactions.
- Preserve the failed tail for diagnostics.

## Revisions

Committing a revision freezes the timeline, transcript, effect settings, assets, and rendering configuration by hash. Editing continues in a new draft derived from that revision.

## Deletion

Project deletion requires confirmation and never deletes externally referenced source files. Cleanup previews every managed path before deletion.

Implemented (2026-10-17): Home renames and deletes closed projects. A rename changes only `name` (and `updated_at`) in `project.json`; the immutable baseline keeps the original name and reads still require every other field to match it. Deleting asks for confirmation in the dialog, then removes the project's app-owned side files (its Claude and API-provider conversations, caption, audio and short-clip choices, and export records) and finally its folder, renamed to `.removing-<id>` first so an interrupted removal finishes on the next listing. Anything unexpected in those places (a link, a folder where a file belongs, a non-record file) stops the removal. Sources stay in the media library with their transcripts and playback proxies; original and exported files are never touched. The Codex thread binding is left in Codex's own records. Duplicate, archive and a per-path cleanup preview remain open.
