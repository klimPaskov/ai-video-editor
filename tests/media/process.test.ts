import assert from "node:assert/strict";
import test from "node:test";
import {
  MediaError,
  runProcess,
} from "../../packages/media-engine/src/process.ts";

test("process arguments remain literal and failures do not expose private diagnostics", async () => {
  const literal = "private path; $(echo secret) & literal";
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", literal],
  });
  assert.equal(result.stdout.toString(), literal);
  await assert.rejects(
    runProcess({
      executable: process.execPath,
      args: ["-e", 'console.error("private-secret");process.exit(3)'],
    }),
    (error: unknown) =>
      error instanceof MediaError &&
      error.code === "PROCESS_FAILED" &&
      !error.message.includes("private-secret"),
  );
  await assert.rejects(
    runProcess({
      executable: "ai-video-editor-nonexistent-executable",
      args: [],
    }),
    { code: "PROCESS_UNAVAILABLE" },
  );
});

test("process bounds timeout, output, and cancellation", async () => {
  await assert.rejects(
    runProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>{},10000)"],
      timeoutMs: 100,
    }),
    { code: "TIMEOUT" },
  );
  await assert.rejects(
    runProcess({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(100000))'],
      maxOutputBytes: 100,
    }),
    { code: "OUTPUT_LIMIT" },
  );
  const controller = new AbortController();
  const result = runProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{},10000)"],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(result, { code: "CANCELLED" });
  await assert.rejects(
    runProcess({
      executable: process.execPath,
      args: [],
      signal: controller.signal,
    }),
    { code: "CANCELLED" },
  );
});
