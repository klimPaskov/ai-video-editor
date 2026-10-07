/** Guest-only real process lifecycle regression. Run with the packaged executable path. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash } from "node:crypto";
import { createPackage, extractAll } from "@electron/asar";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication } from "playwright/test";
import type { DesktopBridge } from "../../apps/desktop/src/bridge.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(
  process.platform,
  "linux",
  "Lifecycle tests require the isolated guest",
);
assert.ok(process.getuid);
assert.equal(process.getuid(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const suppliedExecutable = process.argv[2];
assert.ok(
  suppliedExecutable && isAbsolute(suppliedExecutable),
  "Absolute packaged executable required",
);
const executablePath: string = suppliedExecutable;
await access(executablePath);
const guestInput = resolve("tests/desktop/guest-input.py");
await access(guestInput).catch(() => {
  throw new Error(
    "Copy the guarded guest-input.py helper into this guest workspace before lifecycle tests.",
  );
});
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-lifecycle-"));
const config = join(evidence, "config");
const env = { ...process.env, XDG_CONFIG_HOME: config };
const dialogEvidence: unknown[] = [];
async function crashRenderer(instance: ElectronApplication): Promise<void> {
  const details = await instance.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    return await new Promise<{ reason: string; exitCode: number }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Renderer crash notification timed out")),
          45_000,
        );
        contents.once("render-process-gone", (_event, details) => {
          clearTimeout(timeout);
          resolve(details);
        });
        contents.forcefullyCrashRenderer();
      },
    );
  });
  assert.equal(details.reason, "crashed");
  dialogEvidence.push({ rendererCrash: details });
}
let activeDialog: string | undefined;
async function nativeDialog(
  title: string,
  instance: ElectronApplication,
): Promise<void> {
  let windowTree = "";
  try {
    await expect
      .poll(
        async () => {
          const tree = await runProcess({
            executable: "xwininfo",
            args: ["-root", "-tree"],
          });
          windowTree = tree.stdout.toString("utf8");
          return windowTree.includes(`"${title}"`);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const line = windowTree
      .split("\n")
      .find((line) => line.includes(`"${title}"`));
    const windowId = line?.trim().match(/^0x[0-9a-f]+/i)?.[0];
    assert.ok(windowId);
    const properties = await runProcess({
      executable: "xprop",
      args: ["-id", windowId, "_NET_WM_WINDOW_TYPE", "_NET_WM_PID"],
    });
    const propertyText = properties.stdout.toString("utf8");
    assert.match(propertyText, /_NET_WM_WINDOW_TYPE_DIALOG/);
    assert.match(
      propertyText,
      new RegExp(
        `_NET_WM_PID\\(CARDINAL\\) = ${instance.process().pid}(?:\\s|$)`,
      ),
    );
    const mapped = await runProcess({
      executable: "xwininfo",
      args: ["-id", windowId],
    });
    assert.match(mapped.stdout.toString("utf8"), /Map State: IsViewable/);
    activeDialog = windowId;
    dialogEvidence.push({ dialogWindow: windowId, properties: propertyText });
  } finally {
    const capture = await runProcess({
      executable: "python3",
      args: [guestInput, "capture"],
    });
    dialogEvidence.push({
      title,
      windowTree,
      capture: JSON.parse(capture.stdout.toString("utf8")),
    });
    await writeFile(
      join(evidence, "native-dialogs.json"),
      JSON.stringify(dialogEvidence, null, 2),
    );
  }
}
async function acceptNativeDialog(): Promise<void> {
  assert.ok(activeDialog);
  const focus = await runProcess({
    executable: "xprop",
    args: ["-root", "_NET_ACTIVE_WINDOW"],
  });
  assert.equal(
    focus.stdout
      .toString("utf8")
      .trim()
      .match(/0x[0-9a-f]+$/i)?.[0],
    activeDialog,
  );
  const input = await runProcess({
    executable: "python3",
    args: [guestInput, "key", "Return"],
  });
  dialogEvidence.push({ input: JSON.parse(input.stdout.toString("utf8")) });
  await writeFile(
    join(evidence, "native-dialogs.json"),
    JSON.stringify(dialogEvidence, null, 2),
  );
}

function exitOf(
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Owned application process did not exit within ${timeoutMs / 1_000} seconds`,
          ),
        ),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}
let application: ElectronApplication | undefined;
let second: ChildProcess | undefined;
async function launch(): Promise<ElectronApplication> {
  const instance = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30_000,
  });
  application = instance;
  const page = await instance.firstWindow();
  await expect(
    page.getByRole("button", { name: "Import video", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      instance.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    )
    .toBe(true);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  return instance;
}
async function closeWindow(instance: ElectronApplication): Promise<void> {
  const exited = exitOf(instance.process());
  await instance
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    .catch(() => undefined);
  const result = await exited;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  application = undefined;
}
try {
  let instance = await launch();
  const userData = await instance.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const within = relative(config, userData);
  assert.ok(
    within && !within.startsWith("..") && !isAbsolute(within),
    "Lifecycle fixture must remain inside its own config directory",
  );
  let page = await instance.firstWindow();
  const preferencesReply = await page.evaluate(() =>
    (window as Window & { desktop: DesktopBridge }).desktop.setPreferences({
      interfaceScale: 1.5,
    }),
  );
  assert.equal(preferencesReply.ok, true);
  await closeWindow(instance);

  // Seed real persisted fixture records through the production services, not fabricated JSON.
  const source = join(evidence, "Lifecycle fixture.mkv");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=32x24:rate=2:duration=1",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "bgra",
      "-color_range",
      "pc",
      "-colorspace",
      "rgb",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      source,
    ],
  });
  const library = new MediaLibrary(join(userData, "media-library"));
  const media = await library.importFile(source);
  const projects = new ProjectStore(join(userData, "project-store"), library);
  const created = await projects.createFromMedia(media.id);
  const projectId = created.project.project_id;
  const baselinePath = join(
    created.project.storage.project_root,
    "baseline.json",
  );
  const baseline = await readFile(baselinePath);
  const sourceBytes = await readFile(source);
  const managedPath = (await library.verifiedSource(media.id)).managedPath;
  const preferencePath = join(userData, "preferences", "preferences.json");
  const preferences = await readFile(preferencePath);

  instance = await launch();
  page = await instance.firstWindow();
  assert.equal(
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    ),
    1.5,
  );
  await page.locator(`[data-project-id="${projectId}"]`).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toHaveAttribute("aria-current", "step");
  const committedMetadata = await readFile(
    join(created.project.storage.project_root, "project.json"),
  );

  await instance.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis as typeof globalThis & {
      lifecycleInstances?: number;
    };
    state.lifecycleInstances = 0;
    app.on("second-instance", () => {
      state.lifecycleInstances = (state.lifecycleInstances ?? 0) + 1;
    });
    BrowserWindow.getAllWindows()[0]!.minimize();
  });
  second = spawn(executablePath, [], { env, stdio: "ignore", shell: false });
  const duplicateExit = await exitOf(second);
  assert.equal(duplicateExit.code, 0);
  second = undefined;
  await expect
    .poll(() =>
      instance.evaluate(
        () =>
          (globalThis as typeof globalThis & { lifecycleInstances?: number })
            .lifecycleInstances,
      ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      instance.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isMinimized(),
      ),
    )
    .toBe(false);
  await expect
    .poll(() =>
      instance.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isFocused(),
      ),
    )
    .toBe(true);
  assert.equal(
    await instance.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.deepEqual(
    await readFile(join(created.project.storage.project_root, "project.json")),
    committedMetadata,
  );

  // Kill only the exact main process returned by this test's Playwright launch.
  const mainProcess = instance.process();
  const killed = exitOf(mainProcess);
  assert.equal(mainProcess.kill("SIGKILL"), true);
  assert.equal((await killed).signal, "SIGKILL");
  application = undefined;
  instance = await launch();
  page = await instance.firstWindow();
  assert.equal(
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    ),
    1.5,
  );
  await page.locator(`[data-project-id="${projectId}"]`).click();
  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toHaveAttribute("aria-current", "step");
  assert.deepEqual(await readFile(baselinePath), baseline);
  assert.deepEqual(await readFile(preferencePath), preferences);
  assert.deepEqual(await readFile(managedPath), sourceBytes);
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.deepEqual(
    await readFile(join(created.project.storage.project_root, "project.json")),
    committedMetadata,
  );
  await closeWindow(instance);

  // Crash the real renderer: reopening is a user action, and the second crash cannot loop.
  instance = await launch();
  page = await instance.firstWindow();
  const rendererPid = await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId(),
  );
  await crashRenderer(instance);
  await nativeDialog("Editor window stopped", instance);
  assert.equal(
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.isCrashed(),
    ),
    true,
  );
  const recoveryStarted = Date.now();
  await acceptNativeDialog();
  // Playwright retains its crashed Page state after Electron reloads the same
  // WebContents. Observe the new renderer through Electron's main connection;
  // do not replace the app window or mutate Playwright internals for this test.
  await expect
    .poll(
      () =>
        instance.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          if (contents.isCrashed() || contents.isLoading()) return false;
          return contents.executeJavaScript(
            `Boolean([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Import video' && button.getClientRects().length))`,
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  dialogEvidence.push({
    recoveredRendererAfterMs: Date.now() - recoveryStarted,
  });
  assert.notEqual(
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId(),
    ),
    rendererPid,
  );
  await instance.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        `document.querySelector('[data-project-id="' + ${JSON.stringify(id)} + '"]').click()`,
      ),
    projectId,
  );
  await expect
    .poll(
      () =>
        instance.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
            `document.querySelector('button[aria-current="step"]')?.textContent.trim()`,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe("Review");
  assert.deepEqual(await readFile(baselinePath), baseline);
  assert.deepEqual(await readFile(preferencePath), preferences);
  assert.deepEqual(await readFile(managedPath), sourceBytes);
  assert.deepEqual(
    await readFile(join(created.project.storage.project_root, "project.json")),
    committedMetadata,
  );
  await crashRenderer(instance);
  await nativeDialog("Editor window stopped", instance);
  const recoveryExit = exitOf(instance.process());
  await acceptNativeDialog();
  assert.equal((await recoveryExit).code, 0);
  application = undefined;

  // This covers a preferences-storage startup failure, not missing packaged assets.
  await writeFile(preferencePath, "{corrupt lifecycle fixture");
  instance = await launch();
  page = await instance.firstWindow();
  await expect(page.locator("#error")).toContainText(
    "Saved interface settings could not be loaded",
  );
  assert.equal(
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    ),
    1,
  );
  assert.equal(
    await readFile(preferencePath, "utf8"),
    "{corrupt lifecycle fixture",
  );
  await closeWindow(instance);
  await writeFile(preferencePath, preferences);

  // Modify only a task-owned package copy; the accepted build and source remain unchanged.
  const originalArchive = join(
    dirname(executablePath),
    "resources",
    "app.asar",
  );
  const originalHash = createHash("sha256")
    .update(await readFile(originalArchive))
    .digest("hex");
  const copiedPackage = join(evidence, "missing-assets-package");
  await cp(dirname(executablePath), copiedPackage, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const extracted = join(evidence, "extracted-test-app");
  extractAll(originalArchive, extracted);
  let missingIndex = 0;
  for (const missing of [
    "renderer/index.html",
    "renderer/renderer.js",
    "renderer/style.css",
    "preload.cjs",
  ]) {
    const asset = join(extracted, missing),
      preserved = `${asset}.test-disabled`;
    await rename(asset, preserved);
    const replacement = join(evidence, `missing-${missingIndex}.asar`);
    await createPackage(extracted, replacement);
    const archive = join(copiedPackage, "resources", "app.asar");
    await rename(
      archive,
      join(copiedPackage, "resources", `prior-${missingIndex}.asar`),
    );
    await rename(replacement, archive);
    const broken = await _electron.launch({
      executablePath: join(copiedPackage, basename(executablePath)),
      chromiumSandbox: true,
      env: {
        ...env,
        XDG_CONFIG_HOME: join(evidence, `missing-config-${missingIndex}`),
      },
      timeout: 30_000,
    });
    application = broken;
    await nativeDialog("Could not open AI Video Editor", broken);
    assert.equal(
      await broken.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      0,
    );
    // GTK resolves the native message box before Electron has necessarily
    // finished its fatal-startup shutdown on a loaded guest. Keep the exact
    // exit-code assertion while allowing that separate process transition to
    // use the same bound as packaged startup.
    const failedExit = exitOf(broken.process(), 30_000);
    await acceptNativeDialog();
    assert.equal((await failedExit).code, 1);
    application = undefined;
    await rename(preserved, asset);
    missingIndex++;
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(originalArchive))
      .digest("hex"),
    originalHash,
  );
  await writeFile(
    join(evidence, "lifecycle.json"),
    JSON.stringify(
      {
        normalWindowShutdown: true,
        secondInstance: true,
        mainProcessKillReopen: true,
        baselineSourcePreferencesPreserved: true,
        corruptPreferencesReported: true,
        missingPackagedAssets: [
          "renderer/index.html",
          "renderer/renderer.js",
          "renderer/style.css",
          "preload.cjs",
        ],
        rendererCrashRecovery: "one explicit reopen; subsequent crash closes",
        platform: "linux",
        display: ":99",
        hostInput: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, scope: "native-process-lifecycle" }));
} finally {
  if (second && second.exitCode === null && second.signalCode === null)
    second.kill("SIGKILL");
  if (application)
    await application
      .close()
      .catch(() => application?.process().kill("SIGKILL"));
}
