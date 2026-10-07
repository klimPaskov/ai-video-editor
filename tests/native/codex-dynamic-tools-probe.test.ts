import assert from "node:assert/strict";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { CodexStdioTransport } from "../../packages/codex-bridge/src/transport.ts";
import { buildCodexAppServerArguments } from "../../packages/codex-bridge/src/client.ts";
import {
  decodeAccount,
  decodeModels,
} from "../../packages/codex-bridge/src/metadata.ts";
import {
  buildExperimentalInitialize,
  buildThreadStartRequest,
  buildTurnStartRequest,
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
const cwd = join(root, "context");
const account = join(root, "account");
const keyFile = join(account, "auth.json");
assert.equal(await realpath(account), account);
assert.equal(await realpath(cwd), cwd);
const keyStat = await lstat(keyFile);
assert.ok(
  keyStat.isFile() && !keyStat.isSymbolicLink() && !(keyStat.mode & 0o077),
);
const policy = {
  cwd,
  model: "gpt-6-luna",
  effort: "high",
  baseInstructions:
    "You are inside a video editor. Use only the host-defined codex_video_edit.editor_probe tool. Do not access files, shell, network, apps or external tools.",
  developerInstructions:
    "This is an isolated read-only probe. In code mode compute ALL_TOOLS.map(item => item.name), then call codex_video_edit.editor_probe exactly once with value probe and visibleTools set to that computed array. Reply briefly.",
};
const counts = {
  ownedCalls: 0,
  foreignCalls: 0,
  completed: 0,
  failed: 0,
  foreignMethod: "",
  foreignTool: "",
  inventoryObserved: false,
  unownedCount: -1,
  ownedInInventory: false,
};
let activeThreadId = "";
let finish!: (status: string) => void;
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
    const params = request.params as Record<string, unknown>;
    if (
      request.method !== "item/tool/call" ||
      params?.tool !== "editor_probe" ||
      params?.threadId !== activeThreadId ||
      !params.arguments ||
      typeof params.arguments !== "object" ||
      (params.arguments as Record<string, unknown>).value !== "probe" ||
      !Array.isArray((params.arguments as Record<string, unknown>).visibleTools)
    ) {
      counts.foreignCalls++;
      counts.foreignMethod = request.method.slice(0, 80);
      counts.foreignTool =
        typeof params?.tool === "string" ? params.tool.slice(0, 80) : "";
      throw new Error("Forbidden request");
    }
    const names = (params.arguments as { visibleTools: unknown[] })
      .visibleTools;
    if (
      names.length > 200 ||
      names.some((name) => typeof name !== "string" || name.length > 256)
    )
      throw new Error("Invalid inventory");
    counts.inventoryObserved = true;
    counts.ownedInInventory = names.includes("codex_video_edit__editor_probe");
    counts.unownedCount = names.filter(
      (name) => name !== "codex_video_edit__editor_probe",
    ).length;
    counts.ownedCalls++;
    return {
      contentItems: [{ type: "inputText", text: "probe-ack" }],
      success: true,
    };
  },
  onNotification: (method, params) => {
    const envelope = params as {
      threadId?: unknown;
      turn?: { status?: unknown };
    };
    const threadId = envelope?.threadId;
    if (method === "turn/completed" && threadId === activeThreadId) {
      if (envelope.turn?.status === "completed") {
        counts.completed++;
        finish("completed");
      } else finish("failed");
    }
    if (method === "turn/failed" && threadId === activeThreadId) {
      counts.failed++;
      finish("failed");
    }
  },
  onDisconnect: () => finish("disconnected"),
});
let phase = "initialize";
try {
  await transport.start(buildExperimentalInitialize("0.0.0"));
  phase = "model-discovery";
  assert.equal(
    decodeAccount(
      await transport.request("account/read", { refreshToken: false }),
    ).status,
    "chatgpt",
  );
  const catalog = decodeModels(
    await transport.request("model/list", {
      cursor: null,
      limit: 100,
      includeHidden: false,
    }),
  );
  assert.ok(
    catalog.models.some(
      (model) =>
        model.id === policy.model && model.reasoning.includes(policy.effort),
    ),
  );
  phase = "thread-start";
  const threadResponse = (await transport.request("thread/start", {
    ...buildThreadStartRequest(policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
    dynamicTools: [
      {
        type: "namespace",
        name: "codex_video_edit",
        description: "Application-owned guarded editor functions.",
        tools: [
          {
            type: "function",
            name: "editor_probe",
            description:
              "A read-only host-defined proof tool. Call with value probe.",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string", enum: ["probe"] },
                visibleTools: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 200,
                },
              },
              required: ["value", "visibleTools"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  })) as { thread?: { id?: string } };
  assert.ok(threadResponse.thread?.id);
  activeThreadId = threadResponse.thread.id;
  phase = "turn-start";
  await transport.request(
    "turn/start",
    buildTurnStartRequest(
      threadResponse.thread.id,
      "dynamic-probe-message-1",
      {
        text: "In one code-mode cell, compute ALL_TOOLS.map(item => item.name), then call tools.codex_video_edit__editor_probe({value:'probe',visibleTools:thatArray}). Confirm success after its result.",
      },
      policy,
    ),
  );
  phase = "turn-terminal";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    terminal,
    new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 120000);
    }),
  ]);
  clearTimeout(timeout);
  phase = "rollout-audit";
  await transport.close();
  const rolloutPaths = (await readdir(account, { recursive: true }))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(account, name));
  assert.ok(rolloutPaths.length > 0 && rolloutPaths.length <= 100);
  let auditedExec = false;
  let auditedUnownedCalls = 0;
  let matchedRollouts = 0;
  for (const path of rolloutPaths) {
    const info = await lstat(path);
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && info.size <= 4_000_000,
    );
    const items = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            payload?: {
              type?: string;
              id?: string;
              name?: string;
              input?: string;
            };
          },
      );
    if (
      !items.some(
        (item) =>
          item.type === "session_meta" && item.payload?.id === activeThreadId,
      )
    )
      continue;
    matchedRollouts++;
    const calls = items.filter(
      (item) =>
        item.type === "response_item" &&
        item.payload?.type === "custom_tool_call",
    );
    auditedUnownedCalls += calls.filter(
      (item) => item.payload?.name !== "exec",
    ).length;
    auditedExec = calls.some(
      (item) =>
        item.payload?.name === "exec" &&
        item.payload.input?.includes("ALL_TOOLS.map") &&
        item.payload.input.includes("codex_video_edit__editor_probe"),
    );
  }
  const passed =
    outcome === "completed" &&
    counts.ownedCalls === 1 &&
    counts.foreignCalls === 0 &&
    counts.inventoryObserved &&
    counts.ownedInInventory &&
    counts.unownedCount === 0 &&
    matchedRollouts === 1 &&
    auditedExec &&
    auditedUnownedCalls === 0;
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({
      status: passed ? "pass" : "fail",
      outcome,
      ...counts,
      noMcpServer: true,
      matchedRollouts,
      auditedExec,
      auditedUnownedCalls,
    }),
  );
  if (!passed) throw new Error("Probe did not establish one owned call");
  console.log(JSON.stringify({ status: "pass", outcome, ...counts }));
} catch {
  await writeFile(
    join(root, "failure.json"),
    JSON.stringify({ status: "fail", phase, ...counts }),
  );
  console.error("Dynamic tool probe failed at " + phase);
  process.exitCode = 1;
} finally {
  await transport.close();
}
