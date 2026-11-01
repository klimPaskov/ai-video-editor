/**
 * Turns what the sealed stage saw at each audited moment of a composition
 * into the `composition.check` report (ADR 0021, docs/51 M2). Pure, so the
 * rules are tested without a browser.
 */

export interface StageTextFinding {
  code: "text_cut_off" | "text_outside_safe_area" | "text_too_small";
  text: string;
  box: [number, number, number, number];
  font_px?: number;
}

/** One audited moment, as the stage bridge reported it. */
export interface CompositionSample {
  timeUs: number;
  findings: StageTextFinding[];
  /** A small fingerprint of the captured picture, to see whether it moved. */
  fingerprint: Uint8Array | null;
}

export interface CompositionCheckInput {
  ready: boolean;
  error: string | null;
  durationSeconds: number | null;
  canvas: { width: number; height: number };
  declaredSize: { width: number; height: number } | null;
  timelines: string[];
  animations: number;
  /** The page defines window.__seek (a free-form composition). */
  seek: boolean;
  samples: CompositionSample[];
}

export interface CompositionFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  text?: string;
  times_us?: number[];
}

/** What the stage hands back for a composition after a seek (validated). */
export interface StageAnswer {
  ready: boolean;
  error: string | null;
  duration: number | null;
  report: {
    findings: StageTextFinding[];
    animations: number;
    seek: boolean;
    timelines: string[];
    declared_size: { width: number; height: number } | null;
  } | null;
}

const findingCodes: readonly StageTextFinding["code"][] = [
  "text_cut_off",
  "text_outside_safe_area",
  "text_too_small",
];

function plainText(value: unknown, max: number): string | null {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, max)
    : null;
}

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/**
 * The composition page runs model-authored (and package) code that can post
 * any message, and what it says ends up in Claude's tool result. Only known
 * fields of the expected types and sizes pass; everything else is dropped.
 */
export function cleanAnswer(raw: unknown): StageAnswer | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const answer = raw as Record<string, unknown>;
  let report: StageAnswer["report"] = null;
  const given = answer.report;
  if (given !== null && typeof given === "object" && !Array.isArray(given)) {
    const source = given as Record<string, unknown>;
    const findings: StageTextFinding[] = [];
    if (Array.isArray(source.findings))
      for (const item of source.findings.slice(0, 24)) {
        if (item === null || typeof item !== "object") continue;
        const finding = item as Record<string, unknown>;
        const code = findingCodes.find((known) => known === finding.code);
        const text = plainText(finding.text, 60);
        const box = Array.isArray(finding.box)
          ? finding.box.slice(0, 4).map((part) => bounded(part, -1e6, 1e6))
          : [];
        if (!code || text === null || box.length !== 4 || box.includes(null))
          continue;
        const font = bounded(finding.font_px, 0, 10_000);
        findings.push({
          code,
          text,
          box: box as [number, number, number, number],
          ...(font !== null ? { font_px: font } : {}),
        });
      }
    const size =
      source.declared_size !== null &&
      typeof source.declared_size === "object" &&
      !Array.isArray(source.declared_size)
        ? (source.declared_size as Record<string, unknown>)
        : null;
    const width = size ? bounded(size.width, 1, 100_000) : null;
    const height = size ? bounded(size.height, 1, 100_000) : null;
    report = {
      findings,
      animations: bounded(source.animations, 0, 100_000) ?? 0,
      seek: source.seek === true,
      timelines: Array.isArray(source.timelines)
        ? source.timelines
            .slice(0, 16)
            .map((name) => plainText(name, 64))
            .filter((name): name is string => name !== null)
        : [],
      declared_size:
        width !== null && height !== null ? { width, height } : null,
    };
  }
  return {
    ready: answer.ready === true,
    error: plainText(answer.error, 300),
    duration: bounded(answer.duration, 0, 86_400),
    report,
  };
}

const messages: Record<StageTextFinding["code"], string> = {
  text_cut_off: "Text is cut off by the frame edge.",
  text_outside_safe_area:
    "Text is outside the title-safe margin (6% of the shorter side).",
  text_too_small: "Text is too small to read on a phone.",
};

/** Mean absolute difference of two fingerprints, 0–255. */
function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let index = 0; index < a.length; index++)
    sum += Math.abs(a[index]! - b[index]!);
  return sum / a.length;
}

/** A picture differing by less than this (of 255) has not visibly moved. */
const stillThreshold = 0.5;

