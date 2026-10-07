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
  timeline_undo: { label: "Undoing the last edit", mutating: true },
};

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
  readonly serverName: string;
  private readonly sessionId: string;
  private initialized = false;
  private finished: ClaudeTurnOutcome | null = null;
  private violationFound = false;
  private interruptRequested = false;
  private live = "";
  private readonly segments: string[] = [];
  private readonly activityMap = new Map<string, ClaudeActivity>();
  private lastError: string | null = null;

  constructor(input: {
    allowedTools: Iterable<string>;
    serverName: string;
    sessionId: string;
  }) {
    this.allowedTools = new Set(input.allowedTools);
    this.serverName = input.serverName;
    this.sessionId = input.sessionId;
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

  private validateInit(message: Record<string, unknown>): boolean {
    const tools = message.tools;
    const servers = message.mcp_servers;
    if (
      message.session_id !== this.sessionId ||
      message.permissionMode !== "dontAsk" ||
      !Array.isArray(tools) ||
      tools.length !== this.allowedTools.size ||
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
      if (value !== undefined && (!Array.isArray(value) || value.length))
        return false;
    }
    return true;
  }

  /** Returns false when the turn must be stopped immediately. */
  handle(message: Record<string, unknown>): boolean {
    if (this.finished) return true;
    if (message.type === "system" && message.subtype === "init") {
      if (this.initialized || !this.validateInit(message)) {
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
          if (!this.allowedTools.has(name)) {
            this.violationFound = true;
            this.fail("tools");
            return false;
          }
          const id =
            typeof block.id === "string" && activityId.test(block.id)
              ? block.id
              : `tool-${randomUUID()}`;
          const short = name.slice(`mcp__${this.serverName}__`.length);
          const known = activityLabels[short] ?? {
            label: "Using an editor tool",
            mutating: true,
          };
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
  return [
    ...restrictedSessionArguments,
    "--include-partial-messages",
    "--mcp-config",
    options.mcpConfigPath,
    "--allowedTools",
    options.allowedTools.join(","),
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

  constructor(options: ClaudeTurnOptions) {
    this.projection = new ClaudeTurnProjection({
      allowedTools: options.allowedTools,
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
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
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
      this.child.once("close", settle);
    });
    this.child.stdin?.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: options.text },
        parent_tool_use_id: null,
      })}\n`,
    );
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
