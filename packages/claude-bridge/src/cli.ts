import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import {
  claudeEfforts,
  type ClaudeEffort,
  type ClaudeModelOption,
} from "../../domain/src/claude-view.ts";

/**
 * Oldest Claude Code release whose documented contract this bridge relies on:
 * `auth status` JSON with `configDirectory` (2.1.268), `--permission-prompts`
 * (2.1.259) and the stream-json `system/init` tool inventory.
 */
export const minimumClaudeCodeVersion = "2.1.268";
/** Release used for the isolated acceptance probes. */
export const testedClaudeCodeVersion = "2.1.285";

export class ClaudeCliError extends Error {
  readonly code:
    "missing" | "outdated" | "runtime" | "status" | "catalog" | "timeout";
  constructor(code: ClaudeCliError["code"]) {
    super(`Claude Code ${code}`);
    this.name = "ClaudeCliError";
    this.code = code;
  }
}

export interface ClaudeRuntime {
  executable: string;
  /** Arguments placed before CLI arguments; empty for an installed CLI. */
  prefix: readonly string[];
  version: string;
}

/** Full argument vector for one Claude Code invocation. */
export function claudeArguments(
  runtime: ClaudeRuntime,
  args: readonly string[],
): string[] {
  return [...runtime.prefix, ...args];
}

export interface ClaudeEnvironmentInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configDirectory: string;
}

/**
 * The child gets ordinary OS/session variables plus its dedicated Claude Code
 * configuration directory. Anthropic credential variables and Claude Code
 * overrides from the caller's environment are never inherited, so a turn can
 * only use the login created through Claude Code's own sign-in for this app.
 */
export function claudeEnvironment(
  input: ClaudeEnvironmentInput,
): NodeJS.ProcessEnv {
  if (!isAbsolute(input.configDirectory)) throw new ClaudeCliError("runtime");
  const shared = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
  ];
  const platformKeys =
    input.platform === "win32"
      ? [
          "SystemRoot",
          "SystemDrive",
          "windir",
          "ComSpec",
          "PATHEXT",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "APPDATA",
          "LOCALAPPDATA",
          "ProgramData",
          "ProgramFiles",
          "ProgramFiles(x86)",
          "TEMP",
          "TMP",
          "USERNAME",
          "OS",
        ]
      : [
          "HOME",
          "USER",
          "LOGNAME",
          "SHELL",
          "TMPDIR",
          "DISPLAY",
          "WAYLAND_DISPLAY",
          "XDG_RUNTIME_DIR",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "DBUS_SESSION_BUS_ADDRESS",
          "BROWSER",
        ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...shared, ...platformKeys]) {
    const value = input.env[key];
    if (typeof value === "string" && value && !value.includes("\0"))
      env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = input.configDirectory;
  // The app must not update the user's own Claude Code installation.
  env.DISABLE_AUTOUPDATER = "1";
  // Editor turns get only app-supplied context: no CLAUDE.md or auto memory.
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  return env;
}

function candidateNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["claude.exe"] : ["claude"];
}

