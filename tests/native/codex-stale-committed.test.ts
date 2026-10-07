/** Offline and live stale-tool rejection after a real authenticated native edit. */
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { _electron, expect } from "playwright/test";
import {
  CodexStdioTransport,
  CodexTransportError,
} from "../../packages/codex-bridge/src/transport.ts";
import { buildCodexAppServerArguments } from "../../packages/codex-bridge/src/client.ts";
import { buildExperimentalInitialize } from "../../packages/codex-bridge/src/thread-protocol.ts";
import {
  CodexVideoEditToolError,
  CodexVideoEditToolService,
} from "../../packages/codex-tools/src/service.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { sha256 } from "../../packages/media-engine/src/lossless.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";
import {
  assertNativeTestEnvironment,
  insideGuestWorkspace,
} from "../../scripts/native-test-environment.ts";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const suppliedEvidence = process.argv[2];
const suppliedConfig = process.argv[3];
const executablePath = process.argv[4];
assert.ok(suppliedEvidence && suppliedConfig && executablePath);
assert.equal(resolve(executablePath), executablePath);
assert.ok(insideGuestWorkspace(executablePath));
const evidence = await realpath(suppliedEvidence);
const configRoot = await realpath(suppliedConfig);
assert.equal(evidence, resolve(suppliedEvidence));
assert.equal(configRoot, resolve(suppliedConfig));
assert.ok(evidence.startsWith(resolve("test-results") + sep));
assert.match(basename(evidence), /^native-codex-authenticated-[A-Za-z0-9]+$/u);
const resultDir = await mkdtemp(
  join(resolve("test-results"), "native-codex-stale-"),
);
await chmod(resultDir, 0o700);
let step = "locate-real-fixture";
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let transport: CodexStdioTransport | undefined;
try {
  const original = join(evidence, "Color sequence.mkv");
  const originalHash = sha256(await readFile(original));
  const userData = join(configRoot, "ai-video-editor");
  const projectsRoot = join(userData, "project-store");
  const matches: Array<{
    projectId: string;
    baselinePath: string;
    baselineBytes: Buffer;
    managedPath: string;
  }> = [];
  for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const baselinePath = join(projectsRoot, entry.name, "baseline.json");
    let baselineBytes: Buffer;
    try {
      baselineBytes = await readFile(baselinePath);
    } catch {
      continue;
    }
    const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
    assertInitialProjectSnapshot(baseline);
    if (baseline.source.original_path === original) {
      matches.push({
        projectId: baseline.project.project_id,
        baselinePath,
        baselineBytes,
        managedPath: baseline.source.managed_path,
      });
    }
  }
  assert.equal(matches.length, 1, "Require one matching real native fixture");
  const matched = matches[0]!;
  assert.equal(sha256(await readFile(matched.managedPath)), originalHash);
  const registry = JSON.parse(
    await readFile(
      join(userData, "codex/context/threads/project-threads.json"),
      "utf8",
    ),
  ) as {
    schemaVersion: number;
    entries: Array<{ projectId: string; threadId: string; toolRoute?: string }>;
  };
  const bindings = registry.entries.filter(
    (entry) => entry.projectId === matched.projectId,
  );
  assert.equal(bindings.length, 1);
  const binding = bindings[0]!;
  const route = binding.toolRoute ?? "mcp";
  assert.ok(route === "mcp" || route === "dynamic");
  if (route === "dynamic") assert.equal(registry.schemaVersion, 2);
  const threadId = binding.threadId;
  const journalRoot = join(projectsRoot, matched.projectId, "draft/journal");
  const journalNames = (await readdir(journalRoot))
    .filter((name) =>
      /^\d{12}\.[A-Za-z0-9][A-Za-z0-9._-]{1,127}\.json$/u.test(name),
    )
    .sort();
  assert.equal(
    journalNames.length,
    route === "dynamic" ? 2 : 1,
    "Require the authenticated fixture's real committed edit and optional Undo",
  );
  const journalPath = join(journalRoot, journalNames[0]!);
  const journalBefore = await readFile(journalPath);
  const journalContents = await Promise.all(
    journalNames.map((name) => readFile(join(journalRoot, name))),
  );
  const edit = JSON.parse(
    journalBefore.toString("utf8"),
  ) as DraftTransactionRecord;
  assert.equal(edit.origin, "codex");
  assert.equal(edit.kind, "apply");
  assert.equal(edit.status, "committed");
  assert.equal(edit.before.draft_sequence, 0);
  assert.equal(edit.before.timeline.duration_us, 1500000);
  assert.equal(edit.after.draft_sequence, 1);
  assert.equal(edit.after.timeline.duration_us, 1000000);
  assert.equal(edit.operations.length, 1);
  if (edit.operations[0]!.operation_type !== "trim")
    throw new Error("Expected a trim operation");
  assert.equal(edit.operations[0]!.edge, "start");
  const lastRecord = JSON.parse(
    journalContents.at(-1)!.toString("utf8"),
  ) as DraftTransactionRecord;
  const expectedDraft = lastRecord.after;
  if (route === "dynamic") {
    assert.equal(lastRecord.kind, "undo");
    assert.equal(lastRecord.status, "committed");
    assert.deepEqual(lastRecord.before, edit.after);
    assert.equal(expectedDraft.draft_sequence, 2);
    assert.equal(expectedDraft.timeline.duration_us, 1500000);
  }

  step = "reject-stale-guarded-request";
  const projects = new ProjectStore(
    projectsRoot,
    new MediaLibrary(join(userData, "media-library")),
  );
  const drafts = new DraftTransactionStore(projectsRoot, projects);
  assert.deepEqual(
    (await drafts.snapshot(matched.projectId)).draft,
    expectedDraft,
  );
  const service = new CodexVideoEditToolService(matched.projectId, drafts);
  await assert.rejects(
    service.invoke("cut.trim_edge", {
      schema_version: "1.0",
      request_id: "stale-after-real-codex-001",
      project_id: edit.before.project_id,
      draft_id: edit.before.draft_id,
      base_revision_id: edit.before.base_revision_id,
      expected_sequence: edit.before.draft_sequence,
      expected_timeline_sha256: edit.before.timeline_sha256,
      pass_group_id: "stale-spoken-cut-001",
      reason: "Verify stale freshness after a real Codex edit.",
      clip_id: edit.before.timeline.clips[0]!.clip_id,
      edge: "end",
      timeline_position_us: 1000000,
    }),
    (error: unknown) =>
      error instanceof CodexVideoEditToolError && error.code === "stale_draft",
  );
  assert.deepEqual(
    (await drafts.snapshot(matched.projectId)).draft,
    expectedDraft,
  );
  assert.deepEqual(await readdir(journalRoot), journalNames);
  assert.deepEqual(
    await Promise.all(
      journalNames.map((name) => readFile(join(journalRoot, name))),
    ),
    journalContents,
  );
  assert.deepEqual(await readFile(matched.baselinePath), matched.baselineBytes);
  assert.equal(sha256(await readFile(matched.managedPath)), originalHash);
  assert.equal(sha256(await readFile(original)), originalHash);

  step = "live-stale-guarded-relay";
  const toolName =
    route === "dynamic" ? "codex_video_edit__cut_trim_edge" : "cut.trim_edge";
  const prompt = `Test the guarded stale-draft response. Call ${toolName} exactly once with this earlier, now stale draft head. Do not first refresh it or substitute a new sequence or hash. Treat the expected rejection as success for this diagnostic and do not call any other mutation tool. Use these exact arguments: ${JSON.stringify(
    {
      schema_version: "1.0",
      request_id: "live-stale-after-codex-001",
      project_id: edit.before.project_id,
      draft_id: edit.before.draft_id,
      base_revision_id: edit.before.base_revision_id,
      expected_sequence: edit.before.draft_sequence,
      expected_timeline_sha256: edit.before.timeline_sha256,
      pass_group_id: "stale-spoken-cut-001",
      reason: "Verify stale freshness through the live guarded tool.",
      clip_id: edit.before.timeline.clips[0]!.clip_id,
      edge: "end",
      timeline_position_us: 1000000,
    },
  )}. Then briefly say whether the tool rejected it. Do not claim success without a real tool result.`;
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    timeout: 30000,
  });
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return (
          result.ok &&
          result.value.connection === "connected" &&
          result.value.account === "signed_in" &&
          !result.value.busy
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await page
    .locator(`#projects [data-project-id="${matched.projectId}"]`)
    .click();
  await expect(page.locator("#frame")).toBeVisible();
  await page.locator("#codex-drawer-button").click();
  await page.locator("#assistant-provider").selectOption("codex");
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const thread = async () => {
    const result = await page.evaluate(
      (projectId) =>
        window.desktop.getCodexThread({
          schema_version: "1.0",
          project_id: projectId,
        }),
      matched.projectId,
    );
    assert.ok(result.ok);
    return result.value;
  };
  await expect
    .poll(async () => (await thread()).status, { timeout: 90000 })
    .toBe("ready");
  const priorUsers = (await thread()).messages.filter(
    (message) => message.role === "user",
  ).length;
  await page.locator("#codex-thread-input").fill(prompt);
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(
      async () => {
        const state = await thread();
        if (state.status === "failed" || state.status === "uncertain")
          throw new Error("Live stale turn failed; details omitted");
        const users = state.messages.filter(
          (message) => message.role === "user",
        );
        return (
          state.status === "ready" &&
          users.length === priorUsers + 1 &&
          users.at(-1)?.text === prompt &&
          state.messages.at(-1)?.role === "codex" &&
          state.messages.at(-1)?.complete === true
        );
      },
      { timeout: 240000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  await page.screenshot({ path: join(resultDir, "native-window.png") });
  await electron.close();
  electron = undefined;

  step = "authoritative-stale-tool-history";
  const codexHome = join(userData, "codex/account");
  const runtime = join(dirname(executablePath), "resources/codex/codex");
  transport = new CodexStdioTransport({
    executable: runtime,
    args: buildCodexAppServerArguments(),
    cwd: join(userData, "codex/context"),
    env: {
      HOME: dirname(codexHome),
      USERPROFILE: dirname(codexHome),
      CODEX_HOME: codexHome,
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    },
    requestTimeoutMs: 120000,
  });
  await transport.start(buildExperimentalInitialize("0.0.0"));
  const turns = async () => {
    const input = {
      threadId,
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    };
    try {
      return await transport!.request("thread/turns/list", input);
    } catch (error) {
      if (!(
        error instanceof CodexTransportError && error.code === "remote_error"
      ))
        throw error;
      await transport!.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      return transport!.request("thread/turns/list", input);
    }
  };
  const history = (await turns()) as {
    data: Array<{ status: string; items: Array<Record<string, unknown>> }>;
  };
  const target = history.data.find((turn) =>
    turn.items.some(
      (item) =>
        item.type === "userMessage" &&
        Array.isArray(item.content) &&
        item.content.some(
          (content: unknown) =>
            typeof content === "object" &&
            content !== null &&
            "text" in content &&
            content.text === prompt,
        ),
    ),
  );
  assert.ok(target && target.status === "completed");
  const staleCalls = target.items.filter((item) =>
    route === "dynamic"
      ? item.type === "dynamicToolCall" &&
        item.namespace === "codex_video_edit" &&
        item.tool === "cut_trim_edge"
      : item.type === "mcpToolCall" &&
        item.server === appIdentity.stableMcpServerId &&
        item.tool === "cut.trim_edge",
  );
  assert.equal(staleCalls.length, 1, "Require one live guarded stale call");
  const staleCall = staleCalls[0]!;
  if (route === "dynamic") {
    assert.ok(
      staleCall.status === "completed" || staleCall.status === "failed",
    );
    assert.equal(staleCall.success, false);
  } else assert.equal(staleCall.status, "failed");
  const staleArguments = staleCall.arguments as {
    request_id?: unknown;
    project_id?: unknown;
    draft_id?: unknown;
    base_revision_id?: unknown;
    expected_sequence?: unknown;
    expected_timeline_sha256?: unknown;
    clip_id?: unknown;
  };
  assert.equal(staleArguments.request_id, "live-stale-after-codex-001");
  assert.equal(staleArguments.project_id, edit.before.project_id);
  assert.equal(staleArguments.draft_id, edit.before.draft_id);
  assert.equal(staleArguments.base_revision_id, edit.before.base_revision_id);
  assert.equal(staleArguments.expected_sequence, edit.before.draft_sequence);
  assert.equal(
    staleArguments.expected_timeline_sha256,
    edit.before.timeline_sha256,
  );
  assert.equal(staleArguments.clip_id, edit.before.timeline.clips[0]!.clip_id);
  const resultText =
    route === "dynamic"
      ? JSON.stringify(staleCall.contentItems)
      : JSON.stringify({ result: staleCall.result, error: staleCall.error });
  assert.ok(
    /stale|draft changed before this edit/i.test(resultText),
    "The live guarded result did not relay the stale-draft rejection",
  );
  await transport.close();
  transport = undefined;
  assert.deepEqual(
    (await drafts.snapshot(matched.projectId)).draft,
    expectedDraft,
  );
  assert.deepEqual(await readdir(journalRoot), journalNames);
  assert.deepEqual(
    await Promise.all(
      journalNames.map((name) => readFile(join(journalRoot, name))),
    ),
    journalContents,
  );
  assert.deepEqual(await readFile(matched.baselinePath), matched.baselineBytes);
  assert.equal(sha256(await readFile(matched.managedPath)), originalHash);
  assert.equal(sha256(await readFile(original)), originalHash);
  await writeFile(
    join(resultDir, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope: "P2-stale-guard-after-authenticated-native-edit",
        guardedServiceRejectedStale: true,
        draftUnchanged: true,
        journalUnchanged: true,
        sourceUnchanged: true,
        baselineUnchanged: true,
        nativeLaunchInThisContinuation: true,
        liveStdioStaleRelayVerified: true,
        toolRoute: route,
        journalRecordCount: journalNames.length,
        sourceHash: originalHash,
        journalHash: sha256(journalBefore),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence: resultDir }));
} catch {
  await writeFile(
    join(resultDir, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(
    `Stale continuation failed at ${step}; private details omitted.`,
  );
  process.exitCode = 1;
} finally {
  await transport?.close().catch(() => {});
  await electron?.close().catch(() => {});
}
