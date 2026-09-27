import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { GetAccountParams } from "./generated/v2/GetAccountParams.ts";
import type { ListMcpServerStatusParams } from "./generated/v2/ListMcpServerStatusParams.ts";
import type { ListMcpServerStatusResponse } from "./generated/v2/ListMcpServerStatusResponse.ts";
import type { ModelListParams } from "./generated/v2/ModelListParams.ts";
import type { SkillsListParams } from "./generated/v2/SkillsListParams.ts";
import type { DeviceLoginDetails } from "../../domain/src/codex-device-login.ts";
import { CodexAuthController, type AuthState } from "./auth.ts";
import {
  decodeAccount,
  decodeInitialization,
  decodeModels,
  decodeSkills,
  decodeRateLimits,
  validateRateLimitsUpdate,
  type AccountState,
  type ModelSummary,
  type SkillSummary,
  type RateLimitsSummary,
} from "./metadata.ts";
import { CodexStdioTransport, CodexTransportError } from "./transport.ts";
import { buildExperimentalInitialize } from "./thread-protocol.ts";
import type {
  NativeSubagentProtocol,
  TurnStartInput,
} from "./thread-protocol.ts";
import { ProjectThreadRegistry } from "./thread-registry.ts";
import { CodexProjectThreadClient } from "./thread-client.ts";
import type { DynamicToolAccess } from "./dynamic-tools.ts";
import type {
  ThreadHistorySnapshot,
  ThreadStreamEvent,
} from "./thread-stream.ts";
import { codexVideoEditToolNames } from "../../codex-tools/src/service.ts";
import { codexVideoEditMcpTools } from "../../codex-tools/src/mcp-tools.ts";
import type { CodexVideoEditToolName } from "../../codex-tools/src/service.ts";
import type { CodexMcpRuntime } from "../../codex-tools/src/broker.ts";

export const CODEX_VERSION = "0.155.1";
const execute = promisify(execFile);
const MAX_CONFIGURED_MCP_SERVERS = 64;
const MAX_MCP_SERVER_NAME_LENGTH = 128;
const environmentKeys = ["PATH", "SystemRoot", "WINDIR", "TMP", "TEMP"];
const fixedAppServerArguments = [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'model_provider="openai"',
  "-c",
  "apps._default.enabled=false",
  "-c",
  "apps._default.destructive_enabled=false",
  "-c",
  "apps._default.open_world_enabled=false",
  "-c",
  "tools.update_plan.enabled=false",
  "-c",
  "tools.experimental_request_user_input.enabled=false",
  "-c",
  "agents.enabled=false",
  "-c",
  'web_search="disabled"',
  "-c",
  "features.shell_tool=false",
  "-c",
  "-c",
  "features.sleep_tool=false",
  "-c",
  "features.deferred_executor=false",
  "-c",
  "features.token_budget=false",
  "-c",
  "features.view_image=false",
  "features.browser_use_external=false",
  "features.browser_use_full_cdp_access=false",
  "features.computer_use=false",
  "features.compaction_image_budget=false",
  "features.fast_mode=false",
  "features.guardian_approval=false",
  "features.in_app_browser=false",
  "features.in_app_chat=false",
  "features.in_app_dictation=false",
  "features.in_app_local_automation=false",
  "features.in_app_updates=false",
  "features.mentions_v2=false",
  "features.personality=false",
  "features.shell_snapshot=false",
  "features.unified_exec_tty=false",
  "features.workspace_dependencies=false",
  "-c",
  "features.api_key_model_discovery=false",
  "-c",
  "features.auth_elicitation=false",
  "-c",
  "features.chronicle=false",
  "-c",
  "features.default_mode_request_user_input=false",
  "-c",
  "features.exec_permission_approvals=false",
  "-c",
  "features.external_agent_memory_import=false",
  "-c",
  "features.goals=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.multi_agent_v2=false",
  "-c",
  'features.code_mode.excluded_tool_namespaces=["mcp__codex_apps","multi_agent_v1","skills","functions","image_gen"]',
  "-c",
  "features.code_mode_host.disable_in_process_fallback=true",
  "-c",
  "features.request_permissions_tool=false",
  "-c",
  "features.request_rule=false",
  "-c",
  "features.skill_mcp_dependency_install=false",
  "-c",
  "features.tool_call_mcp_elicitation=false",
  "-c",
  "features.mcp_oauth_refresh_coordination=false",
  "-c",
  "features.standalone_web_search=false",
  "-c",
  "features.web_search_cached=false",
  "-c",
  "features.web_search_request=false",
  "-c",
  "features.js_repl=false",
  "-c",
  "features.browser_use=false",
  "-c",
  "features.computer_use=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.connectors=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.plugin_sharing=false",
  "-c",
  "features.recommended_plugins=false",
  "-c",
  "features.tool_suggest=false",
  "-c",
  "features.remote_plugin=false",
  "-c",
  "features.image_generation=false",
  "-c",
  "project_root_markers=[]",
] as const;