/** Ordered install locations documented for the native installer and npm. */
export function claudeExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const join = paths.join;
  const candidates: string[] = [];
  const add = (path: string | undefined) => {
    if (path && paths.isAbsolute(path) && !candidates.includes(path))
      candidates.push(path);
  };
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const directory of pathValue.split(paths.delimiter)) {
    if (!directory || !paths.isAbsolute(directory)) continue;
    for (const name of candidateNames(platform)) add(join(directory, name));
    if (platform === "win32")
      add(
        join(
          directory,
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin",
          "claude.exe",
        ),
      );
  }
  if (platform === "win32") {
    if (env.USERPROFILE)
      add(join(env.USERPROFILE, ".local", "bin", "claude.exe"));
    if (env.APPDATA)
      add(
        join(
          env.APPDATA,
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin",
          "claude.exe",
        ),
      );
  } else if (env.HOME) {
    add(join(env.HOME, ".local", "bin", "claude"));
    add(join(env.HOME, ".claude", "local", "claude"));
  }
  return candidates;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function parseClaudeVersion(output: string): string | null {
  const match = /^(\d{1,4}\.\d{1,4}\.\d{1,6}) \(Claude Code\)\s*$/u.exec(
    output.trim(),
  );
  return match ? match[1]! : null;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const maxCaptureBytes = 256 * 1024;

export function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    input?: string;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new ClaudeCliError("runtime"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ClaudeCliError("timeout"));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxCaptureBytes) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxCaptureBytes) stderr.push(chunk);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeCliError("runtime"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

async function regularFile(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    const info = await lstat(resolved);
    return info.isFile() && info.size > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/** Finds the user's installed, unmodified Claude Code CLI. */
export async function resolveClaudeRuntime(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
}): Promise<ClaudeRuntime> {
  let outdated = false;
  for (const candidate of claudeExecutableCandidates(
    input.platform,
    input.env,
  )) {
    const executable = await regularFile(candidate);
    if (!executable) continue;
    let result: ProcessResult;
    try {
      result = await runProcess(executable, ["--version"], {
        cwd: input.cwd,
        env: input.childEnv,
        timeoutMs: 15_000,
      });
    } catch {
      continue;
    }
    const version =
      result.code === 0 ? parseClaudeVersion(result.stdout) : null;
    if (!version) continue;
    if (compareVersions(version, minimumClaudeCodeVersion) < 0) {
      outdated = true;
      continue;
    }
    return { executable, prefix: [], version };
  }
  throw new ClaudeCliError(outdated ? "outdated" : "missing");
}

export type ClaudeAuthMethod =
  | "none"
  | "claude.ai"
  | "oauth_token"
  | "api_key"
  | "api_key_helper"
  | "third_party";

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  method: ClaudeAuthMethod;
}

const authMethods = new Set<ClaudeAuthMethod>([
  "none",
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
]);

/** Parses only the documented `claude auth status` fields the app needs. */
export function parseAuthStatus(
  output: string,
  exitCode: number | null,
): ClaudeAuthStatus {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new ClaudeCliError("status");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClaudeCliError("status");
  const record = value as Record<string, unknown>;
  if (
    typeof record.loggedIn !== "boolean" ||
    !authMethods.has(record.authMethod as ClaudeAuthMethod) ||
    (record.loggedIn && exitCode !== 0) ||
    (!record.loggedIn && exitCode !== 1) ||
    (record.loggedIn && record.authMethod === "none")
  )
    throw new ClaudeCliError("status");
  return {
    loggedIn: record.loggedIn,
    method: record.authMethod as ClaudeAuthMethod,
  };
}

export function billingForMethod(
  method: ClaudeAuthMethod,
): "subscription" | "api" | "other" {
  if (method === "claude.ai" || method === "oauth_token") return "subscription";
  if (method === "api_key" || method === "api_key_helper") return "api";
  return "other";
}

/** Flags shared by every headless session the app starts. */
export const restrictedSessionArguments = Object.freeze([
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
]);

export interface ClaudeCatalog {
  models: ClaudeModelOption[];
  plan: string | null;
}

const modelValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u;
const planPattern = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/u;

function boundedLabel(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text && text.length <= maximum ? text : null;
}

/**
 * Parses the CLI's initialize control response. Model descriptions can carry
 * API list prices that do not apply to subscription use, so only the leading
 * model name segment is kept.
 */
export function parseCatalogResponse(response: unknown): ClaudeCatalog {
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new ClaudeCliError("catalog");
  const record = response as Record<string, unknown>;
  if (!Array.isArray(record.models) || record.models.length > 64)
    throw new ClaudeCliError("catalog");
  const models: ClaudeModelOption[] = [];
  for (const raw of record.models) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const model = raw as Record<string, unknown>;
    if (
      typeof model.value !== "string" ||
      !modelValuePattern.test(model.value) ||
      models.some((item) => item.value === model.value)
    )
      continue;
    const label = boundedLabel(model.displayName, 64);
    if (!label) continue;
    const description =
      typeof model.description === "string"
        ? (model.description.split(" · ")[0] ?? "")
        : "";
    const detail = boundedLabel(description, 160) ?? "";
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? claudeEfforts.filter((level) =>
          (model.supportedEffortLevels as unknown[]).includes(level),
        )
      : [];
    models.push({ value: model.value, label, detail, efforts });
    if (models.length === 32) break;
  }
  if (!models.length) throw new ClaudeCliError("catalog");
  let plan: string | null = null;
  const account = record.account;
  if (account && typeof account === "object" && !Array.isArray(account)) {
    const subscription = (account as Record<string, unknown>).subscriptionType;
    if (typeof subscription === "string" && planPattern.test(subscription))
      plan = subscription;
  }
  return { models, plan };
}

