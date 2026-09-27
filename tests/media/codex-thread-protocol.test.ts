import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildExperimentalInitialize,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildThreadTurnsListRequest,
  buildTurnInterruptRequest,
  buildTurnStartRequest,
  CodexThreadProtocolError,
  decodeThreadSession,
  decodeThreadResumeHistoryPage,
  decodeTurnInterrupt,
  decodeTurnStart,
} from "../../packages/codex-bridge/src/thread-protocol.ts";

const cwd = resolve("test-results", "codex-thread-context");
const policy = {
  cwd,
  model: "runtime-discovered-model",
  effort: "high",
  baseInstructions: "Edit only through the guarded video tools.",
  developerInstructions: "Keep source media immutable.",
};
const restrictedFeatures = {
  api_key_model_discovery: false,
  apps: false,
  auth_elicitation: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  chronicle: false,
  compaction_image_budget: false,
  code_mode_only: false,
  code_mode: {
    enabled: false,
    excluded_tool_namespaces: [
      "mcp__codex_apps",
      "multi_agent_v1",
      "codex_video_edit_agents",
      "skills",
      "functions",
      "image_gen",
    ],
  },
  code_mode_host: {
    enabled: false,
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
  fast_mode: false,
  goals: false,
  guardian_approval: false,
  hooks: false,
  image_generation: false,
  imagegenext: false,
  in_app_browser: false,
  in_app_chat: false,
  in_app_dictation: false,
  in_app_local_automation: false,
  in_app_updates: false,
  mcp_oauth_refresh_coordination: false,
  memories: false,
  memory_tool: false,
  mentions_v2: false,
  multi_agent: false,
  multi_agent_v2: false,
  plugins: false,
  plugin_sharing: false,
  personality: false,
  recommended_plugins: false,
  remote_control: false,
  remote_plugin: false,
  request_permissions_tool: false,
  request_rule: false,
  search_tool: false,
  shell_tool: false,
  shell_snapshot: false,
  sleep_tool: false,
  token_budget: false,
  unified_exec_tty: false,
  unbounded_connection_retries: false,
  workspace_dependencies: false,
  skill_mcp_dependency_install: false,
  skill_search: false,
  standalone_web_search: false,
  tool_call_mcp_elicitation: false,
  tool_suggest: false,
  view_image: false,
  web_search_cached: false,
  web_search_request: false,
};
const dynamicFeatures = (nativeSubagentProtocol: "disabled" | "v1" | "v2") => ({
  ...restrictedFeatures,
  code_mode_only: true,
  code_mode: {
    enabled: true,
    excluded_tool_namespaces:
      nativeSubagentProtocol === "v1"
        ? ["mcp__codex_apps", "skills", "functions", "image_gen"]
        : [
            "mcp__codex_apps",
            "multi_agent_v1",
            ...(nativeSubagentProtocol === "disabled"
              ? ["codex_video_edit_agents"]
              : []),
            "skills",
            "functions",
            "image_gen",
          ],
    ...(nativeSubagentProtocol === "v2"
      ? { direct_only_tool_namespaces: ["codex_video_edit_agents"] }
      : {}),
  },
  code_mode_host: {
    enabled: true,
    disable_in_process_fallback: true,
  },
  multi_agent: nativeSubagentProtocol === "v1",
  multi_agent_v2:
    nativeSubagentProtocol === "v2"
      ? {
          enabled: true,
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
});
const restrictedApps = {
  _default: {
    enabled: false,
    destructive_enabled: false,
    open_world_enabled: false,
  },
};
const restrictedTools = {
  update_plan: { enabled: false },
  experimental_request_user_input: { enabled: false },
};

test("experimental initialization and no-environment requests are exact", () => {
  assert.deepEqual(buildExperimentalInitialize("0.0.0"), {
    clientInfo: {
      name: "codex_video_edit",
      title: "codex-video-edit",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
      optOutNotificationMethods: [],
    },
  });

  assert.deepEqual(buildThreadStartRequest(policy), {
    model: "runtime-discovered-model",
    modelProvider: "openai",
    cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: {
      forced_login_method: "chatgpt",
      model_provider: "openai",
      apps: restrictedApps,
      tools: restrictedTools,
      agents: { enabled: false },
      project_root_markers: [],
      features: restrictedFeatures,
      web_search: "disabled",
    },
    ephemeral: false,
    environments: [],
    selectedCapabilityRoots: [],
    experimentalRawEvents: false,
    baseInstructions: policy.baseInstructions,
    developerInstructions: policy.developerInstructions,
  });

  const resume = buildThreadResumeRequest("thread-1", policy);
  assert.deepEqual(resume, {
    threadId: "thread-1",
    model: "runtime-discovered-model",
    modelProvider: "openai",
    cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: {
      forced_login_method: "chatgpt",
      model_provider: "openai",
      apps: restrictedApps,
      tools: restrictedTools,
      agents: { enabled: false },
      project_root_markers: [],
      features: restrictedFeatures,
      web_search: "disabled",
    },
    excludeTurns: true,
    initialTurnsPage: {
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    },
    baseInstructions: policy.baseInstructions,
    developerInstructions: policy.developerInstructions,
  });
  assert.equal("environments" in resume, false);
  assert.deepEqual(buildThreadTurnsListRequest("thread-1"), {
    threadId: "thread-1",
    limit: 100,
    sortDirection: "desc",
    itemsView: "full",
  });

  const dynamicStart = buildThreadStartRequest(policy, {
    route: "dynamic",
    nativeSubagentProtocol: "disabled",
  });
  const dynamicResume = buildThreadResumeRequest("thread-1", policy, {
    route: "dynamic",
    nativeSubagentProtocol: "disabled",
  });
  const collaborativeStart = buildThreadStartRequest(policy, {
    route: "dynamic",
    nativeSubagentProtocol: "v1",
    nativeSubagentModel: "gpt-5.6-luna",
    nativeSubagentReasoning: "high",
  });
  const collaborativeResume = buildThreadResumeRequest("thread-1", policy, {
    route: "dynamic",
    nativeSubagentProtocol: "v1",
    nativeSubagentModel: "gpt-5.6-luna",
    nativeSubagentReasoning: "high",
  });
  const v2Start = buildThreadStartRequest(policy, {
    route: "dynamic",
    nativeSubagentProtocol: "v2",
    nativeSubagentModel: "gpt-6-luna",
    nativeSubagentReasoning: "high",
  });
  const v2Resume = buildThreadResumeRequest("thread-1", policy, {
    route: "dynamic",
    nativeSubagentProtocol: "v2",
    nativeSubagentModel: "gpt-6-luna",
    nativeSubagentReasoning: "high",
  });
  assert.deepEqual(dynamicStart.config.features, dynamicFeatures("disabled"));
  assert.deepEqual(dynamicResume.config.features, dynamicFeatures("disabled"));
  assert.deepEqual(collaborativeStart.config.features, dynamicFeatures("v1"));
  assert.deepEqual(collaborativeResume.config.features, dynamicFeatures("v1"));
  assert.deepEqual(v2Start.config.features, dynamicFeatures("v2"));
  assert.deepEqual(v2Resume.config.features, dynamicFeatures("v2"));
  for (const request of [dynamicStart, dynamicResume]) {
    assert.equal(request.config.features.deferred_executor, false);
    assert.equal(request.config.features.token_budget, false);
    assert.equal(request.config.features.code_mode_only, true);
    assert.equal(request.config.features.code_mode.enabled, true);
    assert.equal(request.config.features.code_mode_host.enabled, true);
    assert.equal(
      request.config.features.code_mode_host.disable_in_process_fallback,
      true,
    );
    assert.equal(request.config.features.multi_agent, false);
    assert.deepEqual(
      request.config.features.code_mode.excluded_tool_namespaces,
      [
        "mcp__codex_apps",
        "multi_agent_v1",
        "codex_video_edit_agents",
        "skills",
        "functions",
        "image_gen",
      ],
    );
  }
  for (const request of [collaborativeStart, collaborativeResume]) {
    assert.equal(request.config.features.multi_agent, true);
    assert.equal(request.config.features.multi_agent_v2, false);
    assert.equal(request.config.features.shell_tool, false);
    assert.equal(request.config.features.sleep_tool, false);
    assert.equal(request.config.features.view_image, false);
    assert.equal(request.config.features.code_mode_only, true);
    assert.equal(request.config.features.computer_use, false);
    assert.equal(request.config.features.browser_use, false);
    assert.equal(request.config.features.browser_use_external, false);
    assert.equal(request.config.features.browser_use_full_cdp_access, false);
    assert.equal(request.config.features.compaction_image_budget, false);
    assert.equal(request.config.features.fast_mode, false);
    assert.equal(request.config.features.guardian_approval, false);
    assert.equal(request.config.features.in_app_browser, false);
    assert.equal(request.config.features.in_app_chat, false);
    assert.equal(request.config.features.in_app_dictation, false);
    assert.equal(request.config.features.in_app_local_automation, false);
    assert.equal(request.config.features.in_app_updates, false);
    assert.equal(request.config.features.mentions_v2, false);
    assert.equal(request.config.features.personality, false);
    assert.equal(request.config.features.shell_snapshot, false);
    assert.equal(request.config.features.unified_exec_tty, false);
    assert.equal(request.config.features.workspace_dependencies, false);
    assert.equal(request.config.features.image_generation, false);
    assert.equal(request.config.features.connectors, false);
    assert.equal(request.config.features.codex_git_commit, false);
    assert.deepEqual(
      request.config.features.code_mode.excluded_tool_namespaces,
      ["mcp__codex_apps", "skills", "functions", "image_gen"],
    );
    assert.deepEqual(request.config.tools, restrictedTools);
    assert.deepEqual(request.config.apps, restrictedApps);
    assert.deepEqual(request.config.agents, {
      enabled: true,
      max_depth: 1,
      default_subagent_model: "gpt-5.6-luna",
      default_subagent_reasoning_effort: "high",
    });
    assert.equal(request.approvalPolicy, "never");
    assert.equal(request.sandbox, "read-only");
  }
  for (const request of [v2Start, v2Resume]) {
    assert.equal(request.config.features.multi_agent, false);
    assert.equal(
      (request.config.features.multi_agent_v2 as { enabled: boolean }).enabled,
      true,
    );
    assert.equal(request.config.features.code_mode_only, true);
    assert.deepEqual(
      request.config.features.code_mode.direct_only_tool_namespaces,
      ["codex_video_edit_agents"],
    );
    assert.deepEqual(request.config.agents, {
      enabled: true,
      max_depth: 1,
      default_subagent_model: "gpt-6-luna",
      default_subagent_reasoning_effort: "high",
    });
    assert.equal(request.sandbox, "read-only");
    assert.equal(request.approvalPolicy, "never");
  }

  assert.deepEqual(
    buildTurnStartRequest(
      "thread-1",
      "message-1",
      {
        text: "Tighten this section.",
        skills: [
          { name: "timeline-editor", path: resolve("skills", "timeline") },
        ],
      },
      policy,
    ),
    {
      threadId: "thread-1",
      clientUserMessageId: "message-1",
      input: [
        { type: "text", text: "Tighten this section.", text_elements: [] },
        {
          type: "skill",
          name: "timeline-editor",
          path: resolve("skills", "timeline"),
        },
      ],
      environments: [],
      cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: policy.model,
      effort: policy.effort,
    },
  );
  assert.deepEqual(buildTurnInterruptRequest("thread-1", "turn-1"), {
    threadId: "thread-1",
    turnId: "turn-1",
  });
});

test("thread and turn decoders expose only correlated identifiers", () => {
  const raw = {
    thread: { id: "thread-1", ephemeral: false, rolloutPath: "C:\\private" },
    model: policy.model,
    modelProvider: "openai",
    cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    privateAccount: "SECRET",
  };
  assert.deepEqual(decodeThreadSession(raw, policy), {
    threadId: "thread-1",
    active: null,
  });
  assert.throws(
    () => decodeThreadSession(raw, policy, true),
    (error: unknown) =>
      error instanceof CodexThreadProtocolError && error.code === "protocol",
  );
  assert.deepEqual(
    decodeThreadSession(
      {
        ...raw,
        thread: {
          ...raw.thread,
          status: { type: "active", activeFlags: [] },
        },
      },
      policy,
    ),
    { threadId: "thread-1", active: true },
  );
  assert.equal(decodeThreadResumeHistoryPage(raw), null);
  const initialTurnsPage = {
    data: [],
    nextCursor: null,
    backwardsCursor: null,
  };
  assert.equal(
    decodeThreadResumeHistoryPage({ ...raw, initialTurnsPage }),
    initialTurnsPage,
  );
  assert.deepEqual(
    decodeTurnStart({
      turn: {
        id: "turn-1",
        status: "inProgress",
        items: [],
        privateField: "SECRET",
      },
    }),
    { turnId: "turn-1", status: "inProgress" },
  );
  assert.equal(decodeTurnInterrupt({}), undefined);
  assert.throws(
    () => decodeTurnInterrupt({ threadId: "leak" }),
    CodexThreadProtocolError,
  );

  for (const response of [
    { ...raw, modelProvider: "private-provider" },
    { ...raw, sandbox: "workspace-write" },
    { ...raw, approvalsReviewer: "auto_review" },
    { ...raw, thread: { id: "thread-1", ephemeral: true } },
    {
      ...raw,
      thread: {
        ...raw.thread,
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
  ]) {
    assert.throws(
      () => decodeThreadSession(response, policy),
      CodexThreadProtocolError,
    );
  }
  assert.throws(
    () => decodeTurnStart({ turn: { id: "turn-1", status: "unknown" } }),
    CodexThreadProtocolError,
  );
});

test("builders reject renderer-style policy and identifier overrides", () => {
  for (const invalid of [
    { ...policy, cwd: "relative" },
    { ...policy, model: "" },
    { ...policy, developerInstructions: "\0" },
  ]) {
    assert.throws(
      () => buildThreadStartRequest(invalid),
      CodexThreadProtocolError,
    );
  }
  assert.throws(
    () => buildTurnStartRequest("", "message-1", { text: "edit" }, policy),
    CodexThreadProtocolError,
  );
  assert.throws(
    () => buildTurnStartRequest("thread-1", "message-1", { text: "" }, policy),
    CodexThreadProtocolError,
  );
  assert.throws(
    () =>
      buildTurnStartRequest(
        "thread-1",
        "message-1",
        { text: "edit", cwd: "renderer-choice" } as never,
        policy,
      ),
    CodexThreadProtocolError,
  );
  assert.throws(
    () =>
      buildThreadStartRequest({
        ...policy,
        approvalPolicy: "on-request",
      } as never),
    CodexThreadProtocolError,
  );
  assert.throws(
    () =>
      buildThreadStartRequest(policy, {
        route: "mcp",
        nativeSubagentProtocol: "v1",
        nativeSubagentModel: "gpt-5.6-luna",
        nativeSubagentReasoning: "high",
      }),
    CodexThreadProtocolError,
  );
  assert.throws(
    () =>
      buildThreadStartRequest(policy, {
        route: "dynamic",
        nativeSubagentProtocol: "v1",
      }),
    CodexThreadProtocolError,
  );
});
