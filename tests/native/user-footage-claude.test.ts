/**
 * Packaged native full AI edit by a real, signed-in Claude on the user's own
 * two recordings (P10 with Claude, docs/40 and docs/50).
 *
 * node tests/native/user-footage-claude.test.ts <packaged-executable>
 *   <claude-bin-dir> <profile-config-root> <first.mp4> <second.mp4> [--export]
 *
 * The profile is a private config root whose Claude Code sign-in the user
 * completed themselves (docs/48); no credential is copied. The run imports the
 * recordings in order, runs Magic Edit (which also transcribes), then Edit
 * with Claude (Polished) with a light brief, and records what changed. With
 * --export it also exports and verifies the lossless master. Footage,
 * transcripts, screenshots and the conversation stay in the guest; only
 * aggregate facts are printed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";

await assertNativeTestEnvironment();
const [executablePath, claudeBin, profileRoot, firstPath, secondPath] =
  process.argv.slice(2);
assert.ok(
  executablePath && claudeBin && profileRoot && firstPath && secondPath,
  "Executable, Claude bin directory, profile and both recordings are required",
);
const exportMaster = process.argv.includes("--export");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-footage-claude-"));
const configRoot = resolve(profileRoot);
const userData = join(configRoot, appIdentity.slug);
const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const originals = [firstPath, secondPath].map((path) => resolve(path));
const originalHashes = await Promise.all(originals.map(fileHash));
let step = "launch";
const result: Record<string, unknown> = {
  scope: "P10-user-footage-claude-full-edit",
  assistant: "Claude (signed in, real model)",
};
const marks: Array<[string, number]> = [];
const mark = (name: string) => {
  step = name;
  marks.push([name, elapsed()]);
  console.log(JSON.stringify({ step: name, seconds: elapsed() }));
};

const launch = () =>
  _electron.launch({
    executablePath,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configRoot,
      PATH: `${resolve(claudeBin)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
    chromiumSandbox: true,
    timeout: 60_000,
  });

async function dialogs(electron: ElectronApplication, save: string | null) {
  await electron.evaluate(
    ({ dialog }, value) => {
      let index = 0;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.sources[index++]!],
      });
      dialog.showSaveDialog = async () =>
        value.save
          ? { canceled: false, filePath: value.save }
          : { canceled: true, filePath: "" };
    },
    { sources: originals, save },
  );
}

let electron = await launch();
let projectId: string | null = null;
async function project(page: Page) {
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const found = listed.value.find((view) => view.id === projectId);
  assert.ok(found, "the run's project is listed");
  return found;
}
async function seek(page: Page, us: number) {
  await page.evaluate((value) => {
    const control = document.querySelector<HTMLInputElement>("#seek")!;
    control.value = String(value);
    control.dispatchEvent(new Event("input"));
  }, us);
  await expect(page.locator("#preview-message")).toBeHidden({
    timeout: 120_000,
  });
}

try {
  await dialogs(electron, null);
  let page = await electron.firstWindow();
  // The app checks Claude Code's status after launch.
  await expect
    .poll(
      async () => {
        const reply = await page.evaluate(() => window.desktop.getClaude());
        return reply.ok ? reply.value.status : "error";
      },
      { timeout: 120_000 },
    )
    .toBe("signed_in");

  mark("import");
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  const known = new Set(before.value.map((view) => view.id));
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await page
    .getByRole("button", { name: "Add footage" })
    .click({ timeout: 600_000 });
  await expect(page.getByRole("button", { name: "Add footage" })).toBeHidden({
    timeout: 600_000,
  });
  await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  projectId = listed.value.find(
    (view) => !known.has(view.id) && view.sources?.length === 2,
  )!.id;
  let current = await project(page);
  const folder = join(userData, "project-store", current.id);
  const baselineBytes = await readFile(join(folder, "baseline.json"));
  const baseline = JSON.parse(baselineBytes.toString("utf8")) as {
    sources: Array<{ managed_path: string; sha256: string }>;
  };
  assert.deepEqual(
    baseline.sources.map((source) => source.sha256),
    originalHashes,
  );
  const originalDurationUs = current.timeline.durationUs;
  result.imported = { sources: 2, inOrder: true };

  mark("magic-edit");
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await page.locator("#magic-start").click();
  await expect(page.locator("#magic-status")).toContainText("Removed", {
    timeout: 4 * 3_600_000,
  });
  current = await project(page);
  const afterMagicUs = current.timeline.durationUs;
  result.magicEdit = {
    removedSeconds: Math.round((originalDurationUs - afterMagicUs) / 1e6),
  };

  mark("claude-full-edit");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible({ timeout: 300_000 });
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const request = { schema_version: "1.0" as const, project_id: current.id };
  const thread = async () => {
    const reply = await page.evaluate(
      (value) => window.desktop.getClaudeThread(value),
      request,
    );
    assert.ok(reply.ok);
    return reply.value;
  };
  await expect
    .poll(async () => (await thread()).status, { timeout: 120_000 })
    .toBe("ready");
  await page.locator("#claude-full-edit summary").click();
  await page.locator("#full-edit-style").fill("Calm and clean");
  await page.locator("#full-edit-level").selectOption("polished");
  await page.screenshot({ path: join(evidence, "full-edit-brief.png") });
  await page.locator("#start-full-edit").click();
  const journal = join(folder, "draft", "journal");
  const records = async () =>
    Promise.all(
      (await readdir(journal).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(
          async (name) =>
            JSON.parse(await readFile(join(journal, name), "utf8")) as {
              origin: string;
              kind: string;
              operations: Array<{ operation_type: string }>;
            },
        ),
    );
  let shot = 0;
  let lastLog = 0;
  let view = await thread();
  for (;;) {
    view = await thread();
    if (view.fullEdit?.status !== "running" && view.status !== "running") break;
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      const claudeEdits = (await records()).filter(
        (record) => record.origin === "claude",
      ).length;
      console.log(
        JSON.stringify({
          seconds: elapsed(),
          status: view.status,
          changes: view.fullEdit?.changes ?? 0,
          claudeTransactions: claudeEdits,
        }),
      );
      if (shot < 12)
        await page.screenshot({
          path: join(
            evidence,
            `running-${String(++shot).padStart(2, "0")}.png`,
          ),
        });
    }
    if (elapsed() > 4 * 3600) throw new Error("The full edit ran too long.");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const applied = await records();
  const claudeOps: Record<string, number> = {};
  for (const record of applied)
    if (record.origin === "claude")
      for (const operation of record.operations)
        claudeOps[operation.operation_type] =
          (claudeOps[operation.operation_type] ?? 0) + 1;
  current = await project(page);
  result.fullEdit = {
    status: view.fullEdit?.status ?? null,
    threadStatus: view.status,
    message: view.message,
    changes: view.fullEdit?.changes ?? 0,
    undoable: view.fullEdit?.undoable ?? false,
    claudeOperations: claudeOps,
    finalSummaryLength: view.messages.at(-1)?.text.length ?? 0,
    editedSeconds: Math.round(current.timeline.durationUs / 1e6),
    graphics: current.graphics?.length ?? 0,
  };
  console.log(JSON.stringify({ fullEdit: result.fullEdit }));
  await page.screenshot({ path: join(evidence, "full-edit-finished.png") });
  await page.locator("#close-codex").click();
  // Pictures across the edit for review.
  for (const fraction of [0.02, 0.1, 0.25, 0.5, 0.75, 0.95]) {
    await seek(page, Math.round(current.timeline.durationUs * fraction));
    await page.screenshot({
      path: join(evidence, `review-${Math.round(fraction * 100)}.png`),
    });
  }

  mark("reopen");
  const head = {
    sequence: current.draft.sequence,
    sha: current.draft.timelineSha256,
  };
  await electron.close();
  electron = await launch();
  await dialogs(electron, null);
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${current.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
  current = await project(page);
  assert.deepEqual(
    { sequence: current.draft.sequence, sha: current.draft.timelineSha256 },
    head,
  );
  result.reopened = true;

  if (exportMaster) {
    mark("export-master");
    const master = join(evidence, "Claude edit master.mkv");
    await dialogs(electron, master);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator("#export-profile")).toHaveValue(
      "lossless_master",
    );
    await page.locator("#export-start").click();
    await expect(page.locator("#export-done")).toBeVisible({
      timeout: 8 * 3_600_000,
    });
    const done = await page.evaluate(
      (id) =>
        window.desktop.getExport({ schema_version: "1.0", project_id: id }),
      current.id,
    );
    assert.ok(done.ok);
    assert.equal(done.value.result?.samplesEqual, true);
    await page.screenshot({ path: join(evidence, "export-master.png") });
    result.master = { appVerifiedSampleEquality: true };
  }

  mark("immutability");
  assert.deepEqual(await Promise.all(originals.map(fileHash)), originalHashes);
  for (const [index, source] of baseline.sources.entries())
    assert.equal(await fileHash(source.managed_path), originalHashes[index]);
  assert.deepEqual(
    await readFile(join(folder, "baseline.json")),
    baselineBytes,
  );
  result.sourcesUnchanged = true;
  result.step = "complete";
  result.marks = marks;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result, marks }, null, 2),
  ).catch(() => undefined);
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}