export function buildCodexAppServerArguments(
  mcp?: CodexMcpRuntime,
  disabledMcpServers: readonly string[] = [],
): string[] {
  if (disabledMcpServers.length > MAX_CONFIGURED_MCP_SERVERS)
    throw new CodexTransportError("configuration");
  const args: string[] = [...fixedAppServerArguments];
  args.push("-c", "mcp_servers={}");
  const seenMcpServerNames = new Set<string>();
  for (const name of disabledMcpServers) {
    if (
      typeof name !== "string" ||
      name.length > MAX_MCP_SERVER_NAME_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(name) ||
      seenMcpServerNames.has(name)
    )
      throw new CodexTransportError("configuration");
    seenMcpServerNames.add(name);
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  if (!mcp) {
    const multiAgentIndex = args.indexOf("features.multi_agent=false");
    const agentsIndex = args.indexOf("agents.enabled=false");
    const excludedNamespacesIndex = args.findIndex((arg) =>
      arg.startsWith("features.code_mode.excluded_tool_namespaces="),
    );
    if (multiAgentIndex < 0 || agentsIndex < 0 || excludedNamespacesIndex < 0)
      throw new CodexTransportError("configuration");
    args[multiAgentIndex] = "features.multi_agent=true";
    const multiAgentV2Index = args.indexOf("features.multi_agent_v2=false");
    if (multiAgentV2Index < 0) throw new CodexTransportError("configuration");
    args[multiAgentV2Index] = "features.multi_agent_v2=true";
    args[agentsIndex] = "agents.enabled=true";
    args[excludedNamespacesIndex] =
      'features.code_mode.excluded_tool_namespaces=["mcp__codex_apps","skills","functions","image_gen"]';
    args.push("-c", "agents.max_depth=1");
    return args;
  }
  const quoted = (value: string) => JSON.stringify(value);
  args.push(
    "-c",
    "mcp_servers={}",
    "-c",
    `mcp_servers.codex-video-edit.command=${quoted(mcp.command)}`,
    "-c",
    `mcp_servers.codex-video-edit.args=[${quoted(mcp.script)}]`,
    "-c",
    'mcp_servers.codex-video-edit.env_vars=["ELECTRON_RUN_AS_NODE","CODEX_VIDEO_EDIT_MCP_ENDPOINT","CODEX_VIDEO_EDIT_MCP_TOKEN"]',
    "-c",
    `mcp_servers.codex-video-edit.enabled_tools=${JSON.stringify(codexVideoEditToolNames)}`,
    "-c",
    'mcp_servers.codex-video-edit.default_tools_approval_mode="approve"',
    "-c",
    "mcp_servers.codex-video-edit.enabled=true",
    "-c",
    "mcp_servers.codex-video-edit.required=true",
    "-c",
    "mcp_servers.codex-video-edit.supports_parallel_tool_calls=false",
    "-c",
    "mcp_servers.codex-video-edit.startup_timeout_sec=10",
    "-c",
    "mcp_servers.codex-video-edit.tool_timeout_sec=40",
  );
  return args;
}

type ConfiguredMcpServer = { name: string; enabled: boolean };

function decodeConfiguredMcpServers(value: unknown): ConfiguredMcpServer[] {
  if (!Array.isArray(value) || value.length > MAX_CONFIGURED_MCP_SERVERS)
    throw new CodexTransportError("protocol");
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !protocolRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length > MAX_MCP_SERVER_NAME_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(item.name) ||
      typeof item.enabled !== "boolean" ||
      seen.has(item.name)
    )
      throw new CodexTransportError("protocol");
    seen.add(item.name);
    return { name: item.name, enabled: item.enabled };
  });
}

