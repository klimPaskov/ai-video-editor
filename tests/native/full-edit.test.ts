/**
 * Packaged native full AI edit with a scripted assistant (P12-04/P12-06).
 *
 * A clearly labeled test double of the Claude Code CLI
 * (tests/media/support/fake-claude-code.ts) stands in for the model: it drives
 * the app's real editor MCP server exactly as a model would (read the
 * timeline, add a title graphic, look at a rendered picture). The packaged
 * app runs everything else for real: Claude Code discovery, the restricted
 * turn and tool inventory check, the guarded transaction, offscreen frame
 * rendering, the full-edit record, Undo all and the drawer UI. It proves no
 * model quality and no account sign-in.
 *
 * node tests/native/full-edit.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-full-edit-"));
const configRoot = join(evidence, "config");
const claudeConfig = join(
  configRoot,
  appIdentity.slug,
  "claude",
  "claude-code",
);
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

// The scripted CLI starts signed in, so no account is involved.
await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
await writeFile(
  join(claudeConfig, "fake-state.json"),
  JSON.stringify({ loggedIn: true, method: "claude.ai" }),
);
await writeFile(
  join(claudeConfig, "fake-scenario.json"),
  JSON.stringify({ kind: "scripted_full_edit" }),
);
const bin = join(evidence, "bin");
await mkdir(bin, { mode: 0o700 });
await writeFile(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${resolve("tests/media/support/fake-claude-code.ts")}" "$@"\n`,
);
await chmod(join(bin, "claude"), 0o700);

const sourcePath = join(evidence, "Demo.mp4");
await runProcess({
  executable: "ffmpeg",
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-g",
    "60",
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-shortest",
    sourcePath,
  ],
  timeoutMs: 120_000,
});
const sourceHash = sha(await readFile(sourcePath));

let step = "launch";
const result: Record<string, unknown> = {
  scope: "P12-native-full-edit",
  scriptedAssistant: true,
};
const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  await electron.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    });
  }, sourcePath);
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  const journal = join(
    configRoot,
    appIdentity.slug,
    "project-store",
    project.id,
    "draft",
    "journal",
  );
  const records = async () =>
    Promise.all(
      (await readdir(journal).catch(() => [])).sort().map(
        async (name) =>
          JSON.parse(await readFile(join(journal, name), "utf8")) as {
            origin: string;
            kind: string;
            operations: Array<{ operation_type: string }>;
          },
      ),
    );

  step = "open";
  await expect
    .poll(
      async () => {
        const reply = await page.evaluate(() => window.desktop.getClaude());
        return reply.ok ? reply.value.status : "error";
      },
      { timeout: 60_000 },
    )
    .toBe("signed_in");
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const request = { schema_version: "1.0" as const, project_id: project.id };
  const thread = async () => {
    const reply = await page.evaluate(
      (value) => window.desktop.getClaudeThread(value),
      request,
    );
    assert.ok(reply.ok);
    return reply.value;
  };
  await expect
    .poll(async () => (await thread()).status, { timeout: 30_000 })
    .toBe("ready");
  await expect(page.locator("#claude-full-edit")).toBeVisible();
  await expect(page.locator("#start-full-edit")).toHaveText("Edit with Claude");

  step = "run";
  await page.locator("#claude-full-edit summary").click();
  await page.locator("#full-edit-goal").fill("A short product update");
  await page.locator("#full-edit-style").fill("Calm and clean");
  await page.locator("#start-full-edit").click();
  await expect
    .poll(async () => (await thread()).fullEdit?.status ?? null, {
      timeout: 180_000,
    })
    .toBe("finished");
  const finished = await thread();
  assert.equal(finished.status, "ready", finished.message ?? "");
  assert.deepEqual(finished.fullEdit, {
    status: "finished",
    changes: 1,
    undoable: true,
  });
  assert.equal(
    finished.messages.at(-2)?.text,
    "Edit with Claude · Polished · A short product update",
  );
  assert.equal(
    finished.messages.at(-1)?.text,
    "Added an opening title and checked it.",
  );
  await expect(page.locator(".timeline-graphic")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator("#full-edit-result")).toBeVisible();
  await expect(page.locator("#full-edit-changes")).toHaveText(
    "Full edit: 1 change",
  );
  await expect(page.locator("#start-full-edit")).toHaveText(
    "Polish with Claude",
  );
  const applied = await records();
  assert.deepEqual(
    applied.map((record) => [
      record.origin,
      record.kind,
      record.operations[0]?.operation_type ?? null,
    ]),
    [["claude", "apply", "graphic"]],
  );
  // The assistant's picture tool returned a rendered JPEG of the edit.
  const log = (await readFile(join(claudeConfig, "fake-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(log.find((entry) => entry.scriptedError) ?? null, null);
  const picture = log.find((entry) => entry.scriptedPicture)
    ?.scriptedPicture as { mimeType: string; bytes: number } | undefined;
  assert.equal(picture?.mimeType, "image/jpeg");
  assert.ok((picture?.bytes ?? 0) > 1000);
  const jpeg = await readFile(join(claudeConfig, "scripted-picture.jpg"));
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  await writeFile(join(evidence, "assistant-picture.jpg"), jpeg);
  await page.screenshot({ path: join(evidence, "full-edit-finished.png") });
  result.run = { changes: 1, pictureBytes: picture?.bytes };

  step = "undo-all";
  await page.locator("#undo-full-edit").click();
  await expect(page.locator(".timeline-graphic")).toHaveCount(0, {
    timeout: 30_000,
  });
  // Everything is undone, so the next run is a fresh full edit.
  await expect
    .poll(async () => (await thread()).fullEdit, { timeout: 30_000 })
    .toBe(null);
  await expect(page.locator("#start-full-edit")).toHaveText("Edit with Claude");
  const after = await records();
  assert.deepEqual(after.at(-1) && [after.at(-1)!.origin, after.at(-1)!.kind], [
    "manual",
    "undo",
  ]);
  await expect(page.locator("#full-edit-result")).toBeHidden();
  await page.screenshot({ path: join(evidence, "full-edit-undone.png") });
  result.undoAll = true;

  assert.equal(sha(await readFile(sourcePath)), sourceHash);
  result.sourceUnchanged = true;
  result.step = "complete";
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result }, null, 2),
  ).catch(() => undefined);
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}
