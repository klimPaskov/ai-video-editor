import {
  DraftTransactionError,
  type DraftCommitResult,
  type DraftProjectReadResult,
  type DraftReadResult,
} from "../../project-store/src/transactions.ts";
import {
  assertTranscriptionProjectView,
  type TranscriptionProjectView,
} from "../../domain/src/transcription.ts";

export const codexVideoEditToolNames = [
  "project.get_summary",
  "timeline.get_summary",
  "cut.trim_edge",
  "cut.split",
  "cut.delete_range",
  "timeline.undo",
  "cut.delete_ranges",
  "cut.restore_range",
  "transcript.get_range",
] as const;

export type CodexVideoEditToolName = (typeof codexVideoEditToolNames)[number];

type DraftTransactions = {
  snapshot(projectId: string): Promise<DraftReadResult>;
  snapshotWithProject(projectId: string): Promise<DraftProjectReadResult>;
  applyCodex(value: unknown): Promise<DraftCommitResult>;
  undoCodex(value: unknown): Promise<DraftCommitResult>;
  applyApiProvider?(value: unknown): Promise<DraftCommitResult>;
  undoApiProvider?(value: unknown): Promise<DraftCommitResult>;
  applyClaude?(value: unknown): Promise<DraftCommitResult>;
  undoClaude?(value: unknown): Promise<DraftCommitResult>;
};

/** The assistant route that main attributes each guarded transaction to. */
export type ToolEditOrigin = "codex" | "claude" | "api_provider";

type TranscriptReader = (
  projectId: string,
) => Promise<TranscriptionProjectView>;

const maxTranscriptPageWords = 250;
const maxTranscriptRangeUs = 5 * 60 * 1_000_000;
const maxTranscriptPageBytes = 48 * 1024;

export type CodexVideoEditToolErrorCode =
  | "tool_not_available"
  | "invalid_request"
  | "inactive_project"
  | "stale_draft"
  | "edit_conflict"
  | "storage_unavailable"
  | "outcome_unknown"
  | "transcript_unavailable"
  | "service_unavailable";

const messages: Record<CodexVideoEditToolErrorCode, string> = {
  tool_not_available: "That editing tool is not available.",
  invalid_request:
    "The edit request is invalid. Refresh the project and try again.",
  inactive_project: "That project is not the active project.",
  stale_draft:
    "The draft changed before this edit could be applied. Refresh and try again.",
  edit_conflict:
    "This edit conflicts with newer draft work. Refresh the project and try again.",
  storage_unavailable:
    "The draft could not be read or saved. Reopen the project and try again.",
  outcome_unknown:
    "The edit may have been saved. Reopen the project before retrying.",
  transcript_unavailable:
    "A completed local transcript is not available for that source and range.",
  service_unavailable:
    "The editing service is unavailable. Reopen the project and try again.",
};

export class CodexVideoEditToolError extends Error {
  readonly code: CodexVideoEditToolErrorCode;

  constructor(code: CodexVideoEditToolErrorCode) {
    super(messages[code]);
    this.name = "CodexVideoEditToolError";
    this.code = code;
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

function reject(code: CodexVideoEditToolErrorCode): never {
  throw new CodexVideoEditToolError(code);
}

function exact(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const allowed = [...keys, ...optional];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length < keys.length ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    reject("invalid_request");
  return value as Record<string, unknown>;
}

function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value))
    reject("invalid_request");
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !hashPattern.test(value))
    reject("invalid_request");
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    reject("invalid_request");
}

function prose(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    reject("invalid_request");
}

function assertActiveProject(
  value: Record<string, unknown>,
  activeProjectId: string,
): asserts value is Record<string, unknown> & { project_id: string } {
  id(value.project_id);
  if (value.project_id !== activeProjectId) reject("inactive_project");
}

function readRequest(value: unknown, activeProjectId: string): string {
  const request = exact(value, ["schema_version", "project_id"]);
  if (request.schema_version !== "1.0") reject("invalid_request");
  assertActiveProject(request, activeProjectId);
  return request.project_id;
}

function freshness(
  request: Record<string, unknown>,
  activeProjectId: string,
): void {
  if (request.schema_version !== "1.0") reject("invalid_request");
  assertActiveProject(request, activeProjectId);
  id(request.request_id);
  id(request.draft_id);
  id(request.base_revision_id);
  integer(request.expected_sequence);
  hash(request.expected_timeline_sha256);
  prose(request.reason);
}