function serverListArgs(overrides: readonly string[] = []): string[] {
  return [
    "mcp",
    "list",
    "--json",
    ...overrides.flatMap((value) => ["-c", value]),
  ];
}

async function executeCodex(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const result = await execute(executable, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      ...(signal ? { signal } : {}),
    });
    return JSON.parse(result.stdout);
  } catch {
    throw new CodexTransportError("configuration");
  }
}

async function disableConfiguredMcpServers(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  runCodex: typeof executeCodex = executeCodex,
): Promise<string[]> {
  const configured = decodeConfiguredMcpServers(
    await runCodex(executable, serverListArgs(), cwd, env, signal),
  );
  const overrides = configured.map(
    ({ name }) => `mcp_servers.${name}.enabled=false`,
  );
  if (overrides.join("").length > 12_000)
    throw new CodexTransportError("configuration");
  const verified = decodeConfiguredMcpServers(
    await runCodex(executable, serverListArgs(overrides), cwd, env, signal),
  );
  const verifiedByName = new Map(
    verified.map(({ name, enabled }) => [name, enabled]),
  );
  if (
    verified.length !== configured.length ||
    configured.some(({ name }) => verifiedByName.get(name) !== false)
  )
    throw new CodexTransportError("configuration");
  return configured.map(({ name }) => name);
}

function protocolRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateOwnedMcpStatus(
  value: unknown,
): asserts value is ListMcpServerStatusResponse {
  if (
    !protocolRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    value.nextCursor !== null
  )
    throw new CodexTransportError("protocol");
  const server = value.data[0];
  if (
    !protocolRecord(server) ||
    server.name !== "codex-video-edit" ||
    server.authStatus !== "unsupported" ||
    !Array.isArray(server.resources) ||
    server.resources.length !== 0 ||
    !Array.isArray(server.resourceTemplates) ||
    server.resourceTemplates.length !== 0 ||
    !protocolRecord(server.serverInfo) ||
    server.serverInfo.name !== "codex-video-edit" ||
    server.serverInfo.version !== "0.0.1" ||
    !protocolRecord(server.tools)
  )
    throw new CodexTransportError("protocol");
  const names = Object.keys(server.tools).sort();
  const tools = server.tools;
  const expected = [...codexVideoEditToolNames].sort();
  const definitions = new Map<string, (typeof codexVideoEditMcpTools)[number]>(
    codexVideoEditMcpTools.map((tool) => [tool.name, tool]),
  );
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index]) ||
    names.some((name) => {
      const tool = tools[name];
      return (
        !protocolRecord(tool) ||
        tool.name !== name ||
        !protocolRecord(tool.inputSchema) ||
        !isDeepStrictEqual(tool.inputSchema, definitions.get(name)?.inputSchema)
      );
    })
  )
    throw new CodexTransportError("protocol");
}

function validateDisabledMcpStatus(
  value: unknown,
  expectedNames: readonly string[],
  requireRuntimeDisabled = false,
): asserts value is ListMcpServerStatusResponse {
  if (
    !protocolRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length !== expectedNames.length ||
    value.nextCursor !== null
  )
    throw new CodexTransportError("protocol");
  const expected = [...expectedNames].sort();
  const servers = value.data.toSorted((left, right) => {
    if (!protocolRecord(left) || !protocolRecord(right)) return 0;
    return String(left.name).localeCompare(String(right.name));
  });
  if (
    new Set(expected).size !== expected.length ||
    servers.some((server, index) => {
      if (
        !protocolRecord(server) ||
        server.name !== expected[index] ||
        !protocolRecord(server.tools) ||
        Object.keys(server.tools).length !== 0 ||
        !Array.isArray(server.resources) ||
        server.resources.length !== 0 ||
        !Array.isArray(server.resourceTemplates) ||
        server.resourceTemplates.length !== 0
      )
        return true;
      return requireRuntimeDisabled
        ? server.runtimeStatus !== "disabled"
        : server.runtimeStatus !== null && server.runtimeStatus !== "disabled";
    })
  )
    throw new CodexTransportError("protocol");
}

