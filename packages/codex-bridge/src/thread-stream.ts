import {
  CodexThreadProtocolError,
  threadProtocolInternals,
  type TurnFailureCategory,
  type TurnStatus,
} from "./thread-protocol.ts";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.ts";

const MAX_DELTA_LENGTH = 16 * 1024;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_TRACKED_TERMINALS = 32;
const MAX_HISTORY_TURNS = 100;
const MAX_HISTORY_ITEMS = 1000;
const MAX_HISTORY_TEXT_BYTES = 512 * 1024;

type SafeItemKind = "message" | "activity" | "subagent" | "edit";

export interface ThreadHistoryMessage {
  itemId: string;
  role: "user" | "codex";
  text: string;
  complete: boolean;
}

export interface ThreadHistoryActivity {
  itemId: string;
  kind: Exclude<SafeItemKind, "message">;
  label: string;
  complete: boolean;
}

/** Main-only projection. Source item/turn IDs are replaced before renderer IPC. */
export interface ThreadHistorySnapshot {
  activeTurnId: string | null;
  terminalStatus: Exclude<TurnStatus, "inProgress"> | null;
  failureCategory: TurnFailureCategory | null;
  retryable: boolean;
  messages: ThreadHistoryMessage[];
  activities: ThreadHistoryActivity[];
}

interface CorrelatedEvent {
  generation: number;
  threadId: string;
  turnId: string;
}

export type ThreadStreamEvent =
  | (CorrelatedEvent & { type: "turn_started" })
  | (CorrelatedEvent & {
      type: "item_started";
      itemId: string;
      kind: SafeItemKind;
      label: string;
    })
  | (CorrelatedEvent & {
      type: "message_delta";
      itemId: string;
      text: string;
    })
  | (CorrelatedEvent & {
      type: "item_completed";
      itemId: string;
      kind: SafeItemKind;
      text: string | null;
    })
  | (CorrelatedEvent & {
      type: "turn_problem";
      retrying: boolean;
    })
  | (CorrelatedEvent & {
      type: "turn_terminal";
      status: Exclude<TurnStatus, "inProgress">;
      failureCategory?: TurnFailureCategory | null;
    })
  | (CorrelatedEvent & { type: "connection_uncertain" });

export interface ThreadStreamProjectorOptions {
  experimentalApiNegotiated: true;
  generation: number;
  threadId: string;
  allowedMcpServer: string;
  allowedMcpTools: ReadonlySet<string>;
  allowedDynamicNamespace?: string;
  allowedDynamicTools?: ReadonlySet<string>;
}

interface ItemState {
  type: string;
  kind: SafeItemKind;
  completed: boolean;
  text: string;
}

interface ActiveTurn {
  id: string;
  terminal: Exclude<TurnStatus, "inProgress"> | "uncertain" | undefined;
  interruptRequested: boolean;
  items: Map<string, ItemState>;
}

const forbiddenNotificationMethods = new Set([
  "command/exec/outputDelta",
  "command/execution/outputDelta",
  "fileChange/outputDelta",
  "fileChange/patch/updated",
  "process/outputDelta",
  "process/exited",
  "terminal/interaction",
  "turn/diff/updated",
]);

function safeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CodexThreadProtocolError("configuration");
  }
  return value;
}

function redactText(value: unknown, maximum = MAX_DELTA_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  return value
    .replace(/\\\\[^\s\\/]+[\\/][^\r\n]*/gu, "[private path]")
    .replace(/[A-Za-z]:[\\/][^\r\n\t]*/gu, "[private path]")
    .replace(
      /\/(?:Users|home|tmp|var|private|mnt)\/[^\r\n\t ]*/gu,
      "[private path]",
    )
    .replace(
      /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9._-]{12,})\b/gu,
      "[credential]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[private email]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function exactHistoryRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !threadProtocolInternals.record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  return value;
}

function historyCursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  return value;
}

