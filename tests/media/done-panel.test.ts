import assert from "node:assert/strict";
import test from "node:test";

import { doneMeta } from "../../apps/desktop/renderer/done-panel.ts";
import { folderLabel } from "../../apps/desktop/src/export.ts";
import type { ExportResultView } from "../../packages/domain/src/export-view.ts";

const result: ExportResultView = {
  fileName: "Shoreline film.mp4",
  folderName: "Videos",
  profile: "smaller_mp4",
  durationUs: 48_000_000,
  frameCount: 1440,
  outputBytes: 214 * 1024 * 1024,
  samplesEqual: false,
  draftSequence: 3,
  captionsFileName: null,
  captionsBurnedIn: false,
  audioCleaned: false,
};

test("the Done card says length, size and folder in plain words", () => {
  assert.equal(doneMeta(result), "0:48 · 214 MB · saved to Videos");
  assert.equal(
    doneMeta({
      ...result,
      durationUs: 3_725_000_000,
      outputBytes: 3 * 1024 ** 3,
    }),
    "1:02:05 · 3.0 GB · saved to Videos",
  );
  assert.equal(
    doneMeta({ ...result, outputBytes: 100 }),
    "0:48 · 1 KB · saved to Videos",
  );
});

test("the folder is named, never shown as a path", () => {
  assert.equal(folderLabel("C:\\Users\\me\\Videos\\Talk share.mp4"), "Videos");
  assert.equal(folderLabel("/home/me/Movies/Talk master.mkv"), "Movies");
  assert.ok(folderLabel("/Talk master.mkv").length > 0);
  assert.ok(!/[\\/]/u.test(folderLabel("/Talk master.mkv")));
});