function validateAppServerMcpStatus(
  value: unknown,
  disabledNames: readonly string[],
  hasOwnedMcp: boolean,
  requireRuntimeDisabled = false,
): asserts value is ListMcpServerStatusResponse {
  if (
    !protocolRecord(value) ||
    !Array.isArray(value.data) ||
    value.nextCursor !== null ||
    value.data.length !== disabledNames.length + Number(hasOwnedMcp)
  )
    throw new CodexTransportError("protocol");
  const disabled = hasOwnedMcp
    ? value.data.filter(
        (server) =>
          protocolRecord(server) && server.name !== "codex-video-edit",
      )
    : value.data;
  const owned = value.data.filter(
    (server) => protocolRecord(server) && server.name === "codex-video-edit",
  );
  validateDisabledMcpStatus(
    { data: disabled, nextCursor: null },
    disabledNames,
    requireRuntimeDisabled,
  );
  if (hasOwnedMcp) {
    if (owned.length !== 1) throw new CodexTransportError("protocol");
    validateOwnedMcpStatus({ data: owned, nextCursor: null });
  } else if (owned.length !== 0) {
    // A configured server using our reserved name is not part of the dynamic route.
    if (!disabledNames.includes("codex-video-edit"))
      throw new CodexTransportError("protocol");
    validateDisabledMcpStatus(
      { data: owned, nextCursor: null },
      ["codex-video-edit"],
      requireRuntimeDisabled,
    );
  }
}

export const codexClientInternals: {
  validateOwnedMcpStatus: typeof validateOwnedMcpStatus;
  validateDisabledMcpStatus: typeof validateDisabledMcpStatus;
  validateAppServerMcpStatus: typeof validateAppServerMcpStatus;
  decodeConfiguredMcpServers: typeof decodeConfiguredMcpServers;
  serverListArgs: typeof serverListArgs;
  disableConfiguredMcpServers: typeof disableConfiguredMcpServers;
} = {
  validateOwnedMcpStatus,
  validateDisabledMcpStatus,
  validateAppServerMcpStatus,
  decodeConfiguredMcpServers,
  serverListArgs,
  disableConfiguredMcpServers,
};

export interface CodexClientOptions {
  executable: string;
  /** Dedicated main-owned context directory, never the app source repository. */
  cwd: string;
  /** Dedicated account/config directory owned by the official client. */
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  onSkillsChanged?: () => void;
  onAuthStateChanged?: (state: AuthState) => void;
  onRateLimitsChanged?: () => void;
  onThreadEvent?: (event: ThreadStreamEvent) => void;
  onThreadHistory?: (history: ThreadHistorySnapshot) => void;
  mcp?: CodexMcpRuntime;
  /** Main-owned guarded editor dispatch. Inactive until a reviewed tool mode enables it. */
  dynamicToolInvoker?: (
    name: CodexVideoEditToolName,
    input: unknown,
    access: DynamicToolAccess,
  ) => Promise<unknown>;
}

export interface OpenProjectThreadInput {
  projectId: string;
  model: string;
  effort: string;
  nativeSubagentProtocol?: NativeSubagentProtocol;
  nativeSubagentModel?: string;
  nativeSubagentReasoning?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

const threadNotification = (method: string) =>
  method.startsWith("thread/") ||
  method.startsWith("turn/") ||
  method.startsWith("item/") ||
  method === "error" ||
  method === "warning";

/** Main-process-only bootstrap client. No arbitrary RPC, turns or edit tools exposed. */
export class CodexClient {
  private readonly options: CodexClientOptions;
  private transport: CodexStdioTransport | undefined;
  private connecting = false;
  private startupAbort: AbortController | undefined;
  private startupFinished: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private auth: CodexAuthController | undefined;
  private threadRegistry: ProjectThreadRegistry | undefined;
  private conversation: CodexProjectThreadClient | undefined;
  private disabledMcpServers: string[] = [];
  private generation = 0;
  private resolvedCwd: string | undefined;

