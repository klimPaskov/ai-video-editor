import {
  assertMediaFrame,
  assertMediaSummary,
  mediaIdPattern,
} from "./library.ts";
import type { MediaFrame, MediaSummary } from "./library.ts";
import { assertTranscriptTextOverrides } from "./transcription.ts";
import type { TranscriptTextOverride } from "./transcription.ts";

export const projectStages = [
  "record_import",
  "auto_edit",
  "edit",
  "review",
  "export",
] as const;
export type ProjectStage = (typeof projectStages)[number];
export interface ProjectRequest {
  id: string;
}
/** Ordered, path-free references to two already imported library sources. */
export interface TwoSourceProjectRequest {
  firstId: string;
  secondId: string;
}
export interface ProjectNavigation extends ProjectRequest {
  stage: ProjectStage;
}
export interface ProjectFrameRequest {
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  timelineTimeUs: number;
}
export interface ProjectFrameView {
  status: "ready";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  draftSequence: number;
  timelineSha256: string;
  timelineTimeUs: number;
  frame: MediaFrame;
}
export type ProjectFrameResult =
  ProjectFrameView | { status: "stale"; draft: ProjectDraftView };
export interface ProjectDraftView {
  projectId: string;
  draft: {
    id: string;
    baseRevisionId: string;
    sequence: number;
    timelineSha256: string;
    undoTransactionId: string | null;
    redoTransactionId: string | null;
  };
  timeline: {
    id: string;
    durationUs: number;
    frameRate: { numerator: number; denominator: number };
  };
  /** Current committed, half-open fragment map. Older exchange fixtures may omit it. */
  clips?: ProjectClipView[];
  /** Text-only corrections committed through the same reversible draft journal. */
  transcriptEdits?: TranscriptTextOverride[];
}
export interface ProjectDraftIntegrityView {
  draft: ProjectDraftView;
  /** True only when main recorded an evidence-backed checkpoint for the current manual group. */
  structuralCheckpointRecorded: boolean;
}
export interface ProjectClipView {
  id: string;
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
}
/** Path-free view of a committed project, never a renderer-owned persistence model. */
export interface ProjectView extends Omit<ProjectDraftView, "projectId"> {
  id: string;
  name: string;
  stage: ProjectStage;
  revisionId: string;
  source: MediaSummary;
  /** Present only for an ordered two-source project; source aliases sources[0]. */
  sources?: MediaSummary[];
}
export interface ManualTrimRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  clipId: string;
  edge: "start" | "end";
  timelinePositionUs: number;
}
export interface ManualSplitRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  clipId: string;
  timelinePositionUs: number;
}
/** Half-open output-timeline interval to remove from the active draft. */
export interface ManualRangeCutRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  startUs: number;
  endUs: number;
}
/** Exact source-time interval confirmed missing from the active draft. */
export interface ManualRestoreRangeRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  sourceId: string;
  sourceStartUs: number;
  sourceEndUs: number;
}
export interface ManualTranscriptCorrectionRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  sourceId: string;
  transcriptId: string;
  wordId: string;
  expectedText: string;
  replacementText: string;
}
export interface ManualUndoRequest {
  schema_version: "1.0";
  projectId: string;
  draftId: string;
  baseRevisionId: string;
  expectedSequence: number;
  expectedTimelineSha256: string;
  targetTransactionId: string;
}
export type ManualRedoRequest = ManualUndoRequest;
function invalid(): never {
  throw new Error("Invalid project exchange.");
}
function exact(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !mediaIdPattern.test(value)) invalid();
}
function opaqueId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(value)
  )
    invalid();
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid();
}
export function assertProjectRequest(
  value: unknown,
): asserts value is ProjectRequest {
  exact(value, ["id"]);
  id(value.id);
}
export function assertTwoSourceProjectRequest(
  value: unknown,
): asserts value is TwoSourceProjectRequest {
  exact(value, ["firstId", "secondId"]);
  id(value.firstId);
  id(value.secondId);
  if (value.firstId === value.secondId) invalid();
}
export function assertProjectNavigation(
  value: unknown,
): asserts value is ProjectNavigation {
  exact(value, ["id", "stage"]);
  id(value.id);
  if (!projectStages.includes(value.stage as ProjectStage)) invalid();
}
export function assertProjectFrameRequest(
  value: unknown,
): asserts value is ProjectFrameRequest {
  exact(value, [
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "timelineTimeUs",
  ]);
  id(value.projectId);
  opaqueId(value.draftId);
  id(value.baseRevisionId);
  integer(value.expectedSequence);
  hash(value.expectedTimelineSha256);
  integer(value.timelineTimeUs);
  if (
    new Set([value.projectId, value.baseRevisionId, value.draftId]).size !== 3
  )
    invalid();
}
function assertManualHead(value: Record<string, unknown>): void {
  if (value.schema_version !== "1.0") invalid();
  id(value.projectId);
  opaqueId(value.draftId);
  id(value.baseRevisionId);
  integer(value.expectedSequence);
  hash(value.expectedTimelineSha256);
  if (
    new Set([value.projectId, value.draftId, value.baseRevisionId]).size !== 3
  )
    invalid();
}
export function assertManualTrimRequest(
  value: unknown,
): asserts value is ManualTrimRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "clipId",
    "edge",
    "timelinePositionUs",
  ]);
  assertManualHead(value);
  opaqueId(value.clipId);
  if (value.edge !== "start" && value.edge !== "end") invalid();
  positive(value.timelinePositionUs);
}
export function assertManualSplitRequest(
  value: unknown,
): asserts value is ManualSplitRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "clipId",
    "timelinePositionUs",
  ]);
  assertManualHead(value);
  opaqueId(value.clipId);
  positive(value.timelinePositionUs);
}
export function assertManualRangeCutRequest(
  value: unknown,
): asserts value is ManualRangeCutRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "startUs",
    "endUs",
  ]);
  assertManualHead(value);
  integer(value.startUs);
  positive(value.endUs);
  if (value.startUs >= value.endUs) invalid();
}
export function assertManualRestoreRangeRequest(
  value: unknown,
): asserts value is ManualRestoreRangeRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "sourceId",
    "sourceStartUs",
    "sourceEndUs",
  ]);
  assertManualHead(value);
  id(value.sourceId);
  integer(value.sourceStartUs);
  positive(value.sourceEndUs);
  if (value.sourceStartUs >= value.sourceEndUs) invalid();
}
export function assertManualTranscriptCorrectionRequest(
  value: unknown,
): asserts value is ManualTranscriptCorrectionRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "sourceId",
    "transcriptId",
    "wordId",
    "expectedText",
    "replacementText",
  ]);
  assertManualHead(value);
  id(value.sourceId);
  opaqueId(value.transcriptId);
  opaqueId(value.wordId);
  const text = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 200 &&
    candidate.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/u.test(candidate);
  if (
    !text(value.expectedText) ||
    !text(value.replacementText) ||
    value.expectedText === value.replacementText
  )
    invalid();
}
export function assertManualUndoRequest(
  value: unknown,
): asserts value is ManualUndoRequest {
  exact(value, [
    "schema_version",
    "projectId",
    "draftId",
    "baseRevisionId",
    "expectedSequence",
    "expectedTimelineSha256",
    "targetTransactionId",
  ]);
  assertManualHead(value);
  opaqueId(value.targetTransactionId);
}
export function assertManualRedoRequest(
  value: unknown,
): asserts value is ManualRedoRequest {
  assertManualUndoRequest(value);
}
export function assertProjectFrameView(
  value: unknown,
): asserts value is ProjectFrameView {
  exact(value, [
    "status",
    "projectId",
    "draftId",
    "baseRevisionId",
    "draftSequence",
    "timelineSha256",
    "timelineTimeUs",
    "frame",
  ]);
  if (value.status !== "ready") invalid();
  assertProjectFrameRequest({
    projectId: value.projectId,
    draftId: value.draftId,
    baseRevisionId: value.baseRevisionId,
    expectedSequence: value.draftSequence,
    expectedTimelineSha256: value.timelineSha256,
    timelineTimeUs: value.timelineTimeUs,
  });
  assertMediaFrame(value.frame);
}
export function assertProjectFrameResult(
  value: unknown,
): asserts value is ProjectFrameResult {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "status" in value &&
    value.status === "stale"
  ) {
    const stale = value as Record<string, unknown>;
    exact(stale, ["status", "draft"]);
    assertProjectDraftView(stale.draft);
    return;
  }
  assertProjectFrameView(value);
}
export function assertProjectDraftView(
  value: unknown,
): asserts value is ProjectDraftView {
  const hasClips =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "clips");
  const hasTranscriptEdits =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "transcriptEdits");
  exact(value, [
    "projectId",
    "draft",
    "timeline",
    ...(hasClips ? ["clips"] : []),
    ...(hasTranscriptEdits ? ["transcriptEdits"] : []),
  ]);
  id(value.projectId);
  exact(value.draft, [
    "id",
    "baseRevisionId",
    "sequence",
    "timelineSha256",
    "undoTransactionId",
    "redoTransactionId",
  ]);
  opaqueId(value.draft.id);
  id(value.draft.baseRevisionId);
  integer(value.draft.sequence);
  hash(value.draft.timelineSha256);
  if (value.draft.undoTransactionId !== null)
    opaqueId(value.draft.undoTransactionId);
  if (value.draft.redoTransactionId !== null)
    opaqueId(value.draft.redoTransactionId);
  exact(value.timeline, ["id", "durationUs", "frameRate"]);
  id(value.timeline.id);
  positive(value.timeline.durationUs);
  exact(value.timeline.frameRate, ["numerator", "denominator"]);
  positive(value.timeline.frameRate.numerator);
  positive(value.timeline.frameRate.denominator);
  if (
    new Set([
      value.projectId,
      value.draft.baseRevisionId,
      value.draft.id,
      value.timeline.id,
    ]).size !== 4
  )
    invalid();
  if (hasClips) {
    if (
      !Array.isArray(value.clips) ||
      value.clips.length < 1 ||
      value.clips.length > 4096
    )
      invalid();
    let position = 0;
    const clipIds = new Set<string>();
    const completedSources = new Set<string>();
    let activeSource: string | undefined;
    let priorSourceEnd = 0;
    for (const clip of value.clips) {
      exact(clip, [
        "id",
        "sourceId",
        "timelineStartUs",
        "timelineEndUs",
        "sourceStartUs",
        "sourceEndUs",
      ]);
      opaqueId(clip.id);
      id(clip.sourceId);
      integer(clip.timelineStartUs);
      positive(clip.timelineEndUs);
      integer(clip.sourceStartUs);
      positive(clip.sourceEndUs);
      if (
        clipIds.has(clip.id) ||
        clip.timelineStartUs !== position ||
        clip.sourceStartUs >= clip.sourceEndUs ||
        (activeSource === clip.sourceId &&
          clip.sourceStartUs < priorSourceEnd) ||
        (activeSource !== clip.sourceId &&
          completedSources.has(clip.sourceId)) ||
        clip.timelineEndUs - clip.timelineStartUs !==
          clip.sourceEndUs - clip.sourceStartUs
      )
        invalid();
      clipIds.add(clip.id);
      if (activeSource !== clip.sourceId) {
        if (activeSource !== undefined) completedSources.add(activeSource);
        activeSource = clip.sourceId;
      }
      priorSourceEnd = clip.sourceEndUs;
      position = clip.timelineEndUs;
    }
    if (completedSources.size + (activeSource === undefined ? 0 : 1) > 2)
      invalid();
    if (position !== value.timeline.durationUs) invalid();
  }
  if (hasTranscriptEdits) assertTranscriptTextOverrides(value.transcriptEdits);
}
export function assertProjectDraftIntegrityView(
  value: unknown,
): asserts value is ProjectDraftIntegrityView {
  exact(value, ["draft", "structuralCheckpointRecorded"]);
  assertProjectDraftView(value.draft);
  if (typeof value.structuralCheckpointRecorded !== "boolean") invalid();
}
export function assertProjectView(
  value: unknown,
): asserts value is ProjectView {
  const keys = [
    "id",
    "name",
    "stage",
    "revisionId",
    "draft",
    "source",
    "timeline",
  ];
  const hasSources =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "sources");
  const hasClips =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "clips");
  const hasTranscriptEdits =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "transcriptEdits");
  exact(value, [
    ...keys,
    ...(hasSources ? ["sources"] : []),
    ...(hasClips ? ["clips"] : []),
    ...(hasTranscriptEdits ? ["transcriptEdits"] : []),
  ]);
  id(value.id);
  id(value.revisionId);
  if (
    typeof value.name !== "string" ||
    !value.name.length ||
    value.name.length > 160 ||
    /[\x00-\x1f/\\]/u.test(value.name)
  )
    invalid();
  if (!projectStages.includes(value.stage as ProjectStage)) invalid();
  assertMediaSummary(value.source);
  let secondSourceId: string | undefined;
  if (hasSources) {
    if (!Array.isArray(value.sources) || value.sources.length !== 2) invalid();
    value.sources.forEach(assertMediaSummary);
    if (value.sources[0].id === value.sources[1].id) invalid();
    secondSourceId = value.sources[1].id;
    for (const key of [
      "id",
      "name",
      "width",
      "height",
      "durationUs",
      "frameRate",
      "previewAvailable",
    ] as const)
      if (value.sources[0][key] !== value.source[key]) invalid();
  }
  const draftView = {
    projectId: value.id,
    draft: value.draft,
    timeline: value.timeline,
    ...(hasClips ? { clips: value.clips } : {}),
    ...(hasTranscriptEdits ? { transcriptEdits: value.transcriptEdits } : {}),
  };
  assertProjectDraftView(draftView);
  if (hasTranscriptEdits)
    assertTranscriptTextOverrides(
      value.transcriptEdits,
      hasSources
        ? (value.sources as MediaSummary[]).map((source) => source.id)
        : [value.source.id as string],
    );
  if (hasClips) {
    const clips = draftView.clips;
    if (!clips) invalid();
    const sourceIds = hasSources
      ? (value.sources as MediaSummary[]).map((source) => source.id)
      : [value.source.id];
    let sourceIndex = -1;
    for (const clip of clips) {
      const clipSourceIndex = sourceIds.indexOf(clip.sourceId);
      if (
        clipSourceIndex < sourceIndex ||
        clipSourceIndex === -1 ||
        clip.sourceEndUs >
          (hasSources
            ? (value.sources as MediaSummary[])[clipSourceIndex]!
            : (value.source as MediaSummary)
          ).durationUs
      )
        invalid();
      sourceIndex = clipSourceIndex;
    }
  }
  if (draftView.draft.baseRevisionId !== value.revisionId) invalid();
  if (
    [
      value.id,
      value.revisionId,
      draftView.draft.id,
      draftView.timeline.id,
    ].includes(value.source.id)
  )
    invalid();
  if (
    secondSourceId !== undefined &&
    [
      value.id,
      value.revisionId,
      draftView.draft.id,
      draftView.timeline.id,
    ].includes(secondSourceId)
  )
    invalid();
}
export function assertProjectList(
  value: unknown,
): asserts value is ProjectView[] {
  if (!Array.isArray(value) || value.length > 1000) invalid();
  value.forEach(assertProjectView);
  if (new Set(value.map((item) => item.id)).size !== value.length) invalid();
}
