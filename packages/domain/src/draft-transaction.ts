import type {
  InitialProjectSnapshot,
  TwoSourceInitialProjectSnapshot,
} from "./project.ts";
import { assertTranscriptTextOverrides } from "./transcription.ts";
import type { TranscriptTextOverride } from "./transcription.ts";
import {
  assertZoomEffect,
  assertZoomEffects,
  type ZoomEffect,
} from "./zoom.ts";
type ProjectBaseline = InitialProjectSnapshot | TwoSourceInitialProjectSnapshot;
import {
  canonicalSha256,
  projectCanonicalJson,
  timelineSha256,
} from "./project.ts";

export type DraftTimeline = InitialProjectSnapshot["timeline"] & {
  transcript_edits?: TranscriptTextOverride[];
  /** Zoom effects anchored to source time; absent means none. */
  zooms?: ZoomEffect[];
};
export type DraftOrigin =
  "manual" | "codex" | "claude" | "api_provider" | "magic_wand";
export type DraftPassKind =
  | "manual"
  | "spoken_cut"
  | "layout"
  | "zoom"
  | "captions"
  | "speed"
  | "audio"
  | "broll"
  | "cursor";

export interface DraftPassGroup {
  pass_group_id: string;
  kind: DraftPassKind;
}

export interface TrimEdgeIntent {
  type: "trim";
  clip_id: string;
  edge: "start" | "end";
  timeline_position_us: number;
}

export interface SplitClipIntent {
  type: "split";
  clip_id: string;
  timeline_position_us: number;
}

export interface RippleDeleteIntent {
  type: "ripple_delete";
  start_us: number;
  end_us: number;
}

export interface RestoreRangeIntent {
  type: "restore_range";
  source_id: string;
  source_start_us: number;
  source_end_us: number;
}

export interface TranscriptEditIntent {
  type: "transcript_edit";
  source_id: string;
  transcript_id: string;
  word_id: string;
  original_text: string;
  expected_text: string;
  replacement_text: string;
}

export interface TranscriptCutIntent {
  type: "transcript_cut";
  source_id: string;
  transcript_id: string;
  start_word_id: string;
  end_word_id: string;
  source_start_us: number;
  source_end_us: number;
  start_us: number;
  end_us: number;
}

/** Adds a zoom, or replaces the zoom with the same id. */
export interface SetZoomIntent {
  type: "set_zoom";
  zoom: ZoomEffect;
}

export interface RemoveZoomIntent {
  type: "remove_zoom";
  zoom_id: string;
}

export type DraftEditIntent =
  | SetZoomIntent
  | RemoveZoomIntent
  | TrimEdgeIntent
  | SplitClipIntent
  | RippleDeleteIntent
  | RestoreRangeIntent
  | TranscriptEditIntent
  | TranscriptCutIntent;

/** Untrusted callers provide intent and freshness only. Authority is injected by the adapter. */
export interface ApplyDraftTransactionRequest {
  schema_version: "1.0";
  request_id: string;
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  expected_sequence: number;
  expected_timeline_sha256: string;
  pass_group: DraftPassGroup;
  reason: string;
  operations: DraftEditIntent[];
}

export interface UndoDraftTransactionRequest {
  schema_version: "1.0";
  request_id: string;
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  expected_sequence: number;
  expected_timeline_sha256: string;
  target_transaction_id: string;
  reason: string;
}

/** Redo only the latest undone transaction on the current exact draft head. */
export interface RedoDraftTransactionRequest extends UndoDraftTransactionRequest {
  kind: "redo";
}

export interface DraftVerificationCheck {
  check_id: string;
  status: "pass";
  method: string;
  evidence_ids: string[];
}

/** Created only by the trusted verification service after its checks have passed. */
export interface PassCheckpointRequest {
  schema_version: "1.0";
  request_id: string;
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  expected_sequence: number;
  expected_timeline_sha256: string;
  pass_group: DraftPassGroup;
  verified_transaction_ids: string[];
  summary: string;
  checks: DraftVerificationCheck[];
}

export interface DraftState {
  schema_version: "1.0";
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
  head_transaction_sha256: string | null;
  timeline: DraftTimeline;
}

export interface TrimOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "trim";
  clip_id: string;
  edge: "start" | "end";
  timeline_position_us: number;
  before: DraftTimeline["clips"][number];
  after: DraftTimeline["clips"][number];
  inverse: {
    type: "restore_clip";
    clip: DraftTimeline["clips"][number];
    expected_after_sha256: string;
  };
}

