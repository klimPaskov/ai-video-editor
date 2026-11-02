/**
 * Packaged native Claude settings (docs/51, M3 and M4): which material
 * Claude may use, and the rough cut's own model.
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
 * node tests/native/asset-setting.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { openFullEditor } from "./disclosures.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-asset-setting-"));
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
  JSON.stringify({ kind: "slow_reply" }),
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
  scope: "M3-native-asset-setting",
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
  await openFullEditor(page);
  await expect(page.locator("#edit-actions")).toBeVisible();
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
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

  step = "settings";
  // Default: any material.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-claude").click();
  await expect(page.locator("#asset-policy")).toHaveValue("any");
  await page.locator("#asset-policy").selectOption("copyright_free");
  await expect
    .poll(async () => {
      const reply = await page.evaluate(() => window.desktop.getPreferences());
      return reply.ok ? (reply.value.assetPolicy ?? "any") : "error";
    })
    .toBe("copyright_free");
  // Production defaults to Sonnet; the rough cut has its own model, Haiku by
  // default, changeable.
  await expect(page.locator("#claude-model")).toHaveValue("sonnet");
  await expect(page.locator("#claude-rough-cut-model")).toHaveValue("haiku");
  await page.locator("#claude-rough-cut-model").selectOption("default");
  await expect
    .poll(
      async () => {
        const reply = await page.evaluate(() => window.desktop.getClaude());
        return reply.ok
          ? (reply.value.roughCutSelection?.model ?? null)
          : "error";
      },
      { timeout: 20_000 },
    )
    .toBe("default");
  await expect(page.locator("#claude-model")).toHaveValue("sonnet");
  result.roughCutModel = { default: "haiku", chosen: "default" };
  await page.screenshot({ path: join(evidence, "asset-setting.png") });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-claude").click();
  await expect(page.locator("#asset-policy")).toHaveValue("copyright_free");
  await expect(page.locator("#claude-rough-cut-model")).toHaveValue("default");
  await page.getByRole("button", { name: "Close settings" }).click();

  step = "turn";
  await page.locator("#codex-thread-input").fill("Pick some music.");
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(async () => (await thread()).status, { timeout: 60_000 })
    .toBe("ready");
  const args = (await readFile(join(claudeConfig, "fake-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args?: string[] })
    .filter((entry) => entry.args?.includes("--system-prompt"))
    .at(-1)!.args!;
  assert.match(
    args[args.indexOf("--system-prompt") + 1]!,
    /copyright-free material only/u,
  );
  result.assetSetting = { savedAndRestored: true, inSystemPrompt: true };
  assert.equal(sha(await readFile(sourcePath)), sourceHash);
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
