/** Read-only live App Server check of the optional project-client host boundary. */
import assert from "node:assert/strict";
import { access, lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CodexClient } from "../../packages/codex-bridge/src/client.ts";
import { ProjectThreadRegistry } from "../../packages/codex-bridge/src/thread-registry.ts";

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
const host = join(dirname(executable), "codex-code-mode-host");
assert.equal(await realpath(host), host);
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

const counts = { ownedReads: 0, foreignCalls: 0, completed: 0 };
let phase = "connect";
let finish!: (status: string) => void;
const terminal = new Promise<string>((resolve) => {
  finish = resolve;
});
let timeout: ReturnType<typeof setTimeout> | undefined;
const client = new CodexClient({
  executable,
  cwd,
  codexHome: account,
  environment: process.env,
  onThreadEvent: (event) => {
    if (event.type === "turn_terminal") {
      if (event.status === "completed") counts.completed++;
      finish(event.status);
    } else if (event.type === "connection_uncertain") {
      finish("disconnected");
    }
  },
  dynamicToolInvoker: async (name, input) => {
    if (
      name !== "project.get_summary" ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (input as Record<string, unknown>).schema_version !== "1.0" ||
      (input as Record<string, unknown>).project_id !== "fixture-project"
    ) {
      counts.foreignCalls++;
      throw new Error("Unexpected host call");
    }
    counts.ownedReads++;
    return { project_id: "fixture-project", status: "read_only_probe" };
  },
});
try {
  await client.connect();
  phase = "catalog";
  assert.equal((await client.account()).status, "chatgpt");
  const models = await client.models();
  assert.ok(
    models.some(
      (model) => model.id === "gpt-6-luna" && model.reasoning.includes("high"),
    ),
  );
  phase = "thread";
  await client.openProjectThread({
    projectId: "fixture-project",
    model: "gpt-6-luna",
    effort: "high",
    baseInstructions:
      "You are testing a local video editor. Use only its owned read-only project tool. Do not use files, shell, network, apps or other tools.",
    developerInstructions:
      "Call codex_video_edit.project_get_summary once with schema_version 1.0 and project_id fixture-project, then report only its status.",
  });
  const binding = await ProjectThreadRegistry.open(join(cwd, "threads"));
  assert.equal(
    (await binding.bindingForProject("fixture-project"))?.toolRoute,
    "dynamic",
  );
  phase = "turn";
  await client.startProjectTurn({
    text: "Read this test project's summary with the owned tool and reply briefly.",
  });
  const outcome = await Promise.race([
    terminal,
    new Promise<string>((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise("timeout"), 120000);
    }),
  ]);
  clearTimeout(timeout);
  const passed =
    outcome === "completed" &&
    counts.ownedReads === 1 &&
    counts.foreignCalls === 0 &&
    counts.completed === 1;
  await writeFile(
    join(root, "dynamic-client-result.json"),
    JSON.stringify({
      status: passed ? "pass" : "fail",
      outcome,
      ...counts,
      noMcpServer: true,
      packagedElectron: false,
    }),
  );
  assert.ok(passed, "The guarded client did not complete one owned read");
  console.log(JSON.stringify({ status: "pass", ...counts }));
} catch {
  await writeFile(
    join(root, "dynamic-client-failure.json"),
    JSON.stringify({ status: "fail", phase, ...counts }),
  );
  console.error("Dynamic project-client probe failed at " + phase);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await client.close();
}
