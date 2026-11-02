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
import { isClipSpeed, sourceAt } from "../../domain/src/speed.ts";
import {
  zoomIntervals,
  zoomLimits,
  zoomSourceRange,
} from "../../domain/src/zoom.ts";
import {
  cutAt,
  transitionCuts,
  transitionIntervals,
  transitionKinds,
  transitionLimits,
  type TransitionKind,
} from "../../domain/src/transitions.ts";
import { assistantGraphicLimits, frameToolLimits } from "./frames.ts";
import {
  assertGraphicContent,
  GraphicContentError,
  graphicAnchor,
  graphicContentReasons,
  graphicIntervals,
  graphicLimits,
} from "../../domain/src/graphics.ts";
import {
  assertLayoutChange,
  layoutIntervals,
  type LayoutChange,
} from "../../domain/src/layouts.ts";
import {
  GraphicComponentError,
  graphicComponentKinds,
  renderGraphicComponent,
  type GraphicComponentKind,
} from "../../domain/src/graphic-components.ts";
import {
  buildSoundLayer,
  SoundBuildError,
  soundIntervals,
  type SoundAsset,
  type SoundLayer,
} from "../../domain/src/sounds.ts";

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
  "transition.set",
  "transition.remove",
  "app.start_magic_edit",
  "app.stop_edit",
  "app.go_to_step",
] as const;

/**
 * Tools only Claude's route offers: they work on files in Claude's project
 * workspace (ADR 0021), which the other routes do not have.
 */
export const claudeOnlyToolNames = [
  "composition.check",
  "sound.list",
  "sound.set",
  "sound.remove",
  "shorts.propose",
  "zoom.targets",
  "graphics.component",
  "layout.set",
  "layout.remove",
  "layout.plan",
  "app.start_edit_my_video",
] as const;

/**
 * The app actions a chat may take (the same code the buttons run). Export
 * and cleanup are deliberately absent: they stay explicit user actions.
 */
export const appActionToolNames: ReadonlySet<string> = new Set([
  "app.start_magic_edit",
  "app.stop_edit",
  "app.go_to_step",
  "app.start_edit_my_video",
]);
export const appActionPresets = ["gentle", "balanced", "tight"] as const;
export const appActionLevels = ["tidy", "polished", "bold"] as const;
/**
 * The workflow steps an assistant can show, in order. These are the project's
 * stages without the Done screen, which only a finished export reaches.
 */
export const appActionSteps = [
  "record_import",
  "auto_edit",
  "edit",
  "clips",
  "export",
] as const;
export type AppActionPreset = (typeof appActionPresets)[number];
export type AppActionLevel = (typeof appActionLevels)[number];
export type AppActionStep = (typeof appActionSteps)[number];
/** Claude's guarded editor tools: the shared tools plus its own. */
export const claudeEditorToolNames = [
  ...codexVideoEditToolNames,
  ...claudeOnlyToolNames,
] as const;

/** Rendered pictures of the edit; the app renders, the tool only validates. */
/**
 * Reads a composition file (free-form or HyperFrames) from the assistant's workspace, seals
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

/**
 * Takes the short clips Claude proposes for the active project, checks them
 * against the draft and keeps the ones that hold.
 */
export interface ShortsProposer {
  propose(
    projectId: string,
    proposals: readonly {
      start_us: number;
      end_us: number;
      title: string;
      reasons: string[];
    }[],
  ): Promise<{ accepted: number; rejected: string[] }>;
}

/** What an app action did, in plain words the assistant relays to the user. */
export interface AppActionResult {
  status:
    | "started"
    | "queued"
    | "stopped"
    | "nothing_running"
    | "moved"
    | "busy"
    | "not_available";
  message: string;
}

/**
 * Actions the assistant may take in the app, running the same code as the
 * buttons for the connection that is chatting. Main implements them; there
 * is no export, deletion or cleanup here (those stay explicit user actions).
 */
