import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CodexClient,
  type CodexClientOptions,
} from "../../../packages/codex-bridge/src/client.ts";
import type { AuthState } from "../../../packages/codex-bridge/src/auth.ts";
import type { DeviceLoginDetails } from "../../../packages/domain/src/codex-device-login.ts";
import type {
  ThreadHistorySnapshot,
  ThreadStreamEvent,
} from "../../../packages/codex-bridge/src/thread-stream.ts";
import type { NativeSubagentProtocol } from "../../../packages/codex-bridge/src/thread-protocol.ts";
import { CodexTransportError } from "../../../packages/codex-bridge/src/transport.ts";
import {
  ProjectThreadRegistry,
  type ProjectThreadToolRoute,
} from "../../../packages/codex-bridge/src/thread-registry.ts";
import {
  resolveCodexRuntime,
  CodexRuntimeError,
} from "../../../packages/codex-bridge/src/runtime.ts";
import {
  assertCodexSelection,
  assertCodexView,
  type CodexView,
  type CodexSelection,
} from "../../../packages/domain/src/codex-view.ts";
import { CodexSettingsStore } from "./codex-settings.ts";
import {
  assertCodexThreadView,
  type CodexThreadView,
} from "../../../packages/domain/src/codex-thread-view.ts";
import type { CodexMcpRuntime } from "../../../packages/codex-tools/src/broker.ts";
import type { CodexVideoEditToolName } from "../../../packages/codex-tools/src/service.ts";
import type { DynamicToolAccess } from "../../../packages/codex-bridge/src/dynamic-tools.ts";

type Client = Pick<
  CodexClient,
  | "connect"
  | "close"
  | "account"
  | "authState"
  | "skills"
  | "models"
  | "rateLimits"
  | "startLogin"
  | "startDeviceLogin"
  | "cancelLogin"
  | "logout"
  | "openProjectThread"
  | "startProjectTurn"
  | "interruptProjectTurn"
  | "closeProjectThread"
>;
/** Internal deterministic-test seam; never renderer-selectable or exposed through IPC. */
export interface DesktopCodexDependencies {
  createClient: (options: CodexClientOptions) => Client;
  resolveRuntime: typeof resolveCodexRuntime;
  directory: (path: string) => Promise<void>;
  now?: () => number;
  metadataRefreshIntervalMs?: number;
  settings: Pick<CodexSettingsStore, "read" | "write">;
  mcpRuntime?: CodexMcpRuntime;
  dynamicToolInvoker?: (
    name: CodexVideoEditToolName,
    input: unknown,
    access: DynamicToolAccess,
  ) => Promise<unknown>;
  toolRouteForProject: (projectId: string) => Promise<ProjectThreadToolRoute>;
}

const initial = (): CodexView => ({
  connection: "disconnected",
  account: "unknown",
  plan: null,
  busy: false,
  message: null,
  models: [],
  skills: [],
  limits: [],
  selection: null,
});
const SETTINGS_METADATA_REFRESH_INTERVAL_MS = 15_000;
const initialThread = (): CodexThreadView => ({
  status: "closed",
  projectId: null,
  messages: [],
  activities: [],
  message: null,
  retryable: false,
});
const PROJECT_THREAD_INSTRUCTIONS =
  "You are the in-app codex-video-edit editor. Read current state through project.get_summary and timeline.get_summary. Before every mutation, refresh the draft sequence and hash, then use only the codex-video-edit MCP tools to apply the user's requested reversible edit. For cut.split, use an exact interior output-time position from the current draft and do not infer a useful speech boundary without transcript or audio evidence. For cut.delete_range, use exact half-open output times from the current draft and preserve meaning; without transcript or audio evidence, do not infer that a range is filler or that its joined speech is sound. For cut.delete_ranges, provide 2–16 confirmed disjoint half-open ranges in descending start-time order. The app commits them as one undoable transaction, but does not verify speech meaning or the rendered joins. For cut.restore_range, restore only a confirmed missing source-time interval using its source_id and exact half-open source times; the main service rejects visible overlap and ambiguous source ordering. Never infer filler from timing alone. Describe an edit as applied only after its tool result confirms the commit. MCP-bound project threads do not support native children. Do not claim a child ran unless a completed server-owned spawn and child-owned summary reads are verified. Never invent timeline, preview, transcript, render, review, or export state. Do not request or use shell, file, network, browser, external app, export, deletion, cleanup, spending, or publication access.";
