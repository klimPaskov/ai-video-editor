import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertExportView,
  exportIssues,
  exportUnsupported,
  idleExportView,
  type ExportView,
} from "../../packages/domain/src/export-view.ts";

test("IPC schema export messages equal the domain's fixed messages", async () => {
  const schema = JSON.parse(
    await readFile("docs/schemas/desktop_ipc.schema.json", "utf8"),
  ) as {
    $defs: { exportView: { properties: { message: { enum: unknown[] } } } };
  };
  assert.deepEqual(schema.$defs.exportView.properties.message.enum, [
    null,
    ...Object.values(exportIssues),
    ...exportUnsupported,
  ]);
});

test("export views reject paths, raw errors and inconsistent states", () => {
  assertExportView(idleExportView());
  const completed: ExportView = {
    status: "completed",
    projectId: "project-1",
    profile: "lossless_master",
    phase: null,
    fraction: null,
    result: {
      fileName: "Talk master.mkv",
      profile: "lossless_master",
      durationUs: 1_000_000,
      frameCount: 30,
      outputBytes: 1024,
      samplesEqual: true,
      draftSequence: 2,
      captionsFileName: null,
      captionsBurnedIn: false,
    },
    message: null,
  };
  assertExportView(completed);
  assertExportView({
    ...completed,
    result: { ...completed.result!, captionsFileName: "Talk master.srt" },
  });
  for (const captionsFileName of ["Talk master.txt", "../x.srt", "a/b.srt"])
    assert.throws(() =>
      assertExportView({
        ...completed,
        result: { ...completed.result!, captionsFileName },
      }),
    );
  for (const bad of [
    {
      ...completed,
      result: { ...completed.result!, fileName: "/tmp/Talk.mkv" },
    },
    { ...completed, result: { ...completed.result!, samplesEqual: false } },
    { ...completed, message: "ffmpeg: Invalid data found" },
    { ...completed, fraction: 0.5 },
    { ...completed, outputPath: "/tmp/Talk.mkv" },
    { ...idleExportView(), message: exportIssues.failed },
    { ...completed, status: "failed", result: null },
    {
      ...completed,
      status: "running",
      result: null,
      phase: "rendering",
      fraction: 2,
    },
  ])
    assert.throws(() => assertExportView(bad), JSON.stringify(bad));
  assertExportView({
    ...completed,
    status: "failed",
    result: null,
    message: exportUnsupported[5],
  });
  assertExportView({
    ...completed,
    profile: "smaller_mp4",
    result: {
      ...completed.result!,
      fileName: "Talk share.mp4",
      profile: "smaller_mp4",
      samplesEqual: false,
    },
  });
});
