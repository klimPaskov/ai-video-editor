import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopRecorder, takeName } from "../../apps/desktop/src/recording.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { CaptureSession } from "../../packages/recorder/src/session.ts";
import { killProcessTree } from "../../packages/recorder/src/process-tree.ts";
import { testToneInput } from "../../packages/recorder/src/capture.ts";
import { recordingIssues } from "../../packages/domain/src/recording-view.ts";

function recorder(
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "linux",
  pickArea?: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>,
): DesktopRecorder {
  const library = new MediaLibrary(join(root, "library"));
  return new DesktopRecorder({
    root: join(root, "recordings"),
    platform,
    env,
    importFile: (file) => library.importFile(file),
    displays: () => [
      {
        id: "display-1",
        label: "Built-in display",
        x: 0,
        y: 0,
        width: 2561,
        height: 1600,
        primary: true,
      },
    ],
    ...(pickArea ? { pickArea } : {}),
    listOutput: async () =>
      "0\talsa_output.pci.monitor\tmodule\ts16le\tIDLE\n1\talsa_input.usb-Mic\tmodule\ts16le\tIDLE\n",
  });
}

test("devices hide FFmpeg names and report unavailable sessions", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "recording-service-")),
  );
  try {
    const x11 = await recorder(root, { DISPLAY: ":0" }).devices();
    assert.deepEqual(x11, {
      displays: [
        {
          id: "display-1",
          label: "Built-in display",
          width: 2560,
          height: 1600,
          primary: true,
        },
      ],
      microphones: [{ id: "pulse-1", label: "usb Mic" }],
      message: null,
    });
    const wayland = await recorder(root, {
      DISPLAY: ":0",
      XDG_SESSION_TYPE: "wayland",
    }).devices();
    assert.equal(wayland.message, recordingIssues.wayland);
    assert.deepEqual(wayland.displays, []);
    const mac = await recorder(root, {}, "darwin").devices();
    assert.equal(mac.message, recordingIssues.unavailable);
    await assert.rejects(
      recorder(root, { DISPLAY: ":0" }).start({
        schema_version: "1.0",
        display_id: "display-9",
        microphone_id: null,
      }),
      { message: recordingIssues.device },
    );
    assert.equal(
      takeName(new Date(2026, 9, 7, 9, 5)),
      "Recording 2026-10-07 09.05",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a synthetic take records, pauses, imports and leaves no working files",
  { timeout: 120_000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "recording-service-")),
    );
    try {
      const service = recorder(root, { AI_VIDEO_EDITOR_TEST_CAPTURE: "1" });
      const devices = await service.devices();
      assert.equal(devices.displays[0]!.label, "Test pattern (not a screen)");
      assert.equal(
        devices.microphones[0]!.label,
        "Test tone (not a microphone)",
      );
      const started = await service.start({
        schema_version: "1.0",
        display_id: devices.displays[0]!.id,
        microphone_id: devices.microphones[0]!.id,
      });
      assert.equal(started.status, "recording");
      assert.ok(service.busy());
      await assert.rejects(
        service.start({
          schema_version: "1.0",
          display_id: devices.displays[0]!.id,
          microphone_id: null,
        }),
        { message: recordingIssues.busy },
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal((await service.pause()).status, "paused");
      assert.equal((await service.resume()).status, "recording");
      await new Promise((resolve) => setTimeout(resolve, 600));
      const finished = await service.stop();
      assert.equal(finished.status, "finished");
      // A paced source misses at most a few frames, even on a loaded machine.
      assert.ok(
        finished.missedFrames * 4 < finished.media!.durationUs / 33_333,
        `missed ${finished.missedFrames}`,
      );
      assert.match(finished.media!.name, /^Recording .+\.mkv$/u);
      assert.equal(finished.media!.previewAvailable, true);
      assert.ok(finished.media!.durationUs >= 1_500_000);
      // Only the take's session record remains; its media is in the library.
      const takes = await readdir(join(root, "recordings"));
      assert.equal(takes.length, 1);
      assert.deepEqual(await readdir(join(root, "recordings", takes[0]!)), [
        "session.json",
      ]);
      assert.equal((await service.cancel()).status, "idle");
      assert.equal(service.busy(), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a dragged area becomes a validated region of the display that is recorded",
  { timeout: 120_000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "recording-region-")),
    );
    try {
      let area: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
      const real = recorder(root, { DISPLAY: ":0" }, "linux", async () => area);
      await real.devices();
      assert.deepEqual(await real.pickRegion("display-1"), {
        x: 640,
        y: 800,
        width: 1280,
        height: 400,
      });
      area = null;
      assert.equal(await real.pickRegion("display-1"), null);
      area = { x: 0.99, y: 0.99, width: 0.5, height: 0.5 };
      await assert.rejects(real.pickRegion("display-1"), {
        message: recordingIssues.region,
      });
      await assert.rejects(real.pickRegion("display-9"), {
        message: recordingIssues.device,
      });
      // Without a picker (or on macOS) the choice is unavailable.
      const plain = recorder(root, { DISPLAY: ":0" });
      await plain.devices();
      await assert.rejects(plain.pickRegion("display-1"), {
        message: recordingIssues.regionUnavailable,
      });
      // A region outside the display is refused before anything starts.
      await assert.rejects(
        real.start({
          schema_version: "1.0",
          display_id: "display-1",
          microphone_id: null,
          region: { x: 2000, y: 0, width: 640, height: 480 },
        }),
        { message: recordingIssues.device },
      );

      area = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
      const synthetic = recorder(
        root,
        { AI_VIDEO_EDITOR_TEST_CAPTURE: "1" },
        "linux",
        async () => area,
      );
      const devices = await synthetic.devices();
      const region = await synthetic.pickRegion(devices.displays[0]!.id);
      assert.deepEqual(region, { x: 160, y: 90, width: 160, height: 90 });
      await synthetic.start({
        schema_version: "1.0",
        display_id: devices.displays[0]!.id,
        microphone_id: null,
        region: region!,
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const finished = await synthetic.stop();
      assert.equal(finished.status, "finished");
      assert.equal(finished.media!.width, 160);
      assert.equal(finished.media!.height, 90);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a take cut short by a crash is listed, recovered and imported once",
  { timeout: 120_000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "recording-recover-")),
    );
    try {
      const directory = join(root, "recordings", randomUUID());
      await mkdir(directory, { recursive: true });
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory,
        request: {
          platform: "test",
          display: {
            id: "test-pattern",
            label: "Test pattern (not a screen)",
            x: 0,
            y: 0,
            width: 320,
            height: 180,
          },
          microphone: testToneInput,
          frameRate: 30,
        },
      });
      // One finished segment, then a second one the "crash" kills.
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await session.pause();
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // On Windows FFmpeg may be a shim; end the real capture as well, and
      // wait until it has really stopped.
      const running = (
        session as unknown as {
          current: { child: ChildProcess; done: Promise<void> };
        }
      ).current;
      killProcessTree(running.child);
      await running.done;

      const service = recorder(root, { AI_VIDEO_EDITOR_TEST_CAPTURE: "1" });
      const { takes } = await service.interrupted();
      assert.equal(takes.length, 1);
      assert.equal(takes[0]!.id, directory.split(/[\\/]/u).pop());
      const recovered = await service.recover(takes[0]!.id);
      assert.equal(recovered.status, "finished");
      const media = recovered.media!;
      assert.match(media.name, /^Recording .+\.mkv$/u);
      assert.equal(media.previewAvailable, true);
      // Both segments are kept: about 0.8 s + 1.2 s of frames.
      assert.ok(
        media.durationUs >= 1_400_000 && media.durationUs <= 4_500_000,
        `duration ${media.durationUs}`,
      );
      assert.deepEqual(await readdir(directory), ["session.json"]);
      assert.deepEqual((await service.interrupted()).takes, []);
      await assert.rejects(service.recover(takes[0]!.id), {
        message: recordingIssues.recover,
      });

      // Discarding removes an interrupted take's folder.
      const other = join(root, "recordings", randomUUID());
      await mkdir(other);
      await writeFile(
        join(other, "take.json"),
        JSON.stringify({ created_at: "2026-10-07T10:00:00.000Z" }),
      );
      await writeFile(join(other, "segment-001.mkv"), "");
      assert.equal((await service.interrupted()).takes.length, 1);
      await assert.rejects(service.recover(other.split(/[\\/]/u).pop()!), {
        message: recordingIssues.recover,
      });
      assert.deepEqual(
        await service.discardInterrupted(other.split(/[\\/]/u).pop()!),
        { takes: [] },
      );
      await assert.rejects(readdir(other));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
