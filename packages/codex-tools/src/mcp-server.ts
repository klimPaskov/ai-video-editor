import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { appIdentity } from "../../domain/src/app-identity.ts";
import { codexVideoEditMcpTools } from "./mcp-tools.ts";

const MAX_FRAME_BYTES = 1024 * 1024;
const endpoint = process.env.AI_VIDEO_EDITOR_MCP_ENDPOINT;
const token = process.env.AI_VIDEO_EDITOR_MCP_TOKEN;
delete process.env.AI_VIDEO_EDITOR_MCP_ENDPOINT;
delete process.env.AI_VIDEO_EDITOR_MCP_TOKEN;

type RpcId = string | number;

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function id(value: unknown): value is RpcId {
  return (
    (typeof value === "string" && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function write(value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) <= MAX_FRAME_BYTES) process.stdout.write(line);
}

function error(requestId: RpcId | null, code: number, message: string): void {
  write({ jsonrpc: "2.0", id: requestId, error: { code, message } });
}

async function invokeBroker(name: string, input: unknown): Promise<unknown> {
  if (!endpoint || !token)
    throw new Error("The editing service is unavailable.");
  const requestId = randomUUID();
  const request = Buffer.from(
    `${JSON.stringify({
      schema_version: "1.0",
      token,
      request_id: requestId,
      tool_name: name,
      input,
    })}\n`,
  );
  if (request.length > MAX_FRAME_BYTES)
    throw new Error("The edit request is too large.");
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = Buffer.alloc(0);
    const fail = () => reject(new Error("The editing service is unavailable."));
    socket.setTimeout(35_000, () => socket.destroy());
    socket.once("error", fail);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) return socket.destroy();
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      socket.removeListener("error", fail);
      socket.end();
      try {
        const reply: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, newline),
          ),
        );
        if (
          !record(reply) ||
          reply.schema_version !== "1.0" ||
          reply.request_id !== requestId ||
          typeof reply.ok !== "boolean"
        )
          return reject(new Error("The editing service is unavailable."));
        if (reply.ok) return resolve(reply.value);
        if (!record(reply.error) || typeof reply.error.message !== "string")
          return reject(new Error("The editing service is unavailable."));
        reject(new Error(reply.error.message));
      } catch {
        reject(new Error("The editing service is unavailable."));
      }
    });
    socket.once("close", () => {
      if (buffer.indexOf(0x0a) < 0) fail();
    });
  });
}

async function request(message: Record<string, unknown>): Promise<void> {
  const requestId = id(message.id) ? message.id : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return error(requestId, -32600, "Invalid request");
  if (message.id === undefined) return;
  if (!id(message.id)) return error(null, -32600, "Invalid request");
  if (message.method === "initialize") {
    if (
      !record(message.params) ||
      typeof message.params.protocolVersion !== "string" ||
      message.params.protocolVersion.length > 64
    )
      return error(message.id, -32602, "Invalid parameters");
    return write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: appIdentity.stableMcpServerId,
          version: "0.0.1",
        },
      },
    });
  }
  if (message.method === "ping")
    return write({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "tools/list") {
    if (
      message.params !== undefined &&
      (!record(message.params) ||
        (message.params.cursor !== undefined && message.params.cursor !== null))
    )
      return error(message.id, -32602, "Invalid parameters");
    return write({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: codexVideoEditMcpTools },
    });
  }
  if (message.method === "tools/call") {
    const params = message.params;
    if (
      !record(params) ||
      typeof params.name !== "string" ||
      !codexVideoEditMcpTools.some((tool) => tool.name === params.name) ||
      !record(params.arguments)
    )
      return error(message.id, -32602, "Invalid parameters");
    try {
      const result = await invokeBroker(params.name, params.arguments);
      return write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        },
      });
    } catch (cause) {
      const messageText =
        cause instanceof Error
          ? cause.message
          : "The editing service is unavailable.";
      return write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: messageText }],
          isError: true,
        },
      });
    }
  }
  error(message.id, -32601, "Method not found");
}

let buffer = Buffer.alloc(0);
let chain = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_FRAME_BYTES) return process.exit(1);
  for (;;) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    const frame = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (!frame.length) continue;
    chain = chain.then(async () => {
      try {
        const message: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(frame),
        );
        if (!record(message)) return error(null, -32600, "Invalid request");
        await request(message);
      } catch {
        error(null, -32700, "Parse error");
      }
    });
  }
});
process.stdin.once("end", () => {
  if (buffer.length) error(null, -32700, "Parse error");
  void chain.finally(() => process.exit(0));
});
