import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { claudeThreadIssues } from "../../domain/src/claude-view.ts";
import { type ClaudeEffort } from "../../domain/src/claude-view.ts";
import {
  claudeArguments,
  JsonLineReader,
  restrictedSessionArguments,
  type ClaudeRuntime,
} from "./cli.ts";

export type ClaudeTurnIssue = keyof typeof claudeThreadIssues;

export interface ClaudeActivity {
  id: string;
  label: string;
  complete: boolean;
  mutating: boolean;
}

export type ClaudeTurnOutcome =
  | { kind: "completed"; text: string }
  | { kind: "failed"; issue: ClaudeTurnIssue; text: string | null };

const activityLabels: Record<string, { label: string; mutating: boolean }> = {
  project_get_summary: { label: "Reading the project", mutating: false },
  timeline_get_summary: { label: "Reading the timeline", mutating: false },
  transcript_get_range: { label: "Reading the transcript", mutating: false },
  cut_trim_edge: { label: "Trimming a clip", mutating: true },
  cut_split: { label: "Splitting a clip", mutating: true },
  cut_delete_range: { label: "Cutting a range", mutating: true },
  cut_delete_ranges: { label: "Cutting ranges", mutating: true },
  cut_restore_range: { label: "Restoring a range", mutating: true },
  zoom_set: { label: "Setting a zoom", mutating: true },
  zoom_remove: { label: "Removing a zoom", mutating: true },
  speed_set: { label: "Changing playback speed", mutating: true },
  graphics_set: { label: "Adding a graphic", mutating: true },
  graphics_remove: { label: "Removing a graphic", mutating: true },
  transition_set: { label: "Adding a transition", mutating: true },
  transition_remove: { label: "Removing a transition", mutating: true },
  captions_configure: { label: "Setting captions", mutating: true },
  audio_configure: { label: "Setting audio", mutating: true },
  media_get_frames: { label: "Looking at the edit", mutating: false },
  composition_check: { label: "Checking a composition", mutating: false },
  sound_list: { label: "Looking at the audio files", mutating: false },
  sound_set: { label: "Placing music or a sound", mutating: true },
  sound_remove: { label: "Removing a sound", mutating: true },
  shorts_propose: { label: "Choosing short clips", mutating: false },
  graphics_component: { label: "Adding a designed graphic", mutating: true },
  layout_set: { label: "Changing the camera layout", mutating: true },
  layout_plan: { label: "Planning the camera layout", mutating: false },
  layout_remove: { label: "Removing a layout change", mutating: true },
  zoom_targets: {
    label: "Finding where things happen on screen",
    mutating: false,
  },
  timeline_undo: { label: "Undoing the last edit", mutating: true },
};

/**
 * Claude Code's own tools a turn may use (ADR 0021). Restricted mode confines
 * the file tools to the project workspace; tools that run commands or code
 * and web access are never named, so they stay off.
 */
export const claudeBuiltInTools = Object.freeze([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Task",
]);

const builtInLabels: Record<string, { label: string; mutating: boolean }> = {
  Read: { label: "Reading the workspace", mutating: false },
  Write: { label: "Writing notes", mutating: false },
  Edit: { label: "Editing notes", mutating: false },
  Glob: { label: "Searching the workspace", mutating: false },
  Grep: { label: "Searching the workspace", mutating: false },
  Task: { label: "Asking a helper", mutating: false },
  Agent: { label: "Asking a helper", mutating: false },
};

/**
 * Claude Code reports its helper tool as "Task" in the init inventory but
 * names the call "Agent"; both are the same allowed tool.
 */
const builtInCallNames: Readonly<Record<string, string>> = { Task: "Agent" };

/** A subagent the app defines for Claude Code's Task tool. */
export interface ClaudeAgentDefinition {
  description: string;
  prompt: string;
  tools: readonly string[];
}

const maxText = 32 * 1024;
const activityId = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clean(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, maxText);
}

/**
 * Projects Claude Code's documented stream-json events for one turn. It
 * enforces the authoritative `system/init` tool inventory and treats any
 * other tool use as a violation that ends the turn.
 */