function historyPage(value: unknown): ThreadTurnsListResponse {
  if (
    !threadProtocolInternals.record(value) ||
    Object.keys(value).some(
      (key) => !["data", "nextCursor", "backwardsCursor"].includes(key),
    ) ||
    !Object.hasOwn(value, "data")
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  const page = value;
  if (!Array.isArray(page.data) || page.data.length > MAX_HISTORY_TURNS) {
    throw new CodexThreadProtocolError("protocol");
  }
  const nextCursor = historyCursor(page.nextCursor ?? null),
    backwardsCursor = historyCursor(page.backwardsCursor ?? null);
  return {
    data: page.data,
    nextCursor,
    backwardsCursor,
  } as ThreadTurnsListResponse;
}

function historyTurn(value: unknown): Record<string, unknown> {
  if (!threadProtocolInternals.record(value)) {
    throw new CodexThreadProtocolError("protocol");
  }
  const allowed = [
    "id",
    "items",
    "itemsView",
    "status",
    "error",
    "startedAt",
    "completedAt",
    "durationMs",
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "items") ||
    !Object.hasOwn(value, "status") ||
    (value.itemsView !== undefined && value.itemsView !== "full")
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  return value;
}

function historicalUserText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content) || item.content.length > 33) {
    throw new CodexThreadProtocolError("protocol");
  }
  const text: string[] = [];
  for (const raw of item.content) {
    if (!threadProtocolInternals.record(raw)) {
      throw new CodexThreadProtocolError("protocol");
    }
    if (raw.type === "text") {
      if (
        Object.keys(raw).some(
          (key) => !["type", "text", "text_elements"].includes(key),
        ) ||
        !Object.hasOwn(raw, "text")
      ) {
        throw new CodexThreadProtocolError("protocol");
      }
      const textElements = raw.text_elements ?? [];
      if (!Array.isArray(textElements) || textElements.length !== 0) {
        throw new CodexThreadProtocolError("forbidden");
      }
      text.push(redactText(raw.text, MAX_MESSAGE_LENGTH));
    } else if (raw.type === "skill") {
      exactHistoryRecord(raw, ["type", "name", "path"]);
      threadProtocolInternals.identifier(raw.name, "protocol");
      if (
        typeof raw.path !== "string" ||
        raw.path.length === 0 ||
        raw.path.length > 4096 ||
        raw.path.includes("\0")
      ) {
        throw new CodexThreadProtocolError("protocol");
      }
    } else {
      throw new CodexThreadProtocolError("forbidden");
    }
  }
  const combined = text.join("\n");
  if (!combined || combined.length > MAX_MESSAGE_LENGTH) {
    throw new CodexThreadProtocolError("protocol");
  }
  return combined;
}

function historicalAgentText(item: Record<string, unknown>): string {
  if (item.text === "") return "";
  return redactText(item.text, MAX_MESSAGE_LENGTH);
}

