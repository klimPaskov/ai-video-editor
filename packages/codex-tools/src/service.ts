import { randomUUID } from "node:crypto";
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
import { isClipSpeed } from "../../domain/src/speed.ts";
import {
  zoomIntervals,
  zoomLimits,
  zoomSourceRange,
} from "../../domain/src/zoom.ts";
import { assistantGraphicLimits, frameToolLimits } from "./frames.ts";
import {
  assertGraphicContent,
  GraphicContentError,
  graphicAnchor,
  graphicContentReasons,
  graphicIntervals,
  graphicLimits,
} from "../../domain/src/graphics.ts";

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
  "zoom.set",
  "zoom.remove",
  "speed.set",
  "graphics.set",
  "graphics.remove",
  "captions.configure",
  "audio.configure",
  "media.get_frames",
] as const;

/**
 * Tools only Claude's route offers: they work on files in Claude's project
 * workspace (ADR 0021), which the other routes do not have.
 */
export const claudeOnlyToolNames = ["composition.check"] as const;
/** Claude's guarded editor tools: the shared tools plus its own. */
export const claudeEditorToolNames = [
  ...codexVideoEditToolNames,
  ...claudeOnlyToolNames,
] as const;

/** Rendered pictures of the edit; the app renders, the tool only validates. */
/**
 * Reads a HyperFrames composition file from the assistant's workspace, seals
 * and stores it, and returns its hash. Throws an error named
 * "CompositionError" with a reason the assistant can act on.
 */
export type CompositionImporter = (
  projectId: string,
  path: string,
) => Promise<{ sha256: string }>;

export type FrameRenderer = (
  projectId: string,
  timesUs: number[],
  maxWidth: number,
  /** "sheet" tiles every time into one picture, in reading order. */
  layout?: "frames" | "sheet",
) => Promise<
  {
    timeUs: number;
    width: number;
    height: number;
    mimeType: "image/jpeg";
    dataBase64: string;
  }[]
>;

export type CodexVideoEditToolName = (typeof codexVideoEditToolNames)[number];
export type ClaudeEditorToolName = (typeof claudeEditorToolNames)[number];

/**
 * Loads a workspace composition in the sealed stage at the video's size,
 * audits it at each composition time (or at evenly spread times) and tiles
 * those moments into one picture. Throws an error named "CompositionError"
 * when the file cannot be sealed.
 */
export type CompositionChecker = (
  projectId: string,
  path: string,
  timesUs: number[] | null,
  cellWidth: number,
) => Promise<{
  report: Record<string, unknown>;
  sheet: {
    width: number;
    height: number;
    mimeType: "image/jpeg";
    dataBase64: string;
  } | null;
}>;

type DraftTransactions = {
  snapshot(projectId: string): Promise<DraftReadResult>;
  snapshotWithProject(projectId: string): Promise<DraftProjectReadResult>;
  applyCodex(value: unknown): Promise<DraftCommitResult>;
  undoCodex(value: unknown): Promise<DraftCommitResult>;
  applyApiProvider?(value: unknown): Promise<DraftCommitResult>;
  undoApiProvider?(value: unknown): Promise<DraftCommitResult>;
  applyClaude?(value: unknown): Promise<DraftCommitResult>;
  undoClaude?(value: unknown): Promise<DraftCommitResult>;
  applyMagicWand?(value: unknown): Promise<DraftCommitResult>;
  undoMagicWand?(value: unknown): Promise<DraftCommitResult>;
};

/** The assistant route that main attributes each guarded transaction to. */
export type ToolEditOrigin = "codex" | "claude" | "api_provider" | "magic_wand";

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
  | "graphic_rejected"
  | "composition_rejected"
  | "frame_unavailable"
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
  frame_unavailable:
    "The frames could not be rendered. Use 1–3 output times inside the edit and try again.",
  graphic_rejected:
    "The graphic was rejected. Use inline HTML and CSS without scripts, forms, embedded documents or network resources.",
  composition_rejected: "The composition could not be used.",
  service_unavailable:
    "The editing service is unavailable. Reopen the project and try again.",
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

