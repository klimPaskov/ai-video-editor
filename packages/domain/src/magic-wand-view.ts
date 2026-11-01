import { magicWandPresets, type MagicWandPreset } from "./magic-wand.ts";

/** Renderer-visible Magic Edit state; ranges and transcript text stay in main. */
export interface MagicWandSummary {
  removedUs: number;
  cuts: number;
  pauses: number;
  fillers: number;
  repeatedTakes: number;
  leftForReview: number;
}

export interface MagicWandView {
  status:
    "idle" | "transcribing" | "applying" | "completed" | "stopped" | "failed";
  projectId: string | null;
  preset: MagicWandPreset | null;
  /** 0..1 while transcribing or applying. */
  progress: number | null;
  summary: MagicWandSummary | null;
  message: string | null;
}

export interface MagicWandProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

/**
 * The connection that makes the story edit. Claude gives the best results;
 * Codex and the API-key providers run the same guarded cutting tools.
 */
export const magicWandProviders = [
  "claude",
  "codex",
  "deepseek",
  "openai",
  "gemini",
] as const;
export type MagicWandProvider = (typeof magicWandProviders)[number];

export interface MagicWandStartRequest extends MagicWandProjectRequest {
  preset: MagicWandPreset;
  /** The connection the user chose in the assistant drawer. */
  provider: MagicWandProvider;
}

/** Why the story edit could not run: how the user fixes it differs. */
export type MagicWandBlock = "signIn" | "outdated" | "missing" | "setup";

export const magicWandIssues = Object.freeze({
  busy: "Magic Edit is already running for this project.",
  transcription:
    "Magic Edit needs a local transcript, and transcription did not finish. Try again from Auto Edit.",
  noAudio: "Magic Edit needs a video with spoken audio.",
  changed:
    "The draft changed while Magic Edit was running. Applied cuts are kept and can be undone.",
  failed:
    "Magic Edit could not finish. Applied cuts are kept and can be undone.",
  stopped: "Magic Edit stopped. Applied cuts are kept and can be undone.",
  nothing: "The story edit found nothing more to cut for this preset.",
  limit:
    "Your AI provider's usage limit was reached. Cuts made so far are kept; run Magic Edit again after it resets.",
  claudeSignIn:
    "The story edit was skipped. Sign in with your Claude account in Settings, then run Magic Edit again.",
  claudeOutdated:
    "The story edit was skipped. Claude Code is out of date: run claude update in a terminal, choose Check again in Settings, then run Magic Edit again.",
  claudeMissing:
    "The story edit was skipped. Claude Code is not installed: install it from claude.com/claude-code, then run Magic Edit again.",
  claudeSetup:
    "The story edit was skipped. Claude is not ready: open Settings, choose Check again under Claude, then run Magic Edit again.",
  codexSignIn:
    "The story edit was skipped. Sign in to Codex in Settings, then run Magic Edit again.",
  codexSetup:
    "The story edit was skipped. Codex is not ready: open Settings, reconnect Codex and choose a model, then run Magic Edit again.",
  deepseekKey:
    "The story edit was skipped. Add your DeepSeek key in Settings, then run Magic Edit again.",
  deepseekModel:
    "The story edit was skipped. Choose a DeepSeek model in Settings, then run Magic Edit again.",
  openaiKey:
    "The story edit was skipped. Add your OpenAI API key in Settings, then run Magic Edit again.",
  openaiModel:
    "The story edit was skipped. Choose an OpenAI API model in Settings, then run Magic Edit again.",
  geminiKey:
    "The story edit was skipped. Add your Gemini API key in Settings, then run Magic Edit again.",
  geminiModel:
    "The story edit was skipped. Choose a Gemini API model in Settings, then run Magic Edit again.",
} as const);

/** What to tell the user when the chosen connection cannot make the story edit. */
export function magicWandSkipMessage(
  provider: MagicWandProvider,
  block: MagicWandBlock,
): string {
  if (provider === "claude")
    return {
      signIn: magicWandIssues.claudeSignIn,
      outdated: magicWandIssues.claudeOutdated,
      missing: magicWandIssues.claudeMissing,
      setup: magicWandIssues.claudeSetup,
    }[block];
  if (provider === "codex")
    return block === "signIn"
      ? magicWandIssues.codexSignIn
      : magicWandIssues.codexSetup;
  const key = block === "signIn" || block === "missing";
  return {
    deepseek: key ? magicWandIssues.deepseekKey : magicWandIssues.deepseekModel,
    openai: key ? magicWandIssues.openaiKey : magicWandIssues.openaiModel,
    gemini: key ? magicWandIssues.geminiKey : magicWandIssues.geminiModel,
  }[provider];
}

const messages = new Set<string>(Object.values(magicWandIssues));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid Magic Edit exchange.");
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}

function count(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
}

function preset(value: unknown): asserts value is MagicWandPreset {
  if (!magicWandPresets.includes(value as MagicWandPreset)) invalid();
}

export function assertMagicWandProjectRequest(
  value: unknown,
): asserts value is MagicWandProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
}

export function assertMagicWandStartRequest(
  value: unknown,
): asserts value is MagicWandStartRequest {
  const request = exact(value, [
    "schema_version",
    "project_id",
    "preset",
    "provider",
  ]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
  preset(request.preset);
  if (!magicWandProviders.includes(request.provider as MagicWandProvider))
    invalid();
}

export function assertMagicWandView(
  value: unknown,
): asserts value is MagicWandView {
  const view = exact(value, [
    "status",
    "projectId",
    "preset",
    "progress",
    "summary",
    "message",
  ]);
  if (
    ![
      "idle",
      "transcribing",
      "applying",
      "completed",
      "stopped",
      "failed",
    ].includes(view.status as string)
  )
    invalid();
  if (
    view.projectId !== null &&
    (typeof view.projectId !== "string" || !idPattern.test(view.projectId))
  )
    invalid();
  if (view.preset !== null) preset(view.preset);
  if (
    view.progress !== null &&
    (typeof view.progress !== "number" ||
      !Number.isFinite(view.progress) ||
      view.progress < 0 ||
      view.progress > 1)
  )
    invalid();
  if (view.message !== null && !messages.has(view.message as string)) invalid();
  const running = view.status === "transcribing" || view.status === "applying";
  // Transcription reports progress; Claude's rough cut has no measurable one.
  if (
    (view.status === "transcribing" && view.progress === null) ||
    (!running && view.progress !== null) ||
    (view.status === "idle") !== (view.projectId === null) ||
    (view.status === "idle" &&
      (view.preset !== null ||
        view.summary !== null ||
        view.message !== null)) ||
    (view.status !== "idle" && view.preset === null) ||
    (view.status === "completed" && view.summary === null) ||
    ((view.status === "failed" || view.status === "stopped") &&
      view.message === null)
  )
    invalid();
  if (view.summary !== null) {
    const summary = exact(view.summary, [
      "removedUs",
      "cuts",
      "pauses",
      "fillers",
      "repeatedTakes",
      "leftForReview",
    ]);
    for (const key of Object.keys(summary)) count(summary[key]);
  }
}

export function idleMagicWandView(): MagicWandView {
  return {
    status: "idle",
    projectId: null,
    preset: null,
    progress: null,
    summary: null,
    message: null,
  };
}
