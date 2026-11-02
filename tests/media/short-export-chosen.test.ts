import assert from "node:assert/strict";
import test from "node:test";

import { assertShortExportAllRequest } from "../../packages/domain/src/short-clips-view.ts";

const base = {
  schema_version: "1.0",
  project_id: "project-1",
  format: "vertical",
  framing: "fit",
  position: 0.5,
  captions: true,
  title: false,
  speed: 1,
};

test("Make clips can name the clips the user chose, or take every clip", () => {
  assertShortExportAllRequest(base);
  assertShortExportAllRequest({
    ...base,
    clip_ids: ["clip-1000000-31000000", "clip-40000000-70000000"],
  });
  for (const clip_ids of [
    [],
    ["../x"],
    ["clip-1-2", "clip-1-2"],
    "clip-1-2",
    Array.from({ length: 65 }, (_, index) => `clip-${index}-${index + 1}`),
  ])
    assert.throws(
      () => assertShortExportAllRequest({ ...base, clip_ids }),
      JSON.stringify(clip_ids).slice(0, 40),
    );
  assert.throws(() => assertShortExportAllRequest({ ...base, extra: true }));
});
