import { CodexTransportError } from "./transport.ts";
import type { ServerRequest } from "./transport.ts";
import { CodexThreadProtocolError } from "./thread-protocol.ts";
import type {
  NativeSubagentProtocol,
  ThreadRuntimePolicy,
  TurnStartInput,
} from "./thread-protocol.ts";
import type { ProjectThreadRegistry } from "./thread-registry.ts";
import { ProjectThreadRuntime } from "./thread-runtime.ts";
import type {
  ThreadHistorySnapshot,
  ThreadStreamEvent,
} from "./thread-stream.ts";
import {
  CODEX_EDITOR_NAMESPACE,
  decodeOwnedDynamicToolCall,
  invokeOwnedDynamicTool,
  nativeChildReadOnlyToolNames,
  ownedDynamicToolWireNames,
} from "./dynamic-tools.ts";
import type { DynamicToolAccess } from "./dynamic-tools.ts";
import {
  CodexVideoEditToolError,
  type CodexVideoEditToolName,
} from "../../codex-tools/src/service.ts";

const MAX_BUFFERED_NOTIFICATIONS = 64;
const MAX_BUFFERED_NOTIFICATION_BYTES = 256 * 1024;
const MAX_NATIVE_CHILDREN = 32;

export interface ThreadRpc {
  request(method: string, params: unknown): Promise<unknown>;
}

export interface CodexProjectThreadClientOptions {
  rpc: ThreadRpc;
  generation: number;
  projectId: string;
  policy: ThreadRuntimePolicy;
  registry: ProjectThreadRegistry;
  allowedMcpServer: string;
  allowedMcpTools: ReadonlySet<string>;
  nativeSubagentProtocol?: NativeSubagentProtocol;
  nativeSubagentModel?: string;
  nativeSubagentReasoning?: string;
  dynamicToolInvoker?: (
    name: CodexVideoEditToolName,
    input: unknown,
    access: DynamicToolAccess,
  ) => Promise<unknown>;
  onEvent?: (event: ThreadStreamEvent) => void;
  onHistory?: (history: ThreadHistorySnapshot) => void;
  onPolicyViolation?: () => void;
  clientMessageId?: () => string;
}

type BufferedNotification = { method: string; params: unknown };

type NativeChildState = {
  parentTurnId: string;
  spawnSeen: boolean;
  activeTurnId?: string;
  complete: boolean;
};

// A child can start before the parent's spawn item carries its receiver ID.
// This bounded cache is only a candidate; it grants no tool access until a
// server-owned parent spawn correlates the same thread and turn.
type PendingNativeChildTurn = {
  parentTurnId: string;
  activeTurnId?: string;
  complete: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function bufferedSize(method: string, params: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify({ method, params }));
  } catch {
    throw new CodexThreadProtocolError("protocol");
  }
}

/**
 * Typed project conversation client. It serializes lifecycle RPCs and buffers the
 * notifications that can race their responses before handing them to the reducer.
 */
export class CodexProjectThreadClient {
  private readonly options: CodexProjectThreadClientOptions;
  private readonly runtime: ProjectThreadRuntime;
  private opened = false;
  private inFlight = false;
  private quarantined = false;
  private pending: BufferedNotification[] = [];
  private readonly nativeChildren = new Map<string, NativeChildState>();
  private readonly pendingNativeChildTurns = new Map<
    string,
    PendingNativeChildTurn
  >();

  constructor(options: CodexProjectThreadClientOptions) {
    this.options = {
      ...options,
      policy: { ...options.policy },
      allowedMcpTools: new Set(options.allowedMcpTools),
    };
    this.runtime = new ProjectThreadRuntime({
      experimentalApiNegotiated: true,
      generation: options.generation,
      projectId: options.projectId,
      policy: options.policy,
      registry: options.registry,
      allowedMcpServer: options.allowedMcpServer,
      allowedMcpTools: options.allowedMcpTools,
      ...(options.dynamicToolInvoker
        ? {
            newThreadToolRoute: "dynamic",
            nativeSubagentProtocol:
              options.nativeSubagentProtocol ?? "disabled",
            ...(options.nativeSubagentProtocol !== undefined &&
            options.nativeSubagentProtocol !== "disabled"
              ? {
                  nativeSubagentModel: options.nativeSubagentModel!,
                  nativeSubagentReasoning: options.nativeSubagentReasoning!,
                }
              : {}),
            allowedDynamicNamespace: CODEX_EDITOR_NAMESPACE,
            allowedDynamicTools: ownedDynamicToolWireNames(),
          }
        : {}),
      ...(options.clientMessageId
        ? { clientMessageId: options.clientMessageId }
        : {}),
    });
  }