const DYNAMIC_PROJECT_THREAD_INSTRUCTIONS = PROJECT_THREAD_INSTRUCTIONS.replace(
  "project.get_summary and timeline.get_summary",
  "codex_video_edit__project_get_summary and codex_video_edit__timeline_get_summary",
)
  .replace("codex-video-edit MCP tools", "codex_video_edit host tools")
  .replace("cut.split", "codex_video_edit__cut_split")
  .replace("cut.delete_ranges", "codex_video_edit__cut_delete_ranges")
  .replace("cut.delete_range", "codex_video_edit__cut_delete_range")
  .replace("cut.restore_range", "codex_video_edit__cut_restore_range");
const DYNAMIC_V1_CHILD_INSTRUCTIONS =
  "Dynamic-bound Codex threads may use a native child only when the selected model advertises the supported V1 protocol. The app pins the default child model and reasoning to this thread's selected model and effort; never request a model override or choose Astra. Spawn with fork_context=true, give the child only this active project and ask it to use codex_video_edit__project_get_summary and codex_video_edit__timeline_get_summary. Main validates the completed parent spawn, child turn and each read, allows no child edits, and hides child transcripts and identities. MCP-bound threads do not expose children. Do not claim a child ran without completed server-owned spawn and child-owned summary reads.";
const DYNAMIC_V2_CHILD_INSTRUCTIONS =
  "This GPT-6-Luna thread may use the guarded V2 native child route for one read-only project task. First read the active project's path-free project and timeline summaries with codex_video_edit__project_get_summary and codex_video_edit__timeline_get_summary. Invoke the direct top-level native codex_video_edit_agents__spawn_agent tool at most once with fork_turns=none and no model or reasoning override; give the child only the active project_id and those two summary JSON values. The child uses only that snapshot and must not ask for more access. These V2 functions are direct model tools, not nested code-mode helpers. The app locks the child model to the selected Luna model, disables model overrides, limits concurrent children to one, and rejects all child edits except the summary reads if any are attempted. Wait with the direct native codex_video_edit_agents__wait_agent tool; do not use send_message or followup_task, attempt another child, or request a model change. Never claim a child ran without completed server-owned spawn correlation and a completed child turn.";
const DYNAMIC_NO_CHILD_INSTRUCTIONS =
  "The selected Codex model has no native child protocol enabled for this conversation. Do not claim a child ran or request native-agent tools.";
function dynamicInstructionsForProtocol(
  protocol: NativeSubagentProtocol,
): string {
  const childInstructions =
    protocol === "v1"
      ? DYNAMIC_V1_CHILD_INSTRUCTIONS
      : protocol === "v2"
        ? DYNAMIC_V2_CHILD_INSTRUCTIONS
        : DYNAMIC_NO_CHILD_INSTRUCTIONS;
  return DYNAMIC_PROJECT_THREAD_INSTRUCTIONS.replace(
    "MCP-bound project threads do not support native children. Do not claim a child ran unless a completed server-owned spawn and child-owned summary reads are verified.",
    childInstructions,
  );
}
const preferredSubscriptionModel: CodexSelection = {
  modelId: "gpt-6-luna",
  reasoning: "high",
};
const preferredModelUnavailable =
  "GPT-6-Luna with high reasoning is unavailable for this account. Choose an available Codex model in Settings.";
const metadataRefreshFailed =
  "Some Codex settings could not be refreshed. Reconnect to try again.";
const label = (value: string, max: number) =>
  value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, max)
    .trim();

