import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import { projectStages } from "../../packages/domain/src/project-view.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";

assert.equal(
  process.platform,
  "linux",
  "Native tests require the isolated guest",
);
assert.ok(process.getuid);
assert.equal(process.getuid(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-product-"));
const video = Buffer.alloc(96 * 64 * 4 * 3);
const colors = [
  [20, 40, 180, 255],
  [30, 170, 50, 255],
  [190, 60, 30, 255],
];
for (let frame = 0; frame < 3; frame++)
  for (let i = 0; i < 96 * 64; i++) {
    for (let channel = 0; channel < 4; channel++)
      video[(frame * 96 * 64 + i) * 4 + channel] =
        channel === 3
          ? 255
          : (colors[frame]![channel]! +
              (i % 96) +
              Math.floor(i / 96) * (channel + 1)) %
            256;
  }
async function assertCanvasFrame(page: Page, frame: number): Promise<void> {
  const actual = await page.locator("canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(
        canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
          .data,
      ),
    };
  });
  assert.equal(actual.width, 96);
  assert.equal(actual.height, 64);
  const expected = Buffer.from(
    video.subarray(frame * 96 * 64 * 4, (frame + 1) * 96 * 64 * 4),
  );
  for (let i = 0; i < expected.length; i += 4) {
    const blue = expected[i]!;
    expected[i] = expected[i + 2]!;
    expected[i + 2] = blue;
  }
  assert.deepEqual(Buffer.from(actual.pixels), expected);
}
const audio = Buffer.alloc(72_000 * 2);
for (let i = 0; i < 72_000; i++)
  audio.writeInt16LE(Math.round(Math.sin(i / 20) * 6000), i * 2);
const videoPath = join(evidence, "canonical.raw"),
  audioPath = join(evidence, "canonical.pcm"),
  source = join(evidence, "Color sequence.mkv");
