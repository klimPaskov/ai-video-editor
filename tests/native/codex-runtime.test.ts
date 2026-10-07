// Real App Server bootstrap test. This is not a native-window or authenticated edit test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  CodexClient,
  CODEX_VERSION,
} from "../../packages/codex-bridge/src/client.ts";
import { CodexTransportError } from "../../packages/codex-bridge/src/transport.ts";

if (
  process.platform !== "linux" ||
  process.getuid?.() !== 1000 ||
  process.env.DISPLAY !== ":99"
)
  throw new Error("Requires the isolated Linux desktop guest.");
await access("/.dockerenv");
const executable = process.argv[2];
assert.ok(executable && isAbsolute(executable));
await mkdir(resolve("test-results"), { recursive: true });
const evidence = await mkdtemp(resolve("test-results/codex-runtime-"));
const cwd = join(evidence, "context");
const codexHome = join(evidence, "account");
const skill = join(cwd, ".agents/skills/fixture-guide/SKILL.md");
await mkdir(join(cwd, ".agents/skills/fixture-guide"), { recursive: true });
await mkdir(codexHome);
const guidance =
  "---\nname: fixture-guide\ndescription: Explain the synthetic fixture without changing files.\n---\nRead-only synthetic guidance for runtime discovery.\n";
const updatedGuidance =
  "---\nname: fixture-guide\ndescription: Describe the refreshed synthetic fixture without changing files.\n---\nUpdated read-only synthetic guidance for runtime discovery.\n";
await writeFile(skill, guidance);
let skillsChangedNotifications = 0;
const client = new CodexClient({
  executable,
  cwd,
  codexHome,
  environment: { PATH: process.env.PATH },
  onSkillsChanged: () => {
    skillsChangedNotifications++;
  },
});
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
try {
  let changedSkillRefreshedWhileConnected = false;
  let runtimeSkillChangeNotificationObserved = false;
  const provenance = {
    version: CODEX_VERSION,
    executableHash: hash(await readFile(executable)),
    clientHash: hash(
      await readFile(resolve("packages/codex-bridge/src/client.ts")),
    ),
    transportHash: hash(
      await readFile(resolve("packages/codex-bridge/src/transport.ts")),
    ),
    generatedContractHash: hash(
      await readFile(resolve("docs/contracts/codex-protocol.json")),
    ),
    testHash: hash(
      await readFile(resolve("tests/native/codex-runtime.test.ts")),
    ),
  };
  await writeFile(
    join(evidence, "provenance.json"),
    JSON.stringify(provenance, null, 2),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.connect();
    assert.deepEqual(await client.account(), { status: "signed_out" });
    const skills = await client.skills();
    const fixtureSkill = skills.find((entry) => entry.name === "fixture-guide");
    assert.ok(fixtureSkill?.enabled);
    assert.equal(
      fixtureSkill.description,
      attempt === 0
        ? "Explain the synthetic fixture without changing files."
        : "Describe the refreshed synthetic fixture without changing files.",
    );
    if (attempt === 0) {
      const notificationsBeforeChange = skillsChangedNotifications;
      await writeFile(skill, updatedGuidance);
      const refreshedSkills = await client.skills();
      const refreshed = refreshedSkills.find(
        (entry) => entry.name === "fixture-guide",
      );
      assert.ok(refreshed?.enabled);
      assert.equal(
        refreshed.description,
        "Describe the refreshed synthetic fixture without changing files.",
      );
      changedSkillRefreshedWhileConnected = true;
      const notificationDeadline = Date.now() + 5000;
      while (
        skillsChangedNotifications === notificationsBeforeChange &&
        Date.now() < notificationDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      runtimeSkillChangeNotificationObserved =
        skillsChangedNotifications > notificationsBeforeChange;
    }
    await assert.rejects(
      client.models(),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "not_ready",
    );
    const closing = client.close();
    await assert.rejects(
      client.connect(),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "closed",
    );
    await closing;
  }
  assert.equal(await readFile(skill, "utf8"), updatedGuidance);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope:
          "Real unauthenticated Codex stdio bootstrap; no Electron window or model turn",
        ...provenance,
        initializedConnections: 2,
        freshAccount: "signed_out",
        realSkillDiscovery: true,
        changedSkillRefreshedWhileConnected,
        runtimeSkillChangeNotificationObserved,
        modelsRequireChatgptAccount: true,
        updatedFixtureUnchanged: true,
        hostCredentialsCopied: false,
        authenticated: false,
        nativeWindow: false,
        edit: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      code:
        error instanceof CodexTransportError
          ? error.code
          : "assertion_or_setup",
    }),
  );
  throw error;
} finally {
  await client.close();
}
