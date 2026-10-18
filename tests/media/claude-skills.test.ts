import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mirrorUserSkills,
  userSkillsDirectory,
} from "../../apps/desktop/src/claude-skills.ts";
import {
  claudeBuiltInTools,
  claudeTurnArguments,
  ClaudeTurnProjection,
} from "../../packages/claude-bridge/src/turn.ts";
import {
  claudeEditorServer,
  claudeEditorTools,
} from "../../apps/desktop/src/claude.ts";

test("the user's skills are mirrored as a plugin, regular files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-skills-"));
  try {
    const source = join(root, "skills");
    await mkdir(join(source, "motion-graphics", "references"), {
      recursive: true,
    });
    await writeFile(
      join(source, "motion-graphics", "SKILL.md"),
      "---\nname: motion-graphics\ndescription: Motion.\n---\nBody",
    );
    await writeFile(
      join(source, "motion-graphics", "references", "easing.md"),
      "Ease out.",
    );
    // Not a skill: no SKILL.md.
    await mkdir(join(source, "notes"));
    await writeFile(join(source, "notes", "todo.md"), "x");
    // A link inside a skill is never followed.
    const outside = join(root, "outside.txt");
    await writeFile(outside, "private");
    let linked = true;
    try {
      await symlink(outside, join(source, "motion-graphics", "leak.txt"));
    } catch {
      linked = false; // Windows without link rights.
    }
    const target = join(root, "plugin");
    const mirrored = await mirrorUserSkills(source, target);
    assert.deepEqual(mirrored, {
      directory: target,
      skills: ["motion-graphics"],
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(join(target, ".claude-plugin", "plugin.json"), "utf8"),
      ).name,
      "my-skills",
    );
    assert.deepEqual(await readdir(join(target, "skills")), [
      "motion-graphics",
    ]);
    assert.equal(
      await readFile(
        join(target, "skills", "motion-graphics", "references", "easing.md"),
        "utf8",
      ),
      "Ease out.",
    );
    if (linked)
      await assert.rejects(
        stat(join(target, "skills", "motion-graphics", "leak.txt")),
      );
    // Unchanged skills are not copied again.
    const before = (await stat(join(target, ".fingerprint"))).mtimeMs;
    await mirrorUserSkills(source, target);
    assert.equal((await stat(join(target, ".fingerprint"))).mtimeMs, before);
    // A changed skill is.
    await writeFile(join(source, "motion-graphics", "SKILL.md"), "changed");
    await mirrorUserSkills(source, target);
    assert.equal(
      await readFile(
        join(target, "skills", "motion-graphics", "SKILL.md"),
        "utf8",
      ),
      "changed",
    );
    assert.equal(await mirrorUserSkills(join(root, "missing"), target), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the skills folder follows the user's Claude Code profile", () => {
  assert.equal(
    userSkillsDirectory({}, "/home/user"),
    join("/home/user", ".claude", "skills"),
  );
  assert.equal(
    userSkillsDirectory({ CLAUDE_CONFIG_DIR: "/profiles/me" }, "/home/user"),
    join("/profiles/me", "skills"),
  );
});

test("skills load only with a plugin, and the tool inventory stays exact", () => {
  const base = {
    mcpConfigPath: "/private/mcp.json",
    serverName: claudeEditorServer,
    allowedTools: claudeEditorTools,
    builtInTools: claudeBuiltInTools,
    model: "default",
    effort: null,
    systemPrompt: "prompt",
    sessionId: "11111111-2222-4333-8444-555555555555",
    resume: false,
    maxTurns: 24,
  } as const;
  const without = claudeTurnArguments(base);
  assert.ok(without.includes("--disable-slash-commands"));
  assert.ok(!without.includes("--plugin-dir"));
  const withSkills = claudeTurnArguments({
    ...base,
    pluginDirs: ["/app/claude/skills-plugin"],
  });
  assert.ok(!withSkills.includes("--disable-slash-commands"));
  assert.equal(
    withSkills[withSkills.indexOf("--plugin-dir") + 1],
    "/app/claude/skills-plugin",
  );
  assert.equal(
    withSkills[withSkills.indexOf("--tools") + 1],
    claudeBuiltInTools.join(","),
  );
  const init = (tools: string[]) => ({
    type: "system",
    subtype: "init",
    session_id: base.sessionId,
    tools,
    mcp_servers: [{ name: claudeEditorServer, status: "connected" }],
    permissionMode: "dontAsk",
    skills: ["my-skills:motion-graphics", "code-review"],
    slash_commands: ["my-skills:motion-graphics"],
  });
  const all = [...claudeEditorTools, ...claudeBuiltInTools];
  const projection = (allowSkills: boolean) =>
    new ClaudeTurnProjection({
      allowedTools: all,
      serverName: claudeEditorServer,
      sessionId: base.sessionId,
      allowSkills,
    });
  assert.equal(projection(true).handle(init(all)), true);
  // Without the user's skills, any skill is still a violation.
  assert.equal(projection(false).handle(init(all)), false);
  // Skills never widen the tools.
  assert.equal(projection(true).handle(init([...all, "Bash"])), false);
});
