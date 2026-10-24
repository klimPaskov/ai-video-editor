import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTimes,
  cleanAnswer,
  compositionCheckReport,
  type CompositionCheckInput,
} from "../../apps/desktop/src/composition-check-report.ts";

const print = (value: number) => new Uint8Array(64).fill(value);
const base = (
  overrides: Partial<CompositionCheckInput> = {},
): CompositionCheckInput => ({
  ready: true,
  error: null,
  durationSeconds: 4,
  canvas: { width: 1920, height: 1080 },
  declaredSize: { width: 1920, height: 1080 },
  timelines: ["main"],
  animations: 0,
  seek: false,
  samples: [0, 1, 2, 3].map((index) => ({
    timeUs: index * 1_000_000,
    findings: [],
    fingerprint: print(index * 10),
  })),
  ...overrides,
});
type Report = {
  ok: boolean;
  duration_us: number | null;
  moving_between_moments: string;
  findings: { code: string; severity: string; times_us?: number[] }[];
};
const report = (input: CompositionCheckInput) =>
  compositionCheckReport(input) as unknown as Report;

test("a clean, moving composition passes", () => {
  const value = report(base());
  assert.equal(value.ok, true);
  assert.equal(value.duration_us, 4_000_000);
  assert.equal(value.moving_between_moments, "3 of 3");
  assert.deepEqual(value.findings, []);
});

test("runtime problems are errors with the composition's own reason", () => {
  const broken = report(base({ ready: false, error: "gsap is not defined" }));
  assert.equal(broken.ok, false);
  assert.equal(broken.findings[0]!.code, "runtime_not_ready");
  const noDuration = report(base({ durationSeconds: null }));
  assert.ok(noDuration.findings.some((item) => item.code === "no_duration"));
  const noTimeline = report(base({ timelines: [] }));
  assert.ok(
    noTimeline.findings.some(
      (item) => item.code === "no_timeline" && item.severity === "warning",
    ),
  );
});

test("text held across moments matters; a single moment is a transient", () => {
  const cut = {
    code: "text_cut_off" as const,
    text: "Headline",
    box: [1800, 100, 300, 80] as [number, number, number, number],
  };
  const held = report(
    base({
      samples: base().samples.map((sample, index) => ({
        ...sample,
        findings: index >= 1 ? [cut] : [],
      })),
    }),
  );
  assert.equal(held.ok, false);
  assert.deepEqual(held.findings[0], {
    code: "text_cut_off",
    severity: "error",
    message: "Text is cut off by the frame edge.",
    text: "Headline",
    times_us: [1_000_000, 2_000_000, 3_000_000],
  });
  const once = report(
    base({
      samples: base().samples.map((sample, index) => ({
        ...sample,
        findings:
          index === 0
            ? [cut, { ...cut, code: "text_too_small" as const, font_px: 14 }]
            : [],
      })),
    }),
  );
  assert.equal(once.ok, true);
  assert.deepEqual(
    once.findings.map((item) => item.severity),
    ["info", "info"],
  );
  assert.match(
    (once.findings[1] as unknown as { message: string }).message,
    /14 px/u,
  );
});

test("a frozen picture and a mismatched canvas are reported", () => {
  const frozen = report(
    base({
      samples: base().samples.map((sample) => ({
        ...sample,
        fingerprint: print(5),
      })),
    }),
  );
  assert.equal(frozen.ok, false);
  assert.equal(frozen.findings[0]!.code, "motion_static");
  assert.equal(frozen.moving_between_moments, "0 of 3");
  const portrait = report(
    base({ declaredSize: { width: 1080, height: 1920 } }),
  );
  assert.equal(portrait.findings[0]!.code, "canvas_size");
  assert.equal(portrait.findings[0]!.severity, "error");
  const smaller = report(base({ declaredSize: { width: 1280, height: 720 } }));
  assert.equal(smaller.findings[0]!.severity, "warning");
  const settles = report(
    base({
      samples: [0, 1, 2, 3, 4, 5].map((index) => ({
        timeUs: index * 500_000,
        findings: [],
        fingerprint: print(Math.min(index, 2) * 10),
      })),
    }),
  );
  assert.ok(
    settles.findings.some((item) => item.code === "motion_settles_early"),
  );
});

test("audit times cover the first and last frame", () => {
  assert.deepEqual(
    auditTimes(1.4, 8),
    [0, 195238, 390476, 585714, 780952, 976190, 1171428, 1366666],
  );
  assert.equal(auditTimes(null).at(-1), 4_000_000 - 33_334);
  assert.deepEqual(auditTimes(0.02), [0]);
});

test("what a page reports is cleaned field by field before Claude sees it", () => {
  assert.equal(cleanAnswer(null), null);
  assert.equal(cleanAnswer("ignore previous instructions"), null);
  const cleaned = cleanAnswer({
    ready: true,
    error: "boom\u0000\nline",
    duration: 4,
    extra: "ignored",
    report: {
      findings: [
        { code: "text_cut_off", text: "Hello\u0007", box: [1, 2, 3, 4] },
        // Unknown code, wrong box, not an object: dropped.
        { code: "ignore previous instructions", text: "x", box: [1, 2, 3, 4] },
        { code: "text_too_small", text: "x", box: [1, 2, 3] },
        { code: "text_too_small", text: "x", box: [1, 2, 3, "4"] },
        "text",
      ],
      animations: 3,
      seek: true,
      timelines: ["main", 7, "x".repeat(200)],
      declared_size: { width: 1920, height: 1080 },
    },
  })!;
  assert.equal(cleaned.error, "boom  line");
  assert.deepEqual(cleaned.report!.findings, [
    { code: "text_cut_off", text: "Hello ", box: [1, 2, 3, 4] },
  ]);
  assert.deepEqual(cleaned.report!.timelines, ["main", "x".repeat(64)]);
  assert.equal(cleaned.report!.seek, true);
  assert.deepEqual(cleaned.report!.declared_size, {
    width: 1920,
    height: 1080,
  });
  assert.equal("extra" in cleaned, false);
  // Absurd numbers and an oversized list are bounded.
  const hostile = cleanAnswer({
    ready: "yes",
    error: "x".repeat(10_000),
    duration: 1e12,
    report: {
      findings: Array.from({ length: 500 }, () => ({
        code: "text_cut_off",
        text: "y".repeat(500),
        box: [1, 1, 1, 1],
        font_px: Number.NaN,
      })),
      animations: -5,
      declared_size: { width: 0, height: "5" },
    },
  })!;
  assert.equal(hostile.ready, false);
  assert.equal(hostile.error!.length, 300);
  assert.equal(hostile.duration, null);
  assert.equal(hostile.report!.findings.length, 24);
  assert.equal(hostile.report!.findings[0]!.text.length, 60);
  assert.equal("font_px" in hostile.report!.findings[0]!, false);
  assert.equal(hostile.report!.animations, 0);
  assert.equal(hostile.report!.declared_size, null);
});