await writeFile(videoPath, video);
await writeFile(audioPath, audio);
const mediaEvidence = await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width: 96,
      height: 64,
      frameRate: { numerator: 2, denominator: 1 },
      pixelFormat: "bgra",
      color: {
        range: "pc",
        space: "gbr",
        primaries: "bt709",
        transfer: "bt709",
      },
      audio: { format: "s16le", sampleRate: 48000, channelLayout: "mono" },
    },
  },
  source,
);
await writeFile(
  join(evidence, "master-roundtrip.json"),
  JSON.stringify(mediaEvidence, null, 2),
);
const sourceHash = sha256(await readFile(source));
const env = { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") };
let electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30000,
});
try {
  let window = await electron.firstWindow();
  await expect(
    window.getByRole("button", { name: "Import video", exact: true }),
  ).toBeVisible();
  assert.equal(await window.title(), "AI Video Editor");
  assert.equal(window.url(), "ai-video-editor://app/index.html");
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  // Electron's sandboxed metric is macOS/Windows-only. Verify Linux kernel state.
  const renderers = await electron.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.type === "Tab")
      .map((metric) => metric.pid),
  );
  assert.ok(renderers.length > 0);
  const parentStatus = await readFile("/proc/self/status", "utf8");
  const filters = (status: string): number =>
    Number(/^Seccomp_filters:\s+(\d+)$/m.exec(status)?.[1]);
  const namespaceDepth = (status: string): number =>
    /^NSpid:\s+(.+)$/m.exec(status)![1]!.trim().split(/\s+/).length;
  for (const pid of renderers) {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(status, /^Seccomp:\s+2$/m);
    assert.ok(
      filters(status) > filters(parentStatus),
      "Renderer must add sandbox filters",
    );
    assert.ok(
      namespaceDepth(status) > namespaceDepth(parentStatus),
      "Renderer must use a nested PID namespace",
    );
  }
  assert.ok(
    !electron.process().spawnargs.some((arg) => arg.includes("--no-sandbox")),
  );
  assert.equal(
    await window.evaluate(
      () => typeof (globalThis as Record<string, unknown>).require,
    ),
    "undefined",
  );
  await electron.evaluate(({ dialog }, sourcePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [sourcePath],
    });
  }, source);
  await window
    .getByRole("button", { name: "Import video", exact: true })
    .click();
  await expect(window.locator("#frame")).toBeVisible({ timeout: 30_000 });
  await expect(window.locator("#time")).toHaveText("0:00.000");
  await expect(
    window.getByRole("button", { name: "Home", exact: true }),
  ).toBeFocused();
  await assertCanvasFrame(window, 0);
  await window.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(window.locator("#time")).toHaveText("0:00.500");
  await assertCanvasFrame(window, 1);
  const projectList = await window.evaluate(() =>
    globalThis.window.desktop.listProjects(),
  );
  assert.equal(projectList.ok, true);
  if (!projectList.ok) throw new Error("Project list failed");
  assert.equal(projectList.value.length, 1);
  const project = projectList.value[0]!;
  assert.equal(project.stage, "record_import");
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const projectFolder = join(userData, "project-store", project.id);
  const baselinePath = join(projectFolder, "baseline.json");
  const baselineBytes = await readFile(baselinePath);
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertInitialProjectSnapshot(baseline);
  assert.equal(baseline.revision.revision_id, project.revisionId);
  assert.deepEqual(baseline.timeline.frame_rate, {
    numerator: 2,
    denominator: 1,
  });
  assert.equal(baseline.timeline.duration_us, 1_500_000);
  const stageNames = [
    "Record or Import",
    "Auto Edit",
    "Edit",
    "Review",
    "Export",
  ];
  for (const [index, stage] of projectStages.entries()) {
    const control = window
      .getByRole("navigation", { name: "Project stages" })
      .getByRole("button", { name: stageNames[index]!, exact: true });
    await control.click();
    await expect(control).toHaveAttribute("aria-current", "step");
    await expect(window.locator("#time")).toHaveText("0:00.500");
    await assertCanvasFrame(window, 1);
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
    const persisted = JSON.parse(
      await readFile(join(projectFolder, "project.json"), "utf8"),
    );
    assert.equal(persisted.workflow_step, stage);
    assert.equal(persisted.current_revision_id, project.revisionId);
  }
  // A real filesystem failure must not announce an unsaved stage or alter the baseline.
  const committedMetadata = await readFile(join(projectFolder, "project.json"));
  await chmod(projectFolder, 0o500);
  try {
    await window
      .getByRole("navigation", { name: "Project stages" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await expect(window.locator("#error")).toBeVisible();
    await expect(
      window
        .getByRole("navigation", { name: "Project stages" })
        .getByRole("button", { name: "Export", exact: true }),
    ).toHaveAttribute("aria-current", "step");
    assert.deepEqual(
      await readFile(join(projectFolder, "project.json")),
      committedMetadata,
    );
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
    await assertCanvasFrame(window, 1);
  } finally {
    await chmod(projectFolder, 0o700);
  }
  const editStageButton = window
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Edit", exact: true });
  await editStageButton.click();
  await expect(editStageButton).toHaveAttribute("aria-current", "step");
  await expect(window.locator("#stage-select")).toHaveValue("edit");
  await expect(window.locator("#edit-actions")).toBeVisible();
  await window
    .getByRole("button", {
      name: "Split clip at playhead",
      exact: true,
    })
    .click();
  await expect(window.locator("#duration")).toHaveText(" / 0:01.500");
  await expect(window.locator("#undo-edit")).toBeEnabled();
  await expect(window.locator("#edit-clip")).toHaveText("Part 2");
  const reviewStageButton = window
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Review", exact: true });
  await reviewStageButton.click();
  await expect(reviewStageButton).toHaveAttribute("aria-current", "step");
  await expect(window.locator("#stage-select")).toHaveValue("review");
  await expect(window.locator("#error")).toBeHidden();
  const reviewProjectBytes = await readFile(
      join(projectFolder, "project.json"),
    ),
    integrityButton = window.getByRole("button", {
      name: "Check draft integrity",
      exact: true,
    }),
    managedSourcePath = baseline.source.managed_path,
    managedSourceBytes = await readFile(managedSourcePath);
  await expect(integrityButton).toBeVisible();
  await expect(window.locator("#draft-integrity-result")).toBeHidden();
  if (process.argv.includes("--inspect")) {
    await integrityButton.scrollIntoViewIfNeeded();
    await window.screenshot({
      path: join(evidence, "review-integrity-ready.png"),
    });
    console.log(JSON.stringify({ reviewInspectionReady: true, evidence }));
    const marker = join(evidence, "review-inspection.done"),
      deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await access(marker);
  }
  await integrityButton.click();
  await expect(window.locator("#draft-integrity-result")).toHaveText(
    "Structure and managed sources verified. Manual checkpoint recorded; meaning and A/V not reviewed.",
  );
  await expect(window.locator("#draft-integrity-error")).toBeHidden();
  assert.deepEqual(
    await readFile(join(projectFolder, "project.json")),
    reviewProjectBytes,
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(sha256(await readFile(source)), sourceHash);
  await writeFile(
    managedSourcePath,
    Buffer.concat([managedSourceBytes, Buffer.from([0])]),
  );
  try {
    await integrityButton.click();
    await expect(window.locator("#draft-integrity-error")).toHaveText(
      "Draft integrity could not be checked. Reopen the project and try again.",
    );
  } finally {
    await writeFile(managedSourcePath, managedSourceBytes);
  }
  await integrityButton.click();
  await expect(window.locator("#draft-integrity-result")).toHaveText(
    "Structure and managed sources verified. Manual checkpoint recorded; meaning and A/V not reviewed.",
  );
  await expect(window.locator("#draft-integrity-error")).toBeHidden();
  assert.deepEqual(await readFile(managedSourcePath), managedSourceBytes);
  assert.deepEqual(
    await readFile(join(projectFolder, "project.json")),
    reviewProjectBytes,
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(sha256(await readFile(source)), sourceHash);
  await window
    .getByRole("button", { name: "Source details", exact: true })
    .click();
  await expect(window.locator("#review-actions")).toBeHidden();
  await expect(
    window.getByRole("complementary", { name: "Source details" }),
  ).toBeVisible();
  await expect(
    window.getByRole("button", { name: "Close source details" }),
  ).toBeFocused();
  await window.keyboard.press("Control+,");
  await expect(
    window.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(window.locator("#inspector")).toBeHidden();
  await expect(
    window.getByLabel("Interface size", { exact: true }),
  ).toBeFocused();
  for (let index = 0; index < 6; index++) {
    await window.keyboard.press("Tab");
    assert.equal(
      await window.evaluate(() => !!document.activeElement?.closest("dialog")),
      true,
    );
  }
  await window.keyboard.press("Escape");
  await expect(window.locator("#settings-dialog")).toBeHidden();
  await expect(window.locator("#inspector")).toBeVisible();
  await expect(
    window.getByRole("button", { name: "Close source details" }),
  ).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.locator("#inspector")).toBeHidden();
  await expect(window.locator("#review-actions")).toBeVisible();
  await expect(window.locator("#draft-integrity-result")).toBeHidden();
  await expect(
    window.getByRole("button", { name: "Source details", exact: true }),
  ).toBeFocused();
  await window
    .getByRole("button", { name: "Source details", exact: true })
    .click();
  await window.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(window.locator("#review-actions")).toBeHidden();
  await expect(window.locator("#inspector")).toBeHidden();
  await expect(
    window.getByRole("complementary", { name: "Codex conversation" }),
  ).toBeVisible();
  await expect(window.locator("#codex-context-notice")).toBeVisible();
  await expect(window.locator("#codex-context-notice")).toContainText(
    "included in later turns",
  );
  await expect(window.locator("#api-turn-notice")).toBeHidden();
  await expect(window.locator("#codex-thread-status")).toBeHidden();
  await expect(window.locator("#retry-codex-thread")).toBeHidden();
  await window
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await expect(window.locator("#codex-thread-error")).toHaveText(
    "Sign in to Codex in Settings to continue.",
    { timeout: 30_000 },
  );
  await expect(
    window.locator("#codex-thread-messages").locator("p"),
  ).toHaveCount(0);
  await window.screenshot({
    path: join(evidence, "codex-drawer-signed-out.png"),
  });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const marker = join(evidence, "inspection.done"),
      deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await access(marker);
  }
  await window.locator("#assistant-provider").selectOption("deepseek");
  await expect(
    window.getByRole("complementary", { name: "DeepSeek conversation" }),
  ).toBeVisible();
  await expect(window.locator("#api-turn-notice")).toBeVisible();
  await expect(window.locator("#api-turn-notice")).toContainText(
    "included in later turns",
  );
  await expect(window.locator("#codex-context-notice")).toBeHidden();
  await window.getByRole("button", { name: "Open conversation" }).click();
  await expect(window.locator("#codex-thread-error")).toHaveText(
    "Connect and choose a provider model in Settings to continue.",
  );
  await expect(window.locator("#codex-thread-messages p")).toHaveCount(0);
  await window.screenshot({
    path: join(evidence, "api-drawer-unconnected-private.png"),
  });
  await window.locator("#assistant-provider").selectOption("codex");
  await window.getByRole("button", { name: "Close Codex" }).click();
  await expect(window.locator("#codex-drawer")).toBeHidden();
  await expect(window.locator("#review-actions")).toBeVisible();
  for (const [width, height, scale] of [
    [1366, 768, 1],
    [1366, 768, 1.5],
    [1366, 768, 2],
    [1200, 800, 2],
    [1920, 1080, 1.25],
  ]) {
    await electron.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!),
      [width!, height!],
    );
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      window.getByLabel("Interface size", { exact: true }),
    ).toBeEnabled();
    await window
      .getByLabel("Interface size", { exact: true })
      .selectOption(String(scale));
    await window.getByRole("button", { name: "Save", exact: true }).click();
    await expect(window.locator("#settings-dialog")).toBeHidden();
    assert.equal(
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
      ),
      scale,
    );
    await expect(
      window.getByRole("button", { name: "Settings", exact: true }),
    ).toBeFocused();
    assert.equal(
      await window.evaluate(
        () => document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      true,
    );
    await assertCanvasFrame(window, 1);
    await window
      .getByRole("button", { name: "Source details", exact: true })
      .click();
    assert.equal(
      await window.locator("#inspector").evaluate((node) => {
        const panel = node.getBoundingClientRect();
        const preview = document
          .querySelector(".preview")!
          .getBoundingClientRect();
        return (
          panel.left >= preview.right &&
          panel.bottom <= globalThis.innerHeight &&
          document.querySelector("header")!.getBoundingClientRect().top >= 0 &&
          document.querySelector("#frame-controls")!.getBoundingClientRect()
            .bottom <= globalThis.innerHeight
        );
      }),
      true,
    );
    await window.screenshot({
      path: join(evidence, `shell-${width}-${scale}.png`),
    });
    await window.keyboard.press("Escape");
  }
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(1366, 768),
  );
  await window.screenshot({ path: join(evidence, "native-frame-1366.png") });
  await window.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__injected=true";
    document.body.append(script);
  });
  assert.equal(
    await window.evaluate(
      () => (globalThis as Record<string, unknown>).__injected,
    ),
    undefined,
  );
  assert.equal(
    await electron.evaluate(
      async ({ net }) =>
        (await net.fetch("ai-video-editor://app/main.cjs")).status,
    ),
    404,
  );
  const foreignSenderAccepted = await electron.evaluate(
    async ({ app, BrowserWindow }) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await foreign.loadURL("ai-video-editor://app/index.html");
      try {
        await foreign.webContents.executeJavaScript(
          "window.desktop.listMedia()",
        );
        return "unexpectedly allowed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        foreign.destroy();
      }
    },
  );
  assert.match(
    foreignSenderAccepted,
    /Untrusted request/,
    "Same-origin foreign windows must not access the media library",
  );
  await electron.close();
  const offlineLibrary = new MediaLibrary(join(userData, "media-library")),
    offlineProjects = new ProjectStore(
      join(userData, "project-store"),
      offlineLibrary,
    ),
    offlineDrafts = new DraftTransactionStore(
      join(userData, "project-store"),
      offlineProjects,
    ),
    initialDraft = await offlineDrafts.snapshot(project.id),
    committedManualEdit = await offlineDrafts.applyManual({
      schema_version: "1.0",
      request_id: "native-project-range-delete-001",
      project_id: project.id,
      draft_id: initialDraft.draft.draft_id,
      base_revision_id: initialDraft.draft.base_revision_id,
      expected_sequence: initialDraft.draft.draft_sequence,
      expected_timeline_sha256: initialDraft.draft.timeline_sha256,
      pass_group: {
        pass_group_id: "native-project-preview-001",
        kind: "manual",
      },
      reason: "Verify the packaged committed draft preview.",
      operations: [{ type: "ripple_delete", start_us: 0, end_us: 500_000 }],
    });
  assert.equal(committedManualEdit.draft.timeline.duration_us, 1_000_000);
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  window = await electron.firstWindow();
  await expect
    .poll(
      () =>
        electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
        ),
      { timeout: 30_000 },
    )
    .toBe(1.25);
  await expect(
    window.locator(`#projects [data-project-id="${project.id}"] small`),
  ).toHaveText("0:01.000 · 1 source · Review");
  await window.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(window.locator("#frame")).toBeVisible();
  await expect(window.locator("#time")).toHaveText("0:00.000");
  await assertCanvasFrame(window, 1);
  await expect(window.locator("#seek")).toHaveAttribute("max", "500000");
  await window.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(window.locator("#time")).toHaveText("0:00.500");
  await assertCanvasFrame(window, 2);
  await expect(
    window.getByRole("button", { name: "Next frame", exact: true }),
  ).toBeDisabled();
  await expect(window.locator("#stage-select")).toHaveValue("review");
  await window.getByRole("button", { name: "Home", exact: true }).click();
  const sourceCard = window.locator(`[data-media-id="${project.source.id}"]`);
  await sourceCard.click();
  await expect(window.locator("#frame")).toBeVisible();
  await assertCanvasFrame(window, 0);
  await expect(window.locator("#project-navigation")).toBeHidden();
  const oldSourceCard = await sourceCard.elementHandle();
  assert.ok(oldSourceCard);
  await window.getByRole("button", { name: "Home", exact: true }).click();
  await expect
    .poll(() => oldSourceCard.evaluate((node) => node.isConnected))
    .toBe(false);
  await expect(sourceCard).toBeFocused();
  await window.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(window.locator("#frame")).toBeVisible();
  await assertCanvasFrame(window, 1);
  await expect(window.locator("#stage-select")).toHaveValue("review");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  assert.equal(sha256(await readFile(source)), sourceHash);
  await window.screenshot({ path: join(evidence, "native-reopened.png") });
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "P2-committed-draft-preview-slice",
        projectId: project.id,
        baselineSha256: sha256(baselineBytes),
        projectStagesPersisted: true,
        failedSavePreserved: true,
        executablePath,
        sourceHash,
        packaged: true,
        sandbox: true,
        import: true,
        exactFramePixels: true,
        pixelScope:
          "All pixels of opaque nonuniform BGRA frames through native canvas readback; not display or arbitrary alpha equality",
        reopen: true,
        committedDraftSequence: committedManualEdit.draft.draft_sequence,
        committedDraftDurationUs:
          committedManualEdit.draft.timeline.duration_us,
        timelineSourceMapping: true,
        headBoundProjectFrames: true,
        sourceUnchanged: true,
        preferencesPersisted: true,
        keyboardFocus: true,
        modalIsolation: true,
        codexDrawerSignedOut: true,
        inspectorDrawerExclusive: true,
        fabricatedConversationMessages: false,
        computerUse: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      evidence,
      config: env.XDG_CONFIG_HOME,
      source,
      executablePath,
    }),
  );
} finally {
  await electron.close();
}