function safeDraft(draft: DraftReadResult["draft"], undoId: string | null) {
  return {
    schema_version: "1.0" as const,
    project_id: draft.project_id,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    draft_sequence: draft.draft_sequence,
    timeline_sha256: draft.timeline_sha256,
    duration_us: draft.timeline.duration_us,
    frame_rate: structuredClone(draft.timeline.frame_rate),
    canvas: structuredClone(draft.timeline.canvas),
    tracks: draft.timeline.tracks.map((track) => ({
      track_id: track.track_id,
      kind: track.kind,
      order: track.order,
      visible: track.visible,
      locked: track.locked,
    })),
    clips: draft.timeline.clips.map((clip) => ({
      clip_id: clip.clip_id,
      track_id: clip.track_id,
      source_id: clip.source_id,
      source_start_us: clip.source_start_us,
      source_end_us: clip.source_end_us,
      timeline_start_us: clip.timeline_start_us,
      timeline_end_us: clip.timeline_end_us,
      enabled: clip.enabled,
    })),
    operation_ids: [...draft.timeline.operation_ids],
    zoom_ids: [...draft.timeline.zoom_ids],
    speed_ids: [...draft.timeline.speed_ids],
    undo_transaction_id: undoId,
  };
}

function safeMutation(result: DraftCommitResult, summary: string) {
  return {
    status: "committed" as const,
    replayed: result.replayed,
    transaction_id: result.transaction.transaction_id,
    applied_operation_ids: result.transaction.operations.map(
      (operation) => operation.operation_id,
    ),
    draft: safeDraft(result.draft, result.undo_transaction_id),
    summary,
    warnings: [] as string[],
    undo_token: result.undo_transaction_id,
  };
}

function mapError(error: unknown): never {
  if (error instanceof CodexVideoEditToolError) throw error;
  if (error instanceof DraftTransactionError) {
    const mapped: Record<
      DraftTransactionError["code"],
      CodexVideoEditToolErrorCode
    > = {
      invalid: "invalid_request",
      stale: "stale_draft",
      conflict: "edit_conflict",
      storage: "storage_unavailable",
      outcome_unknown: "outcome_unknown",
    };
    reject(mapped[error.code]);
  }
  reject("service_unavailable");
}

/**
 * Main creates one instance for the currently active project and replaces it when
 * project focus changes. Tool input can assert that scope but cannot choose it.
 */
export class CodexVideoEditToolService {
  private readonly activeProjectId: string;
  private readonly drafts: DraftTransactions;
  private readonly origin: ToolEditOrigin;
  private readonly transcriptReader: TranscriptReader | undefined;

  constructor(
    activeProjectId: string,
    drafts: DraftTransactions,
    origin: ToolEditOrigin = "codex",
    transcriptReader?: TranscriptReader,
  ) {
    if (!idPattern.test(activeProjectId)) reject("invalid_request");
    this.activeProjectId = activeProjectId;
    this.drafts = drafts;
    this.origin = origin;
    this.transcriptReader = transcriptReader;
  }

  private applier():
    ((value: unknown) => Promise<DraftCommitResult>) | undefined {
    if (this.origin === "api_provider")
      return this.drafts.applyApiProvider?.bind(this.drafts);
    if (this.origin === "claude")
      return this.drafts.applyClaude?.bind(this.drafts);
    return this.drafts.applyCodex.bind(this.drafts);
  }

  private undoer():
    ((value: unknown) => Promise<DraftCommitResult>) | undefined {
    if (this.origin === "api_provider")
      return this.drafts.undoApiProvider?.bind(this.drafts);
    if (this.origin === "claude")
      return this.drafts.undoClaude?.bind(this.drafts);
    return this.drafts.undoCodex.bind(this.drafts);
  }

  async invoke(name: unknown, input: unknown): Promise<unknown> {
    try {
      if (typeof name !== "string") reject("tool_not_available");
      switch (name) {
        case "project.get_summary":
          return await this.projectSummary(input);
        case "timeline.get_summary":
          return await this.timelineSummary(input);
        case "transcript.get_range":
          return await this.transcriptRange(input);
        case "cut.trim_edge":
          return await this.trimEdge(input);
        case "cut.split":
          return await this.split(input);
        case "cut.delete_range":
          return await this.deleteRange(input);
        case "cut.delete_ranges":
          return await this.deleteRanges(input);
        case "cut.restore_range":
          return await this.restoreRange(input);
        case "timeline.undo":
          return await this.undo(input);
        default:
          reject("tool_not_available");
      }
    } catch (error) {
      mapError(error);
    }
  }