export interface AppActions {
  startMagicEdit(
    projectId: string,
    preset: AppActionPreset,
  ): Promise<AppActionResult>;
  /** Only Claude can run the full "Edit my video". */
  startEditMyVideo?(
    projectId: string,
    level: AppActionLevel,
  ): Promise<AppActionResult>;
  stopEdit(projectId: string): Promise<AppActionResult>;
  goToStep(projectId: string, step: AppActionStep): Promise<AppActionResult>;
}

/**
 * Places in the active edit where something happens on screen, found by
 * comparing the recording's frames; times are edit (output) times.
 */
export interface ZoomTargeter {
  targets(
    projectId: string,
    startUs: number,
    endUs: number,
    /** At most this many, strongest first (40 by default). */
    limit?: number,
  ): Promise<
    {
      start_us: number;
      end_us: number;
      x: number;
      y: number;
      width: number;
      height: number;
      center_x: number;
      center_y: number;
      suggested_scale: number;
      score: number;
    }[]
  >;
}

/**
 * A proposed arrangement of the camera and the screen for the active edit,
 * from where the screen changes and where the speech begins. Nothing is
 * applied.
 */
export interface LayoutPlanner {
  plan(projectId: string): Promise<{
    changes: {
      at_us: number;
      kind: "screen" | "camera" | "pip";
      corner?: string;
      size?: number;
      shape?: string;
      reason: string;
    }[];
    activity_places: number;
  }>;
}

/** Which recordings of a project have a camera recording alongside them. */
export interface CameraCatalog {
  has(projectId: string, sourceId: string): Promise<boolean>;
}

