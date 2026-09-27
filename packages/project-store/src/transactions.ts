import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  assertApplyDraftTransactionRequest,
  assertDraftState,
  assertPassCheckpointRequest,
  assertRedoDraftTransactionRequest,
  assertUndoDraftTransactionRequest,
  cloneDraftState,
  draftRecordSha256,
  draftRequestSha256,
  initialDraftState,
  passCheckpointRecordSha256,
  passCheckpointRequestSha256,
  type ApplyDraftTransactionRequest,
  type DraftOrigin,
  type DraftOperationRecord,
  type DraftState,
  type DraftTransactionAuthority,
  type DraftTransactionRecord,
  type PassCheckpointRecord,
  type PassCheckpointRequest,
  type RedoDraftTransactionRequest,
  type UndoDraftTransactionRequest,
} from "../../domain/src/draft-transaction.ts";
import {
  canonicalSha256,
  projectCanonicalJson,
  timelineSha256,
  type InitialProjectSnapshot,
  type TwoSourceInitialProjectSnapshot,
} from "../../domain/src/project.ts";
import { sameProjectStorePath, serializeProjectStore } from "./serialize.ts";

type ProjectBaseline = InitialProjectSnapshot | TwoSourceInitialProjectSnapshot;
type ProjectReader = {
  readForDraftTransaction(projectId: string): Promise<ProjectBaseline>;
};

export type DraftTransactionErrorCode =
  "invalid" | "stale" | "conflict" | "storage" | "outcome_unknown";

export interface DraftConflictState {
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
}

export class DraftTransactionError extends Error {
  readonly code: DraftTransactionErrorCode;
  readonly current: DraftConflictState | null;
  constructor(
    code: DraftTransactionErrorCode,
    current: DraftConflictState | null = null,
  ) {
    const messages: Record<DraftTransactionErrorCode, string> = {
      invalid:
        "The draft change is invalid. Refresh the project and try again.",
      stale:
        "The draft changed before this edit could be applied. Refresh and try again.",
      conflict:
        "This edit conflicts with newer draft work. Refresh the project and try again.",
      storage:
        "The draft could not be read or saved. Check local storage and reopen the project.",
      outcome_unknown:
        "The draft connection ended during saving. Reopen the project before retrying.",
    };
    super(messages[code]);
    this.name = "DraftTransactionError";
    this.code = code;
    this.current = current ? structuredClone(current) : null;
  }
}

export interface DraftTransactionDependencies {
  now: () => string;
  id: () => string;
  /** Internal deterministic crash seams; never renderer or tool controlled. */
  afterPendingWrite?: () => Promise<void>;
  afterJournalCommit?: () => Promise<void>;
  afterCheckpointPendingWrite?: () => Promise<void>;
  afterCheckpointCommit?: () => Promise<void>;
}

export interface DraftReadResult {
  draft: DraftState;
  undo_transaction_id: string | null;
  redo_transaction_id: string | null;
  current_pass_checkpoint: PassCheckpointRecord | null;
}
export interface DraftProjectReadResult extends DraftReadResult {
  project: ProjectBaseline;
}

export interface DraftCommitResult extends DraftReadResult {
  transaction: DraftTransactionRecord;
  replayed: boolean;
}

export interface PassCheckpointCommitResult extends DraftReadResult {
  checkpoint: PassCheckpointRecord;
  replayed: boolean;
}

interface DraftMetaV1 {
  schema_version: "1.0";
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  baseline_timeline_sha256: string;
  source_sha256: string;
  created_at: string;
}
interface DraftMetaV2 {
  schema_version: "1.1";
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  baseline_timeline_sha256: string;
  sources_sha256: string;
  created_at: string;
}
type DraftMeta = DraftMetaV1 | DraftMetaV2;
function sourcesSha256(baseline: TwoSourceInitialProjectSnapshot): string {
  return canonicalSha256(
    baseline.sources.map((source) => ({
      source_id: source.source_id,
      sha256: source.sha256,
    })),
  );
}

interface LoadedDraft {
  baseline: ProjectBaseline;
  state: DraftState;
  records: Map<string, DraftTransactionRecord>;
  requests: Map<string, DraftTransactionRecord>;
  applied: DraftTransactionRecord[];
  undone: DraftTransactionRecord[];
  journal: string;
  checkpointRequests: Map<string, PassCheckpointRecord>;
  currentCheckpoint: PassCheckpointRecord | null;
  checkpoints: string;
}

const jsonLimit = 32 * 1024 * 1024;
const sequenceLimit = 999_999_999_999;
const committedPattern =
  /^(\d{12})\.([A-Za-z0-9][A-Za-z0-9._-]{1,127})\.json$/u;
const pendingPattern = /^\.pending-[A-Za-z0-9][A-Za-z0-9._-]{1,127}\.json$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

function fail(
  code: DraftTransactionErrorCode = "storage",
  current: DraftState | null = null,
): never {
  throw new DraftTransactionError(
    code,
    current
      ? {
          project_id: current.project_id,
          draft_id: current.draft_id,
          base_revision_id: current.base_revision_id,
          draft_sequence: current.draft_sequence,
          timeline_sha256: current.timeline_sha256,
        }
      : null,
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value as Record<string, unknown>;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !sameProjectStorePath(await realpath(path), path)
  )
    fail();
}

async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 2 ||
    info.size > jsonLimit
  )
    fail();
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size > jsonLimit)
      fail();
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof DraftTransactionError) throw error;
    fail();
  } finally {
    await handle.close();
  }
}

