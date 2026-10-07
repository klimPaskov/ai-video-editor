import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-identity-"));
const width = 96;
const height = 64;
const video = Buffer.alloc(width * height * 4 * 3);
for (let frame = 0; frame < 3; frame++) {
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = (frame * width * height + pixel) * 4;
    video.set(
      [20 + frame * 30, 40 + frame * 20, 180 - frame * 40, 255],
      offset,
    );
  }
}
const videoPath = join(evidence, "canonical.bgra");
const audioPath = join(evidence, "canonical.s16le");
const sourcePath = join(evidence, "identity-fixture.mkv");
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
const sourceBytes = await readFile(sourcePath);
const expectedPixels = Buffer.alloc(width * height * 4);
for (let pixel = 0; pixel < width * height; pixel++)
  expectedPixels.set([180, 40, 20, 255], pixel * 4);

async function holdForInspection(profile: string): Promise<void> {
  if (!process.argv.includes("--inspect")) return;
  await writeFile(join(evidence, `${profile}.ready`), "ready\n", {
    mode: 0o600,
  });
  const done = join(evidence, `${profile}.done`);
  const deadline = Date.now() + 120_000;
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

const checks: Array<Record<string, unknown>> = [];
for (const legacy of [false, true]) {
  const profile = legacy ? "existing-install" : "new-install";
  const configRoot = join(evidence, profile);
  const expectedData = join(
    configRoot,
    legacy ? appIdentity.legacyUserDataDirectory : appIdentity.slug,
  );
  const sentinel = join(expectedData, "existing-profile.sentinel");
  if (legacy) {
    await mkdir(expectedData, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "existing-profile\n", { mode: 0o600 });
  }
  const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
  const launch = (): ReturnType<typeof _electron.launch> =>
    _electron.launch({
      executablePath,
      env,
      chromiumSandbox: true,
      timeout: 30_000,
    });
  let electron: Awaited<ReturnType<typeof _electron.launch>> = await launch();
  try {
    let page = await electron.firstWindow();
    await expect(
      page.getByRole("button", { name: "Import video", exact: true }),
    ).toBeVisible();
    assert.equal(await page.title(), appIdentity.displayName);
    assert.equal(page.url(), `${appIdentity.urlScheme}://app/index.html`);
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(
      await electron.evaluate(({ app }) => app.getPath("userData")),
      expectedData,
    );
    assert.ok(
      !electron
        .process()
        .spawnargs.some((argument) => argument.includes("--no-sandbox")),
    );
    await electron.evaluate(({ dialog, shell }, source) => {
      shell.openExternal = async () => {
        throw new Error("External launch disabled in isolated test");
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [source],
      });
    }, sourcePath);
    await page
      .getByRole("button", { name: "Import video", exact: true })
      .click();
    await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
    const listed = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 1);
    const project = listed.value[0]!;
    const baselinePath = join(
      expectedData,
      "project-store",
      project.id,
      "baseline.json",
    );
    const baselineBytes = await readFile(baselinePath);
    const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
    assertInitialProjectSnapshot(baseline);
    const managedPath = baseline.source.managed_path;
    assert.deepEqual(await readFile(managedPath), sourceBytes);
    const edit = page
      .getByRole("navigation", { name: "Project stages" })
      .getByRole("button", { name: "Edit", exact: true });
    await edit.click();
    await expect(edit).toHaveAttribute("aria-current", "step");
    await electron.close();
    electron = await launch();
    page = await electron.firstWindow();
    await expect(
      page.locator(`#projects [data-project-id="${project.id}"]`),
    ).toBeVisible();
    await page.locator(`#projects [data-project-id="${project.id}"]`).click();
    await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
    assert.equal(await page.title(), appIdentity.displayName);
    assert.equal(
      await electron.evaluate(({ app }) => app.getPath("userData")),
      expectedData,
    );
    await expect(
      page
        .getByRole("navigation", { name: "Project stages" })
        .getByRole("button", { name: "Edit", exact: true }),
    ).toHaveAttribute("aria-current", "step");
    const pixels = await page
      .locator("canvas")
      .evaluate((node) =>
        Array.from(
          (node as HTMLCanvasElement)
            .getContext("2d")!
            .getImageData(0, 0, 96, 64).data,
        ),
      );
    assert.deepEqual(Buffer.from(pixels), expectedPixels);
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.deepEqual(await readFile(managedPath), sourceBytes);
    if (legacy)
      assert.equal(await readFile(sentinel, "utf8"), "existing-profile\n");
    await holdForInspection(profile);
    checks.push({
      profile,
      packaged: true,
      productTitle: true,
      localScheme: true,
      sameStoreAfterRestart: true,
      sameProjectAfterRestart: true,
      exactPreviewPixels: true,
      baselineUnchanged: true,
      sourcesUnchanged: true,
      legacySentinelPreserved: legacy,
    });
  } finally {
    await electron.close();
  }
}
await writeFile(
  join(evidence, "result.json"),
  JSON.stringify(
    {
      passed: true,
      hostInput: false,
      paidProviderUsed: false,
      sourceSha256: sha256(sourceBytes),
      checks,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log("Packaged native identity and existing-data reopen checks passed.");
