import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
