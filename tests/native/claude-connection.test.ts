/**
 * Packaged native Claude connection test for the isolated guest.
 *
 * node tests/native/claude-connection.test.ts <packaged-executable> <claude-bin-dir>
 *   [--profile <config-root>] [--hold-sign-in] [--require-signed-in] [--inspect]
 *
 * <claude-bin-dir> contains the official, unmodified `claude` executable. The
 * signed-out path always runs: runtime detection, Anthropic browser sign-in
 * initiation by the real CLI, the fallback page, cancellation, the default
 * drawer route and its sign-in gate. A signed-in profile (created by the user
 * completing Anthropic's sign-in during --hold-sign-in) additionally runs a
 * real Claude edit, shared Undo, Stop and restart. No credential is copied.
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
const claudeBin = process.argv[3];
assert.ok(executablePath, "Packaged executable path is required");
assert.ok(
  claudeBin,
  "Directory containing the official claude CLI is required",
);
await access(join(claudeBin, "claude"));
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const holdSignIn = process.argv.includes("--hold-sign-in");
const requireSignedIn = process.argv.includes("--require-signed-in");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-claude-"));
const configRoot = option("--profile")
  ? resolve(option("--profile")!)
  : join(evidence, "config");
await mkdir(configRoot, { recursive: true, mode: 0o700 });
const userData = join(configRoot, appIdentity.slug);
const claudeConfig = join(userData, "claude", "claude-code");
let step = "setup";

// The real CLI opens the browser through xdg-open. This guest stub records
// only the host; the full sign-in URL is kept privately for --hold-sign-in.
const stubDirectory = join(evidence, "browser-stub");
await mkdir(stubDirectory, { mode: 0o700 });
const browserLog = join(evidence, "browser-open.log");
const privateUrl = join(evidence, "private-sign-in-url.txt");
await writeFile(
  join(stubDirectory, "xdg-open"),
  `#!/bin/sh\nprintf '%s\\n' "$1" | sed -E 's#^https://([^/]+)/.*#\\1#' >> '${browserLog}'\nif [ -n "$CLAUDE_TEST_KEEP_URL" ]; then umask 077; printf '%s\\n' "$1" > '${privateUrl}'; fi\n`,
  { mode: 0o700 },
);
await chmod(join(stubDirectory, "xdg-open"), 0o700);

const width = 96;
const height = 64;
const video = Buffer.alloc(width * height * 4 * 3);
for (let frame = 0; frame < 3; frame++)
  for (let pixel = 0; pixel < width * height; pixel++)
    video.set(
      [30 + frame * 60, 90, 200 - frame * 60, 255],
      (frame * width * height + pixel) * 4,
    );
const videoPath = join(evidence, "canonical.bgra");
const audioPath = join(evidence, "canonical.s16le");
const sourcePath = join(evidence, "claude-fixture.mkv");
await writeFile(videoPath, video, { mode: 0o600 });
await writeFile(audioPath, Buffer.alloc(72_000 * 2), { mode: 0o600 });
await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width,
      height,
      frameRate: { numerator: 2, denominator: 1 },
      pixelFormat: "bgra",
      color: {
        range: "pc",
        space: "gbr",
        primaries: "bt709",
        transfer: "bt709",
      },
      audio: { format: "s16le", sampleRate: 48_000, channelLayout: "mono" },
    },
  },
  sourcePath,
);
const sourceHash = sha256(await readFile(sourcePath));

const env = {
  ...process.env,
  XDG_CONFIG_HOME: configRoot,
  PATH: `${stubDirectory}:${resolve(claudeBin)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  ...(holdSignIn ? { CLAUDE_TEST_KEEP_URL: "1" } : {}),
};
const launch = () =>
  _electron.launch({
    executablePath,
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  });

async function prepare(electron: ElectronApplication): Promise<void> {
  await electron.evaluate(({ dialog, shell }, source) => {
    const opened: string[] = [];
    (globalThis as { __openedHosts?: string[] }).__openedHosts = opened;
    shell.openExternal = async (url: string) => {
      opened.push(new URL(url).hostname);
    };
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    });
  }, sourcePath);
}

async function openedHosts(electron: ElectronApplication): Promise<string[]> {
  return electron.evaluate(
    () => (globalThis as { __openedHosts?: string[] }).__openedHosts ?? [],
  );
}

async function claudeState(page: Page) {
  const reply = await page.evaluate(() => window.desktop.getClaude());
  assert.ok(reply.ok, "Claude state must be readable");
  return reply.value;
}

async function browserHosts(): Promise<string[]> {
  try {
    return (await readFile(browserLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function credentialFiles(): Promise<string[]> {
  try {
    return (await readdir(claudeConfig)).filter((name) =>
      name.includes("credential"),
    );
  } catch {
    return [];
  }
}

async function hold(name: string): Promise<void> {
  if (!process.argv.includes("--inspect")) return;
  await writeFile(join(evidence, `${name}.ready`), "ready\n", { mode: 0o600 });
  console.log(JSON.stringify({ inspectionReady: name, evidence }));
  const done = join(evidence, `${name}.done`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await access(done);
      return;
    } catch {
      await delay(250);
    }
  }
  await access(done);
}

const result: Record<string, unknown> = {
  scope: "P2-11-claude-connection",
  claudeCodeVersion: null,
  runtimeDetected: false,
  signedOutSettings: false,
  officialBrowserSignInStarted: false,
  fallbackPageAnthropicOnly: false,
  cancelledSignIn: false,
  noCredentialFilesAfterCancel: false,
  claudeDefaultDrawer: false,
  signInGate: false,
  signedIn: false,
  signedInAcceptance: false,
  computerUse: false,
};

let electron = await launch();
try {
  await prepare(electron);
  let page = await electron.firstWindow();
  await expect(
    page.getByRole("button", { name: "Import video", exact: true }),
  ).toBeVisible();
  step = "claude-settings";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect
    .poll(async () => (await claudeState(page)).status, { timeout: 90_000 })
    .not.toBe("checking");
  let state = await claudeState(page);
  assert.notEqual(state.status, "unavailable", "Claude Code must be detected");
  assert.notEqual(state.status, "error");
  result.runtimeDetected = true;
  result.claudeCodeVersion = state.version;

  if (state.status === "signed_out") {
    await expect(page.locator("#claude-account")).toHaveText(
      "Sign in to use Claude",
    );
    await expect(page.locator("#claude-sign-in")).toBeVisible();
    await expect(page.locator("#claude-model-settings")).toBeHidden();
    await expect(page.locator("#claude-disclosure")).toContainText(
      "never receives your password",
    );
    result.signedOutSettings = true;
    await page.screenshot({ path: join(evidence, "claude-signed-out.png") });
    await hold("signed-out-settings");

    step = "official-sign-in";
    await page.locator("#claude-sign-in").click();
    await expect(page.locator("#claude-account")).toHaveText(
      "Finish signing in in your browser…",
      { timeout: 30_000 },
    );
    await expect
      .poll(browserHosts, { timeout: 60_000 })
      .toContain("claude.com");
    result.officialBrowserSignInStarted = true;
    await expect(page.locator("#claude-open-sign-in")).toBeVisible({
      timeout: 30_000,
    });
    await page.locator("#claude-open-sign-in").click();
    await expect
      .poll(async () => openedHosts(electron), { timeout: 30_000 })
      .toEqual(["claude.com"]);
    result.fallbackPageAnthropicOnly = (await browserHosts()).every(
      (host) => host === "claude.com",
    );
    await page.screenshot({ path: join(evidence, "claude-signing-in.png") });
    await hold("signing-in");

    if (holdSignIn) {
      step = "await-user-sign-in";
      console.log(
        JSON.stringify({
          action:
            "Open the private sign-in URL in a browser and complete Anthropic's sign-in.",
          privateUrlFile: privateUrl,
        }),
      );
      await expect
        .poll(async () => (await claudeState(page)).status, {
          timeout: 15 * 60_000,
          intervals: [2000],
        })
        .toBe("signed_in");
    } else {
      step = "cancel-sign-in";
      await page.locator("#claude-cancel-sign-in").click();
      await expect(page.locator("#claude-account")).toHaveText(
        "Sign in to use Claude",
        { timeout: 30_000 },
      );
      await expect(page.locator("#claude-error")).toBeHidden();
      result.cancelledSignIn = true;
      assert.deepEqual(await credentialFiles(), []);
      result.noCredentialFilesAfterCancel = true;
    }
  }
  state = await claudeState(page);
  result.signedIn = state.status === "signed_in";
  if (requireSignedIn) assert.equal(state.status, "signed_in");
  if (state.status === "signed_in") {
    await expect(page.locator("#claude-model-settings")).toBeVisible();
    assert.ok(state.models.length > 0);
    assert.ok(state.selection, "A runtime model must be selected");
    await page.screenshot({ path: join(evidence, "claude-signed-in.png") });
  }
  await page.getByRole("button", { name: "Close settings" }).click();

  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  const projectFolder = join(userData, "project-store", project.id);
  const baselineBytes = await readFile(join(projectFolder, "baseline.json"));

  step = "default-drawer";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Claude conversation" }),
  ).toBeVisible();
  await expect(page.locator("#assistant-provider")).toHaveValue("claude");
  await expect(page.locator("#claude-context-notice")).toBeVisible();
  result.claudeDefaultDrawer = true;
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  if (state.status !== "signed_in") {
    await expect(page.locator("#codex-thread-error")).toHaveText(
      "Sign in to Claude in Settings to continue.",
      { timeout: 30_000 },
    );
    await expect(page.locator("#codex-thread-messages p")).toHaveCount(0);
    result.signInGate = true;
    await page.screenshot({ path: join(evidence, "claude-drawer-gate.png") });
    await hold("drawer-gate");
  } else {
    const request = { schema_version: "1.0" as const, project_id: project.id };
    const thread = async () => {
      const reply = await page.evaluate(
        (value) => window.desktop.getClaudeThread(value),
        request,
      );
      assert.ok(reply.ok);
      return reply.value;
    };
    const records = async (): Promise<DraftTransactionRecord[]> => {
      const folder = join(projectFolder, "draft", "journal");
      const names = (await readdir(folder).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .sort();
      return Promise.all(
        names.map(
          async (name) =>
            JSON.parse(
              await readFile(join(folder, name), "utf8"),
            ) as DraftTransactionRecord,
        ),
      );
    };
    await expect
      .poll(async () => (await thread()).status, { timeout: 60_000 })
      .toBe("ready");
    step = "claude-split";
    const prompt =
      "Use the AI Video Editor tools to read the project and timeline, then split the only clip at exactly 500000 microseconds on the output timeline. Apply exactly one split and no other edit, read the timeline again to confirm, then reply in one short sentence.";
    await page.locator("#codex-thread-input").fill(prompt);
    await page.locator("#send-codex-thread").click();
    let committedDuringTurn = false;
    let sawActivity = false;
    await expect
      .poll(
        async () => {
          const view = await thread();
          if (view.activities.length) sawActivity = true;
          const split = (await records()).find(
            (record) =>
              record.origin === "claude" &&
              record.status === "committed" &&
              record.after.timeline.clips.length === 2,
          );
          if (split && view.status === "running") committedDuringTurn = true;
          if (view.status === "failed")
            throw new Error(`Claude turn failed: ${view.message ?? "unknown"}`);
          return view.status === "ready" && Boolean(split);
        },
        { timeout: 300_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    const journal = await records();
    assert.equal(journal.length, 1, "Exactly one Claude transaction");
    assert.equal(journal[0]!.origin, "claude");
    assert.equal(journal[0]!.operations[0]?.operation_type, "split");
    const finished = await thread();
    assert.equal(finished.messages.at(-1)?.role, "assistant");
    const projected = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(projected.ok);
    assert.equal(
      projected.value.find((item) => item.id === project.id)?.clips?.length,
      2,
    );
    await page.screenshot({ path: join(evidence, "claude-split.png") });
    await hold("claude-split");

    step = "shared-undo";
    await page.locator("#close-codex").click();
    await page.locator("#undo-edit").click();
    await expect
      .poll(async () => (await records()).length, { timeout: 60_000 })
      .toBe(2);
    const undone = (await records())[1]!;
    assert.equal(undone.origin, "manual");
    assert.equal(undone.kind, "undo");
    assert.equal(undone.after.timeline.clips.length, 1);

    step = "claude-stop";
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    await expect
      .poll(async () => (await thread()).status, { timeout: 30_000 })
      .toBe("ready");
    await page
      .locator("#codex-thread-input")
      .fill(
        "Without editing anything, read the project summary and the timeline summary one call at a time, six times each, then reply with the clip count.",
      );
    await page.locator("#send-codex-thread").click();
    await expect
      .poll(async () => (await thread()).status, { timeout: 60_000 })
      .toBe("running");
    await expect(page.locator("#interrupt-codex-thread")).toBeEnabled();
    await page.locator("#interrupt-codex-thread").click();
    await expect
      .poll(async () => (await thread()).message, { timeout: 60_000 })
      .toBe(
        "This turn stopped. Review the current draft before sending again.",
      );
    assert.equal((await records()).length, 2, "Stop must not change the draft");
    const messagesBefore = (await thread()).messages.length;

    step = "restart";
    await electron.close();
    electron = await launch();
    await prepare(electron);
    page = await electron.firstWindow();
    await page.locator(`#projects [data-project-id="${project.id}"]`).click();
    await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    await page
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect
      .poll(async () => (await thread()).messages.length, { timeout: 60_000 })
      .toBe(messagesBefore);
    assert.equal((await claudeState(page)).status, "signed_in");
    assert.deepEqual(
      await readFile(join(projectFolder, "baseline.json")),
      baselineBytes,
    );
    result.signedInAcceptance = {
      committedDuringTurn,
      sawActivity,
      originClaude: true,
      sharedManualUndo: true,
      stopWithoutDraftChange: true,
      historyAfterRestart: true,
    };
  }
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
  result.sourceUnchanged = true;
  result.step = "complete";
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result }, null, 2),
    { mode: 0o600 },
  ).catch(() => undefined);
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}
