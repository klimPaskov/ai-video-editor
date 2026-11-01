import type { MagicWandPreset } from "../../../packages/domain/src/magic-wand.ts";
import type {
  MagicWandBlock,
  MagicWandProvider,
  MagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import {
  claudeIssues,
  claudeThreadIssues,
  type ClaudeThreadView,
  type ClaudeView,
} from "../../../packages/domain/src/claude-view.ts";
import type { CodexThreadView } from "../../../packages/domain/src/codex-thread-view.ts";
import type { CodexView } from "../../../packages/domain/src/codex-view.ts";
import type { ApiThreadView } from "../../../packages/domain/src/api-thread-view.ts";
import type {
  ApiProviderId,
  ApiProvidersView,
} from "../../../packages/domain/src/api-providers.ts";
import type {
  AppActionLevel,
  AppActionPreset,
  AppActionResult,
  AppActions,
  AppActionStep,
} from "../../../packages/codex-tools/src/service.ts";
import type { ApiTurnOptions } from "./api-thread.ts";
import { apiTurnProblems, storyPassLimits } from "./api-thread.ts";
import type { RoughCutEditor, RoughCutOutcome } from "./magic-wand.ts";
import {
  roughCutLabel,
  roughCutPlaybookFor,
  roughCutTools,
} from "./rough-cut-playbook.ts";

/** The tools an API provider's story edit may call (no pictures there). */
export const apiRoughCutTools: ReadonlySet<string> = new Set(
  [...roughCutTools]
    .filter((name) => name !== "media.get_frames")
    .map((name) => name.replaceAll(".", "_")),
);

type Route = "claude" | "codex" | "api";

/** What the story edit needs from Claude (the best-results route). */
export interface ClaudeStory {
  settled(): Promise<ClaudeView>;
  startRoughCut(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
  ): Promise<ClaudeThreadView>;
  getThread(projectId: string): ClaudeThreadView;
  interruptThread(projectId: string): Promise<ClaudeThreadView>;
  runKind(projectId: string): string | null;
}

/** What the story edit needs from the Codex app-server thread. */
export interface CodexStory {
  get(): Promise<CodexView>;
  getThread(projectId: string): CodexThreadView;
  openThread(projectId: string): Promise<CodexThreadView>;
  sendThread(projectId: string, text: string): Promise<CodexThreadView>;
  interruptThread(projectId: string): Promise<CodexThreadView>;
}

/** What the story edit needs from the API-key providers. */
export interface ApiStory {
  providers: {
    get(): Promise<ApiProvidersView>;
    selected(
      provider: ApiProviderId,
    ): Promise<{ key: string; model: string } | null>;
  };
  threads: {
    get(projectId: string, provider: ApiProviderId): Promise<ApiThreadView>;
    open(projectId: string, provider: ApiProviderId): Promise<ApiThreadView>;
    send(
      projectId: string,
      provider: ApiProviderId,
      text: string,
      turn?: ApiTurnOptions,
    ): Promise<ApiThreadView>;
    interrupt(
      projectId: string,
      provider: ApiProviderId,
    ): Promise<ApiThreadView>;
  };
}

interface Run {
  route: Route;
  provider: MagicWandProvider;
  stopped: boolean;
  /** API turns finish inside one call; the others are read from their thread. */
  outcome: RoughCutOutcome | null;
}

function routeOf(provider: MagicWandProvider): Route {
  return provider === "claude" || provider === "codex" ? provider : "api";
}

/**
 * Runs Magic Edit's story pass with the connection the user chose: Claude
 * (the best results), a Codex thread, or an API-key provider. All three use
 * the same guarded cutting tools (`roughCutTools`, enforced by main while a
 * run is active), the same playbook adapted to what the provider can do,
 * and the shared draft transactions, attributed to that provider.
 */
export class StoryPassEditor implements RoughCutEditor {
  private readonly runs = new Map<string, Run>();
  private readonly claude: () => ClaudeStory | undefined;
  private readonly codex: () => CodexStory | undefined;
  private readonly api: () => ApiStory | undefined;

  constructor(sources: {
    claude: () => ClaudeStory | undefined;
    codex: () => CodexStory | undefined;
    api: () => ApiStory | undefined;
  }) {
    this.claude = sources.claude;
    this.codex = sources.codex;
    this.api = sources.api;
  }

  /** True while a story pass over this route is running for the project. */
  restricted(projectId: string, route: "codex" | "api"): boolean {
    const run = this.runs.get(projectId);
    return run?.route === route && run.outcome === null;
  }

  async blocked(provider: MagicWandProvider): Promise<MagicWandBlock | null> {
    try {
      if (provider === "claude") {
        const view = await this.claude()?.settled();
        if (!view) return "missing";
        if (view.status === "signed_in")
          return view.selection || view.roughCutSelection ? null : "setup";
        if (view.status === "signed_out" || view.status === "signing_in")
          return "signIn";
        if (view.status === "unavailable")
          return view.message === claudeIssues.outdated
            ? "outdated"
            : "missing";
        return "setup";
      }
      if (provider === "codex") {
        const view = await this.codex()?.get();
        if (!view) return "setup";
        if (view.account === "signed_out") return "signIn";
        return view.connection === "connected" &&
          view.account === "signed_in" &&
          view.selection
          ? null
          : "setup";
      }
      const api = this.api();
      if (!api) return "setup";
      const item = (await api.providers.get()).providers.find(
        (entry) => entry.id === provider,
      );
      if (!item?.connected) return "signIn";
      if (!item.selectedModel) return "setup";
      return (await api.providers.selected(provider)) ? null : "signIn";
    } catch {
      return "setup";
    }
  }

  async start(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
    provider: MagicWandProvider = "claude",
  ): Promise<RoughCutOutcome | null> {
    const run: Run = {
      route: routeOf(provider),
      provider,
      stopped: false,
      outcome: null,
    };
    this.runs.set(projectId, run);
    try {
      if (run.route === "claude")
        return await this.startClaude(projectId, preset, request);
      if (run.route === "codex")
        return await this.startCodex(projectId, request);
      return await this.startApi(projectId, preset, request, run);
    } catch {
      return "failed";
    }
  }

  outcome(projectId: string): RoughCutOutcome | null {
    const run = this.runs.get(projectId);
    if (!run) return "failed";
    try {
      if (run.route === "claude") {
        const claude = this.claude();
        return claude ? claudeOutcome(claude.getThread(projectId)) : "failed";
      }
      if (run.route === "codex") {
        const codex = this.codex();
        if (!codex) return "failed";
        const view = codex.getThread(projectId);
        if (["starting", "running", "interrupting"].includes(view.status))
          return null;
        return run.stopped
          ? "stopped"
          : view.status === "ready"
            ? "completed"
            : "failed";
      }
      return run.outcome;
    } catch {
      return "failed";
    }
  }

  async stop(projectId: string): Promise<void> {
    const run = this.runs.get(projectId);
    if (!run) return;
    run.stopped = true;
    if (run.route === "claude") {
      const claude = this.claude();
      if (claude?.runKind(projectId) === "rough_cut")
        await claude.interruptThread(projectId);
    } else if (run.route === "codex") {
      const codex = this.codex();
      if (codex?.getThread(projectId).status === "running")
        await codex.interruptThread(projectId);
    } else {
      const provider = run.provider;
      if (provider !== "claude" && provider !== "codex")
        await this.api()?.threads.interrupt(projectId, provider);
    }
  }

  release(projectId: string): void {
    this.runs.delete(projectId);
  }

  private async startClaude(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
  ): Promise<RoughCutOutcome | null> {
    const claude = this.claude();
    if (!claude) return "failed";
    if ((await claude.settled()).status !== "signed_in") return "signIn";
    return claudeOutcome(
      await claude.startRoughCut(projectId, preset, request),
    );
  }

  /**
   * Codex's instructions are fixed when its thread opens, so the playbook
   * travels in the turn's own text.
   */
  private async startCodex(
    projectId: string,
    request: string,
  ): Promise<RoughCutOutcome | null> {
    const codex = this.codex();
    if (!codex) return "failed";
    const block = await this.blocked("codex");
    if (block) return block === "signIn" ? "signIn" : "failed";
    let view = codex.getThread(projectId);
    if (view.status === "closed") view = await codex.openThread(projectId);
    if (view.status !== "ready") return "failed";
    view = await codex.sendThread(
      projectId,
      `${roughCutPlaybookFor("codex")}\n\n${request}`,
    );
    return view.status === "starting" || view.status === "running"
      ? null
      : "failed";
  }

  private async startApi(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
    run: Run,
  ): Promise<RoughCutOutcome | null> {
    const api = this.api();
    const provider = run.provider;
    if (!api || provider === "claude" || provider === "codex") return "failed";
    const block = await this.blocked(provider);
    if (block) return block === "signIn" ? "signIn" : "failed";
    await api.threads.open(projectId, provider);
    // The turn runs to its end inside this call; Magic Edit polls `outcome`.
    void api.threads
      .send(projectId, provider, roughCutLabel(preset, provider), {
        request,
        playbook: roughCutPlaybookFor(provider),
        tools: apiRoughCutTools,
        maxCompletions: storyPassLimits.maxCompletions,
        maxToolCalls: storyPassLimits.maxToolCalls,
      })
      .then((view) => {
        run.outcome = run.stopped
          ? "stopped"
          : view.status === "ready"
            ? "completed"
            : view.message === apiTurnProblems.rate
              ? "limit"
              : view.message === apiTurnProblems.authentication ||
                  view.message === apiTurnProblems.connection
                ? "signIn"
                : view.message === apiTurnProblems.stopped
                  ? "stopped"
                  : "failed";
      })
      .catch(() => {
        run.outcome = run.stopped ? "stopped" : "failed";
      });
    return null;
  }
}

/** How a Claude run ended, from its conversation. */
export function claudeOutcome(view: ClaudeThreadView): RoughCutOutcome | null {
  return view.status === "running" || view.status === "interrupting"
    ? null
    : view.status === "ready"
      ? "completed"
      : view.message === claudeThreadIssues.stopped
        ? "stopped"
        : view.message === claudeThreadIssues.signIn ||
            view.message === claudeThreadIssues.model
          ? "signIn"
          : view.message === claudeThreadIssues.limit
            ? "limit"
            : "failed";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work that starts after the assistant's current reply is finished: the
 * assistant calls an app action in the middle of its own turn, and the
 * conversation it runs in cannot take a second turn until that one ends.
 * One pending job per project; Stop cancels it.
 */
export class DeferredActions {
  private readonly jobs = new Map<string, { cancelled: boolean }>();
  private readonly pollMs: number;

  constructor(pollMs = 400) {
    this.pollMs = pollMs;
  }

  has(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  cancel(projectId: string): boolean {
    const job = this.jobs.get(projectId);
    if (!job) return false;
    job.cancelled = true;
    return true;
  }

  /**
   * Waits until `idle()` is true, then runs the work. `run` receives a
   * function that says whether the user stopped it meanwhile. Returns a
   * promise that settles when the job is over (it never rejects).
   */
  defer(
    projectId: string,
    idle: () => boolean | Promise<boolean>,
    run: (cancelled: () => boolean) => Promise<void>,
    options: { timeoutMs?: number } = {},
  ): Promise<void> | null {
    if (this.jobs.has(projectId)) return null;
    const job = { cancelled: false };
    this.jobs.set(projectId, job);
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
    return (async () => {
      try {
        await wait(this.pollMs);
        while (!job.cancelled && Date.now() < deadline) {
          if (await idle()) break;
          await wait(this.pollMs);
        }
        if (!job.cancelled && Date.now() < deadline)
          await run(() => job.cancelled);
      } catch {
        // The work reports its own problems in the app.
      } finally {
        this.jobs.delete(projectId);
      }
    })();
  }
}

const stepNames: Record<AppActionStep, string> = {
  record_import: "Record or import",
  auto_edit: "Auto Edit",
  edit: "Edit",
  review: "Review",
  export: "Export",
};

/** Everything the app actions need from main. */
export interface AppActionDeps {
  provider: MagicWandProvider;
  magic: {
    busy(projectId: string): boolean;
    start(
      projectId: string,
      preset: MagicWandPreset,
      provider: MagicWandProvider,
    ): MagicWandView;
    stop(projectId: string): MagicWandView;
    get(projectId: string): MagicWandView;
  };
  deferred: DeferredActions;
  /** True when the chat connection is not in the middle of a turn. */
  chatIdle(projectId: string): boolean | Promise<boolean>;
  /** The step the project is on now. */
  currentStep(projectId: string): Promise<AppActionStep>;
  /** Moves the app to a step, as the step bar does. Throws a plain message. */
  navigate(projectId: string, step: AppActionStep): Promise<void>;
  /** Claude only: starts the full production edit; throws a plain message. */
  startFullEdit?(projectId: string, level: AppActionLevel): Promise<void>;
  /** Claude only: stops a running full edit; true when one was stopped. */
  stopFullEdit?(projectId: string): Promise<boolean>;
}

function plain(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 300)
    : "That did not work. Try the button instead.";
}

/**
 * The assistant's app actions for one connection. Each runs the same code as
 * its button and answers in plain words. Magic Edit and Edit my video start
 * after the assistant's current reply; export and cleanup are not here.
 */
export function createAppActions(deps: AppActionDeps): AppActions {
  const { provider, magic, deferred } = deps;
  /** The story edit reads the transcript, which needs Auto Edit or Edit. */
  const readyStep = async (projectId: string) => {
    const step = await deps.currentStep(projectId);
    if (step !== "auto_edit" && step !== "edit")
      await deps.navigate(projectId, "auto_edit");
  };
  const waitForMagic = async (
    projectId: string,
    cancelled: () => boolean,
  ): Promise<MagicWandView> => {
    await wait(400);
    while (magic.busy(projectId) && !cancelled()) await wait(400);
    return magic.get(projectId);
  };
  const actions: AppActions = {
    async startMagicEdit(projectId, preset: AppActionPreset) {
      if (magic.busy(projectId) || deferred.has(projectId))
        return {
          status: "busy",
          message:
            "An edit is already running or waiting to start for this video. Stop it first if you want to start another.",
        };
      deferred.defer(
        projectId,
        () => deps.chatIdle(projectId),
        async () => {
          await readyStep(projectId);
          magic.start(projectId, preset, provider);
        },
      );
      return {
        status: "queued",
        message:
          "Magic Edit will start as soon as this reply is finished: the app tightens long pauses and fillers first, then the story edit runs. Progress shows in Auto Edit and every cut can be undone.",
      };
    },
    async stopEdit(projectId) {
      const done: string[] = [];
      if (deferred.cancel(projectId))
        done.push("cancelled the edit that was waiting");
      if (magic.busy(projectId)) {
        magic.stop(projectId);
        done.push("stopped Magic Edit");
      }
      if (await deps.stopFullEdit?.(projectId))
        done.push("stopped the full edit");
      return done.length
        ? {
            status: "stopped",
            message: `I ${done.join(" and ")}. Cuts already made stay and can be undone.`,
          }
        : {
            status: "nothing_running",
            message:
              "Nothing is running that can be stopped right now. If an edit is writing this reply, use the Stop button.",
          };
    },
    async goToStep(projectId, step: AppActionStep) {
      try {
        await deps.navigate(projectId, step);
      } catch (error) {
        return { status: "not_available", message: plain(error) };
      }
      return {
        status: "moved",
        message:
          step === "export"
            ? "Showing the Export step. Nothing is exported until the user presses Export themselves."
            : `Moved to ${stepNames[step]}.`,
      };
    },
  };
  if (deps.startFullEdit) {
    const startFullEdit = deps.startFullEdit;
    actions.startEditMyVideo = async (
      projectId,
      level: AppActionLevel,
    ): Promise<AppActionResult> => {
      if (magic.busy(projectId) || deferred.has(projectId))
        return {
          status: "busy",
          message:
            "An edit is already running or waiting to start for this video. Stop it first if you want to start another.",
        };
      deferred.defer(
        projectId,
        () => deps.chatIdle(projectId),
        async (cancelled) => {
          await readyStep(projectId);
          // Step 1: the rough cut; step 2 only if it finished.
          magic.start(projectId, "balanced", provider);
          const view = await waitForMagic(projectId, cancelled);
          if (cancelled() || view.status !== "completed") return;
          await startFullEdit(projectId, level);
        },
      );
      return {
        status: "queued",
        message:
          "Edit my video will start as soon as this reply is finished: first the rough cut, then graphics, captions and sound. Progress shows in Auto Edit, every step can be undone, and Stop ends it.",
      };
    };
  }
  return actions;
}
