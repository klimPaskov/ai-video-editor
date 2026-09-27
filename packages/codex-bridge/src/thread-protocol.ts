import { isAbsolute } from "node:path";
import type { ThreadResumeParams as GeneratedThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import type { ThreadStartParams as GeneratedThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadUnsubscribeParams as GeneratedThreadUnsubscribeParams } from "./generated/v2/ThreadUnsubscribeParams.ts";
import type { ThreadUnsubscribeResponse as GeneratedThreadUnsubscribeResponse } from "./generated/v2/ThreadUnsubscribeResponse.ts";
import type { ThreadTurnsListParams as GeneratedThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.ts";
import type { TurnInterruptParams as GeneratedTurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse as GeneratedTurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.ts";
import type { TurnStartParams as GeneratedTurnStartParams } from "./generated/v2/TurnStartParams.ts";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_INSTRUCTION_LENGTH = 128 * 1024;
const reasoningPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export class CodexThreadProtocolError extends Error {
  readonly code: "configuration" | "protocol" | "forbidden";

  constructor(code: "configuration" | "protocol" | "forbidden") {
    const messages = {
      configuration: "The Codex thread configuration is invalid.",
      protocol: "The Codex thread response is unsupported.",
      forbidden: "Codex attempted an operation outside the editor boundary.",
    } as const;
    super(messages[code]);
    this.name = "CodexThreadProtocolError";
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function exact(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new CodexThreadProtocolError("configuration");
  }
  return value;
}

function identifier(
  value: unknown,
  code: "configuration" | "protocol",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CodexThreadProtocolError(code);
  }
  return value;
}

function instruction(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_INSTRUCTION_LENGTH ||
    value.includes("\0")
  ) {
    throw new CodexThreadProtocolError("configuration");
  }
  return value;
}

export interface ExperimentalInitializeRequest {
  clientInfo: {
    name: "codex_video_edit";
    title: "codex-video-edit";
    version: string;
  };
  capabilities: {
    experimentalApi: true;
    requestAttestation: false;
    mcpServerOpenaiFormElicitation: false;
    optOutNotificationMethods: [];
  };
}

/**
 * Application-owned initialize payload. The official pinned stable generated
 * schema contains this capability; live experimental acceptance is a separate gate.
 */
export function buildExperimentalInitialize(
  applicationVersion: string,
): ExperimentalInitializeRequest {
  const version = identifier(applicationVersion, "configuration");
  return {
    clientInfo: {
      name: "codex_video_edit",
      title: "codex-video-edit",
      version,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
      optOutNotificationMethods: [],
    },
  };
}

export interface ThreadRuntimePolicy {
  /** Canonical application-owned context directory. */
  cwd: string;
  /** A model ID returned by the connected runtime. */
  model: string;
  /** A reasoning value returned for the selected runtime model. */
  effort: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

function validatePolicy(policy: ThreadRuntimePolicy): ThreadRuntimePolicy {
  exact(policy, [
    "cwd",
    "model",
    "effort",
    "baseInstructions",
    "developerInstructions",
  ]);
  if (
    !isAbsolute(policy.cwd) ||
    policy.cwd.includes("\0") ||
    policy.cwd.length > 4096
  ) {
    throw new CodexThreadProtocolError("configuration");
  }
  if (!reasoningPattern.test(policy.effort)) {
    throw new CodexThreadProtocolError("configuration");
  }
  const baseInstructions = instruction(policy.baseInstructions);
  const developerInstructions = instruction(policy.developerInstructions);
  return {
    cwd: policy.cwd,
    model: identifier(policy.model, "configuration"),
    effort: policy.effort,
    ...(baseInstructions === undefined ? {} : { baseInstructions }),
    ...(developerInstructions === undefined ? {} : { developerInstructions }),
  };
}

export const CODEX_VIDEO_EDIT_V2_AGENT_NAMESPACE = "codex_video_edit_agents";

type CodeModeNamespace =
  | "mcp__codex_apps"
  | "multi_agent_v1"
  | typeof CODEX_VIDEO_EDIT_V2_AGENT_NAMESPACE
  | "skills"
  | "functions"
  | "image_gen";

export type ThreadToolRoute = "mcp" | "dynamic";
export type NativeSubagentProtocol = "disabled" | "v1" | "v2";

export interface ThreadFeaturePolicy {
  route: ThreadToolRoute;
  nativeSubagentProtocol: NativeSubagentProtocol;
  nativeSubagentModel?: string;
  nativeSubagentReasoning?: string;
}

function codeModeExclusions(
  nativeSubagentProtocol: NativeSubagentProtocol,
): CodeModeNamespace[] {
  if (nativeSubagentProtocol === "v1")
    return ["mcp__codex_apps", "skills", "functions", "image_gen"];
  if (nativeSubagentProtocol === "v2")
    return [
      "mcp__codex_apps",
      "multi_agent_v1",
      "skills",
      "functions",
      "image_gen",
    ];
  return [
    "mcp__codex_apps",
    "multi_agent_v1",
    CODEX_VIDEO_EDIT_V2_AGENT_NAMESPACE,
    "skills",
    "functions",
    "image_gen",
  ];
}

const defaultThreadFeaturePolicy: ThreadFeaturePolicy = {
  route: "mcp",
  nativeSubagentProtocol: "disabled",
};

function validatedFeaturePolicy(
  supplied: ThreadFeaturePolicy = defaultThreadFeaturePolicy,
): ThreadFeaturePolicy {
  const hasChildModel = supplied.nativeSubagentModel !== undefined;
  const hasChildReasoning = supplied.nativeSubagentReasoning !== undefined;
  if (
    (supplied.route !== "mcp" && supplied.route !== "dynamic") ||
    !["disabled", "v1", "v2"].includes(supplied.nativeSubagentProtocol) ||
    (supplied.nativeSubagentProtocol !== "disabled" &&
      supplied.route !== "dynamic") ||
    (supplied.nativeSubagentProtocol !== "disabled" &&
      (!hasChildModel ||
        !hasChildReasoning ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(
          supplied.nativeSubagentModel ?? "",
        ) ||
        !reasoningPattern.test(supplied.nativeSubagentReasoning ?? ""))) ||
    (supplied.nativeSubagentProtocol === "disabled" &&
      (hasChildModel || hasChildReasoning))
  ) {
    throw new CodexThreadProtocolError("configuration");
  }
  return supplied;
}

function threadFeatures(policy: ThreadFeaturePolicy) {
  const codeModeOnly = policy.route === "dynamic";
  const nativeV2 = policy.nativeSubagentProtocol === "v2";
  return {
    api_key_model_discovery: false,
    apps: false,
    auth_elicitation: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    chronicle: false,
    code_mode_only: codeModeOnly,
    code_mode: {
      ...(codeModeOnly ? { enabled: true } : {}),
      excluded_tool_namespaces: codeModeExclusions(
        policy.nativeSubagentProtocol,
      ),
      ...(policy.nativeSubagentProtocol === "v2"
        ? {
            direct_only_tool_namespaces: [CODEX_VIDEO_EDIT_V2_AGENT_NAMESPACE],
          }
        : {}),
    },
    code_mode_host: {
      ...(codeModeOnly ? { enabled: true } : {}),
      disable_in_process_fallback: true,
    },
    codex_apps_mcp_2026_07_28: false,
    codex_git_commit: false,
    codex_hooks: false,
    computer_use: false,
    connectors: false,
    default_mode_request_user_input: false,
    deferred_executor: false,
    enable_mcp_apps: false,
    exec_permission_approvals: false,
    external_agent_memory_import: false,
    goals: false,
    hooks: false,
    image_generation: false,
    imagegenext: false,
    in_app_browser: false,
    mcp_oauth_refresh_coordination: false,
    memories: false,
    memory_tool: false,
    multi_agent: policy.nativeSubagentProtocol === "v1",
    multi_agent_v2: nativeV2
      ? {
          enabled: true,
          // The root thread occupies one slot, so two permits exactly one child.
          max_concurrent_threads_per_session: 2,
          min_wait_timeout_ms: 1_000,
          default_wait_timeout_ms: 10_000,
          max_wait_timeout_ms: 30_000,
          subagent_developer_instructions:
            "Read-only project helper. Use only the path-free project and timeline summary JSON supplied in your task message. Do not infer missing state or ask for other access. Never edit the draft, access files, use services, or spawn another child.",
          tool_namespace: "codex_video_edit_agents",
          expose_spawn_agent_model_overrides: false,
          wait_agent_enabled: true,
          non_code_mode_only: false,
        }
      : false,
    plugins: false,
    plugin_sharing: false,
    recommended_plugins: false,
    remote_control: false,
    remote_plugin: false,
    request_permissions_tool: false,
    request_rule: false,
    search_tool: false,
    shell_tool: false,
    sleep_tool: false,
    token_budget: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    standalone_web_search: false,
    tool_call_mcp_elicitation: false,
    tool_suggest: false,
    view_image: false,
    web_search_cached: false,
    web_search_request: false,
  } as const;
}

export interface ThreadStartRequest {
  model: string;
  modelProvider: "openai";
  cwd: string;
  runtimeWorkspaceRoots: [];
  approvalPolicy: "never";
  approvalsReviewer: "user";
  sandbox: "read-only";
  config: {
    forced_login_method: "chatgpt";
    model_provider: "openai";
    apps: {
      _default: {
        enabled: false;
        destructive_enabled: false;
        open_world_enabled: false;
      };
    };
    tools: {
      update_plan: { enabled: false };
      experimental_request_user_input: { enabled: false };
    };
    agents: {
      enabled: boolean;
      max_depth?: 1;
      default_subagent_model?: string;
      default_subagent_reasoning_effort?: string;
    };
    project_root_markers: [];
    features: ReturnType<typeof threadFeatures>;
    web_search: "disabled";
  };
  ephemeral: false;
  environments: [];
  selectedCapabilityRoots: [];
  experimentalRawEvents: false;
  baseInstructions?: string;
  developerInstructions?: string;
}

export function buildThreadStartRequest(
  suppliedPolicy: ThreadRuntimePolicy,
  suppliedFeaturePolicy: ThreadFeaturePolicy = defaultThreadFeaturePolicy,
): ThreadStartRequest {
  const policy = validatePolicy(suppliedPolicy);
  const featurePolicy = validatedFeaturePolicy(suppliedFeaturePolicy);
  const request: ThreadStartRequest = {
    model: policy.model,
    modelProvider: "openai",
    cwd: policy.cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: {
      forced_login_method: "chatgpt",
      model_provider: "openai",
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
      tools: {
        update_plan: { enabled: false },
        experimental_request_user_input: { enabled: false },
      },
      agents:
        featurePolicy.nativeSubagentProtocol === "v1"
          ? {
              enabled: true,
              max_depth: 1,
              default_subagent_model: featurePolicy.nativeSubagentModel!,
              default_subagent_reasoning_effort:
                featurePolicy.nativeSubagentReasoning!,
            }
          : featurePolicy.nativeSubagentProtocol === "v2"
            ? {
                enabled: true,
                max_depth: 1,
                default_subagent_model: featurePolicy.nativeSubagentModel!,
                default_subagent_reasoning_effort:
                  featurePolicy.nativeSubagentReasoning!,
              }
            : { enabled: false },
      project_root_markers: [],
      features: threadFeatures(featurePolicy),
      web_search: "disabled",
    },
    ephemeral: false,
    environments: [],
    selectedCapabilityRoots: [],
    experimentalRawEvents: false,
    ...(policy.baseInstructions === undefined
      ? {}
      : { baseInstructions: policy.baseInstructions }),
    ...(policy.developerInstructions === undefined
      ? {}
      : { developerInstructions: policy.developerInstructions }),
  };
  return request satisfies GeneratedThreadStartParams;
}

export interface ThreadResumeRequest {
  threadId: string;
  model: string;
  modelProvider: "openai";
  cwd: string;
  runtimeWorkspaceRoots: [];
  approvalPolicy: "never";
  approvalsReviewer: "user";
  sandbox: "read-only";
  config: ThreadStartRequest["config"];
  excludeTurns: true;
  initialTurnsPage: {
    limit: 100;
    sortDirection: "desc";
    itemsView: "full";
  };
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ThreadTurnsListRequest {
  threadId: string;
  limit: 100;
  sortDirection: "desc";
  itemsView: "full";
}

/** Resume omits start-only environments and capability roots. */
export function buildThreadResumeRequest(
  trustedThreadId: string,
  suppliedPolicy: ThreadRuntimePolicy,
  suppliedFeaturePolicy: ThreadFeaturePolicy = defaultThreadFeaturePolicy,
): ThreadResumeRequest {
  const policy = validatePolicy(suppliedPolicy);
  const featurePolicy = validatedFeaturePolicy(suppliedFeaturePolicy);
  const request: ThreadResumeRequest = {
    threadId: identifier(trustedThreadId, "configuration"),
    model: policy.model,
    modelProvider: "openai",
    cwd: policy.cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: {
      forced_login_method: "chatgpt",
      model_provider: "openai",
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
      tools: {
        update_plan: { enabled: false },
        experimental_request_user_input: { enabled: false },
      },
      agents:
        featurePolicy.nativeSubagentProtocol === "v1"
          ? {
              enabled: true,
              max_depth: 1,
              default_subagent_model: featurePolicy.nativeSubagentModel!,
              default_subagent_reasoning_effort:
                featurePolicy.nativeSubagentReasoning!,
            }
          : featurePolicy.nativeSubagentProtocol === "v2"
            ? {
                enabled: true,
                max_depth: 1,
                default_subagent_model: featurePolicy.nativeSubagentModel!,
                default_subagent_reasoning_effort:
                  featurePolicy.nativeSubagentReasoning!,
              }
            : { enabled: false },
      project_root_markers: [],
      features: threadFeatures(featurePolicy),
      web_search: "disabled",
    },
    excludeTurns: true,
    initialTurnsPage: {
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    },
    ...(policy.baseInstructions === undefined
      ? {}
      : { baseInstructions: policy.baseInstructions }),
    ...(policy.developerInstructions === undefined
      ? {}
      : { developerInstructions: policy.developerInstructions }),
  };
  return request satisfies GeneratedThreadResumeParams;
}

export function buildThreadTurnsListRequest(
  trustedThreadId: string,
): ThreadTurnsListRequest {
  const request: ThreadTurnsListRequest = {
    threadId: identifier(trustedThreadId, "configuration"),
    limit: 100,
    sortDirection: "desc",
    itemsView: "full",
  };
  return request satisfies GeneratedThreadTurnsListParams;
}

/** The pinned response permits a null inline page; callers then use the list fallback. */
export function decodeThreadResumeHistoryPage(value: unknown): unknown | null {
  if (!record(value)) throw new CodexThreadProtocolError("protocol");
  return value.initialTurnsPage ?? null;
}

export interface TurnTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface TurnSkillInput {
  type: "skill";
  name: string;
  /** Main-owned runtime skill path. Never renderer supplied or projected back. */
  path: string;
}

export interface TurnStartRequest {
  threadId: string;
  clientUserMessageId: string;
  input: Array<TurnTextInput | TurnSkillInput>;
  environments: [];
  cwd: string;
  runtimeWorkspaceRoots: [];
  approvalPolicy: "never";
  approvalsReviewer: "user";
  sandboxPolicy: { type: "readOnly"; networkAccess: false };
  model: string;
  effort: string;
}

export interface TurnStartInput {
  text: string;
  skills?: ReadonlyArray<{ name: string; path: string }>;
}

export function buildTurnStartRequest(
  trustedThreadId: string,
  trustedClientMessageId: string,
  supplied: TurnStartInput,
  suppliedPolicy: ThreadRuntimePolicy,
): TurnStartRequest {
  const policy = validatePolicy(suppliedPolicy);
  exact(supplied, ["text", "skills"]);
  if (
    typeof supplied.text !== "string" ||
    supplied.text.trim().length === 0 ||
    supplied.text.length > MAX_INSTRUCTION_LENGTH ||
    supplied.text.includes("\0") ||
    (supplied.skills?.length ?? 0) > 32
  ) {
    throw new CodexThreadProtocolError("configuration");
  }
  const input: Array<TurnTextInput | TurnSkillInput> = [
    { type: "text", text: supplied.text, text_elements: [] },
  ];
  for (const skill of supplied.skills ?? []) {
    exact(skill, ["name", "path"]);
    if (
      !isAbsolute(skill.path) ||
      skill.path.includes("\0") ||
      skill.path.length > 4096
    ) {
      throw new CodexThreadProtocolError("configuration");
    }
    input.push({
      type: "skill",
      name: identifier(skill.name, "configuration"),
      path: skill.path,
    });
  }
  const request: TurnStartRequest = {
    threadId: identifier(trustedThreadId, "configuration"),
    clientUserMessageId: identifier(trustedClientMessageId, "configuration"),
    input,
    environments: [],
    cwd: policy.cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    model: policy.model,
    effort: policy.effort,
  };
  return request satisfies GeneratedTurnStartParams;
}

export interface TurnInterruptRequest {
  threadId: string;
  turnId: string;
}

export interface ThreadUnsubscribeRequest {
  threadId: string;
}

export function buildThreadUnsubscribeRequest(
  trustedThreadId: string,
): ThreadUnsubscribeRequest {
  const request: ThreadUnsubscribeRequest = {
    threadId: identifier(trustedThreadId, "configuration"),
  };
  return request satisfies GeneratedThreadUnsubscribeParams;
}

export function decodeThreadUnsubscribe(
  value: unknown,
): asserts value is GeneratedThreadUnsubscribeResponse {
  if (
    !record(value) ||
    Object.keys(value).length !== 1 ||
    !["notLoaded", "notSubscribed", "unsubscribed"].includes(
      typeof value.status === "string" ? value.status : "",
    )
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
}

export function buildTurnInterruptRequest(
  trustedThreadId: string,
  trustedTurnId: string,
): TurnInterruptRequest {
  const request: TurnInterruptRequest = {
    threadId: identifier(trustedThreadId, "configuration"),
    turnId: identifier(trustedTurnId, "configuration"),
  };
  return request satisfies GeneratedTurnInterruptParams;
}

export interface ThreadSession {
  threadId: string;
  active: boolean | null;
}

function threadActiveState(thread: Record<string, unknown>): boolean | null {
  if (thread.status === undefined) return null;
  if (!record(thread.status)) {
    throw new CodexThreadProtocolError("protocol");
  }
  const status = thread.status;
  if (status.type === "active") {
    if (
      Object.keys(status).length !== 2 ||
      !Object.hasOwn(status, "activeFlags") ||
      !Array.isArray(status.activeFlags) ||
      status.activeFlags.some(
        (flag) => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput",
      )
    ) {
      throw new CodexThreadProtocolError("protocol");
    }
    if (status.activeFlags.length) {
      throw new CodexThreadProtocolError("forbidden");
    }
    return true;
  }
  if (status.type !== "idle" || Object.keys(status).length !== 1) {
    throw new CodexThreadProtocolError("protocol");
  }
  return false;
}

export function decodeThreadSession(
  value: unknown,
  expectedPolicy: ThreadRuntimePolicy,
  requireThreadStatus = false,
): ThreadSession {
  const policy = validatePolicy(expectedPolicy);
  if (!record(value) || !record(value.thread)) {
    throw new CodexThreadProtocolError("protocol");
  }
  const thread = value.thread;
  if (requireThreadStatus && thread.status === undefined) {
    throw new CodexThreadProtocolError("protocol");
  }
  if (
    value.model !== policy.model ||
    value.modelProvider !== "openai" ||
    value.cwd !== policy.cwd ||
    value.approvalPolicy !== "never" ||
    value.approvalsReviewer !== "user" ||
    !record(value.sandbox) ||
    Object.keys(value.sandbox).some(
      (key) => key !== "type" && key !== "networkAccess",
    ) ||
    value.sandbox.type !== "readOnly" ||
    value.sandbox.networkAccess !== false ||
    thread.ephemeral !== false ||
    (thread.parentThreadId ?? null) !== null ||
    (value.runtimeWorkspaceRoots !== undefined &&
      (!Array.isArray(value.runtimeWorkspaceRoots) ||
        value.runtimeWorkspaceRoots.length !== 0)) ||
    (value.instructionSources !== undefined &&
      (!Array.isArray(value.instructionSources) ||
        value.instructionSources.length !== 0)) ||
    (value.activePermissionProfile ?? null) !== null ||
    (value.multiAgentMode !== undefined &&
      value.multiAgentMode !== "explicitRequestOnly") ||
    (value.reasoningEffort !== undefined &&
      value.reasoningEffort !== null &&
      value.reasoningEffort !== policy.effort)
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  return {
    threadId: identifier(thread.id, "protocol"),
    active: threadActiveState(thread),
  };
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type TurnFailureCategory =
  "authentication" | "rate_limit" | "service" | "other";

function turnFailureCategory(value: unknown): TurnFailureCategory | null {
  if (!record(value) || value.status !== "failed") return null;
  if (value.error === null || value.error === undefined) return null;
  if (!record(value.error)) return "other";
  const info = value.error.codexErrorInfo;
  if (info === "unauthorized") return "authentication";
  if (info === "rateLimitExceeded" || info === "usageLimitExceeded")
    return "rate_limit";
  if (info === "serverOverloaded" || info === "internalServerError")
    return "service";
  if (!record(info)) return "other";
  const names = Object.keys(info);
  if (names.length !== 1) return "other";
  const [name] = names;
  const details = name ? info[name] : undefined;
  if (
    !record(details) ||
    Object.keys(details).some((key) => key !== "httpStatusCode")
  ) {
    return "other";
  }
  const status = Number.isSafeInteger(details.httpStatusCode)
    ? (details.httpStatusCode as number)
    : null;
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "other";
  if (
    name === "httpConnectionFailed" ||
    name === "responseStreamConnectionFailed" ||
    name === "responseStreamDisconnected" ||
    name === "responseTooManyFailedAttempts"
  ) {
    return "service";
  }
  return "other";
}

function turn(value: unknown): { id: string; status: TurnStatus } {
  if (!record(value)) throw new CodexThreadProtocolError("protocol");
  const status = value.status;
  if (
    status !== "completed" &&
    status !== "interrupted" &&
    status !== "failed" &&
    status !== "inProgress"
  ) {
    throw new CodexThreadProtocolError("protocol");
  }
  if (!Array.isArray(value.items)) {
    throw new CodexThreadProtocolError("protocol");
  }
  return { id: identifier(value.id, "protocol"), status };
}

export function decodeTurnStart(value: unknown): {
  turnId: string;
  status: TurnStatus;
} {
  if (!record(value)) throw new CodexThreadProtocolError("protocol");
  const decoded = turn(value.turn);
  return { turnId: decoded.id, status: decoded.status };
}

export function decodeTurnInterrupt(
  value: unknown,
): asserts value is GeneratedTurnInterruptResponse {
  if (!record(value) || Object.keys(value).length !== 0) {
    throw new CodexThreadProtocolError("protocol");
  }
}

export const threadProtocolInternals = {
  record,
  identifier,
  turn,
  turnFailureCategory,
};