export interface SplitOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "split";
  clip_id: string;
  timeline_position_us: number;
  before: DraftTimeline["clips"][number];
  after: [DraftTimeline["clips"][number], DraftTimeline["clips"][number]];
  inverse: {
    type: "merge_split";
    clip: DraftTimeline["clips"][number];
    expected_after_sha256: string;
  };
}

export interface RippleDeleteOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "ripple_delete";
  start_us: number;
  end_us: number;
  before: DraftTimeline["clips"];
  after: DraftTimeline["clips"];
  inverse: {
    type: "restore_timeline_clips";
    clips: DraftTimeline["clips"];
    expected_after_sha256: string;
  };
}

export interface RestoreRangeOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "restore";
  source_id: string;
  source_start_us: number;
  source_end_us: number;
  before: DraftTimeline["clips"];
  after: DraftTimeline["clips"];
  inverse: {
    type: "restore_timeline_clips";
    clips: DraftTimeline["clips"];
    expected_after_sha256: string;
  };
}

export interface TranscriptEditOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "transcript_edit";
  source_id: string;
  transcript_id: string;
  word_id: string;
  original_text: string;
  before_text: string;
  after_text: string;
  before: TranscriptTextOverride[];
  after: TranscriptTextOverride[];
  inverse: {
    type: "restore_transcript_edits";
    edits: TranscriptTextOverride[];
    expected_after_sha256: string;
  };
}

export interface TranscriptCutOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "transcript_cut";
  source_id: string;
  transcript_id: string;
  start_word_id: string;
  end_word_id: string;
  source_start_us: number;
  source_end_us: number;
  start_us: number;
  end_us: number;
  before: DraftTimeline["clips"];
  after: DraftTimeline["clips"];
  inverse: {
    type: "restore_timeline_clips";
    clips: DraftTimeline["clips"];
    expected_after_sha256: string;
  };
}

export interface ZoomOperationRecord {
  schema_version: "1.0";
  operation_id: string;
  operation_type: "zoom";
  action: "set" | "remove";
  zoom_id: string;
  /** The zoom set, or null when removing. */
  zoom: ZoomEffect | null;
  before: ZoomEffect[];
  after: ZoomEffect[];
  inverse: {
    type: "restore_zooms";
    zooms: ZoomEffect[];
    expected_after_sha256: string;
  };
}

export type DraftOperationRecord =
  | ZoomOperationRecord
  | TrimOperationRecord
  | SplitOperationRecord
  | RippleDeleteOperationRecord
  | RestoreRangeOperationRecord
  | TranscriptEditOperationRecord
  | TranscriptCutOperationRecord;

export interface DraftTransactionRecord {
  schema_version: "1.0";
  transaction_id: string;
  request_id: string;
  request_sha256: string;
  transaction_sha256: string;
  previous_transaction_sha256: string | null;
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  kind: "apply" | "undo" | "redo";
  origin: DraftOrigin;
  pass_group: DraftPassGroup | null;
  reason: string;
  created_at: string;
  target_transaction_id: string | null;
  before: DraftState;
  after: DraftState;
  operations: DraftOperationRecord[];
  status: "committed";
}

export interface PassCheckpointRecord {
  schema_version: "1.0";
  checkpoint_id: string;
  request_id: string;
  request_sha256: string;
  checkpoint_sha256: string;
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
  head_transaction_sha256: string;
  pass_group: DraftPassGroup;
  verified_transaction_ids: string[];
  summary: string;
  checks: DraftVerificationCheck[];
  created_at: string;
  status: "verified";
}

export interface DraftTransactionAuthority {
  origin: DraftOrigin;
  transaction_id: string;
  operation_ids: string[];
  created_at: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const passKinds: readonly DraftPassKind[] = [
  "manual",
  "spoken_cut",
  "layout",
  "zoom",
  "captions",
  "speed",
  "audio",
  "broll",
  "cursor",
];

function invalid(): never {
  throw new Error(
    "The draft transaction is invalid or stale. Refresh the project and try again.",
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

function exactOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    invalid();
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}

function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !hashPattern.test(value)) invalid();
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
}

