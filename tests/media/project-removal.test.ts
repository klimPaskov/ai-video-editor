import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  projectSideFiles,
  removeProjectSideFiles,
} from "../../apps/desktop/src/project-removal.ts";

const project = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

async function populate(root: string, id: string) {
  const { files, directories } = projectSideFiles(root, id);
  for (const file of files) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{}");
  }
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "export-1.json"), "{}");
  }
}

test("a deleted project's conversations, choices and export records go; others stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-removal-"));
  try {
    await populate(root, project);
    await populate(root, other);
    await mkdir(join(root, "media-library"), { recursive: true });
    await writeFile(join(root, "media-library", "kept.json"), "{}");
    await removeProjectSideFiles(root, project);
    const left = await readdir(root, { recursive: true });
    assert.equal(
      left.some((path) => path.includes(project)),
      false,
    );
    const { files } = projectSideFiles(root, other);
    for (const file of files)
      assert.ok(
        left.some((path) => file.endsWith(path)),
        file,
      );
    assert.ok(left.some((path) => path.endsWith("kept.json")));
    // Already removed: nothing to do.
    await removeProjectSideFiles(root, project);
    assert.throws(() => projectSideFiles(root, "../media-library"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude's workspace and session logs of a deleted project go, others stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-removal-"));
  try {
    const sessions = join(root, "claude", "claude-code", "projects");
    // Claude Code's folder name: the workspace path with dashes for symbols.
    const sessionFolder = (id: string) =>
      join(sessions, `-home-user-app-claude-workspaces-${id}`);
    for (const id of [project, other]) {
      const workspace = join(root, "claude", "workspaces", id);
      await mkdir(join(workspace, "compositions", "title"), {
        recursive: true,
      });
      await writeFile(join(workspace, "edit.md"), "the spoken words");
      await writeFile(
        join(workspace, "compositions", "title", "index.html"),
        "",
      );
      await mkdir(sessionFolder(id), { recursive: true });
      await writeFile(join(sessionFolder(id), "session.jsonl"), "{}");
    }
    // The sign-in data beside them is never touched.
    await writeFile(join(root, "claude", "claude-code", ".credentials"), "x");
    await removeProjectSideFiles(root, project);
    const left = await readdir(root, { recursive: true });
    assert.equal(
      left.some((path) => path.includes(project)),
      false,
    );
    assert.ok(left.some((path) => path.includes(other)));
    assert.ok(left.some((path) => path.endsWith(".credentials")));
    assert.ok(left.some((path) => path.endsWith("edit.md")));
    // A link in the workspace is removed as a link; its target stays.
    const outside = join(root, "elsewhere.txt");
    await writeFile(outside, "kept");
    await symlink(
      outside,
      join(root, "claude", "workspaces", other, "link.txt"),
    ).catch(() => undefined);
    await removeProjectSideFiles(root, other);
    assert.equal((await readdir(root)).includes("elsewhere.txt"), true);
    // A workspace that is itself a link is refused, not followed.
    await rm(join(root, "claude", "workspaces"), { recursive: true });
    await mkdir(join(root, "claude", "workspaces"), { recursive: true });
    await mkdir(join(root, "media-library"), { recursive: true });
    await writeFile(join(root, "media-library", "kept.json"), "{}");
    let linked = true;
    await symlink(
      join(root, "media-library"),
      join(root, "claude", "workspaces", project),
      "dir",
    ).catch(() => {
      // Creating links needs a privilege on some systems.
      linked = false;
    });
    if (linked) {
      await assert.rejects(removeProjectSideFiles(root, project));
      assert.ok(
        (await readdir(join(root, "media-library"))).includes("kept.json"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexpected entries stop the removal instead of being deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-removal-"));
  try {
    const { files, directories } = projectSideFiles(root, project);
    // A folder where a conversation file should be.
    await mkdir(files[0]!, { recursive: true });
    await assert.rejects(removeProjectSideFiles(root, project));
    await rm(files[0]!, { recursive: true });
    // An export record folder holding something other than records.
    await mkdir(join(directories[0]!, "nested"), { recursive: true });
    await assert.rejects(removeProjectSideFiles(root, project));
    assert.deepEqual(await readdir(directories[0]!), ["nested"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
