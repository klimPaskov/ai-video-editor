import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  projectStages,
  projectCanonicalJson,
} from "../../packages/domain/src/project.ts";
import type { ProjectStage } from "../../packages/domain/src/project.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  ProjectStore,
  renameProjectDirectoryWithRetry,
} from "../../packages/project-store/src/store.ts";

async function fixture() {
  const base = resolve("test-results/project-store");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  const source = join(root, "source.mkv");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=16x16:rate=30000/1001:duration=0.4",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "bgra",
      "-color_range",
      "pc",
      "-colorspace",
      "rgb",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      source,
    ],
  });
  const library = new MediaLibrary(join(root, "library"));
  const media = await library.importFile(source);
  const projects = join(root, "projects");
  const store = new ProjectStore(projects, library);
  return { root, source, library, media, projects, store };
}
test("Windows project publish retries transient rename locks within a fixed bound", async () => {
  let attempts = 0;
  await renameProjectDirectoryWithRetry(
    async () => {
      attempts++;
      if (attempts < 3)
        throw Object.assign(new Error("fixture lock"), { code: "EPERM" });
    },
    "staged-project",
    "published-project",
    "win32",
    async () => {},
  );
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    renameProjectDirectoryWithRetry(
      async () => {
        attempts++;
        throw Object.assign(new Error("fixture lock"), { code: "EPERM" });
      },
      "staged-project",
      "published-project",
      "win32",
      async () => {},
    ),
  );
  assert.equal(attempts, 6);

  attempts = 0;
  await assert.rejects(
    renameProjectDirectoryWithRetry(
      async () => {
        attempts++;
        throw Object.assign(new Error("unrelated"), { code: "EIO" });
      },
      "staged-project",
      "published-project",
      "linux",
      async () => {},
    ),
  );
  assert.equal(attempts, 1);
});
test("real initial project reopens and navigates all five stages without changing baseline or sources", async () => {
  const { source, library, media, projects, store } = await fixture();
  assert.deepEqual(await store.list(), []);
  const original = await readFile(source);
  const verified = await library.verifiedSource(media.id);
  const created = await store.createFromMedia(media.id);
  const id = created.project.project_id;
  assert.equal(
    new Set([
      id,
      created.timeline.timeline_id,
      created.revision.revision_id,
      media.id,
    ]).size,
    4,
  );
  assert.deepEqual(created.timeline.frame_rate, {
    numerator: 30000,
    denominator: 1001,
  });
  assert.equal(
    created.project.current_revision_id,
    created.revision.revision_id,
  );
  const baselinePath = join(projects, id, "baseline.json");
  const baseline = await readFile(baselinePath);
  assert.deepEqual(await new ProjectStore(projects, library).open(id), created);
  for (const stage of projectStages) {
    const changed = await store.navigate(id, stage);
    assert.equal(changed.project.workflow_step, stage);
    assert.equal(
      (await new ProjectStore(projects, library).open(id)).project
        .workflow_step,
      stage,
    );
    assert.equal(
      projectCanonicalJson(changed.timeline),
      projectCanonicalJson(created.timeline),
    );
    assert.deepEqual(changed.revision, created.revision);
    assert.deepEqual(await readFile(baselinePath), baseline);
  }
  assert.equal((await store.list())[0]?.project.workflow_step, "done");
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(verified.managedPath), original);
  const next = store.navigate(id, "edit"),
    last = new ProjectStore(projects, library).navigate(id, "clips");
  await Promise.all([next, last]);
  assert.equal((await store.open(id)).project.workflow_step, "clips");
});
test("a project saved in the retired Review step opens in Refine and keeps everything else", async () => {
  const { store, projects, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  const id = created.project.project_id;
  const path = join(projects, id, "project.json");
  const saved = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    path,
    `${JSON.stringify({ ...saved, workflow_step: "review", name: "Kept" })}\n`,
  );
  const opened = await store.open(id);
  assert.equal(opened.project.workflow_step, "edit");
  assert.equal(opened.project.name, "Kept");
  assert.equal((await store.list())[0]?.project.workflow_step, "edit");
  const moved = await store.navigate(id, "clips");
  assert.equal(moved.project.workflow_step, "clips");
  assert.equal(JSON.parse(await readFile(path, "utf8")).workflow_step, "clips");
});
test("corrupt metadata, stale identity and invalid stages fail without changing committed files", async () => {
  const { store, projects, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  const id = created.project.project_id;
  const path = join(projects, id, "project.json"),
    baselinePath = join(projects, id, "baseline.json");
  const before = await readFile(path),
    baseline = await readFile(baselinePath);
  await assert.rejects(store.navigate(id, "delete" as ProjectStage));
  assert.deepEqual(await readFile(path), before);
  await writeFile(path, "{broken");
  await assert.rejects(store.open(id));
  await assert.rejects(store.navigate(id, "edit"));
  assert.equal(await readFile(path, "utf8"), "{broken");
  const stale = { ...created.project, current_revision_id: media.id };
  await writeFile(path, JSON.stringify(stale));
  await assert.rejects(store.open(id));
  assert.deepEqual(await readFile(baselinePath), baseline);
  await writeFile(path, before);
  await writeFile(
    baselinePath,
    JSON.stringify({
      ...created,
      timeline: { ...created.timeline, duration_us: 1 },
    }),
  );
  await assert.rejects(store.open(id));
  await assert.rejects(store.navigate(id, "clips"));
  assert.deepEqual(await readFile(path), before);
});
test("unsafe identities, linked roots and hardlinked project files are rejected", async () => {
  const { root, store, projects, media, library } = await fixture();
  const created = await store.createFromMedia(media.id);
  const id = created.project.project_id;
  await assert.rejects(store.open("../private"));
  const linked = join(root, "linked");
  await symlink(projects, linked, "junction");
  await assert.rejects(new ProjectStore(linked, library).open(id));
  const path = join(projects, id, "project.json");
  const before = await readFile(path);
  await link(path, join(root, "duplicate.json"));
  await assert.rejects(store.open(id));
  await assert.rejects(store.navigate(id, "edit"));
  assert.deepEqual(await readFile(path), before);
});
test("verified source accessor and project reopen reject changed managed bytes", async () => {
  const { store, library, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  const verified = await library.verifiedSource(media.id);
  await writeFile(verified.managedPath, "changed");
  await assert.rejects(library.verifiedSource(media.id), /changed/u);
  await assert.rejects(store.open(created.project.project_id));
  await assert.rejects(store.createFromMedia(media.id));
});
test("Windows case aliases reopen the same verified project root", async () => {
  const { store, projects, library, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  if (process.platform !== "win32") return;
  const reopened = await new ProjectStore(projects.toLowerCase(), library).open(
    created.project.project_id,
  );
  assert.equal(reopened.project.project_id, created.project.project_id);
});
test("failure after staging navigation preserves committed metadata and baseline", async (context) => {
  const { store, projects, library, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  const folder = join(projects, created.project.project_id);
  const before = await readFile(join(folder, "project.json"));
  const baseline = await readFile(join(folder, "baseline.json"));
  const original = library.verifiedSource.bind(library);
  let calls = 0;
  const fault = context.mock.method(
    library,
    "verifiedSource",
    async (id: string) => {
      if (++calls === 2)
        throw new Error("Injected source validation failure before commit");
      return original(id);
    },
  );
  await assert.rejects(
    store.navigate(created.project.project_id, "edit"),
    /before commit/u,
  );
  fault.mock.restore();
  assert.deepEqual(await readFile(join(folder, "project.json")), before);
  assert.deepEqual(await readFile(join(folder, "baseline.json")), baseline);
  assert.equal(
    (await store.open(created.project.project_id)).project.workflow_step,
    "record_import",
  );
});
test("rename changes only the project name and keeps the baseline", async () => {
  const { store, projects, library, media } = await fixture();
  const created = await store.createFromMedia(media.id);
  const id = created.project.project_id;
  const baseline = await readFile(join(projects, id, "baseline.json"));
  await store.navigate(id, "edit");
  const renamed = await store.rename(id, "Weekly update");
  assert.equal(renamed.project.name, "Weekly update");
  assert.equal(renamed.project.workflow_step, "edit");
  const reopened = await new ProjectStore(projects, library).open(id);
  assert.equal(reopened.project.name, "Weekly update");
  assert.equal(reopened.project.workflow_step, "edit");
  assert.deepEqual(reopened.timeline, created.timeline);
  assert.deepEqual(
    await readFile(join(projects, id, "baseline.json")),
    baseline,
  );
  // Navigation keeps the new name.
  assert.equal(
    (await store.navigate(id, "clips")).project.name,
    "Weekly update",
  );
  for (const name of ["", " padded", "a/b", "a\b", "x\ny", "x".repeat(161)])
    await assert.rejects(store.rename(id, name));
  assert.equal((await store.open(id)).project.name, "Weekly update");
  // Other fields in project.json still have to match the baseline.
  const path = join(projects, id, "project.json");
  const changed = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    path,
    JSON.stringify({ ...changed, created_at: "2020-01-01T00:00:00.000Z" }),
  );
  await assert.rejects(store.open(id));
  // One unreadable project does not hide the others from Home.
  const other = await store.createFromMedia(media.id);
  assert.deepEqual(
    (await store.list()).map((project) => project.project.project_id),
    [other.project.project_id],
  );
});
test("remove deletes the project folder and keeps its source in the library", async () => {
  const { store, projects, library, media, source } = await fixture();
  const original = await readFile(source);
  const kept = await store.createFromMedia(media.id);
  const removed = await store.createFromMedia(media.id);
  await store.remove(removed.project.project_id);
  assert.deepEqual(
    (await store.list()).map((project) => project.project.project_id),
    [kept.project.project_id],
  );
  await assert.rejects(store.open(removed.project.project_id));
  await assert.rejects(store.remove(removed.project.project_id));
  await assert.rejects(store.remove("../library"));
  const verified = await library.verifiedSource(media.id);
  assert.deepEqual(await readFile(verified.managedPath), original);
  assert.deepEqual(await readFile(source), original);
  // A removal interrupted after its rename finishes on the next listing.
  await mkdir(
    join(projects, `.removing-${removed.project.project_id}`, "draft"),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      projects,
      `.removing-${removed.project.project_id}`,
      "draft",
      "x.json",
    ),
    "{}",
  );
  assert.equal((await store.list()).length, 1);
  await assert.rejects(
    readFile(
      join(
        projects,
        `.removing-${removed.project.project_id}`,
        "draft",
        "x.json",
      ),
    ),
  );
});
