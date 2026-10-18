/**
 * Packaged native HyperFrames composition graphic (ADR 0021), placed by a
 * scripted assistant.
 *
 * A clearly labeled test double of the Claude Code CLI
 * (tests/media/support/fake-claude-code.ts) stands in for the model: it drives
 * the app's real editor MCP server exactly as a model would (read the
 * timeline, add a title graphic, look at a rendered picture). The packaged
 * app runs everything else for real: Claude Code discovery, the restricted
 * turn and tool inventory check, the guarded transaction, offscreen frame
 * rendering, the composition import and its sealed frame with the vendored
 * HyperFrames runtime and GSAP fetched once from jsDelivr. It proves no
 * model quality and no account sign-in.
 *
 * node tests/native/composition.test.ts <packaged-executable>
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
const evidence = await mkdtemp(join(evidenceRoot, "native-composition-"));
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
  JSON.stringify({ kind: "scripted_composition" }),
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
  scope: "ADR-0021-native-composition",
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

  step = "place";
  await page
    .locator("#codex-thread-input")
    .fill("Place the sweep composition.");
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(async () => (await thread()).status, { timeout: 180_000 })
    .toBe("ready");
  const finished = await thread();
  assert.equal(finished.message, null, finished.message ?? "");
  const log = (await readFile(join(claudeConfig, "fake-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(log.find((entry) => entry.scriptedError) ?? null, null);
  // composition.check ran the real sealed stage: the sweep is clean and
  // moves; the flawed one has its held, cut-off, too-small headline found.
  const checked = log.find((entry) => entry.scriptedCheck)?.scriptedCheck as {
    sweep: {
      ok: boolean;
      duration_us: number | null;
      moving: string;
      findings: string[];
      sheet: boolean;
    };
    edge: { ok: boolean; findings: string[] };
  };
  assert.ok(checked, "composition.check was not called");
  assert.deepEqual(checked.sweep, {
    ok: true,
    duration_us: 2_000_000,
    moving: "7 of 7",
    findings: [],
    sheet: true,
  });
  assert.equal(checked.edge.ok, false);
  assert.ok(checked.edge.findings.includes("text_cut_off:error"));
  assert.ok(checked.edge.findings.includes("text_too_small:warning"));
  await writeFile(
    join(evidence, "composition-check-sheet.jpg"),
    await readFile(join(claudeConfig, "scripted-check-sheet.jpg")),
  );
  result.check = checked;
  // The flawed composition loads a pinned Fontsource font: it is sealed
  // into the stored page, not fetched at render time.
  const stored = join(configRoot, appIdentity.slug, "compositions");
  const pages = await Promise.all(
    (await readdir(stored))
      .filter((name) => name.endsWith(".html"))
      .map((name) => readFile(join(stored, name), "utf8")),
  );
  const typed = pages.find((html) => html.includes("Cut off headline"));
  assert.ok(typed, "the checked composition was not stored");
  assert.match(typed, /font-family: 'Inter'/u);
  assert.match(typed, /url\("data:font\/woff2;base64,[A-Za-z0-9+/]{200,}/u);
  assert.doesNotMatch(typed, /fontsource|\.woff\)/u);
  result.font = { sealed: true };
  assert.deepEqual(
    (await records()).map((record) => [
      record.origin,
      record.operations[0]?.operation_type ?? null,
    ]),
    [["claude", "graphic"]],
  );
  await expect(page.locator(".timeline-graphic")).toHaveCount(1, {
    timeout: 30_000,
  });
  // The preview plays it in a sealed frame on the composition host.
  const frameSource = await page.evaluate(() => {
    const stage = document.querySelector<HTMLIFrameElement>(
      "iframe.graphics-stage, iframe[src*='stage.html']",
    );
    const inner = stage?.contentDocument?.querySelector("#stage iframe");
    return inner
      ? {
          src: inner.getAttribute("src"),
          sandbox: inner.getAttribute("sandbox"),
        }
      : null;
  });
  assert.match(
    frameSource?.src ?? "",
    /:\/\/composition\/[a-f0-9]{64}\.html$/u,
  );
  assert.equal(frameSource?.sandbox, "allow-scripts");
  await page.screenshot({ path: join(evidence, "composition-preview.png") });

  step = "picture";
  // The picture at 1 s, rendered by the export path: the box has moved to
  // x 100–180 (y 40–120); it was at 0–80 when it started.
  const jpeg = await readFile(join(claudeConfig, "scripted-picture.jpg"));
  await writeFile(join(evidence, "composition-picture.jpg"), jpeg);
  const pixels = (
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        join(evidence, "composition-picture.jpg"),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      timeoutMs: 60_000,
    })
  ).stdout;
  const at = (x: number, y: number) => {
    const offset = (y * 320 + x) * 3;
    return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
  };
  // The box is orange, a colour the test pattern underneath never shows.
  const red = ([r, g, b]: number[]) =>
    Math.abs(r! - 250) < 30 &&
    Math.abs(g! - 140) < 30 &&
    Math.abs(b! - 20) < 40;
  assert.ok(red(at(140, 80)), `moved box missing: ${at(140, 80)}`);
  assert.ok(!red(at(40, 80)), `box did not move: ${at(40, 80)}`);
  result.picture = { movedBox: true };
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
