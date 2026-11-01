# Project data and revisions

## State types

ADR 0013 establishes the minimum project/timeline/baseline revision foundation in P1 and the shared transaction prerequisite in P2. These are implementation dependencies, not completion of P3 or P6. P1 must create actual versioned records with valid references; it cannot relabel an ingestion record or insert a fictional revision ID.

### Source state

Immutable files and recording metadata.

### Draft state

Mutable through validated operations. Autosaved and undoable.

### Revision state

Immutable snapshot created by the user or a defined milestone.

### Derived state

Proxies, previews, transcripts, waveforms, contact sheets, renders, and QA reports. Rebuildable from source and revision state.

### Navigation state

The active project stage selects one of the five workspace views. Persist it separately from media operation history and draft sequence. A transition preserves source/draft state and is announced only after its save succeeds. Visiting Magic Edit, Review or Export does not mean automation ran, review passed or an output exists. Reopen restores the stage and the same committed draft context.

## Initial baseline

P1's project bootstrap records an actual immutable baseline revision and initial canonical timeline derived from the imported source. Store valid project, source, timeline and revision references and preserve the original rational timing and native format metadata. The initial active draft derives from this baseline. Empty operation history represents no edits; do not manufacture transactions, transcripts, effects or completed QA. Existing ingestion records remain independently identifiable preserved media.

## Operation journal

The implemented P1 store retains an immutable baseline snapshot and a separate `project.json` for persisted stage metadata. Existing project, source, timeline and revision schema shapes remain unchanged. Reads validate those records, cross-references, canonical baseline integrity and the complete verified source probe. Stage persistence revalidates committed state before replacement and leaves baseline/source/timeline data intact on failure. The postcommit renderer mapping is pure, preventing a successful save from being reported as a failure due to a subsequent media read.

P2 adds an immutable `draft/meta.json`, an ordered `draft/journal/`, and `draft/checkpoints/`. Navigation and transactions share one root-wide in-process queue. Journal records contain strict request freshness, trusted origin, before/after state, generated operation identity, deterministic inverse data, prior-record hash and self hash. The active draft is reconstructed from baseline plus committed records; there is no mutable head file that can contradict the journal. Checkpoints bind passed verification records to an exact persisted head without mutating it. The draft schemas compose the canonical checked-in timeline schema; strict runtime validation additionally enforces the current baseline/reducer rules and unique checkpoint check IDs.

Headless tests cover project creation/reopen, integrity, failure preservation, navigation/edit serialization, competing same-head edits, staged and postcommit failures, retry idempotence, deterministic undo, checkpoint scope, and unchanged baseline/project/source bytes. The current packaged native suite covers the earlier five-stage shell only. Multi-source projects, additional reducers, complete crash recovery, power-loss guarantee and external concurrent-writer safety remain incomplete.

Each operation contains:

- stable operation ID
- transaction ID
- project and draft IDs
- operation type and schema version
- source or output range
- previous and next values
- origin: user, Codex, Magic Wand, migration, or recovery
- concise reason
- creation time
- dependency hashes
- undo data

## Shared history

Manual and AI edits use the same transaction journal. Undo reverses the newest applicable transaction. Redo reapplies it only when dependencies remain valid.

P2 now has the minimum common transaction foundation, including exact stale-state rejection, idempotent request IDs, deterministic inverse/undo, hash-chain replay and verified pass-checkpoint records. Each complete record is file-synced before an atomic rename, which supports process-crash recovery in the covered tests. The store does not yet claim persistence across power loss because Node cannot portably sync the containing directory on the supported Windows path, and it does not coordinate external writers. The guarded MCP adapter and authenticated fixture edit still have to consume it before P2 can pass. P3/P6 retain full multi-source storage/recovery and editor/history acceptance. Reuse this engine as their features arrive rather than maintaining separate manual and AI histories.

## Revision creation

A revision captures the operation journal head, timeline, transcript, assets, canvas, caption style, audio settings, model and skill metadata for AI-generated changes, and preview hash when available.

## Migration

Every stored contract has a schema version. Migrations are explicit, tested, backed up, and reversible when practical. An unknown newer schema opens read-only rather than risking corruption.