function prose(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function transcriptText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function passGroup(value: unknown): asserts value is DraftPassGroup {
  exact(value, ["pass_group_id", "kind"]);
  id(value.pass_group_id);
  if (!passKinds.includes(value.kind as DraftPassKind)) invalid();
}

function verificationCheck(
  value: unknown,
): asserts value is DraftVerificationCheck {
  exact(value, ["check_id", "status", "method", "evidence_ids"]);
  id(value.check_id);
  if (value.status !== "pass") invalid();
  prose(value.method);
  if (
    !Array.isArray(value.evidence_ids) ||
    value.evidence_ids.length < 1 ||
    value.evidence_ids.length > 64
  )
    invalid();
  for (const evidenceId of value.evidence_ids) id(evidenceId);
  if (new Set(value.evidence_ids).size !== value.evidence_ids.length) invalid();
}

function clip(value: unknown): asserts value is DraftTimeline["clips"][number] {
  exact(value, [
    "clip_id",
    "track_id",
    "source_id",
    "source_start_us",
    "source_end_us",
    "timeline_start_us",
    "timeline_end_us",
    "enabled",
  ]);
  id(value.clip_id);
  id(value.track_id);
  id(value.source_id);
  integer(value.source_start_us);
  integer(value.source_end_us, 1);
  integer(value.timeline_start_us);
  integer(value.timeline_end_us, 1);
  if (
    value.source_start_us >= value.source_end_us ||
    value.timeline_start_us >= value.timeline_end_us ||
    value.enabled !== true
  )
    invalid();
}

/** Preserve the baseline's ordered source identity and contiguous half-open clip map. */
export function assertDraftTimeline(
  value: unknown,
  baseline: DraftTimeline,
): asserts value is DraftTimeline {
  exactOptional(
    value,
    [
      "schema_version",
      "timeline_id",
      "project_id",
      "revision_id",
      "duration_us",
      "frame_rate",
      "canvas",
      "tracks",
      "clips",
      "operation_ids",
      "zoom_ids",
      "speed_ids",
      "created_at",
    ],
    ["transcript_edits", "zooms"],
  );
  if (Object.hasOwn(value, "zooms"))
    assertZoomEffects(value.zooms, baseline.clips);
  if (Object.hasOwn(value, "transcript_edits"))
    assertTranscriptTextOverrides(
      value.transcript_edits,
      baseline.clips.map((clip) => clip.source_id),
    );
  if (
    value.schema_version !== "1.0" ||
    value.timeline_id !== baseline.timeline_id ||
    value.project_id !== baseline.project_id ||
    value.revision_id !== baseline.revision_id ||
    value.created_at !== baseline.created_at ||
    projectCanonicalJson(value.frame_rate) !==
      projectCanonicalJson(baseline.frame_rate) ||
    projectCanonicalJson(value.canvas) !==
      projectCanonicalJson(baseline.canvas) ||
    projectCanonicalJson(value.tracks) !==
      projectCanonicalJson(baseline.tracks) ||
    projectCanonicalJson(value.zoom_ids) !==
      projectCanonicalJson(baseline.zoom_ids) ||
    projectCanonicalJson(value.speed_ids) !==
      projectCanonicalJson(baseline.speed_ids) ||
    !Array.isArray(value.operation_ids) ||
    value.operation_ids.length > 100_000 ||
    !Array.isArray(value.clips) ||
    ![1, 2].includes(baseline.clips.length) ||
    value.clips.length < 1 ||
    value.clips.length > 4096
  )
    invalid();
  for (const operationId of value.operation_ids) id(operationId);
  if (new Set(value.operation_ids).size !== value.operation_ids.length)
    invalid();
  let position = 0;
  let clipIndex = 0;
  const clipIds = new Set<string>();
  for (const original of baseline.clips) {
    clip(original);
    let previousSourceEnd = original.source_start_us;
    while (
      clipIndex < value.clips.length &&
      value.clips[clipIndex]?.source_id === original.source_id
    ) {
      const current = value.clips[clipIndex++]!;
      clip(current);
      if (
        (current.clip_id !== original.clip_id &&
          !/^clip-[a-f0-9]{32}$/u.test(current.clip_id)) ||
        clipIds.has(current.clip_id) ||
        current.track_id !== original.track_id ||
        current.source_id !== original.source_id ||
        current.source_start_us < original.source_start_us ||
        current.source_start_us < previousSourceEnd ||
        current.source_end_us > original.source_end_us ||
        current.timeline_start_us !== position ||
        !Number.isSafeInteger(
          position + current.source_end_us - current.source_start_us,
        ) ||
        current.timeline_end_us !==
          position + current.source_end_us - current.source_start_us
      )
        invalid();
      clipIds.add(current.clip_id);
      previousSourceEnd = current.source_end_us;
      position = current.timeline_end_us;
    }
  }
  if (clipIndex !== value.clips.length || value.duration_us !== position)
    invalid();
}

export function assertDraftState(
  value: unknown,
  baseline: ProjectBaseline,
): asserts value is DraftState {
  exact(value, [
    "schema_version",
    "project_id",
    "draft_id",
    "base_revision_id",
    "draft_sequence",
    "timeline_sha256",
    "head_transaction_sha256",
    "timeline",
  ]);
  if (
    value.schema_version !== "1.0" ||
    value.project_id !== baseline.project.project_id ||
    value.base_revision_id !== baseline.revision.revision_id
  )
    invalid();
  id(value.draft_id);
  integer(value.draft_sequence);
  hash(value.timeline_sha256);
  if (value.head_transaction_sha256 !== null)
    hash(value.head_transaction_sha256);
  if ((value.draft_sequence === 0) !== (value.head_transaction_sha256 === null))
    invalid();
  assertDraftTimeline(value.timeline, baseline.timeline);
  if (timelineSha256(value.timeline) !== value.timeline_sha256) invalid();
}

function commonRequest(value: Record<string, unknown>): void {
  if (value.schema_version !== "1.0") invalid();
  id(value.request_id);
  id(value.project_id);
  id(value.draft_id);
  id(value.base_revision_id);
  integer(value.expected_sequence);
  hash(value.expected_timeline_sha256);
  prose(value.reason);
}

export function assertApplyDraftTransactionRequest(
  value: unknown,
): asserts value is ApplyDraftTransactionRequest {
  exact(value, [
    "schema_version",
    "request_id",
    "project_id",
    "draft_id",
    "base_revision_id",
    "expected_sequence",
    "expected_timeline_sha256",
    "pass_group",
    "reason",
    "operations",
  ]);
  commonRequest(value);
  passGroup(value.pass_group);
  if (
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > 64
  )
    invalid();
  const clips = new Set<string>();
  let previousRangeStart: number | null = null;
  for (const operation of value.operations) {
    if (operation?.type === "set_zoom") {
      if (value.operations.length !== 1) invalid();
      exact(operation, ["type", "zoom"]);
      assertZoomEffect(operation.zoom);
      continue;
    }
    if (operation?.type === "remove_zoom") {
      if (value.operations.length !== 1) invalid();
      exact(operation, ["type", "zoom_id"]);
      id(operation.zoom_id);
      continue;
    }
    if (operation?.type === "transcript_cut") {
      if (value.operations.length !== 1) invalid();
      exact(operation, [
        "type",
        "source_id",
        "transcript_id",
        "start_word_id",
        "end_word_id",
        "source_start_us",
        "source_end_us",
        "start_us",
        "end_us",
      ]);
      id(operation.source_id);
      id(operation.transcript_id);
      id(operation.start_word_id);
      id(operation.end_word_id);
      integer(operation.source_start_us);
      integer(operation.source_end_us, 1);
      integer(operation.start_us);
      integer(operation.end_us, 1);
      if (
        operation.source_start_us >= operation.source_end_us ||
        operation.start_us >= operation.end_us
      )
        invalid();
      continue;
    }
    if (operation?.type === "transcript_edit") {
      if (value.operations.length !== 1) invalid();
      exact(operation, [
        "type",
        "source_id",
        "transcript_id",
        "word_id",
        "original_text",
        "expected_text",
        "replacement_text",
      ]);
      id(operation.source_id);
      id(operation.transcript_id);
      id(operation.word_id);
      transcriptText(operation.original_text);
      transcriptText(operation.expected_text);
      transcriptText(operation.replacement_text);
      if (operation.expected_text === operation.replacement_text) invalid();
      continue;
    }
    if (operation?.type === "restore_range") {
      if (value.operations.length !== 1) invalid();
      exact(operation, [
        "type",
        "source_id",
        "source_start_us",
        "source_end_us",
      ]);
      id(operation.source_id);
      integer(operation.source_start_us);
      integer(operation.source_end_us, 1);
      if (operation.source_start_us >= operation.source_end_us) invalid();
      continue;
    }
    if (operation?.type === "ripple_delete") {
      exact(operation, ["type", "start_us", "end_us"]);
      integer(operation.start_us);
      integer(operation.end_us, 1);
      if (
        operation.start_us >= operation.end_us ||
        (previousRangeStart !== null && operation.end_us > previousRangeStart)
      )
        invalid();
      previousRangeStart = operation.start_us;
      continue;
    }
    if (
      previousRangeStart !== null ||
      value.operations.some(
        (item) =>
          item?.type === "ripple_delete" || item?.type === "restore_range",
      )
    )
      invalid();
    exact(
      operation,
      operation?.type === "split"
        ? ["type", "clip_id", "timeline_position_us"]
        : ["type", "clip_id", "edge", "timeline_position_us"],
    );
    id(operation.clip_id);
    integer(operation.timeline_position_us, 1);
    if (
      (operation.type !== "split" &&
        (operation.type !== "trim" ||
          !["start", "end"].includes(operation.edge as string))) ||
      clips.has(operation.clip_id)
    )
      invalid();
    clips.add(operation.clip_id);
  }
}

export function assertUndoDraftTransactionRequest(
  value: unknown,
): asserts value is UndoDraftTransactionRequest {
  exact(value, [
    "schema_version",
    "request_id",
    "project_id",
    "draft_id",
    "base_revision_id",
    "expected_sequence",
    "expected_timeline_sha256",
    "target_transaction_id",
    "reason",
  ]);
  commonRequest(value);
  id(value.target_transaction_id);
}

export function assertRedoDraftTransactionRequest(
  value: unknown,
): asserts value is RedoDraftTransactionRequest {
  exact(value, [
    "schema_version",
    "request_id",
    "project_id",
    "draft_id",
    "base_revision_id",
    "expected_sequence",
    "expected_timeline_sha256",
    "target_transaction_id",
    "reason",
    "kind",
  ]);
  commonRequest(value);
  id(value.target_transaction_id);
  if (value.kind !== "redo") invalid();
}

export function assertPassCheckpointRequest(
  value: unknown,
): asserts value is PassCheckpointRequest {
  exact(value, [
    "schema_version",
    "request_id",
    "project_id",
    "draft_id",
    "base_revision_id",
    "expected_sequence",
    "expected_timeline_sha256",
    "pass_group",
    "verified_transaction_ids",
    "summary",
    "checks",
  ]);
  commonRequest({
    schema_version: value.schema_version,
    request_id: value.request_id,
    project_id: value.project_id,
    draft_id: value.draft_id,
    base_revision_id: value.base_revision_id,
    expected_sequence: value.expected_sequence,
    expected_timeline_sha256: value.expected_timeline_sha256,
    reason: value.summary,
  });
  passGroup(value.pass_group);
  if (
    !Array.isArray(value.verified_transaction_ids) ||
    value.verified_transaction_ids.length < 1 ||
    value.verified_transaction_ids.length > 64 ||
    !Array.isArray(value.checks) ||
    value.checks.length < 1 ||
    value.checks.length > 64
  )
    invalid();
  for (const transactionId of value.verified_transaction_ids) id(transactionId);
  if (
    new Set(value.verified_transaction_ids).size !==
    value.verified_transaction_ids.length
  )
    invalid();
  for (const check of value.checks) verificationCheck(check);
  if (
    new Set(value.checks.map((check) => check.check_id)).size !==
    value.checks.length
  )
    invalid();
}

export function cloneDraftState(value: DraftState): DraftState {
  return JSON.parse(projectCanonicalJson(value)) as DraftState;
}

export function initialDraftState(
  baseline: ProjectBaseline,
  draftId: string,
): DraftState {
  id(draftId);
  const timeline = JSON.parse(
    projectCanonicalJson(baseline.timeline),
  ) as DraftTimeline;
  return {
    schema_version: "1.0",
    project_id: baseline.project.project_id,
    draft_id: draftId,
    base_revision_id: baseline.revision.revision_id,
    draft_sequence: 0,
    timeline_sha256: timelineSha256(timeline),
    head_transaction_sha256: null,
    timeline,
  };
}

export function draftRequestSha256(
  request:
    | ApplyDraftTransactionRequest
    | UndoDraftTransactionRequest
    | RedoDraftTransactionRequest,
  origin: DraftOrigin,
): string {
  return canonicalSha256({ request, origin });
}

export function draftRecordSha256(
  record: Omit<DraftTransactionRecord, "transaction_sha256">,
): string {
  return canonicalSha256({
    ...record,
    // The head points at this digest, so it is excluded from its own preimage.
    after: { ...record.after, head_transaction_sha256: null },
  });
}

export function passCheckpointRequestSha256(
  request: PassCheckpointRequest,
): string {
  return canonicalSha256(request);
}

export function passCheckpointRecordSha256(
  record: Omit<PassCheckpointRecord, "checkpoint_sha256">,
): string {
  return canonicalSha256(record);
}
