import assert from "node:assert/strict";
import test from "node:test";
import { mapSourceTimeToOutputTime } from "../../packages/domain/src/source-output-map.ts";
import type { ProjectClipView } from "../../packages/domain/src/project-view.ts";

function clips(): ProjectClipView[] {
  return [
    {
      id: "clip-left",
      sourceId: "source-one",
      timelineStartUs: 0,
      timelineEndUs: 500,
      sourceStartUs: 100,
      sourceEndUs: 600,
    },
    {
      id: "clip-right",
      sourceId: "source-one",
      timelineStartUs: 500,
      timelineEndUs: 1000,
      sourceStartUs: 600,
      sourceEndUs: 1100,
    },
    {
      id: "clip-second-source",
      sourceId: "source-two",
      timelineStartUs: 1000,
      timelineEndUs: 1500,
      sourceStartUs: 0,
      sourceEndUs: 500,
    },
  ];
}

test("candidate preview uses exact half-open source/output maps across joins", () => {
  const current = clips();
  assert.equal(mapSourceTimeToOutputTime(current, 1500, "source-one", 100), 0);
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-one", 599),
    499,
  );
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-one", 600),
    500,
  );
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-two", 125),
    1125,
  );
});

test("candidate preview fails closed for hidden, wrong-source, ambiguous or invalid times", () => {
  const current = clips();
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-one", 1100),
    undefined,
  );
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-missing", 200),
    undefined,
  );
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-one", -1),
    undefined,
  );
  assert.equal(
    mapSourceTimeToOutputTime(current, 1500, "source-one", 1.5),
    undefined,
  );
  assert.equal(
    mapSourceTimeToOutputTime(undefined, 1500, "source-one", 200),
    undefined,
  );
  const ambiguous = [current[0]!, { ...current[0]!, id: "overlap" }];
  assert.equal(
    mapSourceTimeToOutputTime(ambiguous, 1000, "source-one", 200),
    undefined,
  );
  assert.equal(
    mapSourceTimeToOutputTime(
      [{ ...current[0]!, timelineEndUs: 2_000 }],
      1500,
      "source-one",
      200,
    ),
    undefined,
  );
  assert.deepEqual(current, clips());
});
