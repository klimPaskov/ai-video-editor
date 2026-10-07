# ADR 0012: Native media bootstrap prerequisite

- Status: Accepted dependency correction
- Date: 2026-09-05

## Decision

Include the minimum actual product shell and media ingestion/frame transport in P0-04 and P0-06. Build packaged local Electron content with sandboxing, context isolation, CSP, validated typed IPC, a native file dialog, and an immutable managed media library. Exercise synthetic media through this product window using Playwright Electron and computer use in the isolated guest.

## Reason

P0 media changes require actual native evidence under AGENTS.md and ADR 0006. Deferring every product window until P1 creates a circular prerequisite. An infrastructure compatibility probe cannot satisfy that gate. Moving only the required bootstrap forward preserves the gate and enables an actual product path to be tested.

## Boundaries

- The append-only media library preserves originals and managed source bytes. Its ingestion records are not projects, draft timelines, revisions, or edit history.
- The initial frame inspection path accepts native-dimension BGRA, full-range GBR, BT.709 SDR within its explicit size limits. It must reject unverified color/precision paths instead of silently resampling or creating a lossy preview. Other supported import formats may be preserved with preview explicitly unavailable.
- Home import, library selection, and frame seek are the initial working controls. No fake recording, project, Codex, edit, playback, or export buttons are introduced.
- P1 still owns the complete shell, five-stage navigation, design system, accessibility, focus, scaling, and visual acceptance. P2 still owns real Codex. P3 still owns project storage, draft timing, recovery, and smooth A/V preview; P4 still owns capture. Later phases and final user-video acceptance remain unchanged.
- Passing a synthetic frame transport test proves neither audio playback nor displayed high-precision master fidelity. Package, security, source-integrity, reopen, deterministic frame, and actual native interaction evidence are required before accepting this bootstrap.

This decision changes dependencies, not completion status. P0 remains incomplete until its complete acceptance audit passes, and the infrastructure probe remains separate evidence.

## Subsequent dependency correction

ADR 0013 brings the minimum real project/timeline/baseline revision and persisted stage foundation into P1, and the common transaction prerequisites for an authenticated edit into P2. It supersedes only the earlier boundary that deferred all project foundations to P3. The P0 ingestion library remains distinct from projects; P3/P6 and later complete acceptance remains required.