/** Main owns runtime paths, credentials, login URLs and external launch authority. */
export class DesktopCodex {
  private state = initial();
  private client: Client | undefined;
  private attempted = false;
  private generation = 0;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private metadataRefreshedAt = 0;
  private readonly now: () => number;
  private readonly metadataRefreshIntervalMs: number;
  private stopped = false;
  private startupFinished: Promise<void> | undefined;
  private actionFinished: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private authKey = "";
  private authRevision = 0;
  private clientRoute: ProjectThreadToolRoute = "mcp";
  private usePreferredDefault = false;
  private thread = initialThread();
  private readonly threadItems = new Map<string, string>();
  private nextThreadViewId = 0;
  private readonly requestModels = new Map<string, string>();
  private readonly nativeSubagentVersions = new Map<
    string,
    NativeSubagentProtocol
  >();
  private readonly settings: Pick<CodexSettingsStore, "read" | "write">;
  private readonly dependencies: DesktopCodexDependencies;
  private readonly resources: string;
  private readonly userData: string;
  private readonly openLogin: (url: string) => Promise<void>;
  constructor(
    resources: string,
    userData: string,
    openLogin: (url: string) => Promise<void>,
    dependencies: Partial<DesktopCodexDependencies> = {},
  ) {
    this.resources = resources;
    this.userData = userData;
    this.openLogin = openLogin;
    this.dependencies = {
      createClient: (options) => new CodexClient(options),
      resolveRuntime: resolveCodexRuntime,
      directory: (path) => this.directory(path),
      settings: new CodexSettingsStore(join(userData, "codex-settings")),
      toolRouteForProject: async (projectId) => {
        const registry = await ProjectThreadRegistry.open(
          join(userData, "codex", "context", "threads"),
        );
        return (
          (await registry.bindingForProject(projectId))?.toolRoute ?? "dynamic"
        );
      },
      ...dependencies,
    };
    this.settings = this.dependencies.settings;
    this.now = this.dependencies.now ?? Date.now;
    this.metadataRefreshIntervalMs =
      this.dependencies.metadataRefreshIntervalMs ??
      SETTINGS_METADATA_REFRESH_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.metadataRefreshIntervalMs) ||
      this.metadataRefreshIntervalMs < 1_000 ||
      this.metadataRefreshIntervalMs > 60_000
    )
      throw new Error("Invalid Codex metadata refresh interval.");
  }
  private current(generation: number, client?: Client): boolean {
    return (
      !this.stopped &&
      generation === this.generation &&
      (client === undefined || client === this.client)
    );
  }
  private applyAuth(auth: AuthState): void {
    const key = JSON.stringify(auth);
    if (key !== this.authKey) {
      this.authKey = key;
      this.authRevision++;
    }
    if (auth.error === "connection_lost") {
      this.state = {
        ...initial(),
        connection: "unavailable",
        busy: this.state.busy,
        message: "The Codex connection was lost. Reconnect to continue.",
      };
      return;
    }
    const pending = [
      "starting",
      "awaiting_browser",
      "awaiting_device_code",
      "reconciling",
      "canceling",
    ].includes(auth.status);
    this.state.account = pending
      ? "signing_in"
      : auth.account === null
        ? "unknown"
        : auth.account.status === "chatgpt"
          ? "signed_in"
          : "signed_out";
    this.state.plan =
      this.state.account === "signed_in" && auth.account?.status === "chatgpt"
        ? auth.account.plan
        : null;
    if (auth.error)
      this.state.message =
        auth.error === "login_timed_out"
          ? "Sign-in expired. Sign in again."
          : "Sign-in did not finish. Try again.";
    else if (
      [
        "Sign-in expired. Sign in again.",
        "Sign-in did not finish. Try again.",
      ].includes(this.state.message ?? "")
    )
      this.state.message = null;
    if (this.state.account !== "signed_in") {
      this.state.models = [];
      this.state.limits = [];
    }
  }
  private snapshot(): CodexView {
    assertCodexView(this.state);
    return structuredClone(this.state);
  }
  private threadSnapshot(): CodexThreadView {
    assertCodexThreadView(this.thread);
    return structuredClone(this.thread);
  }
  private resetThread(): void {
    this.thread = initialThread();
    this.threadItems.clear();
  }
  private viewId(prefix: "message" | "activity"): string {
    return `${prefix}-${String(++this.nextThreadViewId).padStart(8, "0")}`;
  }
  private applyThreadEvent(event: ThreadStreamEvent): void {
    if (this.thread.status === "closed") return;
    switch (event.type) {
      case "turn_started":
        this.thread.status = "running";
        break;
      case "item_started":
        if (event.kind !== "message") {
          const id = this.viewId("activity");
          this.threadItems.set(event.itemId, id);
          this.thread.activities.push({
            id,
            kind: event.kind,
            label: event.label,
            complete: false,
          });
          this.thread.activities = this.thread.activities.slice(-32);
        }
        break;
      case "message_delta": {
        let id = this.threadItems.get(event.itemId);
        let message = this.thread.messages.find((item) => item.id === id);
        if (!message) {
          id = this.viewId("message");
          this.threadItems.set(event.itemId, id);
          message = { id, role: "codex", text: "", complete: false };
          this.thread.messages.push(message);
        }
        message.text += event.text;
        this.thread.messages = this.thread.messages.slice(-200);
        break;
      }
      case "item_completed": {
        const id = this.threadItems.get(event.itemId);
        if (event.kind === "message") {
          let message = this.thread.messages.find((item) => item.id === id);
          if (!message) {
            const nextId = this.viewId("message");
            this.threadItems.set(event.itemId, nextId);
            message = {
              id: nextId,
              role: "codex",
              text: "",
              complete: false,
            };
            this.thread.messages.push(message);
          }
          message.text = event.text ?? message.text;
          message.complete = true;
          this.thread.messages = this.thread.messages.slice(-200);
        } else {
          const activity = this.thread.activities.find(
            (item) => item.id === id,
          );
          if (activity) activity.complete = true;
        }
        break;
      }
      case "turn_problem":
        this.thread.message = event.retrying
          ? "Codex is retrying this turn."
          : "Codex reported a problem with this turn.";
        break;
      case "turn_terminal":
        this.thread.status = "ready";
        this.thread.retryable =
          event.status === "failed" &&
          this.thread.messages.some((message) => message.role === "user");
        for (const message of this.thread.messages) message.complete = true;
        for (const activity of this.thread.activities) activity.complete = true;
        this.thread.message =
          event.status === "failed"
            ? "This Codex turn failed. Review the committed draft before retrying."
            : event.status === "interrupted"
              ? "The Codex turn was interrupted."
              : null;
        break;
      case "connection_uncertain":
        this.thread.status = "uncertain";
        this.thread.retryable = false;
        this.thread.message =
          "The connection ended during this turn. Reopen the project to reconcile its thread and committed draft.";
        break;
    }
  }
  private applyThreadHistory(history: ThreadHistorySnapshot): void {
    if (this.thread.status === "closed") return;
    this.threadItems.clear();
    this.thread.messages = history.messages.map((message) => {
      const id = this.viewId("message");
      this.threadItems.set(message.itemId, id);
      return {
        id,
        role: message.role,
        text: message.text,
        complete: message.complete,
      };
    });
    this.thread.activities = history.activities.map((activity) => {
      const id = this.viewId("activity");
      this.threadItems.set(activity.itemId, id);
      return {
        id,
        kind: activity.kind,
        label: activity.label,
        complete: activity.complete,
      };
    });
    this.thread.status = history.activeTurnId ? "running" : "ready";
    this.thread.retryable = history.retryable;
    this.thread.message =
      history.terminalStatus === "failed"
        ? "This Codex turn failed. Review the committed draft before retrying."
        : history.terminalStatus === "interrupted"
          ? "The Codex turn was interrupted."
          : null;
  }
  async get(): Promise<CodexView> {
    if (!this.attempted && !this.stopped) return this.reconnect();
    // Settings polls this snapshot; revalidate live metadata on a bounded cadence
    // in case a runtime skill change did not emit a notification.
    if (
      !this.stopped &&
      !this.state.busy &&
      this.state.connection === "connected" &&
      this.now() - this.metadataRefreshedAt >= this.metadataRefreshIntervalMs
    )
      await this.refresh();
    return this.snapshot();
  }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      resolve(await realpath(path)) !== resolve(path)
    )
      throw new Error("Invalid account storage");
  }
  async reconnect(
    route: ProjectThreadToolRoute = this.clientRoute,
  ): Promise<CodexView> {
    if (this.stopped || this.state.busy) return this.snapshot();
    if (route !== "mcp" && route !== "dynamic")
      throw new Error("Invalid Codex tool route.");
    this.clientRoute = route;
    this.attempted = true;
    const generation = ++this.generation;
    let finishStartup!: () => void;
    this.startupFinished = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const previous = this.client;
    this.client = undefined;
    this.state = { ...initial(), busy: true };
    this.resetThread();
    this.requestModels.clear();
    this.authKey = "";
    this.authRevision++;
    this.usePreferredDefault = false;
    this.refreshAgain = false;
    try {
      await previous?.close();
      await this.refreshing;
      if (!this.current(generation)) return this.snapshot();
      const executable = await this.dependencies.resolveRuntime(this.resources);
      if (!this.current(generation)) return this.snapshot();
      const root = join(this.userData, "codex");
      const cwd = join(root, "context"),
        codexHome = join(root, "account");
      for (const path of [root, cwd, codexHome]) {
        await this.dependencies.directory(path);
        if (!this.current(generation)) return this.snapshot();
      }
      if (this.stopped || generation !== this.generation)
        return this.snapshot();
      let lastAuthKey = "";
      const update = () => {
        if (
          generation === this.generation &&
          this.state.connection === "connected"
        )
          if (this.refreshing) this.refreshAgain = true;
          else void this.refresh();
      };
      const client = this.dependencies.createClient({
        executable,
        cwd,
        codexHome,
        environment: process.env,
        onAuthStateChanged: (state) => {
          if (!this.current(generation)) return;
          const key = JSON.stringify(state);
          if (key !== lastAuthKey) {
            lastAuthKey = key;
            if (this.state.connection === "connected") this.applyAuth(state);
            update();
          }
        },
        onSkillsChanged: update,
        onRateLimitsChanged: update,
        onThreadEvent: (event) => {
          if (this.current(generation, client)) this.applyThreadEvent(event);
        },
        onThreadHistory: (history) => {
          if (this.current(generation, client))
            this.applyThreadHistory(history);
        },
        ...(route === "mcp"
          ? this.dependencies.mcpRuntime
            ? { mcp: this.dependencies.mcpRuntime }
            : {}
          : this.dependencies.dynamicToolInvoker
            ? { dynamicToolInvoker: this.dependencies.dynamicToolInvoker }
            : {}),
      });
      this.client = client;
      await client.connect();
      if (this.stopped || generation !== this.generation) {
        await client.close();
        return this.snapshot();
      }
      this.state.connection = "connected";
      try {
        const selection = await this.settings.read();
        if (this.current(generation, client)) {
          this.state.selection = selection;
          this.usePreferredDefault = selection === null;
        }
      } catch {
        if (this.current(generation, client))
          this.state.message =
            "Saved model settings could not be loaded. Check local storage access and reconnect.";
      }
      if (this.current(generation, client)) await this.refresh();
    } catch (error) {
      if (generation === this.generation) {
        await this.client?.close();
        this.client = undefined;
        this.state = {
          ...initial(),
          connection: "unavailable",
          message:
            error instanceof CodexRuntimeError
              ? error.message
              : "Codex could not connect. Reconnect to try again.",
        };
      }
    } finally {
      if (generation === this.generation) this.state.busy = false;
      this.startupFinished = undefined;
      finishStartup();
    }
    return this.snapshot();
  }
  private refresh(changed = false): Promise<void> {
    if (this.refreshing) {
      if (changed) this.refreshAgain = true;
      return this.refreshing;
    }
    const client = this.client,
      generation = this.generation;
    if (!client || this.stopped || this.state.connection !== "connected")
      return Promise.resolve();
    this.refreshing = (async () => {
      await Promise.resolve();
      do {
        this.refreshAgain = false;
        await this.refreshOnce(client, generation);
      } while (
        this.refreshAgain &&
        this.current(generation, client) &&
        this.state.connection === "connected"
      );
    })().finally(() => {
      this.metadataRefreshedAt = this.now();
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async refreshOnce(client: Client, generation: number): Promise<void> {
    try {
      await client.account();
      if (
        !this.current(generation, client) ||
        this.state.connection !== "connected"
      )
        return;
      this.applyAuth(client.authState());
      if (this.state.connection !== "connected") return;
      const revision = this.authRevision;
      const work = await Promise.allSettled([
        client.skills(),
        ...(this.state.account === "signed_in"
          ? [client.models(), client.rateLimits()]
          : []),
      ]);
      if (
        !this.current(generation, client) ||
        this.state.connection !== "connected"
      )
        return;
      this.applyAuth(client.authState());
      if (this.state.connection !== "connected") return;
      if (revision !== this.authRevision) {
        this.refreshAgain = true;
        return;
      }
      this.state.skills = [];
      this.state.models = [];
      this.state.limits = [];
      this.requestModels.clear();
      this.nativeSubagentVersions.clear();
      const skills = work[0];
      if (skills?.status === "fulfilled" && Array.isArray(skills.value))
        this.state.skills = (
          skills.value as Awaited<ReturnType<CodexClient["skills"]>>
        ).map((entry) => ({
          ...entry,
          name: label(entry.name, 1024) || "Unnamed skill",
        }));
      const models = work[1];
      if (models?.status === "fulfilled" && Array.isArray(models.value))
        this.state.models = (
          models.value as Awaited<ReturnType<CodexClient["models"]>>
        ).map((entry) => {
          this.requestModels.set(entry.id, entry.model);
          this.nativeSubagentVersions.set(
            entry.id,
            entry.id.toLocaleLowerCase().includes("astra")
              ? "disabled"
              : (entry.multiAgentVersion ?? "disabled"),
          );
          return {
            id: entry.id,
            name: label(entry.displayName, 1024) || entry.id,
            reasoning: entry.reasoning,
            defaultReasoning: entry.defaultReasoning,
          };
        });
      const limits = work[2];
      if (limits?.status === "fulfilled" && !Array.isArray(limits.value)) {
        this.state.limits = [];
        for (const bucket of limits.value.buckets)
          for (const [kind, window] of [
            ["Primary", bucket.primary],
            ["Secondary", bucket.secondary],
          ] as const) {
            if (window)
              this.state.limits.push({
                name: label(
                  `${bucket.name ?? bucket.id ?? "Codex"} · ${kind}`,
                  256,
                ),
                remainingPercent: window.remainingPercent,
                resetsAt: window.resetsAt,
              });
          }
      }
      if (work.some((result) => result.status === "rejected"))
        this.state.message = metadataRefreshFailed;
      else if (this.state.account === "signed_in" && !this.state.models.length)
        this.state.message =
          "No compatible Codex models are available for this account. Reconnect or check your ChatGPT access.";
      else if (
        [
          metadataRefreshFailed,
          "No compatible Codex models are available for this account. Reconnect or check your ChatGPT access.",
        ].includes(this.state.message ?? "")
      )
        this.state.message = null;
      if (
        this.state.selection &&
        models?.status === "fulfilled" &&
        !this.state.models.some(
          (model) =>
            model.id === this.state.selection?.modelId &&
            model.reasoning.includes(this.state.selection.reasoning),
        )
      )
        this.state.selection = null;
      if (
        this.usePreferredDefault &&
        this.state.account === "signed_in" &&
        models?.status === "fulfilled"
      ) {
        const preferred = this.state.models.find(
          (entry) =>
            entry.id === preferredSubscriptionModel.modelId &&
            entry.reasoning.includes(preferredSubscriptionModel.reasoning),
        );
        this.state.selection = preferred
          ? { ...preferredSubscriptionModel }
          : null;
        if (!preferred && this.state.models.length)
          this.state.message = work.some(
            (result) => result.status === "rejected",
          )
            ? `${preferredModelUnavailable} ${metadataRefreshFailed}`
            : preferredModelUnavailable;
        else if (preferred && this.state.message === preferredModelUnavailable)
          this.state.message = null;
      }
    } catch {
      if (generation === this.generation && !this.stopped)
        this.state = {
          ...initial(),
          connection: "unavailable",
          busy: this.state.busy,
          message: "The Codex connection was lost. Reconnect to continue.",
        };
    }
  }
  private async action(
    work: (client: Client, generation: number) => Promise<void>,
  ): Promise<CodexView> {
    if (
      !this.client ||
      this.state.connection !== "connected" ||
      this.state.busy ||
      this.stopped
    )
      return this.snapshot();
    this.state.busy = true;
    this.state.message = null;
    const client = this.client,
      generation = this.generation;
    let finishAction!: () => void;
    this.actionFinished = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    try {
      await work(client, generation);
      if (this.current(generation, client)) await this.refresh(true);
    } catch {
      if (this.current(generation, client))
        this.state.message =
          "This Codex action could not finish. Reconnect or try again.";
    } finally {
      if (this.current(generation, client)) this.state.busy = false;
      this.actionFinished = undefined;
      finishAction();
    }
    return this.snapshot();
  }
  login(): Promise<CodexView> {
    return this.action(async (client, generation) => {
      const login = await client.startLogin();
      if (login && this.current(generation, client)) {
        try {
          await this.openLogin(login.authUrl);
        } catch {
          if (this.current(generation, client)) await client.cancelLogin();
          throw new Error("Browser unavailable");
        }
      }
    });
  }
  async loginDevice(): Promise<DeviceLoginDetails> {
    let details: DeviceLoginDetails | null = null;
    await this.action(async (client) => {
      details = await client.startDeviceLogin();
    });
    if (!details) throw new Error("Device sign-in could not start.");
    return details;
  }
  deviceLoginPending(): boolean {
    return this.client?.authState().status === "awaiting_device_code";
  }
  cancelLogin(): Promise<CodexView> {
    return this.action(async (client) => {
      await client.cancelLogin();
    });
  }
  logout(): Promise<CodexView> {
    return this.action(async (client) => {
      await client.logout();
    });
  }
  async select(value: unknown): Promise<CodexView> {
    assertCodexSelection(value);
    const selected: CodexSelection = { ...value };
    if (
      this.state.account !== "signed_in" ||
      !this.state.models.some(
        (model) =>
          model.id === selected.modelId &&
          model.reasoning.includes(selected.reasoning),
      )
    )
      throw new Error("Choose an available model and reasoning level.");
    return this.action(async (client, generation) => {
      const selection = await this.settings.write(selected);
      if (this.current(generation, client)) {
        this.state.selection = selection;
        this.usePreferredDefault = false;
      }
    });
  }
  getThread(projectId: string): CodexThreadView {
    if (this.thread.projectId !== null && this.thread.projectId !== projectId)
      throw new Error("Open the active project's Codex conversation.");
    return this.threadSnapshot();
  }
  async openThread(projectId: string): Promise<CodexThreadView> {
    if (
      !this.client ||
      this.state.connection !== "connected" ||
      this.state.account !== "signed_in" ||
      !this.state.selection ||
      this.state.busy ||
      this.thread.status !== "closed"
    )
      throw new Error("Codex is not ready to open this project conversation.");
    const route = await this.dependencies.toolRouteForProject(projectId);
    if (route !== this.clientRoute) await this.reconnect(route);
    if (
      !this.client ||
      this.state.connection !== "connected" ||
      this.state.account !== "signed_in" ||
      !this.state.selection ||
      this.state.busy
    )
      throw new Error("Codex could not connect for this project conversation.");
    const selection = this.state.selection;
    if (!selection) throw new Error("Choose an available Codex model.");
    const requestModel = this.requestModels.get(selection.modelId);
    const nativeSubagentProtocol: NativeSubagentProtocol =
      route === "dynamic"
        ? (this.nativeSubagentVersions.get(selection.modelId) ?? "disabled")
        : "disabled";
    let nativeSubagentModel: string | undefined;
    let nativeSubagentReasoning: string | undefined;
    if (!requestModel)
      throw new Error(
        "Choose an available Codex model before opening the conversation.",
      );
    if (nativeSubagentProtocol !== "disabled") {
      nativeSubagentModel = requestModel;
      nativeSubagentReasoning = selection.reasoning;
    }
    this.thread = {
      status: "opening",
      projectId,
      messages: [],
      activities: [],
      message: null,
      retryable: false,
    };
    try {
      await this.client.openProjectThread({
        projectId,
        model: requestModel,
        effort: selection.reasoning,
        ...(route === "dynamic" ? { nativeSubagentProtocol } : {}),
        ...(route === "dynamic" && nativeSubagentProtocol !== "disabled"
          ? {
              nativeSubagentModel: nativeSubagentModel!,
              nativeSubagentReasoning: nativeSubagentReasoning!,
            }
          : {}),
        developerInstructions: `${route === "mcp" ? PROJECT_THREAD_INSTRUCTIONS : dynamicInstructionsForProtocol(nativeSubagentProtocol)}\nRead-tool input for this main-owned active project: ${JSON.stringify({ schema_version: "1.0", project_id: projectId })}. Use this exact project_id; do not guess identifiers or ask the user to provide it. Obtain draft identifiers, sequence and hash from the read tools before editing.`,
      });
      if (this.thread.status === "opening") this.thread.status = "ready";
    } catch {
      this.thread.status = "failed";
      this.thread.message =
        "The project conversation could not be opened. Reconnect Codex and try again.";
    }
    return this.threadSnapshot();
  }
  async sendThread(projectId: string, text: string): Promise<CodexThreadView> {
    if (
      !this.client ||
      this.thread.projectId !== projectId ||
      this.thread.status !== "ready"
    )
      throw new Error("The project conversation is not ready.");
    const id = this.viewId("message");
    this.thread.retryable = false;
    this.thread.messages.push({ id, role: "user", text, complete: true });
    this.thread.messages = this.thread.messages.slice(-200);
    this.thread.status = "starting";
    this.thread.message = null;
    try {
      await this.client.startProjectTurn({ text });
      if (this.thread.status === "starting") this.thread.status = "running";
    } catch (error) {
      if (
        error instanceof CodexTransportError &&
        error.code === "remote_error"
      ) {
        this.thread.messages = this.thread.messages.filter(
          (message) => message.id !== id,
        );
        this.thread.status = "ready";
        this.thread.retryable = false;
        this.thread.message =
          "Codex rejected this turn. Adjust it and try again.";
      } else {
        this.thread.status = "uncertain";
        this.thread.message =
          "The turn outcome is uncertain. Reopen the project before retrying.";
      }
    }
    return this.threadSnapshot();
  }
  async interruptThread(projectId: string): Promise<CodexThreadView> {
    if (
      !this.client ||
      this.thread.projectId !== projectId ||
      this.thread.status !== "running"
    )
      throw new Error("There is no running Codex turn to interrupt.");
    this.thread.status = "interrupting";
    try {
      await this.client.interruptProjectTurn();
      if (this.thread.status === "interrupting")
        this.thread.message = "Interrupt requested. Waiting for Codex to stop.";
    } catch {
      if (this.thread.status === "interrupting") {
        this.thread.status = "uncertain";
        this.thread.message =
          "The interrupt outcome is uncertain. Reopen the project to reconcile the turn.";
      }
    }
    return this.threadSnapshot();
  }
  async closeThread(projectId: string): Promise<void> {
    if (this.thread.projectId === null) return;
    if (this.thread.projectId !== projectId)
      throw new Error("Close the active project's Codex conversation.");
    if (
      ["opening", "starting", "running", "interrupting"].includes(
        this.thread.status,
      )
    )
      throw new Error(
        "Stop the running Codex turn before leaving this project.",
      );
    await this.client?.closeProjectThread();
    this.resetThread();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.generation++;
    const client = this.client;
    this.client = undefined;
    this.state = initial();
    this.resetThread();
    this.requestModels.clear();
    this.refreshAgain = false;
    this.closing = Promise.all([
      client?.close(),
      this.startupFinished,
      this.actionFinished,
      this.refreshing,
    ]).then(() => {});
    return this.closing;
  }
}