export class CodexVideoEditToolError extends Error {
  readonly code: CodexVideoEditToolErrorCode;

  /**
   * `activeProjectId` lets a refused cross-project call name the one project
   * the caller may use, so a model that mistyped the ID can correct itself.
   */
  constructor(
    code: CodexVideoEditToolErrorCode,
    activeProjectId?: string,
    graphicReason?: string,
  ) {
    super(
      code === "inactive_project" &&
        activeProjectId !== undefined &&
        idPattern.test(activeProjectId)
        ? `${messages[code]} The active project_id is "${activeProjectId}".`
        : // Only the validator's own fixed reasons are echoed to the model.
          code === "graphic_rejected" &&
            graphicReason !== undefined &&
            graphicContentReasons.has(graphicReason)
          ? `${messages[code]} ${graphicReason}`
          : // A composition's own problem (its file, or its script error),
            // so Claude can fix what it wrote.
            code === "composition_rejected" && graphicReason !== undefined
            ? `${messages[code]} ${graphicReason.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 400)}`
            : messages[code],
    );
    this.name = "CodexVideoEditToolError";
    this.code = code;
  }
}

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

function fraction(
  value: unknown,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
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
  if (value.project_id !== activeProjectId)
    throw new CodexVideoEditToolError("inactive_project", activeProjectId);
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
  const zooms = draft.timeline.zooms ?? [];
  const clipMap = draft.timeline.clips.map((clip) => ({
    sourceId: clip.source_id,
    timelineStartUs: clip.timeline_start_us,
    timelineEndUs: clip.timeline_end_us,
    sourceStartUs: clip.source_start_us,
    sourceEndUs: clip.source_end_us,
    ...(clip.speed ? { speed: clip.speed } : {}),
  }));
  const visible = zoomIntervals(zooms, clipMap);
  const placedGraphics = graphicIntervals(
    draft.timeline.graphics ?? [],
    clipMap,
    draft.timeline.duration_us,
  );
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
      ...(clip.speed ? { speed: clip.speed } : {}),
    })),
    operation_ids: [...draft.timeline.operation_ids],
    zooms: zooms.map((zoom) => ({
      zoom_id: zoom.zoom_id,
      source_id: zoom.source_id,
      source_start_us: zoom.source_start_us,
      source_end_us: zoom.source_end_us,
      center_x: zoom.center_x,
      center_y: zoom.center_y,
      scale: zoom.scale,
      // Output-time pieces still visible after cuts; empty when all cut.
      timeline_ranges: visible
        .filter((piece) => piece.zoomId === zoom.zoom_id)
        .map((piece) => ({ start_us: piece.startUs, end_us: piece.endUs })),
    })),
    zoom_ids: [...draft.timeline.zoom_ids],
    speed_ids: [...draft.timeline.speed_ids],
    // Null: the draft has no choice of its own; the project's earlier
    // per-project choice or the default applies until one is set.
    captions: draft.timeline.captions
      ? {
          enabled: draft.timeline.captions.enabled,
          style: draft.timeline.captions.style,
          size: draft.timeline.captions.size,
          position: draft.timeline.captions.position,
          burn_in: draft.timeline.captions.burnIn,
        }
      : null,
    audio: draft.timeline.audio ? { ...draft.timeline.audio } : null,
    graphics: (draft.timeline.graphics ?? []).map((graphic) => {
      const placed = placedGraphics.find(
        (interval) => interval.graphicId === graphic.graphic_id,
      );
      return {
        graphic_id: graphic.graphic_id,
        name: graphic.name,
        layer: graphic.layer,
        duration_us: graphic.duration_us,
        source_id: graphic.source_id,
        source_us: graphic.source_us,
        // Null when the anchor moment was cut away and the graphic is hidden.
        timeline_range: placed
          ? { start_us: placed.startUs, end_us: placed.endUs }
          : null,
        html_bytes: new TextEncoder().encode(graphic.html).length,
        css_bytes: new TextEncoder().encode(graphic.css).length,
      };
    }),
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
  private readonly frameRenderer: FrameRenderer | undefined;
  private readonly compositionImporter: CompositionImporter | undefined;
  private readonly compositionChecker: CompositionChecker | undefined;

  constructor(
    activeProjectId: string,
    drafts: DraftTransactions,
    origin: ToolEditOrigin = "codex",
    transcriptReader?: TranscriptReader,
    frameRenderer?: FrameRenderer,
    compositionImporter?: CompositionImporter,
    compositionChecker?: CompositionChecker,
  ) {
    if (!idPattern.test(activeProjectId)) reject("invalid_request");
    this.activeProjectId = activeProjectId;
    this.drafts = drafts;
    this.origin = origin;
    this.transcriptReader = transcriptReader;
    this.frameRenderer = frameRenderer;
    this.compositionImporter = compositionImporter;
    this.compositionChecker = compositionChecker;
  }

  private applier():
    ((value: unknown) => Promise<DraftCommitResult>) | undefined {
    if (this.origin === "api_provider")
      return this.drafts.applyApiProvider?.bind(this.drafts);
    if (this.origin === "claude")
      return this.drafts.applyClaude?.bind(this.drafts);
    if (this.origin === "magic_wand")
      return this.drafts.applyMagicWand?.bind(this.drafts);
    return this.drafts.applyCodex.bind(this.drafts);
  }

  private undoer():
    ((value: unknown) => Promise<DraftCommitResult>) | undefined {
    if (this.origin === "api_provider")
      return this.drafts.undoApiProvider?.bind(this.drafts);
    if (this.origin === "claude")
      return this.drafts.undoClaude?.bind(this.drafts);
    if (this.origin === "magic_wand")
      return this.drafts.undoMagicWand?.bind(this.drafts);
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
        case "zoom.set":
          return await this.setZoom(input);
        case "zoom.remove":
          return await this.removeZoom(input);
        case "speed.set":
          return await this.setSpeed(input);
        case "graphics.set":
          return await this.setGraphic(input);
        case "graphics.remove":
          return await this.removeGraphic(input);
        case "captions.configure":
          return await this.configureCaptions(input);
        case "audio.configure":
          return await this.configureAudio(input);
        case "media.get_frames":
          return await this.getFrames(input);
        case "composition.check":
          return await this.checkComposition(input);
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
      offset = request.offset,
      limit = request.limit;
    const sourceEndUs = request.source_end_us;
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
    if (!result || sourceStartUs >= result.transcript.duration_us)
      reject("transcript_unavailable");
    // A range to the recording's end may overshoot the transcript's (audio)
    // duration slightly; read up to where the transcript ends.
    const endUs = Math.min(sourceEndUs, result.transcript.duration_us);

    const matchingWords = result.transcript.segments.flatMap((segment) =>
      segment.words.filter(
        (word) => word.end_us > sourceStartUs && word.start_us < endUs,
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
          end_us: endUs,
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

  /**
   * Same semantics as the manual zoom: the output range maps to one source's
   * time through the current clip map, and an existing zoom keeps its own
   * source range (only its point and scale change).
   */
  private async setZoom(input: unknown): Promise<unknown> {
    const request = exact(
      input,
      [
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
        "center_x",
        "center_y",
        "scale",
      ],
      ["zoom_id"],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    let zoomId: string | null = null;
    if (request.zoom_id !== undefined) {
      id(request.zoom_id);
      zoomId = request.zoom_id;
    }
    integer(request.start_us);
    integer(request.end_us, 1);
    if (request.end_us - request.start_us < zoomLimits.minDurationUs)
      reject("invalid_request");
    fraction(request.center_x, 0, 1);
    fraction(request.center_y, 0, 1);
    fraction(request.scale, zoomLimits.minScale, zoomLimits.maxScale);
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    // Map against the exact head the caller read; the commit re-checks it.
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    const existing =
      zoomId === null
        ? undefined
        : draft.timeline.zooms?.find((zoom) => zoom.zoom_id === zoomId);
    if (zoomId !== null && !existing) reject("edit_conflict");
    const range =
      existing ??
      zoomSourceRange(draft.timeline.clips, request.start_us, request.end_us);
    if (!range) reject("invalid_request");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "zoom" },
      reason: request.reason,
      operations: [
        {
          type: "set_zoom",
          zoom: {
            zoom_id: zoomId ?? `zoom-${randomUUID().replaceAll("-", "")}`,
            source_id: range.source_id,
            source_start_us: range.source_start_us,
            source_end_us: range.source_end_us,
            center_x: request.center_x,
            center_y: request.center_y,
            scale: request.scale,
          },
        },
      ],
    });
    return safeMutation(
      result,
      zoomId === null
        ? "Zoom added to the active draft."
        : "Zoom changed on the active draft.",
    );
  }

  private async removeZoom(input: unknown): Promise<unknown> {
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
      "zoom_id",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.zoom_id);
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
      pass_group: { pass_group_id: request.pass_group_id, kind: "zoom" },
      reason: request.reason,
      operations: [{ type: "remove_zoom", zoom_id: request.zoom_id }],
    });
    return safeMutation(result, "Zoom removed from the active draft.");
  }

  /**
   * Same semantics as the manual graphic: `start_us` is an output time that
   * main anchors to the source moment shown there, so the graphic follows
   * later cuts. With graphic_id the graphic is replaced in place.
   */
  private async setGraphic(input: unknown): Promise<unknown> {
    const request = exact(
      input,
      [
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
        "duration_us",
        "name",
        "layer",
      ],
      ["graphic_id", "html", "css", "composition_path"],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    // Either an HTML/CSS fragment or a composition file, never both.
    const composing = request.composition_path !== undefined;
    if (
      composing
        ? request.html !== undefined || request.css !== undefined
        : request.html === undefined || request.css === undefined
    )
      reject("invalid_request");
    let graphicId: string | null = null;
    if (request.graphic_id !== undefined) {
      id(request.graphic_id);
      graphicId = request.graphic_id;
    }
    integer(request.start_us);
    integer(request.duration_us, graphicLimits.minDurationUs);
    if (request.duration_us > graphicLimits.maxDurationUs)
      reject("invalid_request");
    integer(request.layer);
    if (request.layer > graphicLimits.maxLayer) reject("invalid_request");
    if (
      typeof request.name !== "string" ||
      !request.name.trim() ||
      request.name.length > graphicLimits.maxNameChars ||
      /[\u0000-\u001f\u007f]/u.test(request.name)
    )
      reject("invalid_request");
    let composition: string | null = null;
    if (composing) {
      if (
        typeof request.composition_path !== "string" ||
        !request.composition_path ||
        request.composition_path.length > 260
      )
        reject("invalid_request");
      if (!this.compositionImporter) reject("tool_not_available");
      try {
        composition = (
          await this.compositionImporter(
            this.activeProjectId,
            request.composition_path,
          )
        ).sha256;
      } catch (error) {
        throw new CodexVideoEditToolError(
          "composition_rejected",
          undefined,
          error instanceof Error && error.name === "CompositionError"
            ? error.message
            : "The composition file could not be read.",
        );
      }
    } else if (
      typeof request.html !== "string" ||
      typeof request.css !== "string" ||
      new TextEncoder().encode(request.html).length >
        assistantGraphicLimits.maxHtmlBytes ||
      new TextEncoder().encode(request.css).length >
        assistantGraphicLimits.maxCssBytes
    )
      reject("invalid_request");
    try {
      if (!composition)
        assertGraphicContent(request.html as string, request.css as string);
    } catch (error) {
      if (error instanceof GraphicContentError)
        throw new CodexVideoEditToolError(
          "graphic_rejected",
          undefined,
          error.message,
        );
      throw error;
    }
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    // Anchor against the exact head the caller read; the commit re-checks it.
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    if (
      graphicId !== null &&
      !draft.timeline.graphics?.some((item) => item.graphic_id === graphicId)
    )
      reject("edit_conflict");
    const anchor = graphicAnchor(draft.timeline.clips, request.start_us);
    if (!anchor) reject("invalid_request");
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "graphics" },
      reason: request.reason,
      operations: [
        {
          type: "set_graphic",
          graphic: {
            graphic_id:
              graphicId ?? `graphic-${randomUUID().replaceAll("-", "")}`,
            name: request.name.trim(),
            source_id: anchor.source_id,
            source_us: anchor.source_us,
            duration_us: request.duration_us,
            layer: request.layer,
            html: composition ? "" : (request.html as string),
            css: composition ? "" : (request.css as string),
            ...(composition ? { composition_sha256: composition } : {}),
          },
        },
      ],
    });
    return safeMutation(
      result,
      graphicId === null
        ? "Graphic added to the active draft."
        : "Graphic replaced on the active draft.",
    );
  }

  private async presentation(
    request: Record<string, unknown>,
    kind: "captions" | "audio",
    settings: Record<string, unknown>,
  ): Promise<unknown> {
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const { draft, undo_transaction_id } = await this.drafts.snapshot(
      this.activeProjectId,
    );
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    const current = (
      kind === "captions" ? draft.timeline.captions : draft.timeline.audio
    ) as Record<string, unknown> | undefined;
    if (
      current &&
      Object.keys(settings).every((key) => current[key] === settings[key])
    )
      return {
        status: "unchanged" as const,
        draft: safeDraft(draft, undo_transaction_id),
        summary:
          kind === "captions"
            ? "Captions already use these choices."
            : "Audio already uses these choices.",
      };
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind },
      reason: request.reason,
      operations: [
        kind === "captions"
          ? { type: "set_captions", captions: settings }
          : { type: "set_audio", audio: settings },
      ],
    });
    return safeMutation(
      result,
      kind === "captions"
        ? "Caption choices changed on the active draft."
        : "Audio treatment changed on the active draft.",
    );
  }

  private async configureCaptions(input: unknown): Promise<unknown> {
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
      "enabled",
      "style",
      "size",
      "position",
      "burn_in",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    if (
      typeof request.enabled !== "boolean" ||
      typeof request.burn_in !== "boolean" ||
      !["plain", "highlight", "minimal"].includes(request.style as string) ||
      !["small", "medium", "large"].includes(request.size as string) ||
      !["bottom", "top"].includes(request.position as string)
    )
      reject("invalid_request");
    return this.presentation(request, "captions", {
      enabled: request.enabled,
      style: request.style,
      size: request.size,
      position: request.position,
      burnIn: request.burn_in,
    });
  }

  /** Rendered pictures of the current edit at output times; reads only. */
  private async getFrames(input: unknown): Promise<unknown> {
    const request = exact(
      input,
      ["schema_version", "project_id", "times_us"],
      ["max_width", "layout"],
    );
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    const sheet = request.layout === "sheet";
    if (request.layout !== undefined && request.layout !== "frames" && !sheet)
      reject("invalid_request");
    const times = request.times_us;
    if (
      !Array.isArray(times) ||
      times.length < (sheet ? 2 : 1) ||
      times.length >
        (sheet ? frameToolLimits.maxSheetFrames : frameToolLimits.maxFrames) ||
      times.some((time) => !Number.isSafeInteger(time) || time < 0)
    )
      reject("invalid_request");
    let maxWidth: number = sheet
      ? frameToolLimits.defaultSheetCellWidth
      : frameToolLimits.defaultWidth;
    if (request.max_width !== undefined) {
      integer(request.max_width, frameToolLimits.minWidth);
      if (
        request.max_width >
        (sheet ? frameToolLimits.maxSheetCellWidth : frameToolLimits.maxWidth)
      )
        reject("invalid_request");
      maxWidth = request.max_width;
    }
    if (!this.frameRenderer) reject("tool_not_available");
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (times.some((time) => (time as number) >= draft.timeline.duration_us))
      reject("invalid_request");
    let frames: Awaited<ReturnType<FrameRenderer>>;
    try {
      frames = await this.frameRenderer(
        this.activeProjectId,
        times as number[],
        maxWidth,
        sheet ? "sheet" : "frames",
      );
    } catch (error) {
      // A composition's own script or load error goes back to its author.
      if (error instanceof Error && error.name === "CompositionRenderError")
        throw new CodexVideoEditToolError(
          "composition_rejected",
          undefined,
          `It did not render: ${error.message}`,
        );
      reject("frame_unavailable");
    }
    // The pictures are of the reported state only if nothing changed while
    // they were rendered (rendering waits behind other picture requests).
    const after = (await this.drafts.snapshot(this.activeProjectId)).draft;
    if (
      after.draft_id !== draft.draft_id ||
      after.draft_sequence !== draft.draft_sequence ||
      after.timeline_sha256 !== draft.timeline_sha256
    )
      reject("stale_draft");
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      draft_sequence: draft.draft_sequence,
      timeline_sha256: draft.timeline_sha256,
      // Pictures include zooms, motion graphics and captions as shown.
      frames: frames.map((frame) => ({
        time_us: frame.timeUs,
        width: frame.width,
        height: frame.height,
        mime_type: frame.mimeType,
        data_base64: frame.dataBase64,
      })),
    };
  }

  private async checkComposition(input: unknown): Promise<unknown> {
    const request = exact(
      input,
      ["schema_version", "project_id", "composition_path"],
      ["times_us", "max_width"],
    );
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (
      typeof request.composition_path !== "string" ||
      !request.composition_path ||
      request.composition_path.length > 260
    )
      reject("invalid_request");
    let times: number[] | null = null;
    if (request.times_us !== undefined) {
      const value = request.times_us;
      if (
        !Array.isArray(value) ||
        value.length < 2 ||
        value.length > frameToolLimits.maxSheetFrames ||
        value.some((time) => !Number.isSafeInteger(time) || time < 0) ||
        value.some((time, index) => index > 0 && time <= value[index - 1])
      )
        reject("invalid_request");
      times = value as number[];
    }
    let cellWidth: number = frameToolLimits.defaultSheetCellWidth;
    if (request.max_width !== undefined) {
      integer(request.max_width, frameToolLimits.minWidth);
      if (request.max_width > frameToolLimits.maxSheetCellWidth)
        reject("invalid_request");
      cellWidth = request.max_width;
    }
    if (!this.compositionChecker) reject("tool_not_available");
    let checked: Awaited<ReturnType<CompositionChecker>>;
    try {
      checked = await this.compositionChecker(
        this.activeProjectId,
        request.composition_path,
        times,
        cellWidth,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "CompositionError")
        throw new CodexVideoEditToolError(
          "composition_rejected",
          undefined,
          error.message,
        );
      reject("frame_unavailable");
    }
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      composition_path: request.composition_path,
      ...checked.report,
      // The audited moments, tiled four across in reading order.
      frames: checked.sheet
        ? [
            {
              width: checked.sheet.width,
              height: checked.sheet.height,
              mime_type: checked.sheet.mimeType,
              data_base64: checked.sheet.dataBase64,
            },
          ]
        : [],
    };
  }

  private async configureAudio(input: unknown): Promise<unknown> {
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
      "normalize",
      "denoise",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    if (
      typeof request.normalize !== "boolean" ||
      typeof request.denoise !== "boolean"
    )
      reject("invalid_request");
    return this.presentation(request, "audio", {
      normalize: request.normalize,
      denoise: request.denoise,
    });
  }

  private async removeGraphic(input: unknown): Promise<unknown> {
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
      "graphic_id",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.graphic_id);
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
      pass_group: { pass_group_id: request.pass_group_id, kind: "graphics" },
      reason: request.reason,
      operations: [{ type: "remove_graphic", graphic_id: request.graphic_id }],
    });
    return safeMutation(result, "Graphic removed from the active draft.");
  }

  private async setSpeed(input: unknown): Promise<unknown> {
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
      "speed",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    integer(request.start_us);
    integer(request.end_us, 1);
    if (request.start_us >= request.end_us || !isClipSpeed(request.speed))
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
      pass_group: { pass_group_id: request.pass_group_id, kind: "speed" },
      reason: request.reason,
      operations: [
        {
          type: "set_speed",
          start_us: request.start_us,
          end_us: request.end_us,
          speed: request.speed,
        },
      ],
    });
    return safeMutation(
      result,
      request.speed === 1
        ? "Normal speed restored on the active draft."
        : `${request.speed}x speed applied to the active draft.`,
    );
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
