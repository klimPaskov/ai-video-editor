import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopRecorder, takeName } from "../../apps/desktop/src/recording.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { recordingIssues } from "../../packages/domain/src/recording-view.ts";

function recorder(
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "linux",
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
    listOutput: async () =>
      "0\talsa_output.pci.monitor\tmodule\ts16le\tIDLE\n1\talsa_input.usb-Mic\tmodule\ts16le\tIDLE\n",
  });
}

test("devices hide FFmpeg names and report unavailable sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-service-"));
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
    const root = await mkdtemp(join(tmpdir(), "recording-service-"));
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
