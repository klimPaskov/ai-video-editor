import { spawn } from "node:child_process";

export type MediaErrorCode =
  | "PROCESS_FAILED"
  | "PROCESS_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "OUTPUT_LIMIT"
  | "INVALID_INPUT"
  | "UNSUPPORTED_PROFILE"
  | "FIDELITY_MISMATCH";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /**
   * Technical detail for private diagnostics (for example the end of a
   * failed executable's error output); never shown to users.
   */
  readonly detail: string | undefined;
  constructor(
    code: MediaErrorCode,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "MediaError";
    this.code = code;
    this.detail = options.detail;
  }
}

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/** No shell, inherited stdin, or process output in public errors. Diagnostics stay caller-owned. */
export async function runProcess(
  request: ProcessRequest,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (request.signal?.aborted)
    throw new MediaError("CANCELLED", "Media operation cancelled.");
  const timeout = request.timeoutMs ?? 30_000;
  const limit = request.maxOutputBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new MediaError("INVALID_INPUT", "Invalid process limits.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: MediaError | undefined;
    const stop = (code: MediaErrorCode, message: string) => {
      failure ??= new MediaError(code, message);
      child.kill("SIGKILL");
    };
    const cancel = () => stop("CANCELLED", "Media operation cancelled.");
    const timer = setTimeout(
      () => stop("TIMEOUT", "Media operation exceeded its time limit."),
      timeout,
    );
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit)
        stop("OUTPUT_LIMIT", "Media operation exceeded its output limit.");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => {
      failure ??= new MediaError(
        "PROCESS_UNAVAILABLE",
        "Media executable could not be started.",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new MediaError("PROCESS_FAILED", "Media executable failed."));
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
    });
  });
}
