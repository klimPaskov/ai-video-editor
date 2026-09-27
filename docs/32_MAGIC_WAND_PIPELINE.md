# Magic Wand pipeline

If an ADR 0014 API provider is selected, separate local deterministic analysis from the explicitly user-started paid generation turn. Validate provider proposals through the shared active-draft transaction engine, preserve source immutability and report only committed changes. Provider-specific tools are available only after their capability tests; this requirement is not implementation evidence.

## Goal

Magic Wand creates a useful first edit from recorded or imported media. It operates through visible, reversible draft transactions and keeps the original footage available.

## Inputs

- source manifests and proxies
- word-timed transcript
- silence evidence
- cursor and click telemetry when recorded
- visible frame samples
- selected preset
- optional user instruction
- camera, audio, caption, and canvas preferences
- indexed local asset descriptions

## Pipeline

### 1. Readiness

Verify source hashes, media decode, proxy availability, transcript bounds, free disk space, and current revision identity.

### 2. Structural analysis

Find scenes, takes, topic changes, screen states, long waits, typing ranges, visible interactions, and camera availability.

### 3. Cut analysis

Generate candidates for dead air, filler, false starts, abandoned phrases, immediate repetitions, failed takes, setup time, and obvious mistakes. Protect facts, names, numbers, negation, warnings, uncertainty, useful pauses, overlapping speech, and visual steps needed to follow the tutorial.

The current deterministic domain slice emits an analysis report from validated transcript and source-analysis records. Configured phrase matches, adjacent exact repetitions, dash-marked restarts, conservative English correction markers, quoted cues, protected words/ranges, opt-in legacy aliases, and silence context are evidence-backed candidates; none authorizes a cut. Auto Edit nests these cues under the completed transcript and seeks to a still frame only when the source point maps through the committed clip list. It does not play audio or edit. Semantic meaning decisions, failed-take/scope analysis, synchronization and final cut application remain later pipeline work.

### 4. Visual focus

Generate zoom candidates only when a visible target is known. Prefer pointer telemetry and click regions. Confirm targets from preview frames. Omit low-confidence zooms.

### 5. Pacing

Generate speed candidates for silent typing, loading, and waiting. Keep normal speed around important actions and spoken explanation unless the user asks otherwise. Select an explicit audio mode.

### 6. Presentation

Create captions, cursor treatment, audio cleanup, camera layout, and local B-roll suggestions according to enabled switches. Do not add unrelated decoration.

### 7. Apply live

Order transactions so the base cut and time map are established before effects. Persist and announce each valid batch. Keep Stop and Undo available throughout.

### 8. Preview and verify

Render representative joins, zooms, speed boundaries, captions, layouts, and audio. Run machine checks and inspect motion through the native app.

## Presets

### Gentle

Remove clear failed material and excessive silence. Use few effects.

### Balanced

Use normal tutorial pacing, captions, purposeful focus, and conservative cleanup.

### Tight

Use stronger pause and filler cleanup while preserving complete meaning and readable UI actions.

### Custom

Use only the enabled switches and user thresholds.

## Completion summary

Show removed duration, restored or protected sections, cut count, zoom count, speed ranges, caption status, audio work, layout changes, B-roll suggestions, and unresolved warnings. Every category links to the affected timeline items.

## Editorial pass ordering and verification

The mandatory detailed policy is [47_EDITORIAL_FIRST_CUT.md](47_EDITORIAL_FIRST_CUT.md); use `docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md` for the runtime task. Discover only real app capabilities/guidance once per connection. Establish active project/revision/draft sequence/hash, transcription job identity, authorized scope, protected ranges, source synchronization and approved styles before planning operations.

The spoken-cut pass establishes the source/output map first. Preserve final complete redos, unique context and meaningful pauses; batch only confirmed nonoverlapping cuts across verified synchronized sources. Check every join in transcript and rendered A/V, run the whole-source omission pass and full edited-transcript reread, and restore failures. Then verify a separate layout pass. Identify selective graphics opportunities after layouts, and verify a separate target-driven zoom pass. Re-map all opportunities after any subsequent timing edit. Other selected presentation/pacing tools remain governed by their source-map dependencies.

A pass checkpoint records verified persisted draft work, not a forced immutable revision, cleared undo history or completed final review. Re-read current sequence/hash after each structural change; reject stale requests. Never announce state before persistence. Abort uncommitted invalid batches; if a persisted effect fails later verification, apply its deterministic compensating undo and record the outcome. Stopping prevents new work while preserving committed history.

Complete a whole-video analysis contact-sheet scan plus precise frames/A/V where required; analysis derivatives never feed the master. Report actual duration, scene/layout/zoom counts and purposes/targets, removals, retained exceptions, unresolved cues, final-timed complete graphics prompts, checkpoint/persistence state and remaining review. Verify no unrequested asset creation or export. Required tests cover job idempotency/timeouts, independent sources, ambiguity/protection, stale hashes, rollback, missing verification and fabricated summaries. Pipeline documentation is not implementation evidence.