function itemProjection(
  item: Record<string, unknown>,
  options: ThreadStreamProjectorOptions,
): { id: string; type: string; kind: SafeItemKind; label: string } {
  const id = threadProtocolInternals.identifier(item.id, "protocol");
  const type = threadProtocolInternals.identifier(item.type, "protocol");
  switch (type) {
    case "userMessage":
      return { id, type, kind: "message", label: "Your request" };
    case "hookPrompt":
    case "agentMessage":
      return {
        id,
        type,
        kind: type === "agentMessage" ? "message" : "activity",
        label:
          type === "agentMessage" ? "Codex response" : "Working on the edit",
      };
    case "plan":
    case "reasoning":
    case "contextCompaction":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { id, type, kind: "activity", label: "Working on the edit" };
    case "collabAgentToolCall":
      if (
        item.status !== "inProgress" &&
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "interrupted"
      ) {
        throw new CodexThreadProtocolError("protocol");
      }
      return { id, type, kind: "subagent", label: "Codex subagent" };
    case "subAgentActivity":
      return { id, type, kind: "subagent", label: "Codex subagent" };
    case "mcpToolCall": {
      const server = threadProtocolInternals.identifier(
        item.server,
        "protocol",
      );
      const tool = threadProtocolInternals.identifier(item.tool, "protocol");
      if (
        item.status !== "inProgress" &&
        item.status !== "completed" &&
        item.status !== "failed"
      ) {
        throw new CodexThreadProtocolError("protocol");
      }
      if (
        server !== options.allowedMcpServer ||
        !options.allowedMcpTools.has(tool)
      ) {
        throw new CodexThreadProtocolError("forbidden");
      }
      return tool === "project.get_summary" || tool === "timeline.get_summary"
        ? { id, type, kind: "activity", label: "Reading the project" }
        : { id, type, kind: "edit", label: "Applying an edit" };
    }
    case "dynamicToolCall": {
      const namespace = threadProtocolInternals.identifier(
        item.namespace,
        "protocol",
      );
      const tool = threadProtocolInternals.identifier(item.tool, "protocol");
      if (
        item.status !== "inProgress" &&
        item.status !== "completed" &&
        item.status !== "failed"
      )
        throw new CodexThreadProtocolError("protocol");
      if (
        namespace !== options.allowedDynamicNamespace ||
        !options.allowedDynamicTools?.has(tool)
      )
        throw new CodexThreadProtocolError("forbidden");
      return tool === "project_get_summary" || tool === "timeline_get_summary"
        ? { id, type, kind: "activity", label: "Reading the project" }
        : { id, type, kind: "edit", label: "Applying an edit" };
    }
    default:
      throw new CodexThreadProtocolError("forbidden");
  }
}

function historicalItemComplete(
  item: Record<string, unknown>,
  turnStatus: TurnStatus,
): boolean {
  if (turnStatus !== "inProgress") return true;
  if (item.type === "userMessage") return true;
  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "collabAgentToolCall"
  ) {
    return (
      item.status === "completed" ||
      item.status === "failed" ||
      item.status === "interrupted"
    );
  }
  return false;
}

/**
 * Converts raw notifications into a small renderer-safe stream. It never returns
 * protocol objects, paths, tool arguments, command output, reasoning, or errors.
 */
export class ThreadStreamProjector {
  private generation: number;
  private readonly threadId: string;
  private readonly options: ThreadStreamProjectorOptions;
  private active: ActiveTurn | undefined;
  private readonly terminals = new Map<
    string,
    Exclude<TurnStatus, "inProgress"> | "uncertain"
  >();
  private poisoned = false;

  constructor(options: ThreadStreamProjectorOptions) {
    if (options.experimentalApiNegotiated !== true) {
      throw new CodexThreadProtocolError("configuration");
    }
    this.generation = safeGeneration(options.generation);
    this.threadId = threadProtocolInternals.identifier(
      options.threadId,
      "configuration",
    );
    this.options = {
      ...options,
      allowedMcpServer: threadProtocolInternals.identifier(
        options.allowedMcpServer,
        "configuration",
      ),
      allowedMcpTools: new Set(options.allowedMcpTools),
      ...(options.allowedDynamicTools
        ? { allowedDynamicTools: new Set(options.allowedDynamicTools) }
        : {}),
    };
    for (const tool of this.options.allowedMcpTools) {
      threadProtocolInternals.identifier(tool, "configuration");
    }
    if (this.options.allowedDynamicTools) {
      threadProtocolInternals.identifier(
        this.options.allowedDynamicNamespace,
        "configuration",
      );
      for (const tool of this.options.allowedDynamicTools)
        threadProtocolInternals.identifier(tool, "configuration");
    }
  }

  currentGeneration(): number {
    return this.generation;
  }

  /** A new in-flight turn may not borrow a previously projected turn identity. */
  hasSeenTurn(turnId: string): boolean {
    return this.active?.id === turnId || this.terminals.has(turnId);
  }

