import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MediaError } from "./process.ts";

/**
 * Client for the Rust engine sidecar (`urushi-engine`, docs/58). One job per
 * process: the request goes in as one JSON line, progress and the final
 * result come back as JSON lines. A cancel line or killing the process stops
 * the job, and the engine removes its own partial files.
 */

export const engineProtocol = 1;

/** Stable failure classes reported by the engine (see `engine-core`). */
export type EngineErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED"
  | "CANCELLED"
  | "TIMEOUT"
  | "TOOL_UNAVAILABLE"
  | "TOOL_FAILED"
  | "OUTPUT_INVALID"
  | "DISK_FULL"
  | "MODEL_UNAVAILABLE"
  | "INTERNAL"
  /** The engine process died or spoke nonsense. */
  | "CRASHED";

const codes: readonly string[] = [
  "INVALID_REQUEST",
  "UNSUPPORTED",
  "CANCELLED",
  "TIMEOUT",
  "TOOL_UNAVAILABLE",
  "TOOL_FAILED",
  "OUTPUT_INVALID",
  "DISK_FULL",
  "MODEL_UNAVAILABLE",
  "INTERNAL",
];

/** The technical `detail` stays out of anything shown to ordinary users. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: string;
  constructor(code: EngineErrorCode, detail: string) {
    super(`Engine ${code}`);
    this.name = "EngineError";
    this.code = code;
    this.detail = detail;
  }
}

export interface EngineRun {
  executable: string;
  /** Extra arguments (tests run a stand-in engine through Node). */
  args?: readonly string[];
  /** How long a cancelled job may take to stop before it is killed. */
  cancelGraceMs?: number;
  method: string;
  params: unknown;
  signal?: AbortSignal;
  onProgress?: (phase: string, fraction: number) => void;
  /** Hard limit for the whole job; the engine has its own per-step limits. */
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runs one engine job and resolves with its result object. */
export function runEngine<T = Record<string, unknown>>(
  run: EngineRun,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(new EngineError("CANCELLED", "cancelled before start"));
      return;
    }
    const child = spawn(run.executable, [...(run.args ?? [])], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let outcome: { result: T } | { error: EngineError } | null = null;
    let cancelTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(cancelTimer);
      run.signal?.removeEventListener("abort", onAbort);
      if (outcome && "result" in outcome) resolve(outcome.result);
      else
        reject(
          outcome?.error ??
            new EngineError("CRASHED", "the engine ended without a result"),
        );
    };
    const kill = () => {
      child.kill("SIGKILL");
    };
    const limit = setTimeout(
      () => {
        outcome ??= { error: new EngineError("TIMEOUT", "job time limit") };
        kill();
      },
      run.timeoutMs ?? 30 * 60_000,
    );
    const onAbort = () => {
      // Ask politely first so the engine can clean up; then make sure.
      child.stdin.write(
        `${JSON.stringify({ v: engineProtocol, id: "job", method: "cancel" })}\n`,
        () => undefined,
      );
      outcome ??= { error: new EngineError("CANCELLED", "cancelled") };
      cancelTimer = setTimeout(kill, run.cancelGraceMs ?? 3000);
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          outcome = { error: new EngineError("CRASHED", "unreadable output") };
          kill();
          return;
        }
        if (!record(event) || typeof event.type !== "string") continue;
        if (event.type === "ready") {
          if (event.v !== engineProtocol) {
            outcome = {
              error: new EngineError("CRASHED", "engine protocol mismatch"),
            };
            kill();
          }
        } else if (event.type === "progress") {
          if (
            typeof event.phase === "string" &&
            typeof event.fraction === "number" &&
            Number.isFinite(event.fraction)
          )
            run.onProgress?.(event.phase, event.fraction);
        } else if (event.type === "result") {
          // A cancel that raced with completion still delivers the result.
          if (!outcome || "error" in outcome)
            outcome = { result: event.result as T };
        } else if (event.type === "error") {
          const code = codes.includes(String(event.code))
            ? (event.code as EngineErrorCode)
            : "INTERNAL";
          outcome = {
            error: new EngineError(code, String(event.detail ?? "")),
          };
        }
      }
    });
    child.once("error", () => {
      outcome = {
        error: new EngineError(
          "TOOL_UNAVAILABLE",
          "the engine could not be started",
        ),
      };
      finish();
    });
    child.once("close", finish);
    child.stdin.write(
      `${JSON.stringify({ v: engineProtocol, id: "job", method: run.method, params: run.params })}\n`,
    );
  });
}

export interface EngineManifest {
  schemaVersion: 1;
  version: string;
  protocol: number;
  platform: string;
  executable: string;
  size: number;
  sha256: string;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Finds the packaged engine and checks it against its manifest, like the
 * other bundled sidecars. Returns null when no engine is packaged, so the
 * app keeps using its TypeScript implementation.
 */
export async function resolveEngine(
  resourcesPath: string,
  environmentOverride?: string,
): Promise<string | null> {
  if (environmentOverride) return environmentOverride;
  const directory = join(resourcesPath, "engine");
  let manifest: EngineManifest;
  try {
    manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as EngineManifest;
  } catch {
    return null;
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== engineProtocol ||
    typeof manifest.executable !== "string" ||
    manifest.executable !== manifest.executable.replace(/[\\/]/gu, "")
  )
    throw new MediaError("INVALID_INPUT", "The bundled engine is not valid.");
  const executable = join(directory, manifest.executable);
  const info = await lstat(executable);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== manifest.size ||
    (await sha256(executable)) !== manifest.sha256
  )
    throw new MediaError(
      "FIDELITY_MISMATCH",
      "The bundled engine failed its integrity check.",
    );
  return executable;
}