  private async projectSummary(input: unknown): Promise<unknown> {
    const projectId = readRequest(input, this.activeProjectId);
    const draft = await this.drafts.snapshotWithProject(projectId),
      project = draft.project;
    if (
      project.project.project_id !== this.activeProjectId ||
      draft.draft.project_id !== this.activeProjectId ||
      draft.draft.base_revision_id !== project.revision.revision_id
    )
      reject("service_unavailable");
    return {
      schema_version: "1.0",
      project_id: project.project.project_id,
      name: project.project.name,
      workflow_step: project.project.workflow_step,
      current_revision_id: project.project.current_revision_id,
      duration_us: draft.draft.timeline.duration_us,
      qa_status: project.revision.qa_status,
      sources: (project.schema_version === "1.1"
        ? project.sources
        : [project.source]
      ).map((source) => ({
        source_id: source.source_id,
        role: "main_video",
        kind: source.kind,
        duration_us: source.duration_us,
        immutable: source.immutable,
        stream_types: [
          ...new Set(source.streams.map((stream) => stream.media_type)),
        ],
      })),
      active_draft: {
        draft_id: draft.draft.draft_id,
        base_revision_id: draft.draft.base_revision_id,
        draft_sequence: draft.draft.draft_sequence,
        timeline_sha256: draft.draft.timeline_sha256,
        undo_transaction_id: draft.undo_transaction_id,
      },
    };
  }

  private async timelineSummary(input: unknown): Promise<unknown> {
    const projectId = readRequest(input, this.activeProjectId);
    const snapshot = await this.drafts.snapshot(projectId);
    return safeDraft(snapshot.draft, snapshot.undo_transaction_id);
  }

