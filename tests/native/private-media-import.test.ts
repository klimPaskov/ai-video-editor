import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(
  process.platform,
  "linux",
  "Private native testing requires the isolated guest",
);
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const [executablePath, firstPath, secondPath] = process.argv.slice(2);
assert.ok(
  executablePath && firstPath && secondPath,
  "Packaged executable and two guest files required",
);
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "private-media-import-"));
const env = { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") };
const electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30_000,
});
const outcomes: {
  order: number;
  imported: boolean;
  projectOpened: boolean;
  preview: boolean;
}[] = [];
try {
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const library = new MediaLibrary(join(userData, "media-library"));
  for (const [index, sourcePath] of [firstPath, secondPath].entries()) {
    if (index > 0) {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Import video", exact: true }),
      ).toBeVisible();
    }
    const original = await readFile(sourcePath);
    const sourceSha256 = createHash("sha256").update(original).digest("hex");
    const before = await page.evaluate(() => window.desktop.listMedia());
    assert.ok(before.ok);
    await electron.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, sourcePath);
    await page
      .getByRole("button", { name: "Import video", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const list = await page.evaluate(() => window.desktop.listMedia());
          return list.ok ? list.value.length : -1;
        },
        { timeout: 90_000 },
      )
      .toBe(before.value.length + 1);
    const mediaList = await page.evaluate(() => window.desktop.listMedia());
    assert.ok(mediaList.ok);
    const added = mediaList.value.filter(
      (item) => !before.value.some((old) => old.id === item.id),
    );
    assert.equal(added.length, 1);
    const media = added[0]!;
    const verified = await library.verifiedSource(media.id);
    assert.equal(verified.sha256, sourceSha256);
    assert.deepEqual(await readFile(verified.managedPath), original);
    assert.deepEqual(await readFile(sourcePath), original);
    const projects = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(projects.ok);
    const projectOpened = projects.value.some(
      (item) => item.source.id === media.id,
    );
    await expect
      .poll(
        async () => {
          if (await page.locator("#frame").isVisible()) return "ready";
          if (await page.locator("#error").isVisible()) return "error";
          return "loading";
        },
        { timeout: 90_000 },
      )
      .not.toBe("loading");
    const preview = await page.locator("#frame").isVisible();
    if (preview) {
      const dimensions = await page.locator("canvas").evaluate((node) => ({
        width: (node as HTMLCanvasElement).width,
        height: (node as HTMLCanvasElement).height,
      }));
      assert.deepEqual(dimensions, {
        width: media.width,
        height: media.height,
      });
    }
    await page.screenshot({
      path: join(evidence, `part-${index + 1}-private.png`),
    });
    outcomes.push({ order: index + 1, imported: true, projectOpened, preview });
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "private-user-media-native-import",
        packaged: true,
        sourceBytesPreserved: true,
        outcomes,
        combinedTimeline: false,
        completePlayback: false,
        export: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, outcomes }));
  assert.equal(
    outcomes.length,
    2,
    "Both inputs must reach the native import path",
  );
  assert.ok(
    outcomes.every((outcome) => outcome.projectOpened && outcome.preview),
  );
} finally {
  await electron.close();
}
