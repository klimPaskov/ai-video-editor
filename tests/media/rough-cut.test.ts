import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopMagicWand,
  type RoughCutEditor,
  type RoughCutOutcome,
} from "../../apps/desktop/src/magic-wand.ts";
import {
  roughCutPlaybook,
  roughCutPlaybookFor,
  roughCutRequest,
  roughCutTools,
} from "../../apps/desktop/src/rough-cut-playbook.ts";
import type { Tightener } from "../../apps/desktop/src/magic-wand.ts";
import type {
  LocalTranscript,
  TranscriptAnalysis,
} from "../../packages/domain/src/transcription.ts";
import {
  assertMagicWandView,
  magicWandIssues,
  magicWandProviders,
  magicWandSkipMessage,
  type MagicWandBlock,
  type MagicWandProvider,
} from "../../packages/domain/src/magic-wand-view.ts";
import { codexVideoEditToolNames } from "../../packages/codex-tools/src/service.ts";

const project = "project-rough-001";

function harness(script: {
  outcome: RoughCutOutcome | "later";
  refuse?: RoughCutOutcome;
  block?: MagicWandBlock;
  results?: unknown[];
  tightener?: Tightener;
  /** The first answer about an earlier transcription job (before any start). */
  earlierJob?: "cancelled" | "failed";
}) {
  const calls: string[] = [];
  const started: Array<{
    preset: string;
    request: string;
    provider: MagicWandProvider | undefined;
  }> = [];
  const released: string[] = [];
  let duration = 60_000_000;
  let operations: string[] = ["op-before"];
  let finished: RoughCutOutcome | null = null;
  let stopped = 0;
  let transcriptionStarts = 0;
  let asked = 0;
  const completedView = (status: string) =>
    ({
      job: {
        status,
        source_count: 1,
        progress_percent: status === "completed" ? 100 : null,
        job_id: "job-1",
      },
      results: script.results ?? [],
    }) as never;
  const transcriptions = {
    get: async () =>
      completedView(
        asked++ === 0 && script.earlierJob ? script.earlierJob : "completed",
      ),
    start: async () => {
      transcriptionStarts++;
      return completedView("completed");
    },
  };
  const invoke = async (_projectId: string, name: string) => {
    calls.push(name);
    assert.equal(name, "timeline.get_summary", "Magic Edit itself never cuts");
    return {
      draft_id: "draft-1",
      base_revision_id: "revision-1",
      draft_sequence: operations.length,
      timeline_sha256: "a".repeat(64),
      duration_us: duration,
      operation_ids: [...operations],
      clips: [
        {
          source_id: "source-1",
          source_start_us: 0,
          source_end_us: duration,
          timeline_start_us: 0,
          timeline_end_us: duration,
        },
      ],
    };
  };
  const editor: RoughCutEditor = {
    async blocked() {
      return script.block ?? null;
    },
    release: (projectId) => void released.push(projectId),
    async start(_projectId, preset, request, provider) {
      started.push({ preset, request, provider });
      if (script.refuse) return script.refuse;
      // Claude's story edit: two cuts committed during the run.
      duration -= 7_500_000;
      operations = [...operations, "claude-cut-1", "claude-cut-2"];
      if (script.outcome !== "later") finished = script.outcome;
      return null;
    },
    outcome: () => finished,
    async stop() {
      stopped++;
      finished = "stopped";
    },
  };
  const magic = new DesktopMagicWand(transcriptions, invoke, editor, {
    pollMs: 5,
    ...(script.tightener ? { tightener: script.tightener } : {}),
  });
  return {
    magic,
    calls,
    started,
    released,
    stopped: () => stopped,
    transcriptionStarts: () => transcriptionStarts,
    finish: (outcome: RoughCutOutcome) => (finished = outcome),
  };
}