  constructor(options: CodexClientOptions) {
    for (const path of [options.executable, options.cwd, options.codexHome]) {
      if (!isAbsolute(path) || path.includes("\0"))
        throw new CodexTransportError("configuration");
    }
    this.options = { ...options, environment: { ...options.environment } };
  }

  async connect(): Promise<void> {
    if (this.closing) throw new CodexTransportError("closed");
    if (this.transport || this.connecting)
      throw new CodexTransportError("configuration");
    this.connecting = true;
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    let finishStartup!: () => void;
    this.startupFinished = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    let transport: CodexStdioTransport | undefined;
    let auth: CodexAuthController | undefined;
    try {
      const executable = await realpath(this.options.executable);
      const cwd = await realpath(this.options.cwd);
      const codexHome = await realpath(this.options.codexHome);
      let mcp: CodexMcpRuntime | undefined;
      if (this.options.mcp) {
        const command = await realpath(this.options.mcp.command);
        const script = await realpath(this.options.mcp.script);
        if (!(await stat(command)).isFile() || !(await stat(script)).isFile())
          throw new CodexTransportError("configuration");
        if (
          !this.options.mcp.endpoint ||
          this.options.mcp.endpoint.length > 4096 ||
          /[\u0000-\u001f\u007f]/u.test(this.options.mcp.endpoint) ||
          !/^[a-f0-9]{64}$/u.test(this.options.mcp.token)
        )
          throw new CodexTransportError("configuration");
        mcp = { ...this.options.mcp, command, script };
      }
      if (
        !(await stat(cwd)).isDirectory() ||
        !(await stat(codexHome)).isDirectory()
      )
        throw new CodexTransportError("configuration");
      const registry = await ProjectThreadRegistry.open(join(cwd, "threads"));
      const env: NodeJS.ProcessEnv = {
        HOME: dirname(codexHome),
        USERPROFILE: dirname(codexHome),
        CODEX_HOME: codexHome,
      };
      for (const key of environmentKeys) {
        const value = this.options.environment[key];
        if (value !== undefined) env[key] = value;
      }
      if (mcp) {
        env.ELECTRON_RUN_AS_NODE = "1";
        env.CODEX_VIDEO_EDIT_MCP_ENDPOINT = mcp.endpoint;
        env.CODEX_VIDEO_EDIT_MCP_TOKEN = mcp.token;
      }
      const version = await execute(executable, ["--version"], {
        cwd,
        env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
        encoding: "utf8",
        signal: startupAbort.signal,
      });
      if (startupAbort.signal.aborted) throw new CodexTransportError("closed");
      if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
        throw new CodexTransportError("protocol");
      const disabledMcpServers = await disableConfiguredMcpServers(
        executable,
        cwd,
        env,
        startupAbort.signal,
      );
      if (mcp && disabledMcpServers.includes("codex-video-edit"))
        throw new CodexTransportError("configuration");
      transport = new CodexStdioTransport({
        executable,
        args: buildCodexAppServerArguments(mcp, disabledMcpServers),
        cwd,
        env,
        onNotification: (method, params) => {
          if (method === "skills/changed") this.options.onSkillsChanged?.();
          auth?.notification(method, params);
          if (method === "account/rateLimits/updated") {
            validateRateLimitsUpdate(params);
            this.options.onRateLimitsChanged?.();
          }
          if (threadNotification(method))
            this.conversation?.notification(method, params);
        },
        onServerRequest: async (request) => {
          try {
            if (!this.conversation) throw new CodexTransportError("protocol");
            return await this.conversation.serverRequest(request);
          } catch (error) {
            setImmediate(() => {
              if (this.transport === transport) void transport?.close();
            });
            throw error;
          }
        },
        onDisconnect: () => {
          auth?.close();
          this.conversation?.disconnect();
        },
      });
      this.transport = transport;
      const connectedTransport = transport;
      auth = new CodexAuthController({
        request: (method, params) => connectedTransport.request(method, params),
        onChanged: (state) => {
          if (this.auth === auth) this.options.onAuthStateChanged?.(state);
        },
      });
      this.auth = auth;
      const params = buildExperimentalInitialize("0.0.0");
      const response = decodeInitialization(await transport.start(params));
      if (normalize(response.codexHome) !== normalize(codexHome))
        throw new CodexTransportError("protocol");
      if (startupAbort.signal.aborted) throw new CodexTransportError("closed");
      const mcpStatusRequest = {
        cursor: null,
        detail: "full",
        limit: MAX_CONFIGURED_MCP_SERVERS + 1,
        threadId: null,
      } satisfies ListMcpServerStatusParams;
      validateAppServerMcpStatus(
        await transport.request("mcpServerStatus/list", mcpStatusRequest),
        disabledMcpServers,
        Boolean(mcp),
      );
      this.threadRegistry = registry;
      this.resolvedCwd = cwd;
      this.disabledMcpServers = disabledMcpServers;
      if (mcp) this.options.mcp = mcp;
      this.generation++;
    } catch (error) {
      auth?.close();
      if (this.auth === auth) this.auth = undefined;
      await transport?.close();
      if (this.transport === transport) this.transport = undefined;
      this.threadRegistry = undefined;
      this.resolvedCwd = undefined;
      this.disabledMcpServers = [];
      if (startupAbort.signal.aborted) throw new CodexTransportError("closed");
      if (error instanceof CodexTransportError) throw error;
      throw new CodexTransportError("process_failed");
    } finally {
      this.connecting = false;
      this.startupAbort = undefined;
      this.startupFinished = undefined;
      finishStartup();
    }
  }

