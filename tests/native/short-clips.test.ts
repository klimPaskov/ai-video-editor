/**
 * Packaged native short clips: a public 60 s talk excerpt is transcribed
 * locally, Export finds self-contained moments in it, one is previewed, one
 * is exported as a vertical MP4 with burned-in captions and listed among the
 * saved clips (shown in its folder on request), the same clip is exported
 * with a title and at 2x speed, every clip is exported to a folder at once,
 * an entry is removed from the list, one clip is discarded, and a scripted
 * Claude chooses clips through the guarded tool (refused when it tries an
 * edit instead).
 *
 * node tests/native/short-clips.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { openDisclosures } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-short-clips-"));
const sampleRevision = "fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634";
const sampleSha256 =
  "c118a98686f286284bf8d69a9049ef48e3031338609d9db970fb00ec7ab04948";
const response = await fetch(
  `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/${sampleRevision}/ted_60_16k.wav`,
  { redirect: "follow" },
);
assert.ok(response.ok);
const sample = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(sample).digest("hex"), sampleSha256);
const samplePath = join(evidence, "public-speech.wav");
await writeFile(samplePath, sample, { mode: 0o600 });
const speech = (
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      samplePath,
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ],
    maxOutputBytes: 64 * 1024 * 1024,
  })
).stdout;
// The talk excerpt alone; whole 0.5 s frames.
let audio = Buffer.from(speech);
const samplesPerFrame = 24_000;
const frames = Math.ceil(audio.length / 2 / samplesPerFrame);
audio = Buffer.concat([
  audio,
  Buffer.alloc(frames * samplesPerFrame * 2 - audio.length),
]);
const width = 96;
const height = 64;
const video = Buffer.alloc(frames * width * height * 4);
for (let frame = 0; frame < frames; frame++)
  for (let pixel = 0; pixel < width * height; pixel++)
    video.set(
      [
        (180 + frame * 23) % 256,
        (100 + frame * 17) % 256,
        (40 + frame * 11) % 256,
        255,
      ],
      (frame * width * height + pixel) * 4,
    );
const videoPath = join(evidence, "video.bgra");
const audioPath = join(evidence, "speech.s16le");
const sourcePath = join(evidence, "Talk.mkv");
await writeFile(videoPath, video, { mode: 0o600 });
await writeFile(audioPath, audio, { mode: 0o600 });
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

let step = "launch";
const result: Record<string, unknown> = { scope: "P10-native-short-clips" };
const configRoot = join(evidence, "config");
const outputs = join(evidence, "outputs");
await mkdir(outputs, { recursive: true });
const clipPath = join(outputs, "Vertical clip.mp4");
const titledPath = join(outputs, "Titled clip.mp4");
const fastPath = join(outputs, "Fast clip.mp4");
const allFolder = join(evidence, "all-clips");
await mkdir(allFolder, { recursive: true });
// The scripted CLI starts signed in, so no account is involved.
const claudeConfig = join(
  configRoot,
  appIdentity.slug,
  "claude",
  "claude-code",
);
await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
await writeFile(
  join(claudeConfig, "fake-state.json"),
  JSON.stringify({ loggedIn: true, method: "claude.ai" }),
);
await writeFile(
  join(claudeConfig, "fake-scenario.json"),
  JSON.stringify({ kind: "scripted_shorts_pick" }),
);
const bin = join(evidence, "bin");
await mkdir(bin, { mode: 0o700 });
await writeFile(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${resolve("tests/media/support/fake-claude-code.ts")}" "$@"\n`,
);
await chmod(join(bin, "claude"), 0o700);
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
  // The dialogs answer from values the test changes between steps; the
  // reveal call is recorded instead of opening a file manager.
  await electron.evaluate(
    ({ dialog, shell }, files) => {
      const state = globalThis as unknown as {
        __clip: string;
        __revealed: string[];
      };
      state.__clip = files.clip;
      state.__revealed = [];
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: string[] } | undefined;
        return options?.properties?.includes("openDirectory")
          ? { canceled: false, filePaths: [files.folder] }
          : { canceled: false, filePaths: [files.source] };
      }) as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: state.__clip,
      });
      shell.showItemInFolder = (path: string) => {
        state.__revealed.push(path);
      };
    },
    { source: sourcePath, clip: clipPath, folder: allFolder },
  );
  const saveAs = (file: string) =>
    electron.evaluate((_electron, value) => {
      (globalThis as unknown as { __clip: string }).__clip = value;
    }, file);
  const page = await electron.firstWindow();
  await openDisclosures(page);
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });

  step = "transcribe";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Transcribe locally", exact: true })
    .click();
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 20 * 60_000 },
  );

  step = "find";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#shorts-find")).toBeEnabled();
  await page.locator("#shorts-find").click();
  const items = page.locator("#shorts-list .short-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  const found = await items.count();
  const titles = await page
    .locator("#shorts-list .short-head strong")
    .allTextContents();
  const times = await page
    .locator("#shorts-list .short-time")
    .allTextContents();
  result.found = found;
  result.titles = titles;
  result.times = times;
  await page.screenshot({ path: join(evidence, "shorts-found.png") });

  step = "preview";
  const first = items.first();
  const firstTime = (await first.locator(".short-time").textContent())!;
  const [startText] = firstTime.split("–");
  const [minutes, seconds] = startText!.split(":").map(Number);
  await first.getByRole("button", { name: /^Preview / }).click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause", {
    timeout: 20_000,
  });
  const playingAt = Number(await page.locator("#seek").inputValue());
  assert.ok(
    Math.abs(playingAt - (minutes! * 60 + seconds!) * 1_000_000) < 3_000_000,
    `preview started at ${playingAt}`,
  );
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");

  step = "export";
  await page.locator("#shorts-format").selectOption("vertical");
  await page.locator("#shorts-framing").selectOption("fit");
  await expect(page.locator("#shorts-captions")).toBeChecked();
  await first.getByRole("button", { name: /^Export / }).click();
  await expect(first.locator(".short-status")).toHaveText(
    "Saved Vertical clip.mp4",
    { timeout: 300_000 },
  );
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          clipPath,
        ],
      })
    ).stdout.toString(),
  ) as {
    streams: Record<string, unknown>[];
    format: Record<string, unknown>;
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
  const [endText] = firstTime.split("–")[1]!.split(" ");
  const [endMinutes, endSeconds] = endText!.split(":").map(Number);
  const expectedSeconds =
    endMinutes! * 60 + endSeconds! - (minutes! * 60 + seconds!);
  const duration = Number(probe.format.duration);
  assert.ok(
    Math.abs(duration - expectedSeconds) <= 1.5,
    `clip lasts ${duration}s, expected about ${expectedSeconds}s`,
  );
  // "Fit" keeps the whole frame: the band above it is a blurred fill, not
  // black, and the middle shows the source colour.
  const frame = (
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-ss",
        "1",
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: 1080 * 1920 * 3 + 1024,
    })
  ).stdout;
  const pixel = (x: number, y: number) => {
    const at = (y * 1080 + x) * 3;
    return [frame[at]!, frame[at + 1]!, frame[at + 2]!];
  };
  const top = pixel(540, 200);
  assert.ok(top[0]! + top[1]! + top[2]! > 40, `top band ${top}`);
  await writeFile(join(evidence, "clip-frame.rgb"), frame);
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      clipPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=360:-2",
      join(evidence, "clip-frame.png"),
    ],
  });
  result.clipSeconds = duration;

  step = "library";
  // The saved clip is listed by name; Show in folder hands its path to the
  // system (recorded here), and the list never shows the path.
  const saved = page.locator("#shorts-library li");
  await expect(saved).toHaveCount(1);
  await expect(saved.first()).toContainText("Vertical clip.mp4");
  await expect(saved.first()).not.toContainText(outputs);
  await saved
    .first()
    .getByRole("button", { name: /^Show / })
    .click();
  await expect
    .poll(() =>
      electron.evaluate(
        () => (globalThis as unknown as { __revealed: string[] }).__revealed,
      ),
    )
    .toEqual([clipPath]);

  const frameAt = async (file: string, seconds: number) =>
    (
      await runProcess({
        executable: "ffmpeg",
        args: [
          "-v",
          "error",
          "-ss",
          String(seconds),
          "-i",
          file,
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        maxOutputBytes: 1080 * 1920 * 3 + 1024,
      })
    ).stdout;
  const meanDifference = (a: Buffer, b: Buffer, from: number, to: number) => {
    let total = 0;
    for (let at = from * 1080 * 3; at < to * 1080 * 3; at++)
      total += Math.abs(a[at]! - b[at]!);
    return total / ((to - from) * 1080 * 3);
  };

  step = "title";
  await saveAs(titledPath);
  await page.locator("#shorts-title").check();
  await first.getByRole("button", { name: /^Export / }).click();
  await expect(first.locator(".short-status")).toHaveText(
    "Saved Titled clip.mp4",
    { timeout: 300_000 },
  );
  await page.locator("#shorts-title").uncheck();
  const plain = await frameAt(clipPath, 1);
  const titled = await frameAt(titledPath, 1);
  // The title sits near the top of the picture; the bottom band is untouched.
  const nearTitle = meanDifference(plain, titled, 640, 800);
  const bottom = meanDifference(plain, titled, 1700, 1900);
  assert.ok(nearTitle > 4, `the title changes the picture: ${nearTitle}`);
  assert.ok(bottom < 1.5, `the rest is unchanged: ${bottom}`);
  result.title = { nearTitle, bottom };

  step = "speed";
  await saveAs(fastPath);
  await page.locator("#shorts-speed").selectOption("2");
  await first.getByRole("button", { name: /^Export / }).click();
  await expect(first.locator(".short-status")).toHaveText(
    "Saved Fast clip.mp4",
    { timeout: 300_000 },
  );
  await page.locator("#shorts-speed").selectOption("1");
  const fastDuration = Number(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=nw=1:nk=1",
          fastPath,
        ],
      })
    ).stdout
      .toString()
      .trim(),
  );
  assert.ok(
    Math.abs(fastDuration - expectedSeconds / 2) <= 1.5,
    `2x clip lasts ${fastDuration}s, expected about ${expectedSeconds / 2}s`,
  );
  await expect(saved).toHaveCount(3);
  await expect(saved.first()).toContainText("2×");
  result.fastSeconds = fastDuration;

  step = "export-all";
  await page.locator("#shorts-export-all").click();
  await expect(page.locator("#shorts-batch")).toContainText(
    `Saved ${found} ${found === 1 ? "clip" : "clips"}.`,
    { timeout: 20 * 60_000 },
  );
  const written = (await readdir(allFolder)).filter((name) =>
    name.endsWith(".mp4"),
  );
  assert.equal(written.length, found, `files: ${written.join(", ")}`);
  assert.equal(new Set(written).size, found);
  for (const name of written) {
    const size = JSON.parse(
      (
        await runProcess({
          executable: "ffprobe",
          args: [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            join(allFolder, name),
          ],
        })
      ).stdout.toString(),
    ) as { streams: { width: number; height: number }[] };
    assert.deepEqual(
      [size.streams[0]!.width, size.streams[0]!.height],
      [1080, 1920],
      name,
    );
  }
  await expect(saved).toHaveCount(3 + found);
  result.exportAll = written;

  step = "remove-from-list";
  await saved
    .last()
    .getByRole("button", { name: /^Remove / })
    .click();
  await expect(saved).toHaveCount(2 + found);
  // Only the entry goes: every file is still where it was saved.
  for (const file of [clipPath, titledPath, fastPath])
    assert.ok((await stat(file)).size > 10_000, file);
  assert.equal(
    (await readdir(allFolder)).filter((name) => name.endsWith(".mp4")).length,
    found,
  );

  step = "discard";
  if (found > 1) {
    const last = items.last();
    const title = await last.locator(".short-head strong").textContent();
    await last.getByRole("button", { name: /^Discard / }).click();
    await expect(items).toHaveCount(found - 1);
    assert.ok(
      !(
        await page.locator("#shorts-list .short-head strong").allTextContents()
      ).includes(title!),
    );
  }

  step = "claude-pick";
  // A scripted Claude reads the edit, is refused an edit, and proposes two
  // clips, one overlapping the other: the app keeps one and says why.
  await page.locator("#shorts-pick").click();
  await expect(page.locator("#shorts-list .short-origin")).toHaveText(
    "Claude's pick",
    { timeout: 120_000 },
  );
  await expect(page.locator("#shorts-list .short-item")).toHaveCount(1);
  await expect(page.locator("#shorts-note")).toContainText("chosen by Claude");
  await expect(page.locator("#shorts-pick")).toBeEnabled();
  const log = (await readFile(join(claudeConfig, "fake-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const scripted = log.find((line) => line.scriptedShorts)?.scriptedShorts as
    | {
        refusedEdit: boolean;
        answer: { accepted: number; rejected: string[] };
      }
    | undefined;
  assert.ok(scripted, "the scripted pick ran");
  assert.equal(scripted.refusedEdit, true, "an edit is refused while picking");
  assert.equal(scripted.answer.accepted, 1);
  assert.match(scripted.answer.rejected[0]!, /^Clip 2: .*overlaps/u);
  await page.screenshot({ path: join(evidence, "shorts-claude-pick.png") });
  result.claudePick = scripted;

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
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}
