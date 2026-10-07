import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  CodexVideoEditToolError,
  type CodexVideoEditToolErrorCode,
} from "./service.ts";

const MAX_FRAME_BYTES = 1024 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/u;

export interface CodexMcpRuntime {
  command: string;
  script: string;
  endpoint: string;
  token: string;
}

type ToolInvoker = (name: unknown, input: unknown) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function safeError(error: unknown): {
  code: CodexVideoEditToolErrorCode;
  message: string;
} {
  const safe =
    error instanceof CodexVideoEditToolError
      ? error
      : new CodexVideoEditToolError("service_unavailable");
  return { code: safe.code, message: safe.message };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function resolveCodexMcpScript(
  resourcesRoot: string,
): Promise<string> {
  try {
    if (!isAbsolute(resourcesRoot)) throw new Error();
    const directory = join(await realpath(resourcesRoot), "mcp");
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new Error();
    const manifestPath = join(directory, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.nlink !== 1
    )
      throw new Error();
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      !record(parsed) ||
      Object.keys(parsed).length !== 4 ||
      parsed.schemaVersion !== 1 ||
      parsed.executable !== "ai-video-editor-mcp.cjs" ||
      !Number.isSafeInteger(parsed.size) ||
      (parsed.size as number) <= 0 ||
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.sha256)
    )
      throw new Error();
    const script = join(directory, parsed.executable);
    const scriptInfo = await lstat(script);
    if (
      !scriptInfo.isFile() ||
      scriptInfo.isSymbolicLink() ||
      scriptInfo.nlink !== 1 ||
      scriptInfo.size !== parsed.size ||
      (await realpath(script)) !== script ||
      (await sha256(script)) !== parsed.sha256
    )
      throw new Error();
    return script;
  } catch {
    throw new Error(
      "The packaged editing service is missing or damaged. Reinstall the application.",
    );
  }
}

/** One authenticated, one-request-per-connection channel into Electron main. */
export class CodexMcpBroker {
  private readonly server: Server;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly invoke: ToolInvoker;
  private readonly sockets = new Set<Socket>();
  private closed = false;

  private constructor(endpoint: string, token: string, invoke: ToolInvoker) {
    this.endpoint = endpoint;
    this.token = token;
    this.invoke = invoke;
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 8;
  }

  static async open(
    rootAbsolute: string,
    invoke: ToolInvoker,
  ): Promise<CodexMcpBroker> {
    if (!isAbsolute(rootAbsolute))
      throw new Error("Invalid MCP runtime directory");
    const root = resolve(rootAbsolute);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      resolve(await realpath(root)) !== root
    )
      throw new Error("Invalid MCP runtime directory");
    const socketId = randomBytes(6).toString("hex");
    const candidate = join(root, `mcp-${socketId}.sock`);
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\ai-video-editor-${randomUUID()}`
        : Buffer.byteLength(candidate) < 100
          ? candidate
          : join(
              tmpdir(),
              `cve-${createHash("sha256").update(root).digest("hex").slice(0, 12)}-${socketId}.sock`,
            );
    const broker = new CodexMcpBroker(
      endpoint,
      randomBytes(32).toString("hex"),
      invoke,
    );
    await new Promise<void>((resolveListen, reject) => {
      const failed = (error: Error) => reject(error);
      broker.server.once("error", failed);
      broker.server.listen(endpoint, () => {
        broker.server.off("error", failed);
        resolveListen();
      });
    });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    return broker;
  }

  runtime(command: string, script: string): CodexMcpRuntime {
    if (!isAbsolute(command) || !isAbsolute(script) || this.closed)
      throw new Error("Invalid MCP runtime");
    return {
      command: resolve(command),
      script: resolve(script),
      endpoint: this.endpoint,
      token: this.token,
    };
  }

  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(35_000, () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) return socket.destroy();
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) return socket.destroy();
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (
        buffer
          .subarray(newline + 1)
          .toString("utf8")
          .trim()
      )
        return socket.destroy();
      handled = true;
      socket.pause();
      void this.handle(buffer.subarray(0, newline))
        .then((reply) => {
          const encoded = Buffer.from(`${JSON.stringify(reply)}\n`);
          if (encoded.length > MAX_FRAME_BYTES) return socket.destroy();
          socket.end(encoded);
        })
        .catch(() => socket.destroy());
    });
  }

  private async handle(frame: Buffer): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(frame),
      );
    } catch {
      throw new Error("Invalid broker request");
    }
    if (
      !record(parsed) ||
      Object.keys(parsed).length !== 5 ||
      parsed.schema_version !== "1.0" ||
      typeof parsed.request_id !== "string" ||
      parsed.request_id.length < 2 ||
      parsed.request_id.length > 128 ||
      typeof parsed.tool_name !== "string" ||
      typeof parsed.token !== "string" ||
      !tokenPattern.test(parsed.token)
    )
      throw new Error("Invalid broker request");
    const actual = Buffer.from(parsed.token, "hex");
    const expected = Buffer.from(this.token, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Invalid broker request");
    try {
      return {
        schema_version: "1.0",
        request_id: parsed.request_id,
        ok: true,
        value: await this.invoke(parsed.tool_name, parsed.input),
      };
    } catch (error) {
      return {
        schema_version: "1.0",
        request_id: parsed.request_id,
        ok: false,
        error: safeError(error),
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose) =>
      this.server.close(() => resolveClose()),
    );
    if (process.platform !== "win32") {
      try {
        const info = await lstat(this.endpoint);
        if (info.isSocket() && !info.isSymbolicLink())
          await rm(this.endpoint, { force: true });
      } catch {
        /* The server may already have removed its socket path. */
      }
    }
  }
}