  private async transcriptRange(input: unknown): Promise<unknown> {
    const request = exact(
      input,
      [
        "schema_version",
        "project_id",
        "source_id",
        "source_start_us",
        "source_end_us",
        "offset",
        "limit",
      ],
      ["transcript_id"],
    );
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    const sourceId = request.source_id,
      expectedTranscriptId = request.transcript_id,
      sourceStartUs = request.source_start_us,
      sourceEndUs = request.source_end_us,
      offset = request.offset,
      limit = request.limit;
    id(sourceId);
    if (expectedTranscriptId !== undefined) id(expectedTranscriptId);
    integer(sourceStartUs);
    integer(sourceEndUs, 1);
    integer(offset);
    integer(limit, 1);
    if (
      sourceStartUs >= sourceEndUs ||
      sourceEndUs - sourceStartUs > maxTranscriptRangeUs ||
      limit > maxTranscriptPageWords
    )
      reject("invalid_request");
    if (!this.transcriptReader) reject("transcript_unavailable");

    const view = await this.transcriptReader(request.project_id);
    assertTranscriptionProjectView(view);
    if (view.job.status !== "completed") reject("transcript_unavailable");
    const result = view.results.find(
      (item) =>
        item.source_id === sourceId &&
        (expectedTranscriptId === undefined ||
          item.transcript.transcript_id === expectedTranscriptId),
    );
    if (!result || sourceEndUs > result.transcript.duration_us)
      reject("transcript_unavailable");

    const matchingWords = result.transcript.segments.flatMap((segment) =>
      segment.words.filter(
        (word) => word.end_us > sourceStartUs && word.start_us < sourceEndUs,
      ),
    );
    if (offset > matchingWords.length) reject("invalid_request");
    const draft = await this.drafts.snapshot(request.project_id);
    const overrides = new Map(
      (draft.draft.timeline.transcript_edits ?? [])
        .filter(
          (edit) =>
            edit.source_id === sourceId &&
            edit.transcript_id === result.transcript.transcript_id,
        )
        .map((edit) => [edit.word_id, edit.replacement_text]),
    );
    let pageSize = Math.min(limit, matchingWords.length - offset);
    for (;;) {
      const page = matchingWords.slice(offset, offset + pageSize),
        nextOffset = offset + page.length;
      const output = {
        schema_version: "1.0",
        project_id: this.activeProjectId,
        source_id: result.source_id,
        transcript_id: result.transcript.transcript_id,
        source_sha256: result.analysis.source_sha256,
        language: result.transcript.language,
        duration_us: result.transcript.duration_us,
        requested_source_range: {
          start_us: sourceStartUs,
          end_us: sourceEndUs,
        },
        draft: {
          draft_id: draft.draft.draft_id,
          base_revision_id: draft.draft.base_revision_id,
          draft_sequence: draft.draft.draft_sequence,
          timeline_sha256: draft.draft.timeline_sha256,
        },
        offset,
        total_word_count: matchingWords.length,
        next_offset: nextOffset < matchingWords.length ? nextOffset : null,
        words: page.map((word) => ({
          word_id: word.word_id,
          start_us: word.start_us,
          end_us: word.end_us,
          asr_text: word.text,
          transcript_override_text: overrides.get(word.word_id) ?? null,
          confidence: word.confidence ?? null,
          flags: word.flags ?? [],
        })),
      };
      if (Buffer.byteLength(JSON.stringify(output)) <= maxTranscriptPageBytes)
        return output;
      if (pageSize <= 1) reject("service_unavailable");
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
  }

  private async trimEdge(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "request_id",
      "project_id",
      "draft_id",
      "base_revision_id",
      "expected_sequence",
      "expected_timeline_sha256",
      "pass_group_id",
      "reason",
      "clip_id",
      "edge",
      "timeline_position_us",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.clip_id);
    integer(request.timeline_position_us, 1);
    if (request.edge !== "start" && request.edge !== "end")
      reject("invalid_request");
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: {
        pass_group_id: request.pass_group_id,
        kind: "spoken_cut",
      },
      reason: request.reason,
      operations: [
        {
          type: "trim",
          clip_id: request.clip_id,
          edge: request.edge,
          timeline_position_us: request.timeline_position_us,
        },
      ],
    });
    return safeMutation(result, "Trim applied to the active draft.");
  }

  private async split(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "request_id",
      "project_id",
      "draft_id",
      "base_revision_id",
      "expected_sequence",
      "expected_timeline_sha256",
      "pass_group_id",
      "reason",
      "clip_id",
      "timeline_position_us",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.clip_id);
    integer(request.timeline_position_us, 1);
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: {
        pass_group_id: request.pass_group_id,
        kind: "spoken_cut",
      },
      reason: request.reason,
      operations: [
        {
          type: "split",
          clip_id: request.clip_id,
          timeline_position_us: request.timeline_position_us,
        },
      ],
    });
    return safeMutation(result, "Clip split on the active draft.");
  }

  private async deleteRange(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "request_id",
      "project_id",
      "draft_id",
      "base_revision_id",
      "expected_sequence",
      "expected_timeline_sha256",
      "pass_group_id",
      "reason",
      "start_us",
      "end_us",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    integer(request.start_us);
    integer(request.end_us, 1);
    if (request.start_us >= request.end_us) reject("invalid_request");
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: {
        pass_group_id: request.pass_group_id,
        kind: "spoken_cut",
      },
      reason: request.reason,
      operations: [
        {
          type: "ripple_delete",
          start_us: request.start_us,
          end_us: request.end_us,
        },
      ],
    });
    return safeMutation(result, "Range cut applied to the active draft.");
  }

  private async deleteRanges(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "request_id",
      "project_id",
      "draft_id",
      "base_revision_id",
      "expected_sequence",
      "expected_timeline_sha256",
      "pass_group_id",
      "reason",
      "ranges",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    if (
      !Array.isArray(request.ranges) ||
      request.ranges.length < 2 ||
      request.ranges.length > 16
    )
      reject("invalid_request");
    let previousStart: number | null = null;
    const operations = request.ranges.map((item: unknown) => {
      const range = exact(item, ["start_us", "end_us"]);
      integer(range.start_us);
      integer(range.end_us, 1);
      if (
        range.start_us >= range.end_us ||
        (previousStart !== null && range.end_us > previousStart)
      )
        reject("invalid_request");
      previousStart = range.start_us;
      return {
        type: "ripple_delete" as const,
        start_us: range.start_us,
        end_us: range.end_us,
      };
    });
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "spoken_cut" },
      reason: request.reason,
      operations,
    });
    return safeMutation(
      result,
      "Range cuts applied together to the active draft.",
    );
  }

  private async restoreRange(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "request_id",
      "project_id",
      "draft_id",
      "base_revision_id",
      "expected_sequence",
      "expected_timeline_sha256",
      "pass_group_id",
      "reason",
      "source_id",
      "source_start_us",
      "source_end_us",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.source_id);
    integer(request.source_start_us);
    integer(request.source_end_us, 1);
    if (request.source_start_us >= request.source_end_us)
      reject("invalid_request");
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "spoken_cut" },
      reason: request.reason,
      operations: [
        {
          type: "restore_range",
          source_id: request.source_id,
          source_start_us: request.source_start_us,
          source_end_us: request.source_end_us,
        },
      ],
    });
    return safeMutation(result, "Source range restored to the active draft.");
  }

  private async undo(input: unknown): Promise<unknown> {
    const request = exact(input, [
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
    freshness(request, this.activeProjectId);
    id(request.target_transaction_id);
    const undo = this.undoer();
    if (!undo) reject("service_unavailable");
    const result = await undo({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      target_transaction_id: request.target_transaction_id,
      reason: request.reason,
    });
    return safeMutation(result, "Newest draft transaction undone.");
  }
}