export function compositionCheckReport(
  input: CompositionCheckInput,
): Record<string, unknown> {
  const findings: CompositionFinding[] = [];
  if (!input.ready)
    findings.push({
      code: "runtime_not_ready",
      severity: "error",
      message:
        input.error ??
        "The composition did not become ready, so it cannot be seeked.",
    });
  else if (input.error)
    findings.push({
      code: "runtime_error",
      severity: "error",
      message: input.error,
    });
  if (input.ready && !(input.durationSeconds && input.durationSeconds > 0))
    findings.push({
      code: "no_duration",
      severity: "error",
      message:
        "No duration: set window.__duration (seconds) in a free-form page, or for HyperFrames register a paused GSAP timeline in window.__timelines or set data-duration on the root.",
    });
  if (
    input.ready &&
    !input.timelines.length &&
    !input.animations &&
    !input.seek
  )
    findings.push({
      code: "no_timeline",
      severity: "warning",
      message:
        "No registered timeline and no CSS or Web animation: nothing is driven by the seek.",
    });
  const declared = input.declaredSize;
  if (
    declared &&
    (declared.width !== input.canvas.width ||
      declared.height !== input.canvas.height)
  )
    findings.push({
      code: "canvas_size",
      severity:
        Math.abs(
          declared.width / declared.height -
            input.canvas.width / input.canvas.height,
        ) > 0.01
          ? "error"
          : "warning",
      message: `The root declares ${declared.width}×${declared.height}, but it plays in the video's ${input.canvas.width}×${input.canvas.height} frame; lay it out for that frame (use 100% sizes or the video's size).`,
    });

  // Text findings: held across moments matter; a single moment is a transient.
  const grouped = new Map<
    string,
    { finding: StageTextFinding; times: number[] }
  >();
  for (const sample of input.samples)
    for (const finding of sample.findings) {
      const key = `${finding.code}\u0000${finding.text}`;
      const entry = grouped.get(key) ?? { finding, times: [] };
      if (!entry.times.includes(sample.timeUs)) entry.times.push(sample.timeUs);
      grouped.set(key, entry);
    }
  for (const { finding, times } of grouped.values()) {
    const held = times.length >= 2 || input.samples.length < 2;
    findings.push({
      code: finding.code,
      severity: !held
        ? "info"
        : finding.code === "text_cut_off"
          ? "error"
          : "warning",
      message: `${messages[finding.code]}${
        finding.font_px !== undefined ? ` (${finding.font_px} px)` : ""
      }${held ? "" : " Seen at one moment only, as in an entrance or exit."}`,
      text: finding.text,
      times_us: times,
    });
  }

  // Motion: did the picture change between consecutive moments?
  const prints = input.samples.map((sample) => sample.fingerprint);
  const changes: boolean[] = [];
  for (let index = 1; index < prints.length; index++) {
    const before = prints[index - 1];
    const after = prints[index];
    if (before && after)
      changes.push(difference(before, after) >= stillThreshold);
  }
  const moving = changes.filter(Boolean).length;
  if (input.ready && changes.length >= 2 && moving === 0)
    findings.push({
      code: "motion_static",
      severity:
        (input.durationSeconds ?? 0) >= 3 &&
        (input.timelines.length > 0 || input.animations > 0 || input.seek)
          ? "error"
          : "warning",
      message:
        "Nothing on screen moved between the audited moments: the seek may not drive the animation, or everything settles before the first moment.",
    });
  else if (
    input.ready &&
    changes.length >= 4 &&
    changes.slice(Math.floor(changes.length / 2)).every((change) => !change)
  )
    findings.push({
      code: "motion_settles_early",
      severity: "info",
      message:
        "The second half holds a still frame. If the graphic stays on screen that long, keep something alive or shorten it.",
    });

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    ready: input.ready,
    duration_us:
      input.durationSeconds && input.durationSeconds > 0
        ? Math.round(input.durationSeconds * 1_000_000)
        : null,
    canvas: input.canvas,
    declared_size: input.declaredSize,
    timelines: input.timelines,
    audited_times_us: input.samples.map((sample) => sample.timeUs),
    moving_between_moments: `${moving} of ${changes.length}`,
    findings: findings.slice(0, 40),
    not_checked: ["colour contrast", "overlap between elements", "audio"],
  };
}

/**
 * Evenly spread composition times for an audit: the first frame, the last
 * frame and moments between, `count` in all.
 */
export function auditTimes(
  durationSeconds: number | null,
  count = 8,
  frameUs = 33_334,
): number[] {
  const durationUs =
    durationSeconds && durationSeconds > 0
      ? Math.round(durationSeconds * 1_000_000)
      : 4_000_000;
  const lastUs = Math.max(0, durationUs - frameUs);
  if (lastUs === 0) return [0];
  const times: number[] = [];
  for (let index = 0; index < count; index++) {
    const time = Math.round((lastUs * index) / (count - 1));
    if (!times.includes(time)) times.push(time);
  }
  return times;
}
