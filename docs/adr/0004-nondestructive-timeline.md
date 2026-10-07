# ADR 0004: Non-destructive operation timeline

- Status: Accepted starting decision
- Date: 2026-09-04

## Decision

All manual, Magic Wand, and Codex edits append validated operations to one active draft journal. Original media remains immutable.

## Consequences

- Shared undo and redo.
- Draft autosave and transaction recovery.
- Revisions are immutable snapshots.
- Export binds to a revision or frozen export snapshot.
- Tool transactions must include before state or a deterministic inverse.
