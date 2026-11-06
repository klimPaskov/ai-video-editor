// Test-only process. It is never imported or packaged by the product.
import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
let initialized = false;
let initializations = 0;
let clientRequest;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (mode === "stubborn") process.on("SIGTERM", () => {});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initializations++;
    if (mode === "init-error") {
      write({ id: message.id, error: { code: -32000, message: "PRIVATE SECRET" } });
    } else {
      write({ id: message.id, result: { initializations, pid: process.pid } });
    }
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!message.method) {
    write({ id: clientRequest, result: message });
    return;
  }
  if (!initialized) process.exit(2);
  switch (message.method) {
    case "echo":
      write({ id: message.id, result: message.params });
      break;
    case "order":
      setTimeout(() => write({ id: message.id, result: message.params }), message.params.delay);
      break;
    case "environment":
      write({ id: message.id, result: { cwd: process.cwd(), marker: process.env.TRANSPORT_MARKER ?? null } });
      break;
    case "error":
      process.stderr.write("PRIVATE SECRET STDERR\n");
      write({ id: message.id, error: { code: -32001, message: "PRIVATE SECRET", data: { token: "secret" } } });
      break;
    case "fragment": {
      const encoded = Buffer.from(JSON.stringify({ id: message.id, result: "é 🌍" }) + "\r\n");
      for (let i = 0; i < encoded.length; i++) setTimeout(() => process.stdout.write(encoded.subarray(i, i + 1)), i);
      break;
    }
    case "coalesce":
      process.stdout.write(JSON.stringify({ method: "event", params: { delta: "first" } }) + "\n" + JSON.stringify({ method: "event", params: { delta: "second" } }) + "\n" + JSON.stringify({ id: message.id, result: true }) + "\n");
      break;
    case "raw":
      process.stdout.write(message.params.repeat ? Buffer.alloc(message.params.repeat, 120) : Buffer.from(message.params.bytes));
      if (message.params.exit) process.stdout.end(() => process.exit(0));
      break;
    case "unknown":
      write({ id: 999999, result: "PRIVATE SECRET" });
      break;
    case "duplicate":
      write({ id: message.id, result: true });
      write({ id: message.id, result: false });
      break;
    case "server":
      clientRequest = message.id;
      write({ id: "approval-1", method: "permission/request", params: { action: "forbidden" } });
      break;
    case "duplicate-server":
      clientRequest = message.id;
      write({ id: "approval-1", method: "permission/request", params: {} });
      write({ id: "approval-1", method: "permission/request", params: {} });
      break;
    case "hold":
      break;
    case "exit":
      process.exit(7);
  }
});
if (mode === "stubborn") input.on("close", () => setInterval(() => {}, 1000));
