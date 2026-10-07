/** Reopen one real synthetic MCP conversation after restoring its v1 registry shape. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executable = process.argv[2];
const configArgument = process.argv[3];
assert.ok(executable && isAbsolute(executable));
assert.ok(configArgument && isAbsolute(configArgument));
const configRoot = await realpath(configArgument);
assert.equal(configRoot, resolve(configArgument));
assert.ok(configRoot.startsWith("/home/node/workspaces/"));
assert.ok((await lstat(executable)).isFile());
const userData = join(configRoot, appIdentity.legacyUserDataDirectory);
const registryPath = join(
  userData,
  "codex/context/threads/project-threads.json",
);
assert.equal(await realpath(dirname(registryPath)), dirname(registryPath));
assert.equal(await realpath(registryPath), registryPath);
const registryStat = await lstat(registryPath);
assert.ok(
  registryStat.isFile() &&
    !registryStat.isSymbolicLink() &&
    registryStat.nlink === 1 &&
    !(registryStat.mode & 0o077),
);
const oldBytes = await readFile(registryPath);
const stored = JSON.parse(oldBytes.toString("utf8"));
assert.equal(stored.schemaVersion, 2);
assert.equal(stored.entries.length, 1);
const binding = stored.entries[0];
assert.equal(binding.toolRoute, "mcp");
assert.match(binding.projectId, /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u);
assert.equal(typeof binding.threadId, "string");
assert.ok(binding.threadId.length > 0);
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-route-migration-"));
await chmod(evidence, 0o700);
await writeFile(join(evidence, "registry-v2-before.json"), oldBytes, {
  mode: 0o600,
});
const legacy = `${JSON.stringify({
  schemaVersion: 1,
  entries: [{ projectId: binding.projectId, threadId: binding.threadId }],
})}\n`;
const pending = join(dirname(registryPath), `.legacy-fixture-${randomUUID()}`);
await writeFile(pending, legacy, { flag: "wx", mode: 0o600 });
await rename(pending, registryPath);

let step = "launch";
const electron = await _electron.launch({
  executablePath: executable,
  chromiumSandbox: true,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  timeout: 30000,
});
try {
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(
    await electron.evaluate(({ app }) => app.getPath("userData")),
    userData,
    "An existing per-user store survives the product rename",
  );
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  step = "account";
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return (
          result.ok &&
          result.value.connection === "connected" &&
          result.value.account === "signed_in"
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  step = "reopen-project";
  await page
    .locator(`#projects [data-project-id="${binding.projectId}"]`)
    .click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30000 });
  const request = {
    schema_version: "1.0" as const,
    project_id: binding.projectId as string,
  };
  step = "reopen-conversation";
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const thread = async () => {
    const result = await page.evaluate(
      (value) => window.desktop.getCodexThread(value),
      request,
    );
    assert.ok(result.ok);
    return result.value;
  };
  await expect
    .poll(async () => (await thread()).status, { timeout: 90000 })
    .toBe("ready");
  const resumed = await thread();
  assert.ok(resumed.messages.some((message) => message.role === "codex"));
  assert.equal(await readFile(registryPath, "utf8"), legacy);
  step = "read-only-turn";
  const beforeUserCount = resumed.messages.filter(
    (message) => message.role === "user",
  ).length;
  const beforeActivityIds = new Set(resumed.activities.map((item) => item.id));
  const beforeMessageIds = new Set(resumed.messages.map((item) => item.id));
  await page
    .locator("#codex-thread-input")
    .fill(
      "Use only project.get_summary and timeline.get_summary to read the active draft. Report its duration in microseconds. Make no edit and do not call any other tool.",
    );
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(
      async () => {
        const state = await thread();
        if (state.status === "failed" || state.status === "uncertain")
          throw new Error("Legacy MCP turn failed");
        return (
          state.status === "ready" &&
          state.messages.filter((message) => message.role === "user").length ===
            beforeUserCount + 1 &&
          state.activities.some(
            (item) =>
              !beforeActivityIds.has(item.id) &&
              item.kind === "activity" &&
              item.complete,
          ) &&
          state.messages.some(
            (message) =>
              !beforeMessageIds.has(message.id) &&
              message.role === "codex" &&
              message.complete,
          )
        );
      },
      { timeout: 180000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  assert.equal(await readFile(registryPath, "utf8"), legacy);
  const oldThreadHash = createHash("sha256")
    .update(binding.threadId)
    .digest("hex");
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      legacyRegistryUnchangedOnRead: true,
      oldThreadHash,
      completedReadOnlyTurn: true,
      packagedElectron: true,
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: "pass",
      legacyRegistryUnchangedOnRead: true,
      completedReadOnlyTurn: true,
    }),
  );
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step }),
    { mode: 0o600 },
  );
  console.error("Thread-route migration native probe failed at " + step);
  process.exitCode = 1;
} finally {
  await electron.close();
}
