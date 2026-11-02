// A stand-in for urushi-engine that speaks the NDJSON protocol in a few
// scripted ways, so the client can be tested without the Rust binary.
import { createInterface } from "node:readline";

const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let started = false;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "cancel") {
    if (mode === "polite")
      send({ type: "error", id: "job", code: "CANCELLED", detail: "stopped" });
    if (mode === "polite") process.exit(0);
    return; // "deaf" ignores it and must be killed
  }
  if (started) return;
  started = true;
  send({ type: "ready", v: 1, engine: "test", methods: [] });
  switch (mode) {
    case "ok":
      send({ type: "progress", id: "job", phase: "rendering", fraction: 0.5 });
      send({
        type: "result",
        id: "job",
        result: { echoed: message.params, method: message.method },
      });
      process.exit(0);
      break;
    case "error":
      send({ type: "error", id: "job", code: "DISK_FULL", detail: "no space" });
      process.exit(0);
      break;
    case "weird-code":
      send({ type: "error", id: "job", code: "SOMETHING_NEW", detail: "x" });
      process.exit(0);
      break;
    case "silent-exit":
      process.exit(3);
      break;
    case "garbage":
      process.stdout.write("this is not json\n");
      setTimeout(() => process.exit(0), 50);
      break;
    case "wrong-protocol":
      send({ type: "ready", v: 99, engine: "test", methods: [] });
      setTimeout(() => process.exit(0), 5000);
      break;
    default: // polite, deaf, hang: keep running until cancelled or killed
      setTimeout(() => process.exit(0), 60_000);
  }
});