async function writeNew(path: string, value: unknown): Promise<void> {
  const content = `${projectCanonicalJson(value)}\n`;
  if (Buffer.byteLength(content) > jsonLimit) fail("invalid");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function same(left: unknown, right: unknown): boolean {
  return projectCanonicalJson(left) === projectCanonicalJson(right);
}

function assertMeta(value: unknown, baseline: ProjectBaseline): DraftMeta {
  const meta = exact(
    value,
    baseline.schema_version === "1.1"
      ? [
          "schema_version",
          "project_id",
          "draft_id",
          "base_revision_id",
          "baseline_timeline_sha256",
          "sources_sha256",
          "created_at",
        ]
      : [
          "schema_version",
          "project_id",
          "draft_id",
          "base_revision_id",
          "baseline_timeline_sha256",
          "source_sha256",
          "created_at",
        ],
  );
  if (
    meta.schema_version !== baseline.schema_version ||
    meta.project_id !== baseline.project.project_id ||
    !validId(meta.draft_id) ||
    meta.base_revision_id !== baseline.revision.revision_id ||
    meta.baseline_timeline_sha256 !== timelineSha256(baseline.timeline) ||
    (baseline.schema_version === "1.1"
      ? meta.sources_sha256 !== sourcesSha256(baseline)
      : meta.source_sha256 !== baseline.source.sha256) ||
    !validTimestamp(meta.created_at)
  )
    fail();
  return meta as unknown as DraftMeta;
}

function recordWithoutHash(
  record: DraftTransactionRecord,
): Omit<DraftTransactionRecord, "transaction_sha256"> {
  const withoutHash: Partial<DraftTransactionRecord> = { ...record };
  delete withoutHash.transaction_sha256;
  return withoutHash as Omit<DraftTransactionRecord, "transaction_sha256">;
}

function checkpointWithoutHash(
  record: PassCheckpointRecord,
): Omit<PassCheckpointRecord, "checkpoint_sha256"> {
  const withoutHash: Partial<PassCheckpointRecord> = { ...record };
  delete withoutHash.checkpoint_sha256;
  return withoutHash as Omit<PassCheckpointRecord, "checkpoint_sha256">;
}

function assertRecordEnvelope(value: unknown): DraftTransactionRecord {
  const record = exact(value, [
    "schema_version",
    "transaction_id",
    "request_id",
    "request_sha256",
    "transaction_sha256",
    "previous_transaction_sha256",
    "project_id",
    "draft_id",
    "base_revision_id",
    "kind",
    "origin",
    "pass_group",
    "reason",
    "created_at",
    "target_transaction_id",
    "before",
    "after",
    "operations",
    "status",
  ]);
  if (
    record.schema_version !== "1.0" ||
    !validId(record.transaction_id) ||
    !validId(record.request_id) ||
    !validHash(record.request_sha256) ||
    !validHash(record.transaction_sha256) ||
    (record.previous_transaction_sha256 !== null &&
      !validHash(record.previous_transaction_sha256)) ||
    !validId(record.project_id) ||
    !validId(record.draft_id) ||
    !validId(record.base_revision_id) ||
    !["apply", "undo", "redo"].includes(record.kind as string) ||
    !["manual", "codex", "api_provider", "magic_wand"].includes(
      record.origin as string,
    ) ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    record.reason.length > 1000 ||
    !validTimestamp(record.created_at) ||
    (record.target_transaction_id !== null &&
      !validId(record.target_transaction_id)) ||
    !Array.isArray(record.operations) ||
    record.status !== "committed"
  )
    fail();
  return record as unknown as DraftTransactionRecord;
}

function checkpointRequestFromRecord(
  record: PassCheckpointRecord,
): PassCheckpointRequest {
  return {
    schema_version: "1.0",
    request_id: record.request_id,
    project_id: record.project_id,
    draft_id: record.draft_id,
    base_revision_id: record.base_revision_id,
    expected_sequence: record.draft_sequence,
    expected_timeline_sha256: record.timeline_sha256,
    pass_group: record.pass_group,
    verified_transaction_ids: record.verified_transaction_ids,
    summary: record.summary,
    checks: record.checks,
  };
}

function assertCheckpointEnvelope(value: unknown): PassCheckpointRecord {
  const record = exact(value, [
    "schema_version",
    "checkpoint_id",
    "request_id",
    "request_sha256",
    "checkpoint_sha256",
    "project_id",
    "draft_id",
    "base_revision_id",
    "draft_sequence",
    "timeline_sha256",
    "head_transaction_sha256",
    "pass_group",
    "verified_transaction_ids",
    "summary",
    "checks",
    "created_at",
    "status",
  ]);
  if (
    record.schema_version !== "1.0" ||
    !validId(record.checkpoint_id) ||
    !validId(record.request_id) ||
    !validHash(record.request_sha256) ||
    !validHash(record.checkpoint_sha256) ||
    !validId(record.project_id) ||
    !validId(record.draft_id) ||
    !validId(record.base_revision_id) ||
    !Number.isSafeInteger(record.draft_sequence) ||
    (record.draft_sequence as number) < 1 ||
    !validHash(record.timeline_sha256) ||
    !validHash(record.head_transaction_sha256) ||
    !validTimestamp(record.created_at) ||
    record.status !== "verified"
  )
    fail();
  const result = record as unknown as PassCheckpointRecord;
  assertPassCheckpointRequest(checkpointRequestFromRecord(result));
  return result;
}

type DraftFreshness = {
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  expected_sequence: number;
  expected_timeline_sha256: string;
};

function ensureFresh(request: DraftFreshness, state: DraftState) {
  if (
    request.project_id !== state.project_id ||
    request.draft_id !== state.draft_id ||
    request.base_revision_id !== state.base_revision_id ||
    request.expected_sequence !== state.draft_sequence ||
    request.expected_timeline_sha256 !== state.timeline_sha256
  )
    fail("stale", state);
}

function nextState(
  before: DraftState,
  timeline: DraftState["timeline"],
): DraftState {
  return {
    schema_version: "1.0",
    project_id: before.project_id,
    draft_id: before.draft_id,
    base_revision_id: before.base_revision_id,
    draft_sequence: before.draft_sequence + 1,
    timeline_sha256: timelineSha256(timeline),
    head_transaction_sha256: "0".repeat(64),
    timeline,
  };
}

function prepareApply(
  baseline: ProjectBaseline,
  before: DraftState,
  request: ApplyDraftTransactionRequest,
  authority: DraftTransactionAuthority,
): DraftTransactionRecord {
  ensureFresh(request, before);
  if (
    authority.operation_ids.length !== request.operations.length ||
    new Set(authority.operation_ids).size !== authority.operation_ids.length
  )
    fail("invalid");
  const timeline = structuredClone(before.timeline),
    records: DraftOperationRecord[] = [];
  for (let index = 0; index < request.operations.length; index++) {
    const intent = request.operations[index]!,
      operationId = authority.operation_ids[index]!;
    if (!validId(operationId) || timeline.operation_ids.includes(operationId))
      fail("conflict");
    if (intent.type === "transcript_edit") {
      if (request.operations.length !== 1) fail("invalid");
      if (
        !baseline.timeline.clips.some(
          (clip) => clip.source_id === intent.source_id,
        )
      )
        fail("invalid");
      const beforeEdits = structuredClone(timeline.transcript_edits ?? []);
      const key = (edit: (typeof beforeEdits)[number]) =>
        `${edit.source_id}\0${edit.transcript_id}\0${edit.word_id}`;
      const targetKey = `${intent.source_id}\0${intent.transcript_id}\0${intent.word_id}`;
      const existing = beforeEdits.find((edit) => key(edit) === targetKey);
      const currentText = existing?.replacement_text ?? intent.original_text;
      if (
        (existing && existing.original_text !== intent.original_text) ||
        currentText !== intent.expected_text
      )
        fail("conflict");
      const afterEdits = beforeEdits.filter((edit) => key(edit) !== targetKey);
      if (intent.replacement_text !== intent.original_text)
        afterEdits.push({
          source_id: intent.source_id,
          transcript_id: intent.transcript_id,
          word_id: intent.word_id,
          original_text: intent.original_text,
          replacement_text: intent.replacement_text,
        });
      timeline.transcript_edits = afterEdits;
      timeline.operation_ids.push(operationId);
      records.push({
        schema_version: "1.0",
        operation_id: operationId,
        operation_type: "transcript_edit",
        source_id: intent.source_id,
        transcript_id: intent.transcript_id,
        word_id: intent.word_id,
        original_text: intent.original_text,
        before_text: currentText,
        after_text: intent.replacement_text,
        before: beforeEdits,
        after: structuredClone(afterEdits),
        inverse: {
          type: "restore_transcript_edits",
          edits: beforeEdits,
          expected_after_sha256: canonicalSha256(afterEdits),
        },
      });
      continue;
    }
    if (intent.type === "restore_range") {
      if (request.operations.length !== 1) fail("invalid");
      const sourceClips = baseline.timeline.clips.filter(
        (candidate) => candidate.source_id === intent.source_id,
      );
      if (sourceClips.length !== 1) fail("conflict");
      const source = sourceClips[0]!;
      if (
        intent.source_start_us < source.source_start_us ||
        intent.source_end_us > source.source_end_us
      )
        fail("invalid");
      if (
        timeline.clips.some(
          (candidate) =>
            candidate.source_id === intent.source_id &&
            intent.source_start_us < candidate.source_end_us &&
            candidate.source_start_us < intent.source_end_us,
        )
      )
        fail("conflict");
      if (timeline.clips.length >= 4096) fail("conflict");
      const clipId = `clip-${canonicalSha256({
        operation_id: operationId,
        source_id: intent.source_id,
        source_start_us: intent.source_start_us,
        source_end_us: intent.source_end_us,
      }).slice(0, 32)}`;
      if (timeline.clips.some((candidate) => candidate.clip_id === clipId))
        fail("conflict");
      const sourceOrder = new Map(
        baseline.timeline.clips.map((candidate, sourceIndex) => [
          candidate.source_id,
          sourceIndex,
        ]),
      );
      const targetSourceOrder = sourceOrder.get(intent.source_id);
      if (targetSourceOrder === undefined) fail("invalid");
      const insertAt = timeline.clips.findIndex((candidate) => {
        const candidateOrder = sourceOrder.get(candidate.source_id);
        if (candidateOrder === undefined) fail("invalid");
        return (
          candidateOrder > targetSourceOrder ||
          (candidateOrder === targetSourceOrder &&
            candidate.source_start_us > intent.source_start_us)
        );
      });
      const priorClips = structuredClone(timeline.clips);
      timeline.clips.splice(
        insertAt < 0 ? timeline.clips.length : insertAt,
        0,
        {
          clip_id: clipId,
          track_id: source.track_id,
          source_id: source.source_id,
          source_start_us: intent.source_start_us,
          source_end_us: intent.source_end_us,
          timeline_start_us: 0,
          timeline_end_us: intent.source_end_us - intent.source_start_us,
          enabled: true,
        },
      );
      let position = 0;
      for (const candidate of timeline.clips) {
        candidate.timeline_start_us = position;
        position += candidate.source_end_us - candidate.source_start_us;
        candidate.timeline_end_us = position;
      }
      if (!Number.isSafeInteger(position) || position < 1) fail("conflict");
      timeline.duration_us = position;
      records.push({
        schema_version: "1.0",
        operation_id: operationId,
        operation_type: "restore",
        source_id: intent.source_id,
        source_start_us: intent.source_start_us,
        source_end_us: intent.source_end_us,
        before: priorClips,
        after: structuredClone(timeline.clips),
        inverse: {
          type: "restore_timeline_clips",
          clips: priorClips,
          expected_after_sha256: canonicalSha256(timeline.clips),
        },
      });
      timeline.operation_ids.push(operationId);
      continue;
    }
    if (intent.type === "ripple_delete" || intent.type === "transcript_cut") {
      if (intent.type === "transcript_cut") {
        const clip = timeline.clips.find(
          (candidate) =>
            candidate.source_id === intent.source_id &&
            candidate.source_start_us <= intent.source_start_us &&
            candidate.source_end_us >= intent.source_end_us,
        );
        if (
          !clip ||
          clip.timeline_start_us +
            (intent.source_start_us - clip.source_start_us) !==
            intent.start_us ||
          clip.timeline_start_us +
            (intent.source_end_us - clip.source_start_us) !==
            intent.end_us
        )
          fail("conflict");
      }
      if (
        intent.end_us > timeline.duration_us ||
        (intent.start_us === 0 && intent.end_us === timeline.duration_us)
      )
        fail("conflict");
      const priorClips = structuredClone(timeline.clips);
      const survivors: typeof timeline.clips = [];
      for (const current of timeline.clips) {
        const leftLength = Math.max(
          0,
          Math.min(intent.start_us, current.timeline_end_us) -
            current.timeline_start_us,
        );
        const rightLength = Math.max(
          0,
          current.timeline_end_us -
            Math.max(intent.end_us, current.timeline_start_us),
        );
        if (leftLength > 0) {
          survivors.push({
            ...current,
            source_end_us: current.source_start_us + leftLength,
          });
        }
        if (rightLength > 0) {
          const rightId =
            leftLength > 0
              ? `clip-${canonicalSha256({ operation_id: operationId, clip_id: current.clip_id }).slice(0, 32)}`
              : current.clip_id;
          if (
            survivors.some((candidate) => candidate.clip_id === rightId) ||
            (leftLength > 0 &&
              timeline.clips.some((candidate) => candidate.clip_id === rightId))
          )
            fail("conflict");
          survivors.push({
            ...current,
            clip_id: rightId,
            source_start_us: current.source_end_us - rightLength,
          });
        }
      }
      if (survivors.length < 1 || survivors.length > 4096) fail("conflict");
      timeline.clips = survivors;
      let position = 0;
      for (const candidate of timeline.clips) {
        candidate.timeline_start_us = position;
        position += candidate.source_end_us - candidate.source_start_us;
        candidate.timeline_end_us = position;
      }
      if (!Number.isSafeInteger(position) || position < 1) fail("conflict");
      timeline.duration_us = position;
      const afterClips = structuredClone(timeline.clips);
      const inverse = {
        type: "restore_timeline_clips" as const,
        clips: structuredClone(priorClips),
        expected_after_sha256: canonicalSha256(timeline.clips),
      };
      records.push(
        intent.type === "transcript_cut"
          ? {
              schema_version: "1.0",
              operation_id: operationId,
              operation_type: "transcript_cut",
              source_id: intent.source_id,
              transcript_id: intent.transcript_id,
              start_word_id: intent.start_word_id,
              end_word_id: intent.end_word_id,
              source_start_us: intent.source_start_us,
              source_end_us: intent.source_end_us,
              start_us: intent.start_us,
              end_us: intent.end_us,
              before: priorClips,
              after: afterClips,
              inverse,
            }
          : {
              schema_version: "1.0",
              operation_id: operationId,
              operation_type: "ripple_delete",
              start_us: intent.start_us,
              end_us: intent.end_us,
              before: priorClips,
              after: afterClips,
              inverse,
            },
      );
      timeline.operation_ids.push(operationId);
      continue;
    }
    const clipIndex = timeline.clips.findIndex(
      (candidate) => candidate.clip_id === intent.clip_id,
    );
    if (clipIndex < 0) fail("invalid");
    const current = timeline.clips[clipIndex]!;
    if (
      intent.timeline_position_us <= current.timeline_start_us ||
      intent.timeline_position_us >= current.timeline_end_us
    )
      fail("conflict");
    if (intent.type === "split") {
      if (timeline.clips.length >= 4096) fail("conflict");
      const splitSourceUs =
        current.source_start_us +
        (intent.timeline_position_us - current.timeline_start_us);
      const left = {
        ...current,
        source_end_us: splitSourceUs,
        timeline_end_us: intent.timeline_position_us,
      };
      const right = {
        ...current,
        clip_id: `clip-${canonicalSha256({ operation_id: operationId, clip_id: intent.clip_id }).slice(0, 32)}`,
        source_start_us: splitSourceUs,
        timeline_start_us: intent.timeline_position_us,
      };
      if (
        timeline.clips.some((candidate) => candidate.clip_id === right.clip_id)
      )
        fail("conflict");
      timeline.clips.splice(clipIndex, 1, left, right);
      records.push({
        schema_version: "1.0",
        operation_id: operationId,
        operation_type: "split",
        clip_id: intent.clip_id,
        timeline_position_us: intent.timeline_position_us,
        before: structuredClone(current),
        after: [structuredClone(left), structuredClone(right)],
        inverse: {
          type: "merge_split",
          clip: structuredClone(current),
          expected_after_sha256: canonicalSha256([left, right]),
        },
      });
    } else {
      const next = structuredClone(current);
      if (intent.edge === "start") {
        const removed = intent.timeline_position_us - current.timeline_start_us;
        next.source_start_us += removed;
      } else {
        next.source_end_us =
          current.source_start_us +
          (intent.timeline_position_us - current.timeline_start_us);
      }
      timeline.clips[clipIndex] = next;
      records.push({
        schema_version: "1.0",
        operation_id: operationId,
        operation_type: "trim",
        clip_id: intent.clip_id,
        edge: intent.edge,
        timeline_position_us: intent.timeline_position_us,
        before: structuredClone(current),
        after: structuredClone(next),
        inverse: {
          type: "restore_clip",
          clip: structuredClone(current),
          expected_after_sha256: canonicalSha256(next),
        },
      });
    }
    let position = 0;
    for (const candidate of timeline.clips) {
      candidate.timeline_start_us = position;
      position += candidate.source_end_us - candidate.source_start_us;
      candidate.timeline_end_us = position;
    }
    timeline.duration_us = position;
    timeline.operation_ids.push(operationId);
  }
  const after = nextState(before, timeline);
  assertDraftState(after, baseline);
  const partial: Omit<DraftTransactionRecord, "transaction_sha256"> = {
    schema_version: "1.0",
    transaction_id: authority.transaction_id,
    request_id: request.request_id,
    request_sha256: draftRequestSha256(request, authority.origin),
    previous_transaction_sha256: before.head_transaction_sha256,
    project_id: before.project_id,
    draft_id: before.draft_id,
    base_revision_id: before.base_revision_id,
    kind: "apply",
    origin: authority.origin,
    pass_group: structuredClone(request.pass_group),
    reason: request.reason,
    created_at: authority.created_at,
    target_transaction_id: null,
    before: cloneDraftState(before),
    after,
    operations: records,
    status: "committed",
  };
  const transaction_sha256 = draftRecordSha256(partial);
  partial.after.head_transaction_sha256 = transaction_sha256;
  return { ...partial, transaction_sha256 };
}

function prepareUndo(
  baseline: ProjectBaseline,
  before: DraftState,
  request: UndoDraftTransactionRequest,
  authority: DraftTransactionAuthority,
  target: DraftTransactionRecord,
): DraftTransactionRecord {
  ensureFresh(request, before);
  if (
    authority.operation_ids.length !== 0 ||
    target.kind !== "apply" ||
    target.transaction_id !== request.target_transaction_id ||
    target.after.timeline_sha256 !== before.timeline_sha256 ||
    target.operations.some(
      (operation) =>
        canonicalSha256(operation.after) !==
        operation.inverse.expected_after_sha256,
    )
  )
    fail("conflict");
  const after = nextState(before, structuredClone(target.before.timeline));
  assertDraftState(after, baseline);
  const partial: Omit<DraftTransactionRecord, "transaction_sha256"> = {
    schema_version: "1.0",
    transaction_id: authority.transaction_id,
    request_id: request.request_id,
    request_sha256: draftRequestSha256(request, authority.origin),
    previous_transaction_sha256: before.head_transaction_sha256,
    project_id: before.project_id,
    draft_id: before.draft_id,
    base_revision_id: before.base_revision_id,
    kind: "undo",
    origin: authority.origin,
    pass_group: null,
    reason: request.reason,
    created_at: authority.created_at,
    target_transaction_id: target.transaction_id,
    before: cloneDraftState(before),
    after,
    operations: [],
    status: "committed",
  };
  const transaction_sha256 = draftRecordSha256(partial);
  partial.after.head_transaction_sha256 = transaction_sha256;
  return { ...partial, transaction_sha256 };
}

function prepareRedo(
  baseline: ProjectBaseline,
  before: DraftState,
  request: RedoDraftTransactionRequest,
  authority: DraftTransactionAuthority,
  targetUndo: DraftTransactionRecord,
  targetApply: DraftTransactionRecord,
): DraftTransactionRecord {
  ensureFresh(request, before);
  if (
    authority.operation_ids.length !== 0 ||
    targetUndo.kind !== "undo" ||
    targetUndo.transaction_id !== request.target_transaction_id ||
    targetUndo.target_transaction_id !== targetApply.transaction_id ||
    targetApply.kind !== "apply" ||
    targetUndo.after.timeline_sha256 !== before.timeline_sha256 ||
    targetUndo.before.timeline_sha256 !== targetApply.after.timeline_sha256
  )
    fail("conflict");
  const after = nextState(before, structuredClone(targetApply.after.timeline));
  assertDraftState(after, baseline);
  const partial: Omit<DraftTransactionRecord, "transaction_sha256"> = {
    schema_version: "1.0",
    transaction_id: authority.transaction_id,
    request_id: request.request_id,
    request_sha256: draftRequestSha256(request, authority.origin),
    previous_transaction_sha256: before.head_transaction_sha256,
    project_id: before.project_id,
    draft_id: before.draft_id,
    base_revision_id: before.base_revision_id,
    kind: "redo",
    origin: authority.origin,
    pass_group: null,
    reason: request.reason,
    created_at: authority.created_at,
    target_transaction_id: targetUndo.transaction_id,
    before: cloneDraftState(before),
    after,
    operations: [],
    status: "committed",
  };
  const transaction_sha256 = draftRecordSha256(partial);
  partial.after.head_transaction_sha256 = transaction_sha256;
  return { ...partial, transaction_sha256 };
}

/** Shared durable history for manual, Codex, and Magic Wand draft mutations. */
export class DraftTransactionStore {
  private readonly root: string;
  private readonly projects: ProjectReader;
  private readonly dependencies: DraftTransactionDependencies;

  constructor(
    rootAbsolute: string,
    projects: ProjectReader,
    dependencies: Partial<DraftTransactionDependencies> = {},
  ) {
    if (!isAbsolute(rootAbsolute)) fail("invalid");
    this.root = resolve(rootAbsolute);
    this.projects = projects;
    this.dependencies = {
      now: () => new Date().toISOString(),
      id: () => randomUUID(),
      ...dependencies,
    };
  }

  private async load(projectId: string): Promise<LoadedDraft> {
    let baseline: ProjectBaseline;
    try {
      baseline = await this.projects.readForDraftTransaction(projectId);
    } catch {
      fail();
    }
    const folder = join(this.root, projectId);
    await safeDirectory(this.root);
    await safeDirectory(folder);
    if (
      !sameProjectStorePath(
        await realpath(folder),
        baseline.project.storage.project_root,
      )
    )
      fail();
    const draftFolder = join(folder, "draft"),
      journal = join(draftFolder, "journal"),
      checkpoints = join(draftFolder, "checkpoints");
    await mkdir(draftFolder, { recursive: true, mode: 0o700 });
    await safeDirectory(draftFolder);
    await mkdir(journal, { recursive: true, mode: 0o700 });
    await safeDirectory(journal);
    await mkdir(checkpoints, { recursive: true, mode: 0o700 });
    await safeDirectory(checkpoints);
    const metaPath = join(draftFolder, "meta.json");
    let meta: DraftMeta;
    try {
      meta = assertMeta(await readJson(metaPath), baseline);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      const draftId = `draft-${this.dependencies.id()}`,
        createdAt = this.dependencies.now();
      if (!validId(draftId) || !validTimestamp(createdAt)) fail("invalid");
      const common = {
        project_id: baseline.project.project_id,
        draft_id: draftId,
        base_revision_id: baseline.revision.revision_id,
        baseline_timeline_sha256: timelineSha256(baseline.timeline),
        created_at: createdAt,
      };
      meta =
        baseline.schema_version === "1.1"
          ? {
              schema_version: "1.1",
              ...common,
              sources_sha256: sourcesSha256(baseline),
            }
          : {
              schema_version: "1.0",
              ...common,
              source_sha256: baseline.source.sha256,
            };
      await writeNew(metaPath, meta);
    }
    const entries = await readdir(journal);
    if (entries.length > 100_000) fail();
    const committed: { sequence: number; id: string; path: string }[] = [];
    for (const entry of entries) {
      if (pendingPattern.test(entry)) {
        const info = await lstat(join(journal, entry));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
        continue;
      }
      const match = committedPattern.exec(entry);
      if (!match) fail();
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail();
      committed.push({ sequence, id: match[2]!, path: join(journal, entry) });
    }
    committed.sort((left, right) => left.sequence - right.sequence);
    let state = initialDraftState(baseline, meta.draft_id);
    const records = new Map<string, DraftTransactionRecord>(),
      requests = new Map<string, DraftTransactionRecord>(),
      applied: DraftTransactionRecord[] = [],
      undone: DraftTransactionRecord[] = [],
      states = new Map<number, DraftState>([[0, cloneDraftState(state)]]),
      appliedIds = new Map<number, string[]>([[0, []]]);
    for (let index = 0; index < committed.length; index++) {
      const entry = committed[index]!;
      if (entry.sequence !== index + 1 || records.has(entry.id)) fail();
      const record = assertRecordEnvelope(await readJson(entry.path));
      if (
        record.transaction_id !== entry.id ||
        record.project_id !== projectId ||
        record.draft_id !== meta.draft_id ||
        record.base_revision_id !== meta.base_revision_id ||
        record.previous_transaction_sha256 !== state.head_transaction_sha256 ||
        record.transaction_sha256 !==
          draftRecordSha256(recordWithoutHash(record)) ||
        !same(record.before, state)
      )
        fail();
      assertDraftState(record.before, baseline);
      assertDraftState(record.after, baseline);
      if (
        record.after.draft_sequence !== entry.sequence ||
        record.after.head_transaction_sha256 !== record.transaction_sha256 ||
        requests.has(record.request_id)
      )
        fail();
      let replay: DraftTransactionRecord;
      if (record.kind === "apply") {
        if (!record.pass_group || record.target_transaction_id !== null) fail();
        const request: ApplyDraftTransactionRequest = {
          schema_version: "1.0",
          request_id: record.request_id,
          project_id: record.project_id,
          draft_id: record.draft_id,
          base_revision_id: record.base_revision_id,
          expected_sequence: record.before.draft_sequence,
          expected_timeline_sha256: record.before.timeline_sha256,
          pass_group: record.pass_group,
          reason: record.reason,
          operations: record.operations.map((operation) =>
            operation.operation_type === "split"
              ? {
                  type: "split" as const,
                  clip_id: operation.clip_id,
                  timeline_position_us: operation.timeline_position_us,
                }
              : operation.operation_type === "ripple_delete"
                ? {
                    type: "ripple_delete" as const,
                    start_us: operation.start_us,
                    end_us: operation.end_us,
                  }
                : operation.operation_type === "restore"
                  ? {
                      type: "restore_range" as const,
                      source_id: operation.source_id,
                      source_start_us: operation.source_start_us,
                      source_end_us: operation.source_end_us,
                    }
                  : operation.operation_type === "transcript_cut"
                    ? {
                        type: "transcript_cut" as const,
                        source_id: operation.source_id,
                        transcript_id: operation.transcript_id,
                        start_word_id: operation.start_word_id,
                        end_word_id: operation.end_word_id,
                        source_start_us: operation.source_start_us,
                        source_end_us: operation.source_end_us,
                        start_us: operation.start_us,
                        end_us: operation.end_us,
                      }
                    : operation.operation_type === "transcript_edit"
                      ? {
                          type: "transcript_edit" as const,
                          source_id: operation.source_id,
                          transcript_id: operation.transcript_id,
                          word_id: operation.word_id,
                          original_text: operation.original_text,
                          expected_text: operation.before_text,
                          replacement_text: operation.after_text,
                        }
                      : {
                          type: "trim" as const,
                          clip_id: operation.clip_id,
                          edge: operation.edge,
                          timeline_position_us: operation.timeline_position_us,
                        },
          ),
        };
        assertApplyDraftTransactionRequest(request);
        replay = prepareApply(baseline, state, request, {
          origin: record.origin,
          transaction_id: record.transaction_id,
          operation_ids: record.operations.map(
            (operation) => operation.operation_id,
          ),
          created_at: record.created_at,
        });
        applied.push(record);
        undone.length = 0;
      } else if (record.kind === "undo") {
        if (
          record.pass_group !== null ||
          record.operations.length ||
          !record.target_transaction_id ||
          applied.at(-1)?.transaction_id !== record.target_transaction_id
        )
          fail();
        const request: UndoDraftTransactionRequest = {
          schema_version: "1.0",
          request_id: record.request_id,
          project_id: record.project_id,
          draft_id: record.draft_id,
          base_revision_id: record.base_revision_id,
          expected_sequence: record.before.draft_sequence,
          expected_timeline_sha256: record.before.timeline_sha256,
          target_transaction_id: record.target_transaction_id,
          reason: record.reason,
        };
        assertUndoDraftTransactionRequest(request);
        replay = prepareUndo(
          baseline,
          state,
          request,
          {
            origin: record.origin,
            transaction_id: record.transaction_id,
            operation_ids: [],
            created_at: record.created_at,
          },
          applied.at(-1)!,
        );
        applied.pop();
        undone.push(record);
      } else {
        if (
          record.pass_group !== null ||
          record.operations.length ||
          !record.target_transaction_id ||
          undone.at(-1)?.transaction_id !== record.target_transaction_id
        )
          fail();
        const targetUndo = undone.at(-1)!;
        const targetApply = records.get(targetUndo.target_transaction_id ?? "");
        if (!targetApply) fail();
        const request: RedoDraftTransactionRequest = {
          schema_version: "1.0",
          request_id: record.request_id,
          project_id: record.project_id,
          draft_id: record.draft_id,
          base_revision_id: record.base_revision_id,
          expected_sequence: record.before.draft_sequence,
          expected_timeline_sha256: record.before.timeline_sha256,
          target_transaction_id: record.target_transaction_id,
          reason: record.reason,
          kind: "redo",
        };
        assertRedoDraftTransactionRequest(request);
        replay = prepareRedo(
          baseline,
          state,
          request,
          {
            origin: record.origin,
            transaction_id: record.transaction_id,
            operation_ids: [],
            created_at: record.created_at,
          },
          targetUndo,
          targetApply,
        );
        undone.pop();
        applied.push(targetApply);
      }
      if (!same(replay, record)) fail();
      state = cloneDraftState(record.after);
      records.set(record.transaction_id, record);
      requests.set(record.request_id, record);
      states.set(entry.sequence, cloneDraftState(state));
      appliedIds.set(
        entry.sequence,
        applied.map((transaction) => transaction.transaction_id),
      );
    }
    const checkpointEntries = await readdir(checkpoints);
    if (checkpointEntries.length > 100_000) fail();
    const checkpointFiles: { sequence: number; id: string; path: string }[] =
      [];
    for (const entry of checkpointEntries) {
      if (pendingPattern.test(entry)) {
        const info = await lstat(join(checkpoints, entry));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
        continue;
      }
      const match = committedPattern.exec(entry);
      if (!match) fail();
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail();
      checkpointFiles.push({
        sequence,
        id: match[2]!,
        path: join(checkpoints, entry),
      });
    }
    checkpointFiles.sort((left, right) => left.sequence - right.sequence);
    const checkpointRequests = new Map<string, PassCheckpointRecord>(),
      checkpointIds = new Set<string>(),
      checkpointSequences = new Set<number>();
    let currentCheckpoint: PassCheckpointRecord | null = null;
    for (const entry of checkpointFiles) {
      const checkpoint = assertCheckpointEnvelope(await readJson(entry.path)),
        checkpointState = states.get(entry.sequence),
        activeIds = appliedIds.get(entry.sequence);
      if (
        !checkpointState ||
        !activeIds ||
        checkpoint.checkpoint_id !== entry.id ||
        checkpoint.project_id !== projectId ||
        checkpoint.draft_id !== meta.draft_id ||
        checkpoint.base_revision_id !== meta.base_revision_id ||
        checkpoint.draft_sequence !== entry.sequence ||
        checkpoint.timeline_sha256 !== checkpointState.timeline_sha256 ||
        checkpoint.head_transaction_sha256 !==
          checkpointState.head_transaction_sha256 ||
        checkpoint.request_sha256 !==
          passCheckpointRequestSha256(
            checkpointRequestFromRecord(checkpoint),
          ) ||
        checkpoint.checkpoint_sha256 !==
          passCheckpointRecordSha256(checkpointWithoutHash(checkpoint)) ||
        checkpointIds.has(checkpoint.checkpoint_id) ||
        checkpointSequences.has(entry.sequence) ||
        checkpointRequests.has(checkpoint.request_id)
      )
        fail();
      const groupIds = activeIds.filter((transactionId) => {
        const transaction = records.get(transactionId);
        return (
          transaction?.pass_group?.pass_group_id ===
            checkpoint.pass_group.pass_group_id &&
          transaction.pass_group.kind === checkpoint.pass_group.kind
        );
      });
      const newest = records.get(activeIds.at(-1) ?? "");
      if (
        !same(groupIds, checkpoint.verified_transaction_ids) ||
        newest?.pass_group?.pass_group_id !==
          checkpoint.pass_group.pass_group_id ||
        newest.pass_group.kind !== checkpoint.pass_group.kind
      )
        fail();
      checkpointIds.add(checkpoint.checkpoint_id);
      checkpointSequences.add(entry.sequence);
      checkpointRequests.set(checkpoint.request_id, checkpoint);
      if (entry.sequence === state.draft_sequence)
        currentCheckpoint = checkpoint;
    }
    return {
      baseline,
      state,
      records,
      requests,
      applied,
      undone,
      journal,
      checkpointRequests,
      currentCheckpoint,
      checkpoints,
    };
  }

  private serialize<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (!validId(projectId))
      return Promise.reject(new DraftTransactionError("invalid"));
    return serializeProjectStore(this.root, work).catch((error: unknown) => {
      if (error instanceof DraftTransactionError) throw error;
      fail("storage");
    });
  }

  snapshot(projectId: string): Promise<DraftReadResult> {
    return this.serialize(projectId, async () => {
      const loaded = await this.load(projectId);
      return {
        draft: cloneDraftState(loaded.state),
        undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
        redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
        current_pass_checkpoint: loaded.currentCheckpoint
          ? structuredClone(loaded.currentCheckpoint)
          : null,
      };
    });
  }

  /** One root-queue read keeps project navigation and the active draft coherent. */
  snapshotWithProject(projectId: string): Promise<DraftProjectReadResult> {
    return this.serialize(projectId, async () => {
      const loaded = await this.load(projectId);
      return {
        project: structuredClone(loaded.baseline),
        draft: cloneDraftState(loaded.state),
        undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
        redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
        current_pass_checkpoint: loaded.currentCheckpoint
          ? structuredClone(loaded.currentCheckpoint)
          : null,
      };
    });
  }

  applyManual(value: unknown): Promise<DraftCommitResult> {
    return this.applyAs("manual", value);
  }

  applyCodex(value: unknown): Promise<DraftCommitResult> {
    return this.applyAs("codex", value);
  }

  applyApiProvider(value: unknown): Promise<DraftCommitResult> {
    return this.applyAs("api_provider", value);
  }

  applyMagicWand(value: unknown): Promise<DraftCommitResult> {
    return this.applyAs("magic_wand", value);
  }

  private applyAs(
    origin: DraftOrigin,
    value: unknown,
  ): Promise<DraftCommitResult> {
    try {
      assertApplyDraftTransactionRequest(value);
    } catch {
      fail("invalid");
    }
    const request = structuredClone(value);
    return this.serialize(request.project_id, async () => {
      const loaded = await this.load(request.project_id),
        requestHash = draftRequestSha256(request, origin),
        previous = loaded.requests.get(request.request_id);
      if (loaded.checkpointRequests.has(request.request_id)) fail("conflict");
      if (previous) {
        if (previous.request_sha256 !== requestHash) fail("conflict");
        return {
          draft: cloneDraftState(loaded.state),
          undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
          redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
          current_pass_checkpoint: loaded.currentCheckpoint
            ? structuredClone(loaded.currentCheckpoint)
            : null,
          transaction: structuredClone(previous),
          replayed: true,
        };
      }
      ensureFresh(request, loaded.state);
      if (loaded.state.draft_sequence >= sequenceLimit) fail("conflict");
      const transactionId = this.dependencies.id(),
        operationIds = request.operations.map(() => this.dependencies.id()),
        createdAt = this.dependencies.now();
      if (
        !validId(transactionId) ||
        operationIds.some((id) => !validId(id)) ||
        !validTimestamp(createdAt) ||
        loaded.records.has(transactionId)
      )
        fail("invalid");
      const transaction = prepareApply(loaded.baseline, loaded.state, request, {
        origin,
        transaction_id: transactionId,
        operation_ids: operationIds,
        created_at: createdAt,
      });
      await this.commit(loaded.journal, transaction);
      return {
        draft: cloneDraftState(transaction.after),
        undo_transaction_id: transaction.transaction_id,
        redo_transaction_id: null,
        current_pass_checkpoint: null,
        transaction: structuredClone(transaction),
        replayed: false,
      };
    });
  }

  recordPassCheckpoint(value: unknown): Promise<PassCheckpointCommitResult> {
    try {
      assertPassCheckpointRequest(value);
    } catch {
      fail("invalid");
    }
    const request = structuredClone(value);
    return this.serialize(request.project_id, async () => {
      const loaded = await this.load(request.project_id),
        requestHash = passCheckpointRequestSha256(request),
        previous = loaded.checkpointRequests.get(request.request_id);
      if (loaded.requests.has(request.request_id)) fail("conflict");
      if (previous) {
        if (previous.request_sha256 !== requestHash) fail("conflict");
        return {
          draft: cloneDraftState(loaded.state),
          undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
          redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
          current_pass_checkpoint: loaded.currentCheckpoint
            ? structuredClone(loaded.currentCheckpoint)
            : null,
          checkpoint: structuredClone(previous),
          replayed: true,
        };
      }
      ensureFresh(request, loaded.state);
      const groupIds = loaded.applied
          .filter(
            (transaction) =>
              transaction.pass_group?.pass_group_id ===
                request.pass_group.pass_group_id &&
              transaction.pass_group.kind === request.pass_group.kind,
          )
          .map((transaction) => transaction.transaction_id),
        newest = loaded.applied.at(-1);
      if (
        !same(groupIds, request.verified_transaction_ids) ||
        newest?.pass_group?.pass_group_id !==
          request.pass_group.pass_group_id ||
        newest.pass_group.kind !== request.pass_group.kind ||
        !loaded.state.head_transaction_sha256
      )
        fail("conflict");
      const checkpointId = this.dependencies.id(),
        createdAt = this.dependencies.now();
      if (
        !validId(checkpointId) ||
        !validTimestamp(createdAt) ||
        loaded.records.has(checkpointId) ||
        [...loaded.checkpointRequests.values()].some(
          (checkpoint) => checkpoint.checkpoint_id === checkpointId,
        )
      )
        fail("invalid");
      const partial: Omit<PassCheckpointRecord, "checkpoint_sha256"> = {
          schema_version: "1.0",
          checkpoint_id: checkpointId,
          request_id: request.request_id,
          request_sha256: requestHash,
          project_id: loaded.state.project_id,
          draft_id: loaded.state.draft_id,
          base_revision_id: loaded.state.base_revision_id,
          draft_sequence: loaded.state.draft_sequence,
          timeline_sha256: loaded.state.timeline_sha256,
          head_transaction_sha256: loaded.state.head_transaction_sha256,
          pass_group: structuredClone(request.pass_group),
          verified_transaction_ids: [...request.verified_transaction_ids],
          summary: request.summary,
          checks: structuredClone(request.checks),
          created_at: createdAt,
          status: "verified",
        },
        checkpoint: PassCheckpointRecord = {
          ...partial,
          checkpoint_sha256: passCheckpointRecordSha256(partial),
        };
      await this.commitCheckpoint(loaded.checkpoints, checkpoint);
      return {
        draft: cloneDraftState(loaded.state),
        undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
        redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
        current_pass_checkpoint: structuredClone(checkpoint),
        checkpoint: structuredClone(checkpoint),
        replayed: false,
      };
    });
  }

  /**
   * Persist a structural-only checkpoint for the current manual group. Evidence
   * comes from this store's validated reads, never from renderer or model text.
   * This does not certify editorial meaning or rendered A/V joins.
   */
  private manualStructureCheckpointRequest(
    projectId: string,
    loaded: LoadedDraft,
    passGroupId: string,
  ): PassCheckpointRequest {
    if (!validId(passGroupId)) fail("invalid");
    const passGroup = { pass_group_id: passGroupId, kind: "manual" as const },
      transactionIds = loaded.applied
        .filter(
          (transaction) =>
            transaction.origin === "manual" &&
            transaction.pass_group?.pass_group_id === passGroupId &&
            transaction.pass_group.kind === "manual",
        )
        .map((transaction) => transaction.transaction_id),
      newestApplied = loaded.applied.at(-1);
    if (
      transactionIds.length < 1 ||
      transactionIds.length > 64 ||
      newestApplied?.origin !== "manual" ||
      newestApplied?.pass_group?.pass_group_id !== passGroupId ||
      newestApplied.pass_group.kind !== "manual" ||
      !loaded.state.head_transaction_sha256
    )
      fail("conflict");
    const sourceHashes = [
      ...new Set(
        loaded.baseline.schema_version === "1.1"
          ? loaded.baseline.sources.map((source) => source.sha256)
          : [loaded.baseline.source.sha256],
      ),
    ];
    const checkpointRequest: PassCheckpointRequest = {
      schema_version: "1.0",
      request_id: `structure-${canonicalSha256({
        project_id: projectId,
        draft_id: loaded.state.draft_id,
        draft_sequence: loaded.state.draft_sequence,
        timeline_sha256: loaded.state.timeline_sha256,
        head_transaction_sha256: loaded.state.head_transaction_sha256,
        pass_group: passGroup,
      })}`,
      project_id: projectId,
      draft_id: loaded.state.draft_id,
      base_revision_id: loaded.state.base_revision_id,
      expected_sequence: loaded.state.draft_sequence,
      expected_timeline_sha256: loaded.state.timeline_sha256,
      pass_group: passGroup,
      verified_transaction_ids: transactionIds,
      summary:
        "Manual draft structure integrity verified; editorial meaning and audio/video review were not performed.",
      checks: [
        {
          check_id: "draft-timeline-structure",
          status: "pass",
          method:
            "Re-read the committed draft and validated source intervals against the immutable baseline.",
          evidence_ids: [loaded.state.timeline_sha256],
        },
        {
          check_id: "draft-journal-integrity",
          status: "pass",
          method:
            "Replayed complete committed transactions and matched the current journal head.",
          evidence_ids: [loaded.state.head_transaction_sha256],
        },
        {
          check_id: "draft-managed-source-integrity",
          status: "pass",
          method:
            "Re-read managed sources and validated hashes, sizes, probes, and timing metadata against the project manifest.",
          evidence_ids: sourceHashes,
        },
      ],
    };
    try {
      assertPassCheckpointRequest(checkpointRequest);
    } catch {
      fail("invalid");
    }
    return checkpointRequest;
  }

  recordManualStructureCheckpoint(
    projectId: string,
    passGroupId: string,
  ): Promise<PassCheckpointCommitResult> {
    return this.serialize(projectId, async () => {
      return this.manualStructureCheckpointRequest(
        projectId,
        await this.load(projectId),
        passGroupId,
      );
    }).then((request) => this.recordPassCheckpoint(request));
  }

  /**
   * Record a structure-only checkpoint when the current head belongs to a
   * main-owned manual group. AI-origin groups are never checkpointed here.
   */
  recordLatestManualStructureCheckpoint(
    projectId: string,
  ): Promise<PassCheckpointCommitResult | null> {
    return this.serialize(projectId, async () => {
      const loaded = await this.load(projectId),
        newestApplied = loaded.applied.at(-1),
        passGroup = newestApplied?.pass_group;
      if (newestApplied?.origin !== "manual" || passGroup?.kind !== "manual")
        return null;
      return this.manualStructureCheckpointRequest(
        projectId,
        loaded,
        passGroup.pass_group_id,
      );
    }).then((request) => (request ? this.recordPassCheckpoint(request) : null));
  }

  undoManual(value: unknown): Promise<DraftCommitResult> {
    return this.undoAs("manual", value);
  }

  undoCodex(value: unknown): Promise<DraftCommitResult> {
    return this.undoAs("codex", value);
  }

  undoApiProvider(value: unknown): Promise<DraftCommitResult> {
    return this.undoAs("api_provider", value);
  }

  undoMagicWand(value: unknown): Promise<DraftCommitResult> {
    return this.undoAs("magic_wand", value);
  }

  private undoAs(
    origin: DraftOrigin,
    value: unknown,
  ): Promise<DraftCommitResult> {
    try {
      assertUndoDraftTransactionRequest(value);
    } catch {
      fail("invalid");
    }
    const request = structuredClone(value);
    return this.serialize(request.project_id, async () => {
      const loaded = await this.load(request.project_id),
        requestHash = draftRequestSha256(request, origin),
        previous = loaded.requests.get(request.request_id);
      if (loaded.checkpointRequests.has(request.request_id)) fail("conflict");
      if (previous) {
        if (previous.request_sha256 !== requestHash) fail("conflict");
        return {
          draft: cloneDraftState(loaded.state),
          undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
          redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
          current_pass_checkpoint: loaded.currentCheckpoint
            ? structuredClone(loaded.currentCheckpoint)
            : null,
          transaction: structuredClone(previous),
          replayed: true,
        };
      }
      ensureFresh(request, loaded.state);
      if (loaded.state.draft_sequence >= sequenceLimit) fail("conflict");
      const target = loaded.applied.at(-1);
      if (!target || target.transaction_id !== request.target_transaction_id)
        fail("conflict");
      const transactionId = this.dependencies.id(),
        createdAt = this.dependencies.now();
      if (
        !validId(transactionId) ||
        !validTimestamp(createdAt) ||
        loaded.records.has(transactionId)
      )
        fail("invalid");
      const transaction = prepareUndo(
        loaded.baseline,
        loaded.state,
        request,
        {
          origin,
          transaction_id: transactionId,
          operation_ids: [],
          created_at: createdAt,
        },
        target,
      );
      await this.commit(loaded.journal, transaction);
      loaded.applied.pop();
      loaded.undone.push(transaction);
      return {
        draft: cloneDraftState(transaction.after),
        undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
        redo_transaction_id: transaction.transaction_id,
        current_pass_checkpoint: null,
        transaction: structuredClone(transaction),
        replayed: false,
      };
    });
  }

  redoManual(value: unknown): Promise<DraftCommitResult> {
    return this.redoAs("manual", value);
  }

  redoCodex(value: unknown): Promise<DraftCommitResult> {
    return this.redoAs("codex", value);
  }

  redoApiProvider(value: unknown): Promise<DraftCommitResult> {
    return this.redoAs("api_provider", value);
  }

  redoMagicWand(value: unknown): Promise<DraftCommitResult> {
    return this.redoAs("magic_wand", value);
  }

  private redoAs(
    origin: DraftOrigin,
    value: unknown,
  ): Promise<DraftCommitResult> {
    try {
      assertRedoDraftTransactionRequest(value);
    } catch {
      fail("invalid");
    }
    const request = structuredClone(value);
    return this.serialize(request.project_id, async () => {
      const loaded = await this.load(request.project_id),
        requestHash = draftRequestSha256(request, origin),
        previous = loaded.requests.get(request.request_id);
      if (loaded.checkpointRequests.has(request.request_id)) fail("conflict");
      if (previous) {
        if (previous.request_sha256 !== requestHash) fail("conflict");
        return {
          draft: cloneDraftState(loaded.state),
          undo_transaction_id: loaded.applied.at(-1)?.transaction_id ?? null,
          redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
          current_pass_checkpoint: loaded.currentCheckpoint
            ? structuredClone(loaded.currentCheckpoint)
            : null,
          transaction: structuredClone(previous),
          replayed: true,
        };
      }
      ensureFresh(request, loaded.state);
      if (loaded.state.draft_sequence >= sequenceLimit) fail("conflict");
      const targetUndo = loaded.undone.at(-1);
      if (
        !targetUndo ||
        targetUndo.transaction_id !== request.target_transaction_id
      )
        fail("conflict");
      const targetApply = loaded.records.get(
        targetUndo.target_transaction_id ?? "",
      );
      if (!targetApply) fail("conflict");
      const transactionId = this.dependencies.id(),
        createdAt = this.dependencies.now();
      if (
        !validId(transactionId) ||
        !validTimestamp(createdAt) ||
        loaded.records.has(transactionId)
      )
        fail("invalid");
      const transaction = prepareRedo(
        loaded.baseline,
        loaded.state,
        request,
        {
          origin,
          transaction_id: transactionId,
          operation_ids: [],
          created_at: createdAt,
        },
        targetUndo,
        targetApply,
      );
      await this.commit(loaded.journal, transaction);
      loaded.undone.pop();
      loaded.applied.push(targetApply);
      return {
        draft: cloneDraftState(transaction.after),
        undo_transaction_id: targetApply.transaction_id,
        redo_transaction_id: loaded.undone.at(-1)?.transaction_id ?? null,
        current_pass_checkpoint: null,
        transaction: structuredClone(transaction),
        replayed: false,
      };
    });
  }

  private async commit(
    journal: string,
    transaction: DraftTransactionRecord,
  ): Promise<void> {
    const pending = join(
        journal,
        `.pending-${transaction.transaction_id}.json`,
      ),
      committed = join(
        journal,
        `${String(transaction.after.draft_sequence).padStart(12, "0")}.${transaction.transaction_id}.json`,
      );
    await writeNew(pending, transaction);
    try {
      await this.dependencies.afterPendingWrite?.();
    } catch {
      fail("storage");
    }
    await safeDirectory(journal);
    await rename(pending, committed);
    try {
      await this.dependencies.afterJournalCommit?.();
    } catch {
      fail("outcome_unknown");
    }
  }

  private async commitCheckpoint(
    checkpoints: string,
    checkpoint: PassCheckpointRecord,
  ): Promise<void> {
    const pending = join(
        checkpoints,
        `.pending-${checkpoint.checkpoint_id}.json`,
      ),
      committed = join(
        checkpoints,
        `${String(checkpoint.draft_sequence).padStart(12, "0")}.${checkpoint.checkpoint_id}.json`,
      );
    await writeNew(pending, checkpoint);
    try {
      await this.dependencies.afterCheckpointPendingWrite?.();
    } catch {
      fail("storage");
    }
    await safeDirectory(checkpoints);
    await rename(pending, committed);
    try {
      await this.dependencies.afterCheckpointCommit?.();
    } catch {
      fail("outcome_unknown");
    }
  }
}