const maxLineBytes = 4 * 1024 * 1024;

/** Line-splits a bounded NDJSON stream into parsed records. */
export class JsonLineReader {
  private buffer = "";
  private readonly onRecord: (value: Record<string, unknown>) => void;
  private readonly onOverflow: () => void;

  constructor(
    onRecord: (value: Record<string, unknown>) => void,
    onOverflow: () => void,
  ) {
    this.onRecord = onRecord;
    this.onOverflow = onOverflow;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value))
        this.onRecord(value as Record<string, unknown>);
    }
    if (this.buffer.length > maxLineBytes) {
      this.buffer = "";
      this.onOverflow();
    }
  }
}

/** Sends one initialize control request; no user message, so no model turn. */
export function readCatalog(
  runtime: ClaudeRuntime,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ClaudeCatalog> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        runtime.executable,
        claudeArguments(runtime, [
          ...restrictedSessionArguments,
          "--no-session-persistence",
        ]),
        {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
    } catch {
      reject(new ClaudeCliError("runtime"));
      return;
    }
    const requestId = `catalog-${randomUUID()}`;
    let settled = false;
    const finish = (error: ClaudeCliError | null, value?: ClaudeCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      const killer = setTimeout(() => child.kill(), 5_000);
      child.once("close", () => clearTimeout(killer));
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new ClaudeCliError("timeout")),
      options.timeoutMs ?? 30_000,
    );
    const reader = new JsonLineReader(
      (message) => {
        if (message.type !== "control_response") return;
        const response = message.response as Record<string, unknown> | null;
        if (!response || response.request_id !== requestId) return;
        if (response.subtype !== "success")
          return finish(new ClaudeCliError("catalog"));
        try {
          finish(null, parseCatalogResponse(response.response));
        } catch (error) {
          finish(error as ClaudeCliError);
        }
      },
      () => finish(new ClaudeCliError("catalog")),
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => reader.push(chunk));
    child.once("error", () => finish(new ClaudeCliError("runtime")));
    child.once("close", () => finish(new ClaudeCliError("catalog")));
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      })}\n`,
    );
  });
}

const signInHosts = new Set([
  "claude.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
]);

/** Accepts only an Anthropic-hosted HTTPS sign-in page printed by the CLI. */
export function parseSignInUrl(output: string): string | null {
  const match = /visit:\s*(https:\/\/\S+)/u.exec(output);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !signInHosts.has(url.hostname) ||
      url.href.length > 4096
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Runs `claude auth login --claudeai`. Claude Code opens the browser and
 * receives Anthropic's callback itself; the app only watches for the printed
 * fallback page and never writes to the CLI's code prompt.
 */
export class ClaudeLoginProcess {
  private readonly child: ChildProcess;
  private output = "";
  private signInUrl: string | null = null;
  readonly done: Promise<number | null>;

  constructor(
    runtime: ClaudeRuntime,
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {
    this.child = spawn(
      runtime.executable,
      claudeArguments(runtime, ["auth", "login", "--claudeai"]),
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const collect = (chunk: Buffer) => {
      if (this.output.length > 64 * 1024) return;
      this.output += chunk.toString("utf8");
      this.signInUrl ??= parseSignInUrl(this.output);
    };
    this.child.stdout?.on("data", collect);
    this.child.stderr?.on("data", collect);
    this.child.stdin?.on("error", () => undefined);
    this.done = new Promise((resolve) => {
      this.child.once("error", () => resolve(null));
      this.child.once("close", (code) => resolve(code));
    });
  }

  get url(): string | null {
    return this.signInUrl;
  }

  stop(): void {
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill();
  }
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return claudeEfforts.includes(value as ClaudeEffort);
}