  /** Restore one requested newest-first page before buffered live events flush. */
  restoreHistory(value: unknown): ThreadHistorySnapshot {
    this.assertHealthy();
    if (this.active || this.terminals.size) {
      throw new CodexThreadProtocolError("configuration");
    }
    try {
      const page = historyPage(value),
        turns = page.data,
        turnIds = new Set<string>(),
        itemIds = new Set<string>(),
        messages: ThreadHistoryMessage[] = [],
        activities: ThreadHistoryActivity[] = [];
      let activeTurnId: string | null = null,
        newestTurnId: string | null = null,
        terminalStatus: Exclude<TurnStatus, "inProgress"> | null = null,
        failureCategory: TurnFailureCategory | null = null,
        retryableUserItemId: string | null = null,
        itemCount = 0,
        textBytes = 0;
      for (let index = 0; index < turns.length; index++) {
        const raw = historyTurn(turns[index]),
          decoded = threadProtocolInternals.turn(raw);
        if (
          turnIds.has(decoded.id) ||
          (decoded.status === "inProgress" && index !== 0)
        ) {
          throw new CodexThreadProtocolError("protocol");
        }
        turnIds.add(decoded.id);
        if (index === 0) {
          newestTurnId = decoded.id;
          terminalStatus =
            decoded.status === "inProgress" ? null : decoded.status;
          failureCategory = threadProtocolInternals.turnFailureCategory(raw);
        }
        if (decoded.status === "inProgress") {
          if (activeTurnId !== null) {
            throw new CodexThreadProtocolError("protocol");
          }
          activeTurnId = decoded.id;
        }
        itemCount += (raw.items as unknown[]).length;
        if (itemCount > MAX_HISTORY_ITEMS) {
          throw new CodexThreadProtocolError("protocol");
        }
      }
      for (const rawTurn of [...turns].reverse()) {
        const decoded = threadProtocolInternals.turn(rawTurn);
        if (decoded.status === "inProgress") {
          this.active = {
            id: decoded.id,
            terminal: undefined,
            interruptRequested: false,
            items: new Map(),
          };
        } else {
          this.rememberTerminal(decoded.id, decoded.status);
        }
        for (const rawItem of rawTurn.items) {
          if (!threadProtocolInternals.record(rawItem)) {
            throw new CodexThreadProtocolError("protocol");
          }
          const projected = itemProjection(rawItem, this.options);
          if (itemIds.has(projected.id)) {
            throw new CodexThreadProtocolError("protocol");
          }
          itemIds.add(projected.id);
          const complete = historicalItemComplete(rawItem, decoded.status);
          let activeText = "";
          if (projected.type === "userMessage") {
            const text = historicalUserText(rawItem);
            activeText = text;
            textBytes += Buffer.byteLength(text);
            if (
              decoded.id === newestTurnId &&
              terminalStatus === "failed" &&
              text.trim().length > 0
            ) {
              retryableUserItemId = projected.id;
            }
            messages.push({
              itemId: projected.id,
              role: "user",
              text,
              complete: true,
            });
          } else if (projected.type === "agentMessage") {
            const text = historicalAgentText(rawItem);
            activeText = text;
            textBytes += Buffer.byteLength(text);
            messages.push({
              itemId: projected.id,
              role: "codex",
              text,
              complete,
            });
          } else {
            activities.push({
              itemId: projected.id,
              kind: projected.kind as Exclude<SafeItemKind, "message">,
              label: projected.label,
              complete,
            });
          }
          if (decoded.status === "inProgress") {
            this.active!.items.set(projected.id, {
              type: projected.type,
              kind: projected.kind,
              completed: complete,
              text: activeText,
            });
          }
          if (textBytes > MAX_HISTORY_TEXT_BYTES) {
            throw new CodexThreadProtocolError("protocol");
          }
        }
      }
      const boundedMessages = messages.slice(-200);
      return {
        activeTurnId,
        terminalStatus,
        failureCategory,
        retryable:
          retryableUserItemId !== null &&
          boundedMessages.some(
            (message) => message.itemId === retryableUserItemId,
          ),
        messages: boundedMessages,
        activities: activities.slice(-32),
      };
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  beginTurn(
    generation: number,
    turnId: string,
    status: TurnStatus = "inProgress",
  ): ThreadStreamEvent | null {
    if (generation !== this.generation) return null;
    this.assertHealthy();
    const id = threadProtocolInternals.identifier(turnId, "protocol");
    if (this.active && this.active.id !== id && !this.active.terminal) {
      return this.failProtocol();
    }
    if (this.terminals.has(id)) return null;
    if (!this.active || this.active.id !== id) {
      this.active = {
        id,
        terminal: undefined,
        interruptRequested: false,
        items: new Map(),
      };
    }
    if (status === "inProgress") return null;
    return this.complete(status);
  }

  markInterruptRequested(generation: number, turnId: string): void {
    if (generation !== this.generation) return;
    this.assertHealthy();
    const active = this.requireActive(turnId);
    if (!active.terminal) active.interruptRequested = true;
  }

  observe(
    generation: number,
    method: string,
    params: unknown,
  ): ThreadStreamEvent | null {
    if (generation !== this.generation) return null;
    this.assertHealthy();
    if (
      forbiddenNotificationMethods.has(method) ||
      method.includes("commandExecution") ||
      method.includes("fileChange") ||
      method.includes("terminal/") ||
      method.includes("process/")
    ) {
      this.poisoned = true;
      throw new CodexThreadProtocolError("forbidden");
    }
    if (
      method !== "turn/started" &&
      method !== "item/started" &&
      method !== "item/agentMessage/delta" &&
      method !== "item/completed" &&
      method !== "turn/completed" &&
      method !== "error"
    ) {
      return null;
    }
    if (!threadProtocolInternals.record(params)) return this.failProtocol();
    const threadId = threadProtocolInternals.identifier(
      params.threadId,
      "protocol",
    );
    if (threadId !== this.threadId) return this.failProtocol();

    if (method === "turn/started" || method === "turn/completed") {
      const turn = threadProtocolInternals.turn(params.turn);
      const terminal = this.terminals.get(turn.id);
      if (terminal !== undefined) {
        if (
          method === "turn/completed" &&
          terminal !== "uncertain" &&
          terminal !== turn.status
        ) {
          return this.failProtocol();
        }
        return null;
      }
      if (!this.active) {
        this.active = {
          id: turn.id,
          terminal: undefined,
          interruptRequested: false,
          items: new Map(),
        };
      } else if (this.active.id !== turn.id) {
        if (!this.active.terminal) return this.failProtocol();
        this.active = {
          id: turn.id,
          terminal: undefined,
          interruptRequested: false,
          items: new Map(),
        };
      }
      if (method === "turn/started") {
        if (turn.status !== "inProgress") return this.failProtocol();
        return this.event(turn.id, { type: "turn_started" });
      }
      if (turn.status === "inProgress") return this.failProtocol();
      return this.complete(
        turn.status,
        threadProtocolInternals.turnFailureCategory(params.turn),
      );
    }

    const turnId = threadProtocolInternals.identifier(
      params.turnId,
      "protocol",
    );
    if (this.terminals.has(turnId)) return null;
    const active = this.requireActive(turnId);
    if (active.terminal) return null;

    if (method === "error") {
      if (typeof params.willRetry !== "boolean") return this.failProtocol();
      return this.event(turnId, {
        type: "turn_problem",
        retrying: params.willRetry,
      });
    }

    if (method === "item/agentMessage/delta") {
      const itemId = threadProtocolInternals.identifier(
        params.itemId,
        "protocol",
      );
      const item = active.items.get(itemId);
      if (!item || item.type !== "agentMessage" || item.completed) {
        return this.failProtocol();
      }
      const text = redactText(params.delta);
      if (item.text.length + text.length > MAX_MESSAGE_LENGTH) {
        return this.failProtocol();
      }
      item.text += text;
      return this.event(turnId, {
        type: "message_delta",
        itemId,
        text,
      });
    }

    if (!threadProtocolInternals.record(params.item))
      return this.failProtocol();
    const timestamp =
      method === "item/started" ? params.startedAtMs : params.completedAtMs;
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) {
      return this.failProtocol();
    }
    let projected: ReturnType<typeof itemProjection>;
    try {
      projected = itemProjection(params.item, this.options);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    const existing = active.items.get(projected.id);
    if (method === "item/started") {
      if (existing) {
        if (existing.type !== projected.type) return this.failProtocol();
        return null;
      }
      active.items.set(projected.id, {
        type: projected.type,
        kind: projected.kind,
        completed: false,
        text: "",
      });
      // Main has already published the submitted user message. Its server echo
      // remains tracked for correlation, but is never a Codex response.
      if (projected.type === "userMessage") return null;
      return this.event(turnId, {
        type: "item_started",
        itemId: projected.id,
        kind: projected.kind,
        label: projected.label,
      });
    }
    if (!existing || existing.type !== projected.type) {
      return this.failProtocol();
    }
    if (projected.type === "userMessage") historicalUserText(params.item);
    const text =
      projected.type === "agentMessage"
        ? redactText(params.item.text, MAX_MESSAGE_LENGTH)
        : null;
    if (existing.completed) return null;
    existing.completed = true;
    if (projected.type === "userMessage") return null;
    return this.event(turnId, {
      type: "item_completed",
      itemId: projected.id,
      kind: projected.kind,
      text,
    });
  }

  disconnect(generation: number): ThreadStreamEvent | null {
    if (generation !== this.generation) return null;
    // Teardown must still mark an active turn uncertain after a policy failure.
    // Keep poisoned intact: disconnect is not permission to reuse this projector.
    if (!this.active || this.active.terminal) return null;
    this.active.terminal = "uncertain";
    this.rememberTerminal(this.active.id, "uncertain");
    return this.event(this.active.id, { type: "connection_uncertain" });
  }

  advanceGeneration(nextGeneration: number): ThreadStreamEvent | null {
    const next = safeGeneration(nextGeneration);
    if (next <= this.generation) {
      throw new CodexThreadProtocolError("configuration");
    }
    const uncertainty = this.disconnect(this.generation);
    this.generation = next;
    this.active = undefined;
    return uncertainty;
  }

  private complete(
    status: Exclude<TurnStatus, "inProgress">,
    failureCategory: TurnFailureCategory | null = null,
  ): ThreadStreamEvent | null {
    if (!this.active || this.active.terminal) return null;
    this.active.terminal = status;
    this.rememberTerminal(this.active.id, status);
    return this.event(this.active.id, {
      type: "turn_terminal",
      status,
      ...(failureCategory ? { failureCategory } : {}),
    });
  }

  private rememberTerminal(
    turnId: string,
    status: Exclude<TurnStatus, "inProgress"> | "uncertain",
  ): void {
    this.terminals.set(turnId, status);
    while (this.terminals.size > MAX_TRACKED_TERMINALS) {
      const oldest = this.terminals.keys().next().value;
      if (oldest === undefined) break;
      this.terminals.delete(oldest);
    }
  }

  private requireActive(turnId: unknown): ActiveTurn {
    const id = threadProtocolInternals.identifier(turnId, "protocol");
    if (!this.active || this.active.id !== id) return this.failProtocol();
    return this.active;
  }

  private event<T extends Omit<ThreadStreamEvent, keyof CorrelatedEvent>>(
    turnId: string,
    event: T,
  ): ThreadStreamEvent {
    return {
      generation: this.generation,
      threadId: this.threadId,
      turnId,
      ...event,
    } as ThreadStreamEvent;
  }

  private assertHealthy(): void {
    if (this.poisoned) throw new CodexThreadProtocolError("forbidden");
  }

  private failProtocol(): never {
    this.poisoned = true;
    throw new CodexThreadProtocolError("protocol");
  }
}

export const threadStreamInternals = { redactText };