/** The project's audio files (music and sound effects), for sound layers. */
export interface SoundCatalog {
  list(projectId: string): Promise<SoundAsset[]>;
}

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
  | "sound_rejected"
  | "component_rejected"
  | "layout_rejected"
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
  sound_rejected: "The sound could not be used.",
  component_rejected: "The graphic component could not be used.",
  layout_rejected: "The layout could not be used.",
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
            (code === "composition_rejected" ||
                code === "sound_rejected" ||
                code === "component_rejected" ||
                code === "layout_rejected") &&
              graphicReason !== undefined
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
  const placedTransitions = transitionIntervals(
    draft.timeline.transitions ?? [],
    clipMap,
    draft.timeline.duration_us,
  );
  const cuts = transitionCuts(clipMap);
  const placedLayouts = layoutIntervals(draft.timeline.layouts ?? [], clipMap);
  const placedSounds = soundIntervals(
    draft.timeline.sounds ?? [],
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
    // Real cuts of the edit, where a transition can go (`at_us` is the output
    // time of the incoming clip's first frame, for transition.set).
    cuts: cuts.map((cut) => ({
      at_us: cut.atUs,
      left_clip_us: cut.beforeUs,
      right_clip_us: cut.afterUs,
      transition_id:
        (draft.timeline.transitions ?? []).find(
          (transition) =>
            transition.source_id === cut.sourceId &&
            transition.source_us === cut.sourceUs,
        )?.transition_id ?? null,
    })),
    transitions: (draft.timeline.transitions ?? []).map((transition) => {
      const placed = placedTransitions.find(
        (interval) => interval.transitionId === transition.transition_id,
      );
      return {
        transition_id: transition.transition_id,
        kind: transition.kind,
        duration_us: transition.duration_us,
        color: transition.color,
        // Null when its cut is gone and the transition is dormant.
        at_us: placed ? placed.cutUs : null,
        timeline_range: placed
          ? { start_us: placed.startUs, end_us: placed.endUs }
          : null,
      };
    }),
    // How the camera and screen share the picture; empty when unchanged
    // (the screen alone). `at_us` is edit time; null when the moment was cut
    // away and the change has nothing left to apply to.
    layouts: (draft.timeline.layouts ?? []).map((layout) => {
      const placed = placedLayouts.find(
        (interval) => interval.layoutId === layout.layout_id,
      );
      return {
        layout_id: layout.layout_id,
        kind: layout.kind,
        ...(layout.corner ? { corner: layout.corner } : {}),
        ...(layout.size !== undefined ? { size: layout.size } : {}),
        ...(layout.shape ? { shape: layout.shape } : {}),
        ...(layout.face_zoom !== undefined
          ? { face_zoom: layout.face_zoom }
          : {}),
        at_us: placed ? placed.startUs : null,
      };
    }),
    // Music and sound effects; empty when the draft has none.
    sounds: (draft.timeline.sounds ?? []).map((sound) => {
      const placed = placedSounds.find(
        (interval) => interval.soundId === sound.sound_id,
      );
      return {
        sound_id: sound.sound_id,
        name: sound.name,
        kind: sound.kind,
        asset_id: sound.asset_id,
        asset_start_us: sound.asset_start_us,
        duration_us: sound.duration_us,
        gain_db: sound.gain_db,
        fade_in_us: sound.fade_in_us,
        fade_out_us: sound.fade_out_us,
        duck_db: sound.duck_db,
        loop: sound.loop,
        follows_cuts: sound.start.type === "source",
        // Null when the anchor moment was cut away and the layer is silent.
        timeline_range: placed
          ? { start_us: placed.startUs, end_us: placed.endUs }
          : null,
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
  private readonly soundCatalog: SoundCatalog | undefined;
  private readonly shortsProposer: ShortsProposer | undefined;
  private readonly zoomTargeter: ZoomTargeter | undefined;
  private readonly cameraCatalog: CameraCatalog | undefined;
  private readonly layoutPlanner: LayoutPlanner | undefined;
  private readonly appActions: AppActions | undefined;

  constructor(
    activeProjectId: string,
    drafts: DraftTransactions,
    origin: ToolEditOrigin = "codex",
    transcriptReader?: TranscriptReader,
    frameRenderer?: FrameRenderer,
    compositionImporter?: CompositionImporter,
    compositionChecker?: CompositionChecker,
    soundCatalog?: SoundCatalog,
    shortsProposer?: ShortsProposer,
    zoomTargeter?: ZoomTargeter,
    cameraCatalog?: CameraCatalog,
    layoutPlanner?: LayoutPlanner,
    appActions?: AppActions,
  ) {
    if (!idPattern.test(activeProjectId)) reject("invalid_request");
    this.activeProjectId = activeProjectId;
    this.drafts = drafts;
    this.origin = origin;
    this.transcriptReader = transcriptReader;
    this.frameRenderer = frameRenderer;
    this.compositionImporter = compositionImporter;
    this.compositionChecker = compositionChecker;
    this.soundCatalog = soundCatalog;
    this.shortsProposer = shortsProposer;
    this.zoomTargeter = zoomTargeter;
    this.cameraCatalog = cameraCatalog;
    this.layoutPlanner = layoutPlanner;
    this.appActions = appActions;
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
        case "transition.set":
          return await this.setTransition(input);
        case "transition.remove":
          return await this.removeTransition(input);
        case "captions.configure":
          return await this.configureCaptions(input);
        case "audio.configure":
          return await this.configureAudio(input);
        case "media.get_frames":
          return await this.getFrames(input);
        case "composition.check":
          return await this.checkComposition(input);
        case "sound.list":
          return await this.listSounds(input);
        case "sound.set":
          return await this.setSound(input);
        case "sound.remove":
          return await this.removeSound(input);
        case "shorts.propose":
          return await this.proposeShorts(input);
        case "zoom.targets":
          return await this.findZoomTargets(input);
        case "graphics.component":
          return await this.placeGraphicComponent(input);
        case "layout.set":
          return await this.setLayout(input);
        case "layout.remove":
          return await this.removeLayout(input);
        case "layout.plan":
          return await this.planLayout(input);
        case "app.start_magic_edit":
          return await this.startMagicEdit(input);
        case "app.start_edit_my_video":
          return await this.startEditMyVideo(input);
        case "app.stop_edit":
          return await this.stopEdit(input);
        case "app.go_to_step":
          return await this.goToStep(input);
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
      [
        "zoom_id",
        "motion",
        "end_center_x",
        "end_center_y",
        "ease_in_us",
        "ease_out_us",
      ],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    if (
      request.motion !== undefined &&
      request.motion !== "hold" &&
      request.motion !== "push"
    )
      reject("invalid_request");
    if (
      (request.end_center_x === undefined) !==
      (request.end_center_y === undefined)
    )
      reject("invalid_request");
    if (request.end_center_x !== undefined) {
      fraction(request.end_center_x, 0, 1);
      fraction(request.end_center_y, 0, 1);
    }
    for (const key of ["ease_in_us", "ease_out_us"] as const)
      if (request[key] !== undefined) {
        integer(request[key]);
        if (
          (request[key] as number) < zoomLimits.minEaseUs ||
          (request[key] as number) > zoomLimits.maxEaseUs
        )
          reject("invalid_request");
      }
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
            ...(request.motion === "push" ? { motion: "push" as const } : {}),
            ...(request.end_center_x !== undefined
              ? {
                  end_center_x: request.end_center_x as number,
                  end_center_y: request.end_center_y as number,
                }
              : {}),
            ...(request.ease_in_us !== undefined
              ? { ease_in_us: request.ease_in_us as number }
              : {}),
            ...(request.ease_out_us !== undefined
              ? { ease_out_us: request.ease_out_us as number }
              : {}),
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
   * A transition sits on a cut: `at_us` is the output time of the incoming
   * clip's first frame, which must be a real cut of the current draft. It is
   * anchored to the source moment there, so it follows later cuts. Setting
   * one on a cut that has one replaces it.
   */
  private async setTransition(input: unknown): Promise<unknown> {
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
        "at_us",
        "kind",
      ],
      ["transition_id", "duration_us", "color"],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    let transitionId: string | null = null;
    if (request.transition_id !== undefined) {
      id(request.transition_id);
      transitionId = request.transition_id;
    }
    integer(request.at_us, 1);
    if (!transitionKinds.includes(request.kind as TransitionKind))
      reject("invalid_request");
    const durationUs =
      request.duration_us === undefined ? 600_000 : request.duration_us;
    integer(durationUs, transitionLimits.minDurationUs);
    if (durationUs > transitionLimits.maxDurationUs) reject("invalid_request");
    const color = request.color === undefined ? "#000000" : request.color;
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(color))
      reject("invalid_request");
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    // Look up the cut in the exact head the caller read; the commit re-checks.
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    const existing =
      transitionId === null
        ? undefined
        : draft.timeline.transitions?.find(
            (transition) => transition.transition_id === transitionId,
          );
    if (transitionId !== null && !existing) reject("edit_conflict");
    const cut = cutAt(
      draft.timeline.clips.map((clip) => ({
        sourceId: clip.source_id,
        timelineStartUs: clip.timeline_start_us,
        timelineEndUs: clip.timeline_end_us,
        sourceStartUs: clip.source_start_us,
        sourceEndUs: clip.source_end_us,
        ...(clip.speed ? { speed: clip.speed } : {}),
      })),
      request.at_us,
    );
    if (!cut) reject("invalid_request");
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
          type: "set_transition",
          transition: {
            transition_id:
              transitionId ?? `transition-${randomUUID().replaceAll("-", "")}`,
            source_id: cut.sourceId,
            source_us: cut.sourceUs,
            kind: request.kind as TransitionKind,
            duration_us: durationUs,
            color: color.toLowerCase(),
          },
        },
      ],
    });
    return safeMutation(
      result,
      transitionId === null
        ? "Transition added to the active draft."
        : "Transition changed on the active draft.",
    );
  }

  private async removeTransition(input: unknown): Promise<unknown> {
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
      "transition_id",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.transition_id);
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
      operations: [
        { type: "remove_transition", transition_id: request.transition_id },
      ],
    });
    return safeMutation(result, "Transition removed from the active draft.");
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

  /**
   * Proposes short clips for the app's Short clips panel. It does not touch
   * the draft: the app checks every clip against the draft's words and the
   * length and overlap rules, keeps the ones that hold and says why it
   * refused the others, so the model can correct and call again.
   */
  private async proposeShorts(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id", "clips"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!this.shortsProposer) reject("tool_not_available");
    const clips = request.clips;
    if (!Array.isArray(clips) || clips.length < 1 || clips.length > 6)
      reject("invalid_request");
    const proposals = (clips as unknown[]).map((value) => {
      const clip = exact(value, ["start_us", "end_us", "title", "reasons"]);
      integer(clip.start_us);
      integer(clip.end_us, 1);
      if (
        typeof clip.title !== "string" ||
        clip.title.length < 1 ||
        clip.title.length > 120 ||
        !Array.isArray(clip.reasons) ||
        clip.reasons.length > 4 ||
        clip.reasons.some(
          (reason: unknown) =>
            typeof reason !== "string" || reason.length > 120,
        )
      )
        reject("invalid_request");
      return {
        start_us: clip.start_us as number,
        end_us: clip.end_us as number,
        title: clip.title as string,
        reasons: clip.reasons as string[],
      };
    });
    const result = await this.shortsProposer.propose(
      this.activeProjectId,
      proposals,
    );
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      accepted: result.accepted,
      rejected: result.rejected,
      summary:
        result.accepted > 0
          ? `${result.accepted} ${result.accepted === 1 ? "clip" : "clips"} added to the Short clips panel.`
          : "No clip was kept. Fix the problems listed and call again.",
    };
  }

  /**
   * Changes how the camera and the screen share the picture from a moment of
   * the edit until the next change. The moment is given in edit time and kept
   * as a moment of the recording, so it follows cuts.
   */
  private async setLayout(input: unknown): Promise<unknown> {
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
        "at_us",
        "kind",
      ],
      [
        "layout_id",
        "corner",
        "size",
        "shape",
        "face_zoom",
        "focus_x",
        "focus_y",
        "move_us",
      ],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    let layoutId: string | null = null;
    if (request.layout_id !== undefined) {
      id(request.layout_id);
      layoutId = request.layout_id;
    }
    integer(request.at_us);
    const atUs = request.at_us;
    const change: Record<string, unknown> = { kind: request.kind };
    for (const key of [
      "corner",
      "size",
      "shape",
      "face_zoom",
      "focus_x",
      "focus_y",
      "move_us",
    ])
      if (request[key] !== undefined) change[key] = request[key];
    try {
      assertLayoutChange({
        layout_id: "layout-check",
        source_id: "source-check",
        source_us: 0,
        ...change,
      });
    } catch {
      reject("invalid_request");
    }
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    if (
      layoutId !== null &&
      !draft.timeline.layouts?.some((item) => item.layout_id === layoutId)
    )
      reject("edit_conflict");
    const clip = draft.timeline.clips.find(
      (item) => atUs >= item.timeline_start_us && atUs < item.timeline_end_us,
    );
    if (!clip) reject("invalid_request");
    if (
      request.kind !== "screen" &&
      !(
        this.cameraCatalog &&
        (await this.cameraCatalog.has(this.activeProjectId, clip.source_id))
      )
    )
      throw new CodexVideoEditToolError(
        "layout_rejected",
        undefined,
        "This video has no camera recording, so only the screen layout is available.",
      );
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "layout" },
      reason: request.reason,
      operations: [
        {
          type: "set_layout",
          layout: {
            layout_id: layoutId ?? `layout-${randomUUID().replaceAll("-", "")}`,
            source_id: clip.source_id,
            source_us: sourceAt(clip, atUs),
            ...change,
          } as LayoutChange,
        },
      ],
    });
    return safeMutation(
      result,
      layoutId === null
        ? "Layout change added to the active draft."
        : "Layout change updated on the active draft.",
    );
  }

  /** A proposal only: it does not change the draft. */
  private async planLayout(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!this.layoutPlanner) reject("tool_not_available");
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    const camera =
      this.cameraCatalog &&
      (await Promise.all(
        [...new Set(draft.timeline.clips.map((clip) => clip.source_id))].map(
          (sourceId) => this.cameraCatalog!.has(this.activeProjectId, sourceId),
        ),
      ).then((found) => found.some(Boolean)));
    if (!camera)
      throw new CodexVideoEditToolError(
        "layout_rejected",
        undefined,
        "This video has no camera recording, so there is nothing to arrange.",
      );
    const plan = await this.layoutPlanner.plan(this.activeProjectId);
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      changes: plan.changes,
      summary:
        plan.changes.length > 0
          ? `${plan.changes.length} layout ${plan.changes.length === 1 ? "change" : "changes"} proposed from ${plan.activity_places} places where the screen changes. Apply the ones you agree with using layout.set at at_us; adjust the rest. The screen alone is the arrangement before the first change.`
          : "Nothing to propose: the edit has too little speech to arrange the camera around.",
    };
  }

  private async removeLayout(input: unknown): Promise<unknown> {
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
      "layout_id",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.layout_id);
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
      pass_group: { pass_group_id: request.pass_group_id, kind: "layout" },
      reason: request.reason,
      operations: [{ type: "remove_layout", layout_id: request.layout_id }],
    });
    return safeMutation(result, "Layout change removed from the active draft.");
  }

  /**
   * Places one designed component (lower third, chapter card, stat, highlight,
   * keyword, step) as an ordinary graphic: the app renders the layout, the
   * model supplies the content, the moment and the accent.
   */
  private async placeGraphicComponent(input: unknown): Promise<unknown> {
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
        "kind",
        "title",
      ],
      [
        "graphic_id",
        "layer",
        "subtitle",
        "accent",
        "side",
        "place",
        "x",
        "y",
        "width",
        "height",
      ],
    );
    if (
      typeof request.kind !== "string" ||
      !(graphicComponentKinds as readonly string[]).includes(request.kind)
    )
      reject("invalid_request");
    integer(request.duration_us, graphicLimits.minDurationUs);
    let rendered: { name: string; html: string; css: string };
    try {
      rendered = renderGraphicComponent(
        request.kind as GraphicComponentKind,
        {
          title: request.title as string,
          ...(request.subtitle !== undefined
            ? { subtitle: request.subtitle as string }
            : {}),
          ...(request.accent !== undefined
            ? { accent: request.accent as string }
            : {}),
          ...(request.side !== undefined
            ? { side: request.side as "left" | "right" }
            : {}),
          ...(request.place !== undefined
            ? { place: request.place as "top" | "middle" | "bottom" }
            : {}),
          ...(request.x !== undefined ? { x: request.x as number } : {}),
          ...(request.y !== undefined ? { y: request.y as number } : {}),
          ...(request.width !== undefined
            ? { width: request.width as number }
            : {}),
          ...(request.height !== undefined
            ? { height: request.height as number }
            : {}),
        },
        request.duration_us as number,
      );
    } catch (error) {
      if (error instanceof GraphicComponentError)
        throw new CodexVideoEditToolError(
          "component_rejected",
          undefined,
          error.message,
        );
      throw error;
    }
    return this.setGraphic({
      schema_version: request.schema_version,
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group_id: request.pass_group_id,
      reason: request.reason,
      start_us: request.start_us,
      duration_us: request.duration_us,
      name: rendered.name,
      layer: request.layer ?? 20,
      html: rendered.html,
      css: rendered.css,
      ...(request.graphic_id !== undefined
        ? { graphic_id: request.graphic_id }
        : {}),
    });
  }

  /**
   * Where something happens on screen in a range of the edit: the evidence a
   * zoom needs. Read-only; the draft is not touched.
   */
  private async findZoomTargets(input: unknown): Promise<unknown> {
    const request = exact(input, [
      "schema_version",
      "project_id",
      "start_us",
      "end_us",
    ]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!this.zoomTargeter) reject("tool_not_available");
    const startUs = request.start_us === null ? 0 : request.start_us;
    const endUs =
      request.end_us === null ? Number.MAX_SAFE_INTEGER : request.end_us;
    integer(startUs);
    integer(endUs, 1);
    if (startUs >= endUs) reject("invalid_request");
    const targets = await this.zoomTargeter.targets(
      this.activeProjectId,
      startUs,
      endUs,
    );
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      targets,
      summary:
        targets.length > 0
          ? `${targets.length} ${targets.length === 1 ? "place" : "places"} on screen where something changes. Zoom only at these, and only when a viewer needs to read or follow the detail; otherwise do not zoom.`
          : "Nothing on screen changes locally in this range, so there is nothing worth zooming to. Do not zoom here.",
    };
  }

  private async listSounds(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!this.soundCatalog) reject("tool_not_available");
    const assets = await this.soundCatalog.list(this.activeProjectId);
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      assets: assets.map((asset) => ({
        asset_id: asset.asset_id,
        name: asset.name,
        duration_us: asset.duration_us,
        sample_rate: asset.sample_rate,
        channels: asset.channels,
      })),
    };
  }

  private async setSound(input: unknown): Promise<unknown> {
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
        "name",
        "kind",
        "asset_id",
        "start_us",
      ],
      [
        "sound_id",
        "follows_cuts",
        "asset_start_us",
        "duration_us",
        "gain_db",
        "fade_in_us",
        "fade_out_us",
        "duck_db",
        "loop",
      ],
    );
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.asset_id);
    integer(request.start_us);
    if (request.kind !== "music" && request.kind !== "effect")
      reject("invalid_request");
    if (request.sound_id !== undefined) id(request.sound_id);
    if (
      request.follows_cuts !== undefined &&
      typeof request.follows_cuts !== "boolean"
    )
      reject("invalid_request");
    if (request.loop !== undefined && typeof request.loop !== "boolean")
      reject("invalid_request");
    for (const key of [
      "asset_start_us",
      "duration_us",
      "gain_db",
      "fade_in_us",
      "fade_out_us",
      "duck_db",
    ])
      if (request[key] !== undefined && !Number.isSafeInteger(request[key]))
        reject("invalid_request");
    if (!this.soundCatalog) reject("tool_not_available");
    const asset = (await this.soundCatalog.list(this.activeProjectId)).find(
      (item) => item.asset_id === request.asset_id,
    );
    if (!asset)
      throw new CodexVideoEditToolError(
        "sound_rejected",
        undefined,
        "That audio file is not in the project. Call sound.list for the files you can use.",
      );
    const apply = this.applier();
    if (!apply) reject("service_unavailable");
    const { draft } = await this.drafts.snapshot(this.activeProjectId);
    if (
      draft.draft_id !== request.draft_id ||
      draft.base_revision_id !== request.base_revision_id ||
      draft.draft_sequence !== request.expected_sequence ||
      draft.timeline_sha256 !== request.expected_timeline_sha256
    )
      reject("stale_draft");
    const soundId = (request.sound_id as string | undefined) ?? null;
    if (
      soundId !== null &&
      !draft.timeline.sounds?.some((item) => item.sound_id === soundId)
    )
      reject("edit_conflict");
    const optional = (key: string): number | undefined =>
      request[key] === undefined ? undefined : (request[key] as number);
    let layer: SoundLayer;
    try {
      layer = buildSoundLayer(
        {
          ...(soundId !== null ? { soundId } : {}),
          name: typeof request.name === "string" ? request.name : "",
          kind: request.kind as SoundLayer["kind"],
          asset,
          startUs: request.start_us as number,
          followsCuts: request.follows_cuts as boolean | undefined,
          assetStartUs: optional("asset_start_us"),
          durationUs: optional("duration_us"),
          gainDb: optional("gain_db"),
          fadeInUs: optional("fade_in_us"),
          fadeOutUs: optional("fade_out_us"),
          duckDb: optional("duck_db"),
          loop: request.loop as boolean | undefined,
        },
        draft.timeline,
        () => `sound-${randomUUID().replaceAll("-", "")}`,
      );
    } catch (error) {
      if (error instanceof SoundBuildError)
        throw new CodexVideoEditToolError(
          "sound_rejected",
          undefined,
          error.message,
        );
      throw error;
    }
    const result = await apply({
      schema_version: "1.0",
      request_id: request.request_id,
      project_id: request.project_id,
      draft_id: request.draft_id,
      base_revision_id: request.base_revision_id,
      expected_sequence: request.expected_sequence,
      expected_timeline_sha256: request.expected_timeline_sha256,
      pass_group: { pass_group_id: request.pass_group_id, kind: "audio" },
      reason: request.reason,
      operations: [{ type: "set_sound", sound: layer }],
    });
    return safeMutation(
      result,
      soundId === null
        ? "Sound added to the active draft."
        : "Sound replaced on the active draft.",
    );
  }

  private async removeSound(input: unknown): Promise<unknown> {
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
      "sound_id",
    ]);
    freshness(request, this.activeProjectId);
    id(request.pass_group_id);
    id(request.sound_id);
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
      pass_group: { pass_group_id: request.pass_group_id, kind: "audio" },
      reason: request.reason,
      operations: [{ type: "remove_sound", sound_id: request.sound_id }],
    });
    return safeMutation(result, "Sound removed from the active draft.");
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

  private appResult(result: AppActionResult): unknown {
    if (
      !result ||
      typeof result.message !== "string" ||
      !result.message ||
      result.message.length > 600
    )
      reject("service_unavailable");
    return {
      schema_version: "1.0",
      project_id: this.activeProjectId,
      status: result.status,
      message: result.message,
    };
  }

  private async startMagicEdit(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id", "preset"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!(appActionPresets as readonly unknown[]).includes(request.preset))
      reject("invalid_request");
    if (!this.appActions) reject("service_unavailable");
    return this.appResult(
      await this.appActions.startMagicEdit(
        this.activeProjectId,
        request.preset as AppActionPreset,
      ),
    );
  }

  private async startEditMyVideo(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id", "level"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!(appActionLevels as readonly unknown[]).includes(request.level))
      reject("invalid_request");
    // Only Claude's tool list offers this action; any other origin is refused.
    if (this.origin !== "claude" || !this.appActions?.startEditMyVideo)
      reject("tool_not_available");
    return this.appResult(
      await this.appActions.startEditMyVideo(
        this.activeProjectId,
        request.level as AppActionLevel,
      ),
    );
  }

  private async stopEdit(input: unknown): Promise<unknown> {
    const projectId = readRequest(input, this.activeProjectId);
    if (!this.appActions) reject("service_unavailable");
    return this.appResult(await this.appActions.stopEdit(projectId));
  }

  private async goToStep(input: unknown): Promise<unknown> {
    const request = exact(input, ["schema_version", "project_id", "step"]);
    if (request.schema_version !== "1.0") reject("invalid_request");
    assertActiveProject(request, this.activeProjectId);
    if (!(appActionSteps as readonly unknown[]).includes(request.step))
      reject("invalid_request");
    if (!this.appActions) reject("service_unavailable");
    return this.appResult(
      await this.appActions.goToStep(
        this.activeProjectId,
        request.step as AppActionStep,
      ),
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