  private ready(): CodexStdioTransport {
    if (this.connecting || !this.transport || this.transport.state !== "ready")
      throw new CodexTransportError("not_ready");
    return this.transport;
  }

  async account(): Promise<AccountState> {
    this.ready();
    return this.auth!.refreshAccount();
  }

  authState(): AuthState {
    return (
      this.auth?.snapshot() ?? { status: "idle", account: null, error: null }
    );
  }
  /** Main-only result. Never serialize its URL to the packaged renderer. */
  async startLogin(): Promise<{ authUrl: string } | null> {
    this.ready();
    return this.auth!.startLogin();
  }
  async startDeviceLogin(): Promise<DeviceLoginDetails | null> {
    this.ready();
    return this.auth!.startDeviceLogin();
  }
  async cancelLogin(): Promise<void> {
    this.ready();
    await this.auth!.cancelLogin();
  }
  async logout(): Promise<void> {
    this.ready();
    await this.auth!.logout();
  }
  async rateLimits(): Promise<RateLimitsSummary> {
    const transport = this.ready();
    if ((await this.account()).status !== "chatgpt")
      throw new CodexTransportError("not_ready");
    return decodeRateLimits(
      await transport.request("account/rateLimits/read", undefined),
    );
  }

  async models(): Promise<ModelSummary[]> {
    const transport = this.ready();
    const accountParams: GetAccountParams = { refreshToken: false };
    if (
      decodeAccount(await transport.request("account/read", accountParams))
        .status !== "chatgpt"
    )
      throw new CodexTransportError("not_ready");
    const models: ModelSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const params: ModelListParams = {
        cursor,
        limit: 100,
        includeHidden: false,
      };
      const page = decodeModels(await transport.request("model/list", params));
      models.push(...page.models);
      cursor = page.cursor;
      if (
        models.length > 1000 ||
        cursors.size >= 100 ||
        (cursor && cursors.has(cursor))
      )
        throw new CodexTransportError("protocol");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(models.map((model) => model.id)).size !== models.length)
      throw new CodexTransportError("protocol");
    return models;
  }

  async skills(): Promise<SkillSummary[]> {
    const cwd = await realpath(this.options.cwd);
    const params: SkillsListParams = { cwds: [cwd], forceReload: true };
    return decodeSkills(await this.ready().request("skills/list", params), cwd);
  }

