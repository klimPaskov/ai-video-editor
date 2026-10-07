import assert from "node:assert/strict";
import { access, lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CodexStdioTransport } from "../../packages/codex-bridge/src/transport.ts";
import { buildCodexAppServerArguments } from "../../packages/codex-bridge/src/client.ts";
import {
  buildCodexVideoEditDynamicTools,
  decodeOwnedDynamicToolCall,
  invokeOwnedDynamicTool,
} from "../../packages/codex-bridge/src/dynamic-tools.ts";
import {
  decodeAccount,
  decodeModels,
} from "../../packages/codex-bridge/src/metadata.ts";
import {
  buildExperimentalInitialize,
  buildThreadStartRequest,
  buildTurnStartRequest,
  decodeTurnStart,
} from "../../packages/codex-bridge/src/thread-protocol.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
await access("/.dockerenv");
const executable = resolve(process.argv[2]!);
const root = resolve(process.argv[3]!);
assert.ok(
  executable.startsWith("/home/node/") &&
    root.startsWith(resolve("test-results") + "/"),
);
assert.equal(await realpath(executable), executable);
assert.equal(await realpath(root), root);
const codeModeHost = join(dirname(executable), "codex-code-mode-host");
assert.equal(await realpath(codeModeHost), codeModeHost);
const hostStat = await lstat(codeModeHost);
assert.ok(
  hostStat.isFile() && !hostStat.isSymbolicLink() && hostStat.mode & 0o111,
);
const account = join(root, "account");
const cwd = join(root, "context");
assert.equal(await realpath(account), account);
assert.equal(await realpath(cwd), cwd);
const credential = await lstat(join(account, "auth.json"));
assert.ok(
  credential.isFile() &&
    !credential.isSymbolicLink() &&
    !(credential.mode & 0o077),
);

const policy = {
  cwd,
  model: "gpt-6-luna",
  effort: "high",
  baseInstructions:
    "You are in a local video editor. Use only the application-owned codex_video_edit tools. Do not use files, shell, network, apps, or other tools.",
  developerInstructions:
    "This is a read-only timing probe. In code mode inspect ALL_TOOLS.map(item => item.name), then call tools.codex_video_edit__project_get_summary exactly once for project fixture-project with schema_version 1.0. Reply briefly after the result.",
};
const counts = {
  ownedCalls: 0,
  foreignCalls: 0,
  earlyCalls: 0,
  mismatchedTurnCalls: 0,
  completed: 0,
};
let phase = "initialize";
let threadId = "";
let turnId = "";
let turnStartSettled = false;
let finish!: (value: string) => void;
const terminal = new Promise<string>((resolve) => {
  finish = resolve;
});
const transport = new CodexStdioTransport({
  executable,
  args: buildCodexAppServerArguments(),
  cwd,
  env: {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: account,
    PATH: process.env.PATH,
  },
  requestTimeoutMs: 30000,
  serverRequestTimeoutMs: 30000,
  onServerRequest: async (request) => {
    if (request.method !== "item/tool/call") {
      counts.foreignCalls++;
      throw new Error("Foreign server request");
    }
    let call;
    try {
      call = decodeOwnedDynamicToolCall(request.params);
    } catch {
      counts.foreignCalls++;
      throw new Error("Foreign host call");
    }
    if (!turnStartSettled) {
      counts.earlyCalls++;
      throw new Error("Host call before turn/start settled");
    }
    if (call.threadId !== threadId || call.turnId !== turnId) {
      counts.mismatchedTurnCalls++;
      throw new Error("Mismatched host call");
    }
    if (
      call.name !== "project.get_summary" ||
      call.arguments.schema_version !== "1.0" ||
      call.arguments.project_id !== "fixture-project"
    ) {
      counts.foreignCalls++;
      throw new Error("Unexpected host call");
    }
    counts.ownedCalls++;
    return invokeOwnedDynamicTool(call, async () => ({
      project_id: "fixture-project",
      status: "read_only_probe",
    }));
  },
  onNotification: (method, params) => {
    const value = params as {
      threadId?: unknown;
      turn?: { id?: unknown; status?: unknown };
    };
    if (
      method === "turn/completed" &&
      value?.threadId === threadId &&
      value.turn?.id === turnId
    ) {
      if (value.turn.status === "completed") counts.completed++;
      finish(value.turn.status === "completed" ? "completed" : "failed");
    }
  },
  onDisconnect: () => finish("disconnected"),
});
try {
  await transport.start(buildExperimentalInitialize("0.0.0"));
  phase = "catalog";
  assert.equal(
    decodeAccount(
      await transport.request("account/read", { refreshToken: false }),
    ).status,
    "chatgpt",
  );
  const models = decodeModels(
    await transport.request("model/list", {
      cursor: null,
      limit: 100,
      includeHidden: false,
    }),
  );
  assert.ok(
    models.models.some(
      (model) =>
        model.id === policy.model && model.reasoning.includes(policy.effort),
    ),
  );
  phase = "thread-start";
  const response = (await transport.request("thread/start", {
    ...buildThreadStartRequest(policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
    dynamicTools: buildCodexVideoEditDynamicTools("fixture-project"),
  })) as { thread?: { id?: string } };
  assert.ok(response.thread?.id);
  threadId = response.thread.id;
  phase = "turn-start";
  const started = decodeTurnStart(
    await transport.request(
      "turn/start",
      buildTurnStartRequest(
        threadId,
        "dynamic-timing-message-1",
        {
          text: "In one code-mode cell, compute ALL_TOOLS.map(item => item.name), then call await tools.codex_video_edit__project_get_summary({schema_version:'1.0',project_id:'fixture-project'}). Confirm the host result after that cell.",
        },
        policy,
      ),
    ),
  );
  turnId = started.turnId;
  turnStartSettled = true;
  phase = "turn-terminal";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    terminal,
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 120000);
    }),
  ]);
  clearTimeout(timer);
  const passed =
    outcome === "completed" &&
    counts.ownedCalls === 1 &&
    counts.foreignCalls === 0 &&
    counts.earlyCalls === 0 &&
    counts.mismatchedTurnCalls === 0 &&
    counts.completed === 1;
  await writeFile(
    join(root, "timing-result.json"),
    JSON.stringify({
      status: passed ? "pass" : "fail",
      outcome,
      ...counts,
      noMcpServer: true,
      packagedElectron: false,
    }),
  );
  assert.ok(
    passed,
    "The live tool call did not follow the validated turn/start response",
  );
  console.log(JSON.stringify({ status: "pass", ...counts }));
} catch {
  await writeFile(
    join(root, "timing-failure.json"),
    JSON.stringify({ status: "fail", phase, ...counts }),
  );
  console.error("Dynamic tool timing probe failed at " + phase);
  process.exitCode = 1;
} finally {
  await transport.close();
}
