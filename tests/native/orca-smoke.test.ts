import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "Run beneath dbus-run-session");
await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path required");
assert.ok(isAbsolute(executablePath), "Packaged executable must be absolute");
await access(executablePath);
const forced = process.argv[3] === "--forced-accessibility";
assert.ok(process.argv.length <= 4 && (!process.argv[3] || forced));
const root = resolve("test-results");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(
  join(root, forced ? "orca-forced-" : "orca-natural-"),
);
const sourceEnv: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: join(evidence, "config"),
  XDG_DATA_HOME: join(evidence, "data"),
};
delete sourceEnv.NO_AT_BRIDGE;
delete sourceEnv.PULSE_SERVER;
const env: Record<string, string> = Object.fromEntries(
  Object.entries(sourceEnv).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const children: {
  child: ChildProcess;
  name: string;
  output: string;
  overflow: boolean;
}[] = [];
let electron: ElectronApplication | undefined;
let failure: unknown;
const steps: {
  name: string;
  braille: string[];
  focus: unknown[];
  screenshot: string;
}[] = [];

function start(
  name: string,
  executable: string,
  args: string[],
): (typeof children)[number] {
  const item = {
    child: spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] }),
    name,
    output: "",
    overflow: false,
  };
  const collect = (data: Buffer): void => {
    if (item.output.length + data.length > 4 * 1024 * 1024) {
      item.overflow = true;
      item.child.kill("SIGTERM");
    } else item.output += data.toString("utf8");
  };
  item.child.stdout!.on("data", collect);
  item.child.stderr!.on("data", collect);
  item.child.on("error", (error) => {
    item.output += String(error);
  });
  children.push(item);
  return item;
}
async function waitFor(
  check: () => Promise<boolean>,
  message: string,
  timeout = 15000,
): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(150);
  }
  throw new Error(message);
}
async function readDebug(): Promise<string> {
  const path = join(evidence, "orca-debug.log");
  try {
    assert.ok(
      (await stat(path)).size < 16 * 1024 * 1024,
      "Orca debug log exceeded evidence limit",
    );
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
async function tabTo(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
    await page.keyboard.press("Tab");
    await delay(100);
  }
  throw new Error(`Keyboard could not reach ${id}`);
}
try {
  const orcaExecutable = process.env.ORCA_EXECUTABLE ?? "orca";
  if (orcaExecutable !== "orca") {
    assert.ok(isAbsolute(orcaExecutable));
    await access(orcaExecutable);
  }
  const version = (
    await runProcess({ executable: orcaExecutable, args: ["--version"] })
  ).stdout
    .toString("utf8")
    .trim();
  const modern = version === "Orca version 50.2, AT-SPI2 version: 2.56.8";
  if (modern) env.GSETTINGS_BACKEND = "keyfile";
  assert.ok(modern || version === "43.1", "Unreviewed Orca startup contract");
  const orcaArgs = modern
    ? [`--debug-file=${join(evidence, "orca-debug.log")}`]
    : [
        "--disable=speech",
        "--disable=braille",
        "--enable=braille-monitor",
        `--user-prefs-dir=${join(evidence, "orca-prefs")}`,
        `--debug-file=${join(evidence, "orca-debug.log")}`,
      ];
  const runtimeLibraries = modern
    ? await Promise.all(
        ["libatspi.so.0", "libatk-bridge-2.0.so.0"].map(async (name) => {
          const path = join(dirname(dirname(orcaExecutable)), "lib", name);
          return { path, sha256: sha256(await readFile(path)) };
        }),
      )
    : [];
  await writeFile(
    join(evidence, "provenance.json"),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        readerVersion: version,
        readerCommand: [orcaExecutable, ...orcaArgs],
        readerEntryHash: modern ? sha256(await readFile(orcaExecutable)) : null,
        runtimeLibraries,
        executablePath,
        executableHash: sha256(await readFile(executablePath)),
        asarHash: sha256(
          await readFile(join(dirname(executablePath), "resources/app.asar")),
        ),
        testHash: sha256(
          await readFile(resolve("tests/native/orca-smoke.test.ts")),
        ),
        observerHash: sha256(
          await readFile(resolve("tests/native/atspi-observer.py")),
        ),
        environmentNames: Object.keys(env).sort(),
        runtime: Object.fromEntries(
          ["GI_TYPELIB_PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"].map((key) => [
            key,
            env[key] ?? null,
          ]),
        ),
        activation: forced ? "forced-api-only" : "natural",
      },
      null,
      2,
    ),
  );
  if (modern) {
    for (const [schema, key] of [
      ["org.gnome.Orca.Speech:/org/gnome/orca/default/speech/", "enable"],
      ["org.gnome.Orca.Braille:/org/gnome/orca/default/braille/", "enabled"],
    ]) {
      await runProcess({
        executable: "env",
        args: [
          `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`,
          "GSETTINGS_BACKEND=keyfile",
          "gsettings",
          "set",
          schema!,
          key!,
          "false",
        ],
      });
    }
  }
  await runProcess({
    executable: "gdbus",
    args: [
      "call",
      "--session",
      "--dest",
      "org.a11y.Bus",
      "--object-path",
      "/org/a11y/bus",
      "--method",
      "org.a11y.Bus.GetAddress",
    ],
  });
  const observer = start("atspi", "python3", [
    resolve("tests/native/atspi-observer.py"),
  ]);
  await waitFor(
    async () => observer.output.includes('"ready": true'),
    "AT-SPI observer did not initialize",
  );
  const orca = start("orca", orcaExecutable, orcaArgs);
  if (!modern)
    await waitFor(
      async () => (await readDebug()).length > 0,
      "Orca did not initialize",
    );
  if (modern) {
    await waitFor(async () => {
      try {
        const reply = await runProcess({
          executable: "gdbus",
          args: [
            "call",
            "--session",
            "--dest",
            "org.gnome.Orca.Service",
            "--object-path",
            "/org/gnome/Orca/Service",
            "--method",
            "org.gnome.Orca.Service.ListModules",
          ],
          timeoutMs: 2000,
        });
        return (
          reply.stdout.includes("BraillePresenter") &&
          reply.stdout.includes("SpeechManager")
        );
      } catch {
        return false;
      }
    }, "Orca control modules did not initialize");
    const settings: Record<string, boolean> = {};
    for (const [module, getter, expected] of [
      ["SpeechManager", "SpeechIsEnabled", false],
      ["BraillePresenter", "BrailleIsEnabled", false],
      ["BraillePresenter", "MonitorIsEnabled", true],
    ] as const) {
      const response = await runProcess({
        executable: "gdbus",
        args: [
          "call",
          "--session",
          "--dest",
          "org.gnome.Orca.Service",
          "--object-path",
          `/org/gnome/Orca/Service/${module}`,
          "--method",
          "org.gnome.Orca.Module.ExecuteRuntimeSetter",
          getter,
          `<${expected}>`,
        ],
      });
      assert.equal(response.stdout.toString("utf8").trim(), "(true,)");
      const readback = await runProcess({
        executable: "gdbus",
        args: [
          "call",
          "--session",
          "--dest",
          "org.gnome.Orca.Service",
          "--object-path",
          `/org/gnome/Orca/Service/${module}`,
          "--method",
          "org.gnome.Orca.Module.ExecuteRuntimeGetter",
          getter,
        ],
      });
      assert.equal(readback.stdout.toString("utf8").trim(), `(<${expected}>,)`);
      settings[getter] = expected;
    }
    await writeFile(
      join(evidence, "reader-settings.json"),
      JSON.stringify(settings, null, 2),
    );
  }
  const videoPath = join(evidence, "fixture.raw"),
    audioPath = join(evidence, "fixture.pcm"),
    source = join(evidence, "Orca fixture.mkv");
  const pixels = Buffer.alloc(96 * 64 * 4 * 3);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = i % 251;
    pixels[i + 1] = 80;
    pixels[i + 2] = 160;
    pixels[i + 3] = 255;
  }
  await writeFile(videoPath, pixels);
  await writeFile(audioPath, Buffer.alloc(72000 * 2));
  const media = await encodeVerifiedMaster(
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
    join(evidence, "fixture-verification.json"),
    JSON.stringify(media, null, 2),
  );
  const sourceHash = sha256(await readFile(source));
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const app = electron;
  const applicationPids = new Set(
    await app.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    ),
  );
  const mainPid = app.process().pid;
  assert.ok(mainPid);
  applicationPids.add(mainPid);
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.ok(
    !app.process().spawnargs.some((arg) => arg.includes("--no-sandbox")),
  );
  if (forced)
    await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
  const page = await app.firstWindow();
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.focus();
  });

  async function observe(
    name: string,
    text: RegExp,
    action: () => Promise<void>,
    exactFocusName?: string,
  ): Promise<void> {
    const debugOffset = (await readDebug()).length,
      focusOffset = observer.output.length;
    await action();
    let braille: string[] = [],
      events: Record<string, unknown>[] = [];
    await waitFor(async () => {
      assert.equal(orca.child.exitCode, null, "Orca exited");
      assert.equal(observer.child.exitCode, null, "AT-SPI observer exited");
      braille = (await readDebug())
        .slice(debugOffset)
        .split("\n")
        .filter((line) => line.includes("BRAILLE LINE:") && text.test(line));
      events = observer.output
        .slice(focusOffset)
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .filter(
          (event) =>
            typeof event.name === "string" &&
            text.test(event.name) &&
            (!exactFocusName || event.name === exactFocusName) &&
            typeof event.pid === "number" &&
            applicationPids.has(event.pid) &&
            typeof event.role === "string" &&
            /^(push button|button|combo box)$/.test(event.role) &&
            typeof event.application === "string" &&
            /ai-video-editor/i.test(event.application),
        );
      return braille.length > 0 && events.length > 0;
    }, `No matching real Orca braille and app AT-SPI focus for ${name}`);
    // Orca writes its debug output before GTK paints the monitor.
    await delay(300);
    const screenshot = join(evidence, `${steps.length}-${name}.png`);
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "x11grab",
        "-video_size",
        "1440x900",
        "-i",
        ":99",
        "-frames:v",
        "1",
        "-threads",
        "1",
        screenshot,
      ],
    });
    steps.push({ name, braille, focus: events, screenshot });
  }
  await observe("import-focus", /Import video/i, async () => {
    await tabTo(page, "import");
  });
  await app.evaluate(({ dialog }, sourcePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [sourcePath],
    });
  }, source);
  await observe("project-home-focus", /Home/i, async () => {
    await page.keyboard.press("Enter");
    await expect(page.locator("#frame")).toBeVisible();
    await expect(page.locator("#back")).toBeFocused();
  });
  await observe("settings-scale", /Interface size/i, async () => {
    await page.keyboard.press("Control+,");
    await expect(page.locator("#interface-scale")).toBeFocused();
  });
  await observe("settings-cancel", /Cancel/i, async () => {
    await tabTo(page, "cancel-settings");
  });
  await observe("modal-return-home", /Home/i, async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#back")).toBeFocused();
  });
  await observe("source-details", /Source details/i, async () => {
    await tabTo(page, "source-details");
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#close-inspector")).toBeFocused();
  await page.keyboard.press("Escape");
  const stages = page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button");
  await observe(
    "edit-stage",
    /(?:^Edit$|'Edit button')/,
    async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        if (
          (await page.evaluate(() =>
            document.activeElement?.textContent?.trim(),
          )) === "Edit"
        )
          break;
      }
      await expect(stages.filter({ hasText: /^Edit$/ })).toBeFocused();
    },
    "Edit",
  );
  await page.keyboard.press("Enter");
  await expect(stages.filter({ hasText: /^Edit$/ })).toHaveAttribute(
    "aria-current",
    "step",
    { timeout: 30000 },
  );
  const projectStore = join(
    env.XDG_CONFIG_HOME!,
    "ai-video-editor",
    "project-store",
  );
  const projectIds = await readdir(projectStore);
  assert.equal(projectIds.length, 1);
  const savedProject = JSON.parse(
    await readFile(join(projectStore, projectIds[0]!, "project.json"), "utf8"),
  ) as { workflow_step: string };
  assert.equal(savedProject.workflow_step, "edit");
  assert.equal(sha256(await readFile(source)), sourceHash);
  assert.ok(children.every((item) => !item.overflow));
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope:
          "Real Orca AT-SPI focus to braille-monitor output; no speech or physical braille verification",
        activation: forced ? "forced-api-only" : "natural",
        applicationPids: [...applicationPids],
        naturalDetectionPassed: !forced,
        accessibilityEnabled: await app.evaluate(
          ({ app }) => app.accessibilitySupportEnabled,
        ),
        sourceHash,
        fixturePickerStubbed: true,
        input: "Playwright keyboard in packaged guest window",
        hostInput: false,
        visualReview: "pending inspection of whole guest screenshots",
        steps,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error;
  if (electron) {
    try {
      const failedPage = await electron.firstWindow();
      await writeFile(
        join(evidence, "failure-window.json"),
        JSON.stringify(
          await failedPage.evaluate(() => ({
            text: document.body.innerText,
            activeElement: document.activeElement?.id,
            stages: [
              ...document.querySelectorAll(
                'nav[aria-label="Project stages"] button',
              ),
            ].map((button) => ({
              text: button.textContent,
              disabled: (button as HTMLButtonElement).disabled,
              current: button.getAttribute("aria-current"),
            })),
          })),
          null,
          2,
        ),
      );
      await runProcess({
        executable: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "x11grab",
          "-video_size",
          "1440x900",
          "-i",
          ":99",
          "-frames:v",
          "1",
          "-threads",
          "1",
          join(evidence, "failure-window.png"),
        ],
      });
    } catch (inspectionError) {
      await writeFile(
        join(evidence, "failure-inspection.txt"),
        String(inspectionError),
      );
    }
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      {
        status: "failed",
        activation: forced ? "forced-api-only" : "natural",
        error: String(error),
        steps,
      },
      null,
      2,
    ),
  );
} finally {
  if (electron) await electron.close().catch(() => undefined);
  for (const item of children.reverse()) {
    if (item.child.exitCode === null && item.child.signalCode === null) {
      item.child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((done) => item.child.once("exit", () => done())),
        delay(2000),
      ]);
      if (item.child.exitCode === null && item.child.signalCode === null)
        item.child.kill("SIGKILL");
    }
    await writeFile(join(evidence, `${item.name}-process.log`), item.output);
  }
}
console.log(
  JSON.stringify({
    evidence,
    status: failure ? "failed" : "pass",
    activation: forced ? "forced-api-only" : "natural",
  }),
);
if (failure) throw failure;
