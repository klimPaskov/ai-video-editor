import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopMagicWand,
  type RoughCutEditor,
  type RoughCutOutcome,
} from "../../apps/desktop/src/magic-wand.ts";
import {
  roughCutRequest,
  roughCutTools,
} from "../../apps/desktop/src/rough-cut-playbook.ts";
import { magicWandIssues } from "../../packages/domain/src/magic-wand-view.ts";
import { codexVideoEditToolNames } from "../../packages/codex-tools/src/service.ts";

const project = "project-rough-001";

function harness(script: {
  outcome: RoughCutOutcome | "later";
  refuse?: RoughCutOutcome;
}) {
  const calls: string[] = [];
  const started: Array<{ preset: string; request: string }> = [];
  let duration = 60_000_000;
  let operations: string[] = ["op-before"];
  let finished: RoughCutOutcome | null = null;
  let stopped = 0;
  const transcriptions = {
    get: async () =>
      ({
        job: {
          status: "completed",
          source_count: 1,
          progress_percent: 100,
          job_id: "job-1",
        },
        results: [],
      }) as never,
    start: async () => {
      throw new Error("not needed");
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
    async start(_projectId, preset, request) {
      started.push({ preset, request });
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
  });
  return {
    magic,
    calls,
    started,
    stopped: () => stopped,
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
  assert.equal(view.message, magicWandIssues.claude);
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
    { kind: "pause", startUs: 1_000_000, endUs: 3_500_000 },
    { kind: "repeated_take", startUs: 9_000_000, endUs: 12_000_000 },
  ]);
  assert.match(request, /not a cut list/u);
  assert.match(request, /long pause: 1000000–3500000/u);
  assert.match(request, /earlier copy of repeated wording: 9000000–12000000/u);
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