export class ClaudeTurnProjection {
  readonly allowedTools: ReadonlySet<string>;
  /** Names a tool call may carry: the allowed tools and their call aliases. */
  private readonly callNames: Set<string>;
  readonly serverName: string;
  private readonly sessionId: string;
  /** True when the turn loads skills (the user's own, ADR 0021). */
  private readonly allowSkills: boolean;
  private initialized = false;
  private finished: ClaudeTurnOutcome | null = null;
  private violationFound = false;
  /** What stopped the turn for its tools: names only, never content. */
  violationDetail: {
    type: string;
    subtype: string | null;
    tools: string[];
    fromHelper: boolean;
  } | null = null;
  /**
   * Why a turn failed, for private diagnostics only (never shown to users):
   * the result event's own fields and how the process ended.
   */
  failureDetail: Record<string, unknown> | null = null;
  private interruptRequested = false;
  private live = "";
  private readonly segments: string[] = [];
  private readonly activityMap = new Map<string, ClaudeActivity>();
  private lastError: string | null = null;

  constructor(input: {
    allowedTools: Iterable<string>;
    serverName: string;
    sessionId: string;
    allowSkills?: boolean;
  }) {
    this.allowedTools = new Set(input.allowedTools);
    this.callNames = new Set(this.allowedTools);
    for (const [listed, called] of Object.entries(builtInCallNames))
      if (this.allowedTools.has(listed)) this.callNames.add(called);
    this.serverName = input.serverName;
    this.sessionId = input.sessionId;
    this.allowSkills = input.allowSkills ?? false;
  }

  get ready(): boolean {
    return this.initialized;
  }

  get outcome(): ClaudeTurnOutcome | null {
    return this.finished;
  }

  get violation(): boolean {
    return this.violationFound;
  }

  get streaming(): string {
    return clean([...this.segments, this.live].filter(Boolean).join("\n\n"));
  }

  get activities(): ClaudeActivity[] {
    return [...this.activityMap.values()].map((item) => ({ ...item }));
  }

  get pendingMutation(): boolean {
    return [...this.activityMap.values()].some(
      (item) => item.mutating && !item.complete,
    );
  }

  markInterrupted(): void {
    this.interruptRequested = true;
  }

  private fail(issue: ClaudeTurnIssue): void {
    this.finished ??= {
      kind: "failed",
      issue,
      text: this.streaming || null,
    };
  }

