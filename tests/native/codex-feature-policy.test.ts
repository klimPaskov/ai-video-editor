/** Check process feature overrides against the actual pinned Codex binary. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodexAppServerArguments,
  CODEX_VERSION,
} from "../../packages/codex-bridge/src/client.ts";
import {
  buildThreadResumeRequest,
  buildThreadStartRequest,
} from "../../packages/codex-bridge/src/thread-protocol.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await accessDocker();

const executableArgument = process.argv[2];
assert.ok(executableArgument && isAbsolute(executableArgument));
const executable = await realpath(executableArgument);
const insideGuest = relative("/home/node", executable);
assert.ok(
  insideGuest.length > 0 &&
    !isAbsolute(insideGuest) &&
    !insideGuest.split(sep).includes(".."),
  "Pinned executable must stay inside the isolated guest",
);

const workspace = resolve("test-results");
await mkdir(workspace, { recursive: true });
const evidence = await mkdtemp(join(workspace, "native-codex-feature-policy-"));
await chmod(evidence, 0o700);
const codexHome = join(evidence, "account");
const cwd = join(evidence, "context");
await mkdir(codexHome, { mode: 0o700 });
await mkdir(cwd, { mode: 0o700 });

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const manifestPath = join(dirname(executable), "manifest.json");
const provenance = {
  version: CODEX_VERSION,
  executableHash: sha256(await readFile(executable)),
  manifestHash: sha256(await readFile(manifestPath)),
  testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
};
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify(provenance, null, 2),
  { mode: 0o600 },
);

function configArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-c") continue;
    const expression = args[index + 1];
    assert.ok(expression && expression !== "-c", "Dangling config flag");
    assert.match(expression, /^[A-Za-z0-9_.-]+=/u);
    result.push("-c", expression);
    index++;
  }
  return result;
}

const args = buildCodexAppServerArguments();
assert.ok(args.includes("--strict-config"));
const overrides = configArguments(args);
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: codexHome,
  USERPROFILE: codexHome,
  CODEX_HOME: codexHome,
};
const execute = promisify(execFile);
const step = "feature-list";
try {
  const result = await execute(executable, ["features", "list", ...overrides], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 256 * 1024,
  });
  assert.doesNotMatch(result.stderr, /unknown (?:feature|config) key/iu);
  const features = new Map<string, boolean>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s+.+\s+(true|false)\s*$/u.exec(line);
    if (match) features.set(match[1]!, match[2] === "true");
  }
  assert.ok(features.size > 0, "Pinned feature inventory was empty");
  const configuredFeatureNames = new Set<string>();
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "-c") continue;
    const match = /^features\.([A-Za-z0-9_-]+)=/u.exec(args[index + 1]!);
    if (match) configuredFeatureNames.add(match[1]!);
  }
  for (const name of configuredFeatureNames)
    assert.ok(
      features.has(name),
      `Process config sets an unlisted feature: ${name}`,
    );

  const disabled = [
    "api_key_model_discovery",
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "chronicle",
    "code_mode",
    "code_mode_host",
    "computer_use",
    "compaction_image_budget",
    "deferred_executor",
    "default_mode_request_user_input",
    "exec_permission_approvals",
    "external_agent_memory_import",
    "fast_mode",
    "goals",
    "guardian_approval",
    "hooks",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_local_automation",
    "in_app_updates",
    "mentions_v2",
    "memories",
    "plugins",
    "plugin_sharing",
    "personality",
    "remote_plugin",
    "request_permissions_tool",
    "request_rule",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "skill_search",
    "sleep_tool",
    "standalone_web_search",
    "token_budget",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "unbounded_connection_retries",
    "unified_exec_tty",
    "view_image",
    "web_search_cached",
    "web_search_request",
    "workspace_dependencies",
  ];
  for (const name of disabled) assert.equal(features.get(name), false, name);
  // This backend flag remains true in 0.155.1; shell registration is separately off.
  assert.equal(features.get("unified_exec"), true);

  const policy = {
    model: "runtime-discovered-test-model",
    effort: "high",
    cwd,
    baseInstructions: "Use only the guarded editor tools.",
    developerInstructions: "Keep media and external tools out of scope.",
  };
  const mcpRequests = [
    buildThreadStartRequest(policy, {
      route: "mcp",
      nativeSubagentProtocol: "disabled",
    }),
    buildThreadResumeRequest("thread-feature-policy", policy, {
      route: "mcp",
      nativeSubagentProtocol: "disabled",
    }),
  ];
  const dynamicRequests = [
    buildThreadStartRequest(policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
    buildThreadResumeRequest("thread-feature-policy", policy, {
      route: "dynamic",
      nativeSubagentProtocol: "disabled",
    }),
  ];
  for (const request of [...mcpRequests, ...dynamicRequests])
    for (const name of Object.keys(request.config.features))
      assert.ok(
        features.has(name),
        `Thread config sets a feature absent from the pinned runtime: ${name}`,
      );
  for (const request of mcpRequests) {
    assert.equal(request.config.features.code_mode_only, false);
    assert.equal(request.config.features.code_mode.enabled, false);
    assert.equal(request.config.features.code_mode_host.enabled, false);
    assert.equal(request.config.features.unbounded_connection_retries, false);
  }
  for (const request of dynamicRequests) {
    assert.equal(request.config.features.code_mode_only, true);
    assert.equal(request.config.features.code_mode.enabled, true);
    assert.equal(request.config.features.code_mode_host.enabled, true);
    assert.equal(request.config.features.unbounded_connection_retries, false);
  }

  const count = disabled.length;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope: "pinned process feature overrides only",
        ...provenance,
        disabledFeatureCount: count,
        effectiveToolCatalogProven: false,
        threadRequestValuesVerified: true,
        effectiveThreadPolicyProven: false,
        signedIn: false,
        modelTurn: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ status: "pass", disabledFeatureCount: count }));
} catch (error) {
  const code =
    error instanceof Error && "code" in error
      ? String(error.code)
      : "assertion_or_setup";
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, code, ...provenance }),
    { mode: 0o600 },
  );
  throw error;
}

async function accessDocker(): Promise<void> {
  const { access } = await import("node:fs/promises");
  await access("/.dockerenv");
}