  async openProjectThread(input: OpenProjectThreadInput): Promise<void> {
    const transport = this.ready();
    if (
      this.conversation ||
      !this.threadRegistry ||
      !this.resolvedCwd ||
      this.authState().account?.status !== "chatgpt"
    )
      throw new CodexTransportError("not_ready");
    const hasMcp = Boolean(this.options.mcp);
    const hasDynamic = Boolean(this.options.dynamicToolInvoker);
    if (hasMcp === hasDynamic) throw new CodexTransportError("configuration");
    const route = hasDynamic ? "dynamic" : "mcp";
    const existing = await this.threadRegistry.bindingForProject(
      input.projectId,
    );
    if (existing && existing.toolRoute !== route)
      throw new CodexTransportError("configuration");
    const conversation = new CodexProjectThreadClient({
      rpc: transport,
      generation: this.generation,
      projectId: input.projectId,
      policy: {
        cwd: this.resolvedCwd,
        model: input.model,
        effort: input.effort,
        ...(input.baseInstructions === undefined
          ? {}
          : { baseInstructions: input.baseInstructions }),
        ...(input.developerInstructions === undefined
          ? {}
          : { developerInstructions: input.developerInstructions }),
      },
      registry: this.threadRegistry,
      allowedMcpServer: "codex-video-edit",
      allowedMcpTools: new Set(codexVideoEditToolNames),
      ...(this.options.dynamicToolInvoker
        ? { dynamicToolInvoker: this.options.dynamicToolInvoker }
        : {}),
      ...(this.options.dynamicToolInvoker
        ? {
            nativeSubagentProtocol: input.nativeSubagentProtocol ?? "disabled",
            ...(input.nativeSubagentProtocol !== undefined &&
            input.nativeSubagentProtocol !== "disabled"
              ? {
                  nativeSubagentModel: input.nativeSubagentModel!,
                  nativeSubagentReasoning: input.nativeSubagentReasoning!,
                }
              : {}),
          }
        : {}),
      onEvent: (event) => {
        if (this.conversation === conversation)
          this.options.onThreadEvent?.(event);
      },
      onHistory: (history) => {
        if (this.conversation === conversation)
          this.options.onThreadHistory?.(history);
      },
      onPolicyViolation: () => {
        if (this.transport === transport) void transport.close();
      },
    });
    this.conversation = conversation;
    try {
      await conversation.open();
      const threadId = conversation.activeThreadId();
      if (!threadId) throw new CodexTransportError("protocol");
      const mcpStatusRequest = {
        cursor: null,
        detail: "full",
        limit: MAX_CONFIGURED_MCP_SERVERS + 1,
        threadId,
      } satisfies ListMcpServerStatusParams;
      validateAppServerMcpStatus(
        await transport.request("mcpServerStatus/list", mcpStatusRequest),
        this.disabledMcpServers,
        Boolean(this.options.mcp),
        true,
      );
    } catch (error) {
      if (error instanceof CodexTransportError && error.code === "protocol") {
        await this.close();
      } else if (this.conversation === conversation) {
        this.conversation = undefined;
      }
      throw error;
    }
  }

  async startProjectTurn(input: TurnStartInput): Promise<void> {
    this.ready();
    if (!this.conversation) throw new CodexTransportError("not_ready");
    await this.conversation.startTurn(input);
  }

  async interruptProjectTurn(): Promise<void> {
    this.ready();
    if (!this.conversation) throw new CodexTransportError("not_ready");
    await this.conversation.interrupt();
  }

  async closeProjectThread(): Promise<void> {
    this.ready();
    const conversation = this.conversation;
    if (!conversation) return;
    await conversation.close();
    if (this.conversation === conversation) this.conversation = undefined;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const startupFinished = this.startupFinished;
    this.startupAbort?.abort();
    try {
      this.auth?.close();
    } catch {
      // A notification consumer cannot bypass process cleanup.
    }
    this.auth = undefined;
    const transport = this.transport;
    try {
      this.conversation?.disconnect();
    } catch {
      // Always reach the transport shutdown barrier.
    }
    this.conversation = undefined;
    this.threadRegistry = undefined;
    this.resolvedCwd = undefined;
    this.disabledMcpServers = [];
    this.transport = undefined;
    this.closing = Promise.all([transport?.close(), startupFinished])
      .then(() => {})
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}
