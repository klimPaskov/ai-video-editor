import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopRecorder } from "../../apps/desktop/src/recording.ts";
import { recordingIssues } from "../../packages/domain/src/recording-view.ts";
import { testToneInput } from "../../packages/recorder/src/capture.ts";
import {
  CaptureSession,
  CaptureStartError,
} from "../../packages/recorder/src/session.ts";

const dshowListing = [
  "[in#0 @ 1] DirectShow video devices",
  '[in#0 @ 1] "Camera" (video)',
  "[in#0 @ 1] DirectShow audio devices",
  '[in#0 @ 1] "Desk microphone" (audio)',
].join("\n");

function windowsRecorder(
  root: string,
  listOutput: (executable: string, args: string[]) => Promise<string>,
): DesktopRecorder {
  return new DesktopRecorder({
    root: join(root, "recordings"),
    platform: "win32",
    env: {},
    importFile: () => Promise.reject(new Error("unused")),
    displays: () => [
      {
        id: "display-1",
        label: "Display",
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        primary: true,
      },
    ],
    listOutput,
  });
}

test("the microphone list is probed once, not on every dialog open", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "recording-devices-")),
  );
  try {
    let probes = 0;
    const service = windowsRecorder(root, async () => {
      probes++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return dshowListing;
    });
    // A warm-up at launch and a dialog opened meanwhile share one probe.
    service.warm();
    const first = await service.devices();
    assert.equal(first.microphones[0]!.label, "Desk microphone");
    assert.equal(probes, 1);
    const started = performance.now();
    for (let open = 0; open < 5; open++) await service.devices();
    assert.equal(probes, 1);
    assert.ok(performance.now() - started < 50, "reopening must not probe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blank probe answer is retried once and never cached", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "recording-devices-")),
  );
  try {
    const answers = ["", "", dshowListing];
    let probes = 0;
    const service = windowsRecorder(root, async () => answers[probes++] ?? "");
    // Both tries of the first dialog open come back blank: nothing cached.
    assert.deepEqual((await service.devices()).microphones, []);
    assert.equal(probes, 2);
    // The next open probes again and now sees the microphone.
    assert.equal(
      (await service.devices()).microphones[0]!.label,
      "Desk microphone",
    );
    assert.equal(probes, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A stand-in for the capture process: fails a set number of times first. */
async function fakeCapture(
  root: string,
  failures: number,
  complaint: string,
): Promise<{ executable: string; script: string; env: NodeJS.ProcessEnv }> {
  const script = join(root, "fake-capture.cjs");
  await writeFile(
    script,
    `const fs = require("node:fs");
const marker = ${JSON.stringify(join(root, "attempts"))};
const attempts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
fs.writeFileSync(marker, String(attempts + 1));
if (attempts < ${failures}) {
  process.stderr.write(${JSON.stringify(complaint)} + "\\n");
  process.exit(1);
}
process.stdout.write("frame=3\\ndup_frames=0\\ndrop_frames=0\\nprogress=continue\\n");
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("q")) {
    process.stdout.write("frame=9\\nprogress=end\\n");
    process.exit(0);
  }
});
`,
  );
  return { executable: process.execPath, script, env: process.env };
}

function fakeSession(
  root: string,
  supervisor: { executable: string; script: string; env: NodeJS.ProcessEnv },
  microphone: typeof testToneInput | null,
): CaptureSession {
  return new CaptureSession({
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    directory: root,
    supervisor,
    request: {
      platform: "test",
      display: { id: "t", label: "t", x: 0, y: 0, width: 64, height: 64 },
      microphone,
      frameRate: 30,
    },
  });
}

test("a device that is busy for a moment is retried once, then reported plainly", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "recording-retry-")),
  );
  try {
    const busy =
      "[dshow @ 0] Could not run graph (sometimes caused by a device already in use)";
    // One failure: the automatic retry succeeds and leaves no trace.
    const retried = fakeSession(
      root,
      await fakeCapture(root, 1, busy),
      testToneInput,
    );
    await retried.record();
    assert.equal(retried.state().status, "recording");
    assert.equal(retried.state().interrupted, false);
    await retried.cancel();
    // Two failures: the microphone is named, not a generic error.
    await rm(join(root, "attempts"), { force: true });
    const failing = fakeSession(
      root,
      await fakeCapture(root, 2, busy),
      testToneInput,
    );
    await assert.rejects(failing.record(), (error: unknown) => {
      assert.ok(error instanceof CaptureStartError);
      assert.equal(error.failure, "microphone");
      return true;
    });
    // The screen is blamed when there is no microphone.
    await rm(join(root, "attempts"), { force: true });
    const screen = fakeSession(
      root,
      await fakeCapture(root, 2, "[gdigrab @ 0] Failed to capture image"),
      null,
    );
    await assert.rejects(screen.record(), (error: unknown) => {
      assert.ok(error instanceof CaptureStartError);
      assert.equal(error.failure, "screen");
      return true;
    });
    assert.ok(
      recordingIssues.microphone.startsWith("The microphone could not"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