  /**
   * The turn's first init must list exactly the allowed tools. A later init
   * (a new step of the turn, or a helper starting with its own smaller set)
   * may list fewer, but never a tool outside them.
   */
  private validateInit(
    message: Record<string, unknown>,
    first: boolean,
  ): boolean {
    const tools = message.tools;
    const servers = message.mcp_servers;
    if (
      (first && message.session_id !== this.sessionId) ||
      message.permissionMode !== "dontAsk" ||
      !Array.isArray(tools) ||
      (first && tools.length !== this.allowedTools.size) ||
      tools.some(
        (tool) => typeof tool !== "string" || !this.allowedTools.has(tool),
      ) ||
      !Array.isArray(servers) ||
      servers.length !== 1
    )
      return false;
    const server = record(servers[0]);
    if (
      !server ||
      server.name !== this.serverName ||
      server.status !== "connected"
    )
      return false;
    for (const key of ["skills", "slash_commands"]) {
      const value = message[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return false;
      // Skills only guide Claude; the tool inventory above is what limits it.
      if (value.length && !this.allowSkills) return false;
    }
    return true;
  }

  /** Returns false when the turn must be stopped immediately. */
  handle(message: Record<string, unknown>): boolean {
    if (this.finished) return true;
    if (message.type === "system" && message.subtype === "init") {
      // Claude Code starts a new step of the turn (for example when a
      // helper starts or reports back) with another init; each is checked.
      if (!this.validateInit(message, !this.initialized)) {
        this.violationDetail = {
          type: "system",
          subtype: "init",
          tools: Array.isArray(message.tools)
            ? message.tools
                .filter((tool): tool is string => typeof tool === "string")
                .slice(0, 64)
            : [],
          fromHelper:
            message.parent_tool_use_id !== null &&
            message.parent_tool_use_id !== undefined,
        };
        this.violationFound = true;
        this.fail("tools");
        return false;
      }
      this.initialized = true;
      return true;
    }
    if (!this.initialized) return true;
    // Subagent traffic carries a parent tool ID; the app exposes no Agent tool.
    if (
      message.parent_tool_use_id !== null &&
      message.parent_tool_use_id !== undefined
    )
      return true;
    if (message.type === "stream_event") {
      const event = record(message.event);
      const delta = record(event?.delta);
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      )
        this.live = clean(this.live + delta.text);
      return true;
    }
    if (message.type === "assistant") {
      if (typeof message.error === "string") this.lastError = message.error;
      const content = record(message.message)?.content;
      if (!Array.isArray(content)) return true;
      const text: string[] = [];
      for (const raw of content) {
        const block = record(raw);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string")
          text.push(block.text);
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "";
          if (!this.callNames.has(name)) {
            this.violationDetail = {
              type: "assistant",
              subtype: null,
              tools: [name.slice(0, 120)],
              fromHelper: false,
            };
            this.violationFound = true;
            this.fail("tools");
            return false;
          }
          const id =
            typeof block.id === "string" && activityId.test(block.id)
              ? block.id
              : `tool-${randomUUID()}`;
          const prefix = `mcp__${this.serverName}__`;
          const known = (name.startsWith(prefix)
            ? activityLabels[name.slice(prefix.length)]
            : builtInLabels[name]) ?? {
            label: "Using an editor tool",
            mutating: true,
          };
          // Long runs make many calls: forget the oldest finished one so
          // pending edits stay tracked for the uncertain-outcome check.
          if (!this.activityMap.has(id) && this.activityMap.size >= 32)
            for (const [key, item] of this.activityMap)
              if (item.complete) {
                this.activityMap.delete(key);
                break;
              }
          if (!this.activityMap.has(id) && this.activityMap.size < 32)
            this.activityMap.set(id, {
              id,
              label: known.label,
              complete: false,
              mutating: known.mutating,
            });
        }
      }
      // A complete assistant message supersedes its partial deltas.
      this.live = "";
      const joined = clean(text.join("").trim());
      if (joined && !message.error) this.segments.push(joined);
      return true;
    }
    if (message.type === "user") {
      const content = record(message.message)?.content;
      if (!Array.isArray(content)) return true;
      for (const raw of content) {
        const block = record(raw);
        if (block?.type !== "tool_result") continue;
        const activity =
          typeof block.tool_use_id === "string"
            ? this.activityMap.get(block.tool_use_id)
            : undefined;
        if (activity) activity.complete = true;
      }
      return true;
    }
    if (message.type === "result") {
      this.live = "";
      if (this.interruptRequested) {
        this.fail(this.pendingMutation ? "uncertain" : "stopped");
        return true;
      }
      const subtype = message.subtype;
      const terminal = message.terminal_reason;
      this.failureDetail = {
        resultSubtype: subtype ?? null,
        isError: message.is_error ?? null,
        terminalReason: terminal ?? null,
        stopReason: message.stop_reason ?? null,
        assistantError: this.lastError,
        streamedText: this.streaming.length,
        result: String(message.result ?? "").slice(0, 400),
      };
      if (message.is_error !== true && subtype === "success") {
        const text = this.streaming;
        if (text) this.finished = { kind: "completed", text };
        else this.fail("failed");
        return true;
      }
      if (subtype === "error_max_turns" || terminal === "max_turns")
        return (this.fail("turns"), true);
      switch (this.lastError) {
        case "authentication_failed":
        case "oauth_org_not_allowed":
          this.fail("signIn");
          break;
        case "rate_limit":
          this.fail("limit");
          break;
        case "billing_error":
        case "account_on_hold":
          this.fail("account");
          break;
        case "model_not_found":
          this.fail("modelUnavailable");
          break;
        default:
          this.fail(this.pendingMutation ? "uncertain" : "failed");
      }
      return true;
    }
    return true;
  }

  /** The process ended; settle a turn that produced no result event. */
  closed(resumed: boolean): ClaudeTurnOutcome {
    if (this.finished) return this.finished;
    this.failureDetail ??= {
      closedWithoutResult: true,
      initialized: this.initialized,
      pendingMutation: this.pendingMutation,
      interruptRequested: this.interruptRequested,
    };
    if (!this.initialized) this.fail(resumed ? "resume" : "failed");
    else if (this.pendingMutation) this.fail("uncertain");
    else this.fail(this.interruptRequested ? "stopped" : "failed");
    return this.finished!;
  }
}

