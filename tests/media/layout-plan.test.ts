import assert from "node:assert/strict";
import test from "node:test";
import {
  planLayouts,
  type PlanActivity,
  type PlanInput,
} from "../../packages/domain/src/layout-plan.ts";

const geometry = { canvasAspect: 16 / 9, cameraAspect: 16 / 9 };
const second = 1_000_000;

function input(
  extra: Partial<PlanInput> & { activity?: PlanActivity[] } = {},
): PlanInput {
  return {
    durationUs: 90 * second,
    activity: [],
    sentenceStarts: Array.from(
      { length: 30 },
      (_, index) => index * 3 * second,
    ),
    speech: { startUs: 0.5 * second, endUs: 88 * second },
    geometry,
    ...extra,
  };
}

const busy = (
  fromS: number,
  toS: number,
  rect: { x: number; y: number; width: number; height: number },
): PlanActivity => ({
  startUs: fromS * second,
  endUs: toS * second,
  ...rect,
  score: 20,
});

test("the speaker opens and closes the video; a demonstration puts the camera in a corner", () => {
  const plan = planLayouts(
    input({
      activity: [busy(20, 60, { x: 0.1, y: 0.15, width: 0.5, height: 0.5 })],
    }),
  );
  assert.equal(plan[0]!.kind, "camera");
  assert.ok(plan[0]!.atUs < 3 * second);
  const demo = plan.find((item) => item.kind === "pip");
  assert.ok(demo, "a corner camera while something is shown");
  assert.ok(demo!.atUs >= 17 * second && demo!.atUs <= 23 * second);
  assert.equal(demo!.corner, "bottom_right");
  const last = plan.at(-1)!;
  assert.equal(last.kind, "camera");
  assert.ok(last.atUs >= 55 * second);
});

test("the camera keeps out of the part of the screen that is changing", () => {
  // Everything happens in the lower right, where the camera would sit.
  const plan = planLayouts(
    input({
      activity: [busy(20, 60, { x: 0.55, y: 0.5, width: 0.45, height: 0.5 })],
    }),
  );
  const demo = plan.find((item) => item.kind === "pip")!;
  assert.notEqual(demo.corner, "bottom_right");
  assert.ok(["bottom_left", "top_left", "top_right"].includes(demo.corner!));
});

test("a screen with nowhere clear for the camera is shown alone", () => {
  const corners = [
    { x: 0, y: 0, width: 0.3, height: 0.3 },
    { x: 0.7, y: 0, width: 0.3, height: 0.3 },
    { x: 0, y: 0.7, width: 0.3, height: 0.3 },
    { x: 0.7, y: 0.7, width: 0.3, height: 0.3 },
  ];
  const plan = planLayouts(
    input({ activity: corners.map((rect) => busy(20, 60, rect)) }),
  );
  assert.ok(plan.some((item) => item.kind === "screen"));
  assert.ok(
    !plan.some(
      (item) =>
        item.kind === "pip" &&
        item.atUs > 25 * second &&
        item.atUs < 55 * second,
    ),
  );
});

test("changes are well apart, start at a sentence and never repeat an arrangement", () => {
  const activity = [
    busy(15, 25, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }),
    busy(26, 27, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }),
    busy(40, 55, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }),
  ];
  const plan = planLayouts(input({ activity }));
  for (const [index, item] of plan.entries()) {
    if (index > 0) {
      assert.ok(item.atUs - plan[index - 1]!.atUs >= 6 * second);
      const previous = plan[index - 1]!;
      assert.ok(
        item.kind !== previous.kind || item.corner !== previous.corner,
        "no repeated arrangement",
      );
    }
    assert.ok(
      item.atUs % (3 * second) === 0,
      `at ${item.atUs} is a sentence start`,
    );
    assert.ok(item.reason.length > 0);
  }
});

test("without speech or with a very short edit there is nothing to plan", () => {
  assert.deepEqual(planLayouts(input({ speech: null })), []);
  assert.deepEqual(planLayouts(input({ durationUs: 3 * second })), []);
});