async function settle(magic: DesktopMagicWand) {
  for (let index = 0; index < 400 && magic.busy(project); index++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return magic.get(project);
}

test("Magic Edit hands the rough cut to Claude and reports what changed", async () => {
  const run = harness({ outcome: "completed" });
  run.magic.start(project, "balanced");
  const view = await settle(run.magic);
  assert.equal(view.status, "completed");
  assert.equal(view.message, null);
  assert.deepEqual(view.summary, {
    removedUs: 7_500_000,
    cuts: 2,
    pauses: 0,
    fillers: 0,
    repeatedTakes: 0,
    leftForReview: 0,
  });
  assert.equal(run.started.length, 1);
  assert.equal(run.started[0]!.preset, "balanced");
  assert.match(run.started[0]!.request, /Make the rough cut/u);
  assert.match(run.started[0]!.request, /story edit/u);
  // Only reads: before and after the run.
  assert.deepEqual(run.calls, ["timeline.get_summary", "timeline.get_summary"]);
});

test("without Claude, Magic Edit says so instead of cutting by itself", async () => {
  const run = harness({ outcome: "completed", refuse: "signIn" });
  run.magic.start(project, "tight");
  const view = await settle(run.magic);
  assert.equal(view.status, "failed");
  assert.equal(view.message, magicWandIssues.claudeSignIn);
  assert.equal(view.summary?.cuts ?? 0, 0);
  const limited = harness({ outcome: "limit" });
  limited.magic.start(project, "gentle");
  const after = await settle(limited.magic);
  assert.equal(after.message, magicWandIssues.limit);
  // Cuts made before the limit are reported and stay undoable.
  assert.equal(after.summary?.cuts, 2);
});

test("Stop stops Claude's run and keeps its cuts", async () => {
  const run = harness({ outcome: "later" });
  run.magic.start(project, "balanced");
  for (let index = 0; index < 200; index++) {
    if (run.magic.get(project).status === "applying") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(run.magic.get(project).status, "applying");
  assert.equal(run.magic.get(project).progress, null);
  run.magic.stop(project);
  const view = await settle(run.magic);
  assert.equal(run.stopped(), 1);
  assert.equal(view.status, "stopped");
  assert.equal(view.message, magicWandIssues.stopped);
  assert.equal(view.summary?.cuts, 2);
});

test("the rough cut's request carries evidence, not cuts, and its tools only cut", () => {
  const request = roughCutRequest("balanced", [
    {
      kind: "pause",
      sourceId: "source-a",
      sourceStartUs: 1_000_000,
      sourceEndUs: 3_500_000,
      startUs: 1_000_000,
      endUs: 3_500_000,
    },
    {
      kind: "repeated_take",
      sourceId: "source-b",
      sourceStartUs: 2_000_000,
      sourceEndUs: 5_000_000,
      startUs: 9_000_000,
      endUs: 12_000_000,
    },
  ]);
  assert.match(request, /not a cut list/u);
  assert.match(
    request,
    /long pause · source source-a 1000000–3500000 · edit 1000000–3500000/u,
  );
  // The second recording's own time differs from its place in the edit.
  assert.match(
    request,
    /earlier copy of repeated wording · source source-b 2000000–5000000 · edit 9000000–12000000/u,
  );
  for (const tool of roughCutTools)
    assert.ok(
      (codexVideoEditToolNames as readonly string[]).includes(tool),
      tool,
    );
  for (const tool of [
    "graphics.set",
    "zoom.set",
    "speed.set",
    "captions.configure",
    "audio.configure",
    "timeline.undo",
  ])
    assert.equal(roughCutTools.has(tool), false, tool);
});

function tightenFixture(options: {
  outcome: RoughCutOutcome;
  block?: MagicWandBlock;
  refuse?: RoughCutOutcome;
}) {
  const word = (id: string, text: string, start: number, end: number) => ({
    word_id: id,
    text,
    start_us: start,
    end_us: end,
    confidence: null,
    flags: [],
  });
  const words = [
    word("word-000001", "Open", 200_000, 600_000),
    word("word-000002", "the", 2_600_000, 2_800_000),
  ];
  const transcript: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: "transcript-1",
    project_id: "project-01",
    source_id: "source-1",
    duration_us: 3_000_000,
    language: "en",
    model: { provider: "local", name: "fixture", version: "1" },
    segments: [
      {
        segment_id: "segment-01",
        start_us: 200_000,
        end_us: 2_800_000,
        text: "Open the",
        words,
      },
    ],
    warnings: [
      "Word timings are local model estimates; verify before editing.",
    ],
  };
  const analysis: TranscriptAnalysis = {
    schema_version: "1.0",
    project_id: "project-01",
    source_id: "source-1",
    source_sha256: "a".repeat(64),
    duration_us: 3_000_000,
    silence_policy: {
      version: "1",
      noise_db: -40,
      minimum_duration_us: 250_000,
    },
    silences: [],
  };
  const applied: Array<{ start_us: number; end_us: number }[]> = [];
  const frames = new Float32Array(300).fill(0.001);
  frames.fill(0.2, 20, 60);
  frames.fill(0.2, 260, 280);
  const run = harness({
    ...options,
    results: [{ source_id: "source-1", transcript, analysis }],
    tightener: {
      energy: async () => ({ frameUs: 10_000, rms: frames }),
      applyRanges: async (_projectId, _draft, ranges) => {
        applied.push([...ranges]);
      },
    },
  });
  return { run, applied };
}

test("pauses and fillers are tightened by the app in one transaction; Claude is told", async () => {
  const { run, applied } = tightenFixture({ outcome: "completed" });
  run.magic.start(project, "balanced");
  const view = await settle(run.magic);
  assert.equal(view.status, "completed");
  assert.equal(applied.length, 1, "one transaction");
  const gap = applied[0]!.find((range) => range.start_us >= 600_000)!;
  // 2.0 s gap, 0.3 s kept.
  assert.equal(gap.end_us - gap.start_us, 1_700_000);
  assert.equal(view.summary?.pauses, applied[0]!.length);
  assert.match(run.started[0]!.request, /already tightened the pacing/u);
  assert.equal(run.started[0]!.provider, "claude");
  assert.deepEqual(run.released, [project]);
});

test("when the chosen connection cannot run, the tightening stands and the result says what was skipped", async () => {
  for (const [provider, block] of [
    ["claude", "outdated"],
    ["codex", "signIn"],
    ["openai", "setup"],
  ] as const) {
    const { run, applied } = tightenFixture({ outcome: "completed", block });
    run.magic.start(project, "balanced", provider);
    const view = await settle(run.magic);
    // The pacing cuts were made and are reported; only the story edit is skipped.
    assert.equal(applied.length, 1, provider);
    assert.equal(
      run.started.length,
      0,
      "the unready connection is not started",
    );
    assert.equal(view.status, "completed", provider);
    assert.equal(view.message, magicWandSkipMessage(provider, block));
    assert.ok(view.summary && view.summary.pauses > 0);
    assert.deepEqual(run.released, [project]);
  }
  // Nothing at all to tighten: the same message, reported as not run.
  const bare = harness({ outcome: "completed", block: "outdated" });
  bare.magic.start(project, "tight", "claude");
  const view = await settle(bare.magic);
  assert.equal(view.status, "failed");
  assert.equal(view.message, magicWandIssues.claudeOutdated);
  assert.match(view.message ?? "", /claude update/u);
});

test("a sign-in problem found after the tightening keeps the tightening and names the provider", async () => {
  const { run, applied } = tightenFixture({
    outcome: "completed",
    refuse: "signIn",
  });
  run.magic.start(project, "balanced", "deepseek");
  const view = await settle(run.magic);
  assert.equal(applied.length, 1);
  assert.equal(view.status, "completed");
  assert.equal(view.message, magicWandIssues.deepseekKey);
  assert.equal(run.started[0]!.provider, "deepseek");
});

test("every connection gets the same guarded tools and rules, adapted to what it can do", () => {
  assert.equal(roughCutPlaybookFor("claude"), roughCutPlaybook);
  const codex = roughCutPlaybookFor("codex");
  assert.match(codex, /rendered pictures/u);
  assert.match(codex, /cut\.delete_ranges/u);
  for (const provider of ["deepseek", "openai", "gemini"] as const) {
    const text = roughCutPlaybookFor(provider);
    // No pictures, and tool names as the API providers see them.
    assert.doesNotMatch(text, /rendered picture/u);
    assert.match(text, /You cannot see pictures/u);
    assert.match(text, /cut_delete_ranges/u);
    assert.doesNotMatch(text, /cut\.delete_ranges/u);
  }
  for (const provider of magicWandProviders)
    assert.match(
      roughCutPlaybookFor(provider),
      /untrusted source content/u,
      provider,
    );
  const evidence = [
    {
      kind: "pause" as const,
      sourceId: "source-a",
      sourceStartUs: 1_000_000,
      sourceEndUs: 3_500_000,
      startUs: 1_000_000,
      endUs: 3_500_000,
    },
  ];
  const request = roughCutRequest("balanced", evidence, null, "gemini");
  assert.match(request, /transcript_get_range/u);
  assert.doesNotMatch(request, /transcript\.get_range/u);
  assert.match(roughCutRequest("balanced", evidence), /transcript\.get_range/u);
  // Every tool the story edit may call is a guarded editor tool; none is an app action.
  for (const tool of roughCutTools)
    assert.equal(tool.startsWith("app."), false, tool);
});

test("Stop also stops the transcription Magic Edit is waiting for, so the step can be left", async () => {
  const stopRequests: unknown[] = [];
  let running = true;
  const transcriptions = {
    get: async () =>
      ({
        job: {
          status: running ? "transcribing" : "cancelled",
          source_count: 1,
          progress_percent: 10,
          job_id: "job-running",
        },
        results: [],
      }) as never,
    start: async () => {
      throw new Error("a transcription is already running");
    },
    stop: async (request: unknown) => {
      stopRequests.push(request);
      running = false;
      return (await transcriptions.get()) as never;
    },
  };
  const editor: RoughCutEditor = {
    async blocked() {
      return null;
    },
    async start() {
      throw new Error("the story pass must not start after Stop");
    },
    outcome: () => null,
    async stop() {},
  };
  const magic = new DesktopMagicWand(
    transcriptions,
    async () => {
      throw new Error("no tool call is expected");
    },
    editor,
    { pollMs: 5 },
  );
  magic.start(project, "balanced");
  await new Promise((resolve) => setTimeout(resolve, 30));
  magic.stop(project);
  const view = await settle(magic);
  assert.equal(view.status, "stopped");
  assert.deepEqual(stopRequests, [
    { schema_version: "1.0", project_id: project, job_id: "job-running" },
  ]);
});

test("a transcription stopped earlier does not fail the next Magic Edit: a fresh one is started", async () => {
  const run = harness({ outcome: "completed", earlierJob: "cancelled" });
  run.magic.start(project, "balanced");
  const view = await settle(run.magic);
  assert.equal(view.status, "completed");
  assert.equal(run.transcriptionStarts(), 1);
});

test("a video with no usable speech finishes as a valid completed view with a plain note", async () => {
  const failing = {
    get: async () =>
      ({
        job: {
          status: "failed",
          source_count: 1,
          progress_percent: null,
          job_id: "job-1",
        },
        results: [],
      }) as never,
    start: async () =>
      ({
        job: {
          status: "failed",
          source_count: 1,
          progress_percent: null,
          job_id: "job-2",
        },
        results: [],
      }) as never,
  };
  const editor: RoughCutEditor = {
    async blocked() {
      return null;
    },
    async start() {
      throw new Error("the story pass must not start without speech");
    },
    outcome: () => null,
    async stop() {},
  };
  const magic = new DesktopMagicWand(
    failing,
    async () => {
      throw new Error("no tool call is expected");
    },
    editor,
    { pollMs: 5 },
  );
  magic.start(project, "balanced");
  const view = await settle(magic);
  assertMagicWandView(view);
  assert.equal(view.status, "completed");
  assert.equal(view.message, magicWandIssues.noSpeech);
  assert.deepEqual(view.summary?.cuts, 0);
});