export interface ClaudeTurnOptions {
  runtime: ClaudeRuntime;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpConfigPath: string;
  serverName: string;
  allowedTools: readonly string[];
  /** Claude Code's own tools for this turn; none keeps them all off. */
  builtInTools?: readonly string[];
  agents?: Readonly<Record<string, ClaudeAgentDefinition>>;
  /** Plugin folders whose skills the turn loads (the user's own skills). */
  pluginDirs?: readonly string[];
  model: string;
  effort: ClaudeEffort | null;
  systemPrompt: string;
  sessionId: string;
  resume: boolean;
  text: string;
  maxTurns: number;
  onUpdate: () => void;
}

export function claudeTurnArguments(
  options: Omit<
    ClaudeTurnOptions,
    "runtime" | "cwd" | "env" | "onUpdate" | "text"
  >,
): string[] {
  const builtIns = options.builtInTools ?? [];
  const session = [...restrictedSessionArguments];
  if (builtIns.length) {
    // Restricted mode confines the file tools to the working directory.
    const at = session.indexOf("--tools");
    session.splice(at, 2, "--restricted", "--tools", builtIns.join(","));
  }
  const plugins = options.pluginDirs ?? [];
  if (plugins.length) {
    // Skills load only with slash commands on; tools stay as listed.
    session.splice(session.indexOf("--disable-slash-commands"), 1);
    for (const directory of plugins) session.push("--plugin-dir", directory);
  }
  return [
    ...session,
    "--include-partial-messages",
    "--mcp-config",
    options.mcpConfigPath,
    "--allowedTools",
    [...options.allowedTools, ...builtIns].join(","),
    ...(options.agents && Object.keys(options.agents).length
      ? ["--agents", JSON.stringify(options.agents)]
      : []),
    "--model",
    options.model,
    ...(options.effort ? ["--effort", options.effort] : []),
    "--max-turns",
    String(options.maxTurns),
    "--system-prompt",
    options.systemPrompt,
    ...(options.resume
      ? ["--resume", options.sessionId]
      : ["--session-id", options.sessionId]),
  ];
}

/** One headless Claude Code process for one user-started turn. */
export class ClaudeTurn {
  readonly projection: ClaudeTurnProjection;
  readonly done: Promise<ClaudeTurnOutcome>;
  private readonly child: ChildProcess;
  private stopping = false;
  /** The end of the process's error output and how it exited (private). */
  private stderrTail = "";
  private exit: { code: number | null; signal: string | null } | null = null;

  constructor(options: ClaudeTurnOptions) {
    this.projection = new ClaudeTurnProjection({
      allowedTools: [...options.allowedTools, ...(options.builtInTools ?? [])],
      allowSkills: Boolean(options.pluginDirs?.length),
      serverName: options.serverName,
      sessionId: options.sessionId,
    });
    this.child = spawn(
      options.runtime.executable,
      claudeArguments(options.runtime, claudeTurnArguments(options)),
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    const reader = new JsonLineReader(
      (message) => {
        const keep = this.projection.handle(message);
        options.onUpdate();
        if (!keep) this.kill();
        else if (message.type === "result") {
          this.child.stdin?.end();
          resultTimer ??= setTimeout(() => this.kill(), 10_000);
        }
      },
      () => {
        this.projection.markInterrupted();
        this.kill();
      },
    );
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => reader.push(chunk));
    this.child.stdin?.on("error", () => undefined);
    this.done = new Promise((resolve) => {
      const settle = () => {
        clearTimeout(resultTimer);
        resolve(this.projection.closed(options.resume));
      };
      this.child.once("error", settle);
      this.child.once("close", (code, signal) => {
        this.exit = { code, signal };
        settle();
      });
    });
    this.child.stdin?.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: options.text },
        parent_tool_use_id: null,
      })}\n`,
    );
  }

  /** What is known about why the turn ended, for a private failure note. */
  diagnostics(): Record<string, unknown> {
    return {
      ...this.projection.failureDetail,
      exit: this.exit,
      stderrTail: this.stderrTail,
    };
  }

  /** Requests a graceful interrupt, then stops the process if it does not end. */
  interrupt(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.projection.markInterrupted();
    this.child.stdin?.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: `interrupt-${randomUUID()}`,
        request: { subtype: "interrupt" },
      })}\n`,
    );
    const timer = setTimeout(() => this.kill(), 15_000);
    void this.done.finally(() => clearTimeout(timer));
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill();
  }
}