  async open(): Promise<void> {
    this.begin(false);
    try {
      const request = await this.runtime.openThreadRequest();
      const response = await this.options.rpc.request(
        request.method,
        request.params,
      );
      const resumed = request.method === "thread/resume",
        inlineHistory = await this.runtime.acceptThreadResponse(
          response,
          resumed,
        );
      if (resumed) {
        const inline = inlineHistory !== null;
        const history = this.runtime.acceptHistoryPage(
          inlineHistory ??
            (await this.options.rpc.request(
              "thread/turns/list",
              await this.runtime.historyRequest(),
            )),
          inline,
        );
        this.options.onHistory?.(structuredClone(history));
      }
      this.opened = true;
      this.flush();
    } catch (error) {
      this.pending = [];
      if (error instanceof CodexThreadProtocolError) this.quarantine();
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async startTurn(input: TurnStartInput): Promise<void> {
    this.begin(true);
    this.clearNativeChildren();
    let requestBuilt = false;
    try {
      const request = await this.runtime.turnStartRequest(input);
      this.runtime.markTurnStartSubmitted();
      requestBuilt = true;
      const response = await this.options.rpc.request("turn/start", request);
      this.emit(this.runtime.acceptTurnStartResponse(response));
      this.flush();
    } catch (error) {
      this.pending = [];
      if (
        error instanceof CodexThreadProtocolError &&
        error.code !== "configuration"
      )
        this.quarantine();
      if (
        requestBuilt &&
        error instanceof CodexTransportError &&
        error.code === "remote_error"
      ) {
        try {
          this.runtime.rejectTurnStart();
        } catch (conflict) {
          this.quarantine();
          this.emit(this.runtime.disconnect());
          this.opened = false;
          throw conflict;
        }
      } else if (requestBuilt) {
        this.emit(this.runtime.disconnect());
        this.opened = false;
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async interrupt(): Promise<void> {
    this.begin(true);
    let requestBuilt = false;
    try {
      const request = await this.runtime.interruptRequest();
      requestBuilt = true;
      const response = await this.options.rpc.request(
        "turn/interrupt",
        request,
      );
      this.runtime.acceptInterruptResponse(response);
      this.flush();
    } catch (error) {
      this.pending = [];
      if (
        requestBuilt &&
        (!(error instanceof CodexTransportError) ||
          error.code !== "remote_error")
      ) {
        this.emit(this.runtime.disconnect());
        this.opened = false;
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.quarantined || !this.opened) {
      this.pending = [];
      this.opened = false;
      return;
    }
    this.begin(true);
    try {
      const request = await this.runtime.unsubscribeRequest();
      const response = await this.options.rpc.request(
        "thread/unsubscribe",
        request,
      );
      this.runtime.acceptUnsubscribeResponse(response);
      this.pending = [];
      this.clearNativeChildren();
      this.opened = false;
    } finally {
      this.inFlight = false;
    }
  }

  activeThreadId(): string | undefined {
    return this.runtime.activeThreadId();
  }

  notification(method: string, params: unknown): void {
    if (this.quarantined) throw new CodexThreadProtocolError("forbidden");
    if (method === "thread/started") {
      // Parent spawn items, not thread broadcasts, authorize child lineage.
      return;
    }
    // Native child threads share this app-server transport. Their ordinary
    // stream belongs to the child, never to the active project projection.
    if (
      (method === "turn/started" ||
        method === "turn/completed" ||
        method === "item/started" ||
        method === "item/completed" ||
        method === "item/agentMessage/delta" ||
        method === "error") &&
      this.runtime.isOtherThreadNotification(params)
    ) {
      this.observeChildTurn(method, params);
      return;
    }
    if (this.inFlight) {
      if (
        this.pending.length >= MAX_BUFFERED_NOTIFICATIONS ||
        bufferedSize(method, params) > MAX_BUFFERED_NOTIFICATION_BYTES
      ) {
        this.quarantine();
        throw new CodexThreadProtocolError("protocol");
      }
      try {
        this.runtime.noteBufferedTurnNotification(method, params);
        this.runtime.noteBufferedParentSpawn(method, params);
        // Keep authoritative parent spawn lineage even when the App Server
        // streams it before the turn/start response resolves.
        this.observeParentSpawn(method, params);
      } catch (error) {
        this.quarantine();
        throw error;
      }
      this.pending.push({ method, params });
      return;
    }
    if (!this.opened) throw new CodexThreadProtocolError("configuration");
    const event = this.runtime.notification(method, params);
    this.observeParentSpawn(method, params);
    if (event?.type === "turn_terminal") this.clearNativeChildren();
    this.emit(event);
  }

  serverRequest(request: ServerRequest): unknown {
    if (this.quarantined || !this.opened || request.signal.aborted) {
      throw new CodexThreadProtocolError("forbidden");
    }
    const { method, params } = request;
    if (method === "item/tool/call") {
      if (
        !this.options.dynamicToolInvoker ||
        this.runtime.toolRoute() !== "dynamic"
      ) {
        this.quarantine();
        throw new CodexThreadProtocolError("forbidden");
      }
      try {
        const call = decodeOwnedDynamicToolCall(params);
        const parentThreadId = this.runtime.activeThreadId();
        const parentTurnId = this.runtime.notificationTurnId();
        if (!parentThreadId) {
          throw new CodexThreadProtocolError("forbidden");
        }
        let access: DynamicToolAccess = "project_editor";
        if (call.threadId === parentThreadId) {
          // A host edit cannot commit before the current turn ID is authoritative.
          this.runtime.assertActiveCorrelation(params, false, false);
        } else {
          if (!parentTurnId) throw new CodexThreadProtocolError("forbidden");
          const child = this.nativeChildren.get(call.threadId);
          if (
            !child ||
            child.parentTurnId !== parentTurnId ||
            !child.spawnSeen ||
            child.activeTurnId !== call.turnId ||
            child.complete
          ) {
            throw new CodexThreadProtocolError("forbidden");
          }
          access = "native_child_read_only";
          if (!nativeChildReadOnlyToolNames.has(call.name)) {
            return invokeOwnedDynamicTool(
              call,
              async () => {
                throw new CodexVideoEditToolError("tool_not_available");
              },
              access,
            );
          }
        }
        return invokeOwnedDynamicTool(call, (name, input) =>
          this.options.dynamicToolInvoker!(name, input, access),
        );
      } catch (error) {
        this.quarantine();
        throw error;
      }
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.runtime.assertActiveCorrelation(params, true);
      this.quarantine();
      return { decision: "decline" };
    }
    if (method === "mcpServer/elicitation/request") {
      if (
        !record(params) ||
        params.serverName !== this.options.allowedMcpServer
      ) {
        this.quarantine();
        throw new CodexThreadProtocolError("forbidden");
      }
      this.runtime.assertActiveCorrelation(
        { threadId: params.threadId, turnId: params.turnId },
        false,
      );
      this.quarantine();
      return { action: "cancel", content: null, _meta: null };
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      this.quarantine();
      return {
        decision: {
          denied: {
            rejection: "This editor does not allow command or file access.",
          },
        },
      };
    }
    this.quarantine();
    throw new CodexThreadProtocolError("forbidden");
  }

  disconnect(): void {
    this.pending = [];
    this.clearNativeChildren();
    this.inFlight = false;
    const opened = this.opened;
    this.opened = false;
    if (opened) {
      try {
        this.emit(this.runtime.disconnect());
      } catch {
        // Consumer notification failures cannot prevent teardown or enable reuse.
        this.quarantined = true;
      }
    }
  }

  private begin(requireOpen: boolean): void {
    if (
      this.quarantined ||
      this.inFlight ||
      (requireOpen ? !this.opened : this.opened)
    ) {
      throw new CodexThreadProtocolError("configuration");
    }
    this.inFlight = true;
    this.pending = [];
  }

  private flush(): void {
    while (this.pending.length) {
      const notification = this.pending.shift()!;
      const event = this.runtime.notification(
        notification.method,
        notification.params,
      );
      this.observeParentSpawn(notification.method, notification.params);
      if (event?.type === "turn_terminal") this.clearNativeChildren();
      this.emit(event);
    }
  }

  private observeParentSpawn(method: string, params: unknown): void {
    if (
      (method !== "item/started" && method !== "item/completed") ||
      !record(params) ||
      !record(params.item)
    ) {
      return;
    }
    const parentThreadId = this.runtime.activeThreadId();
    const parentTurnId = this.runtime.notificationTurnId();
    const item = params.item;
    const isParentItem = params.threadId === parentThreadId;
    const itemTurnId = params.turnId;
    const spawnStarted =
      method === "item/started" && item.status === "inProgress";
    const spawnCompleted =
      method === "item/completed" && item.status === "completed";
    if (
      !parentThreadId ||
      !parentTurnId ||
      !isParentItem ||
      itemTurnId !== parentTurnId
    ) {
      return;
    }
    const v1Spawn =
      item.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      item.senderThreadId === parentThreadId &&
      (spawnStarted || spawnCompleted) &&
      Array.isArray(item.receiverThreadIds) &&
      item.receiverThreadIds.length > 0 &&
      item.receiverThreadIds.length <= 8;
    const v2SpawnStarted =
      method === "item/started" &&
      item.type === "subAgentActivity" &&
      item.kind === "started";
    if (!v1Spawn && !v2SpawnStarted) return;
    const childIds = v1Spawn
      ? (item.receiverThreadIds as unknown[])
      : [item.agentThreadId];
    for (const childId of childIds) {
      if (
        typeof childId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(childId)
      ) {
        const existing = this.nativeChildren.get(childId);
        if (existing && existing.parentTurnId !== parentTurnId) continue;
        const childLimit = v2SpawnStarted ? 1 : MAX_NATIVE_CHILDREN;
        if (!existing && this.nativeChildren.size >= childLimit) continue;
        const child: NativeChildState = existing ?? {
          parentTurnId,
          spawnSeen: false,
          complete: false,
        };
        child.spawnSeen = true;
        child.complete = false;
        const pendingTurn = this.pendingNativeChildTurns.get(childId);
        if (pendingTurn?.parentTurnId === parentTurnId) {
          if (pendingTurn.activeTurnId !== undefined)
            child.activeTurnId = pendingTurn.activeTurnId;
          child.complete = pendingTurn.complete;
        }
        this.nativeChildren.set(childId, child);
        this.pendingNativeChildTurns.delete(childId);
      }
    }
  }

  private clearNativeChildren(): void {
    this.nativeChildren.clear();
    this.pendingNativeChildTurns.clear();
  }

  private observeChildTurn(method: string, params: unknown): void {
    if (method !== "turn/started" && method !== "turn/completed") return;
    if (!record(params)) return;
    const threadId = params.threadId;
    const parentTurnId = this.runtime.notificationTurnId();
    if (
      typeof threadId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(threadId)
    )
      return;
    const child = this.nativeChildren.get(threadId);
    const turn = params.turn;
    if (
      !record(turn) ||
      typeof turn.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(turn.id)
    ) {
      throw new CodexThreadProtocolError("protocol");
    }
    if (method === "turn/started") {
      if (turn.status !== "inProgress") {
        throw new CodexThreadProtocolError("protocol");
      }
      if (!child || !parentTurnId || child.parentTurnId !== parentTurnId) {
        if (!parentTurnId) return;
        const pending = this.pendingNativeChildTurns.get(threadId);
        if (
          (pending && pending.parentTurnId !== parentTurnId) ||
          (pending?.activeTurnId &&
            pending.activeTurnId !== turn.id &&
            !pending.complete)
        ) {
          throw new CodexThreadProtocolError("protocol");
        }
        if (
          !pending &&
          this.pendingNativeChildTurns.size >= MAX_NATIVE_CHILDREN
        )
          return;
        this.pendingNativeChildTurns.set(threadId, {
          parentTurnId,
          activeTurnId: turn.id,
          complete: false,
        });
        return;
      }
      if (child.activeTurnId && !child.complete) {
        throw new CodexThreadProtocolError("protocol");
      }
      child.activeTurnId = turn.id;
      child.complete = false;
      return;
    }
    if (method === "turn/completed" && turn.status !== "inProgress") {
      if (
        child &&
        parentTurnId &&
        child.parentTurnId === parentTurnId &&
        child.activeTurnId === turn.id
      ) {
        child.complete = true;
        return;
      }
      const pending = this.pendingNativeChildTurns.get(threadId);
      if (
        pending &&
        parentTurnId &&
        pending.parentTurnId === parentTurnId &&
        pending.activeTurnId === turn.id
      ) {
        pending.complete = true;
      }
    }
  }

  private emit(event: ThreadStreamEvent | null): void {
    if (event) this.options.onEvent?.(structuredClone(event));
  }

  private quarantine(): void {
    if (this.quarantined) return;
    this.quarantined = true;
    this.options.onPolicyViolation?.();
  }
}
