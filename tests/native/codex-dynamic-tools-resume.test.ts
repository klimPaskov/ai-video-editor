import assert from "node:assert/strict";
import { access, lstat, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexStdioTransport } from "../../packages/codex-bridge/src/transport.ts";
import { buildCodexAppServerArguments } from "../../packages/codex-bridge/src/client.ts";
import {
  buildExperimentalInitialize,
  buildThreadStartRequest,
  buildThreadResumeRequest,
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
assert.equal(await realpath(join(root, "account")), join(root, "account"));
assert.equal(await realpath(join(root, "context")), join(root, "context"));
const key = await lstat(join(root, "account", "auth.json"));
assert.ok(key.isFile() && !(key.mode & 0o077));
const policy = {
  cwd: join(root, "context"),
  model: "gpt-6-luna",
  effort: "high",
  baseInstructions:
    "Use only the host-defined codex_video_edit.editor_probe tool. Do not access files, shell, network, apps or external tools.",
  developerInstructions:
    "This is a read-only isolated protocol probe. Call codex_video_edit.editor_probe with value probe once for each user turn. Do not use another tool.",
};
const counts = {
  first: 0,
  second: 0,
  foreign: 0,
  firstCompleted: false,
  secondCompleted: false,
};
let expectedThread = "";
let phase: "first" | "second" = "first";

function startTransport(onTerminal: (state: string) => void) {
  return new CodexStdioTransport({
    executable,
    args: buildCodexAppServerArguments(),
    cwd: policy.cwd,
    env: {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: join(root, "account"),
      PATH: process.env.PATH,
    },
    requestTimeoutMs: 30000,
    serverRequestTimeoutMs: 30000,
    onServerRequest: async (request) => {
      const params = request.params as Record<string, unknown>;
      if (
        request.method !== "item/tool/call" ||
        params?.tool !== "editor_probe" ||
        params?.threadId !== expectedThread ||
        !params.arguments ||
        typeof params.arguments !== "object" ||
        (params.arguments as Record<string, unknown>).value !== "probe"
      ) {
        counts.foreign++;
        throw new Error("Forbidden request");
      }
      counts[phase]++;
      return {
        contentItems: [{ type: "inputText", text: "probe-ack" }],
        success: true,
      };
    },
    onNotification: (method, params) => {
      const envelope = params as {
        threadId?: string;
        turn?: { status?: string };
      };
      if (method === "turn/completed" && envelope.threadId === expectedThread)
        onTerminal(envelope.turn?.status ?? "unknown");
      if (method === "turn/failed" && envelope.threadId === expectedThread)
        onTerminal("failed");
    },
    onDisconnect: () => onTerminal("disconnected"),
  });
}

async function waitTurn(terminal: Promise<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    terminal,
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 90000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(result, "completed");
}

let step = "first-start";
let transport: CodexStdioTransport | undefined;
try {
  let resolveFirst!: (value: string) => void;
  const firstTerminal = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  transport = startTransport(resolveFirst);
  await transport.start(buildExperimentalInitialize("0.0.0"));
  const started = (await transport.request("thread/start", {
    ...buildThreadStartRequest(policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
    dynamicTools: [
      {
        type: "namespace",
        name: "codex_video_edit",
        description: "App-owned proof tools",
        tools: [
          {
            type: "function",
            name: "editor_probe",
            description: "A read-only proof tool",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string", enum: ["probe"] } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  })) as { thread?: { id?: string } };
  assert.ok(started.thread?.id);
  expectedThread = started.thread.id;
  await transport.request(
    "turn/start",
    buildTurnStartRequest(
      expectedThread,
      "dynamic-resume-first",
      {
        text: "Call tools.codex_video_edit__editor_probe({value:'probe'}) exactly once, then confirm its result.",
      },
      policy,
    ),
  );
  await waitTurn(firstTerminal);
  counts.firstCompleted = true;
  assert.equal(counts.first, 1);
  await transport.close();
  transport = undefined;

  step = "resume";
  phase = "second";
  let resolveSecond!: (value: string) => void;
  const secondTerminal = new Promise<string>((resolve) => {
    resolveSecond = resolve;
  });
  transport = startTransport(resolveSecond);
  await transport.start(buildExperimentalInitialize("0.0.0"));
  const resumed = (await transport.request(
    "thread/resume",
    buildThreadResumeRequest(expectedThread, policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
  )) as { thread?: { id?: string } };
  assert.equal(resumed.thread?.id, expectedThread);
  step = "second-turn";
  await transport.request(
    "turn/start",
    buildTurnStartRequest(
      expectedThread,
      "dynamic-resume-second",
      {
        text: "Call tools.codex_video_edit__editor_probe({value:'probe'}) exactly once again, then confirm its result.",
      },
      policy,
    ),
  );
  await waitTurn(secondTerminal);
  counts.secondCompleted = true;
  assert.equal(counts.second, 1);
  assert.equal(counts.foreign, 0);
  await writeFile(
    join(root, "resume-result.json"),
    JSON.stringify({ status: "pass", ...counts }),
  );
  console.log(JSON.stringify({ status: "pass", ...counts }));
} catch {
  await writeFile(
    join(root, "resume-result.json"),
    JSON.stringify({ status: "fail", step, ...counts }),
  );
  console.error(JSON.stringify({ status: "fail", step, ...counts }));
  process.exitCode = 1;
} finally {
  await transport?.close();
}
