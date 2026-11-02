import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineError,
  resolveEngine,
  runEngine,
} from "../../packages/media-engine/src/engine-client.ts";
import { ensureFaceModel } from "../../packages/media-engine/src/face-model.ts";

const fake = join(import.meta.dirname, "support", "fake-engine.mjs");

function run(
  mode: string,
  extra: Partial<Parameters<typeof runEngine>[0]> = {},
) {
  return runEngine({
    executable: process.execPath,
    args: [fake, mode],
    method: "clips.render",
    params: { hello: "world" },
    ...extra,
  });
}

test("a result comes back with progress along the way", async () => {
  const seen: [string, number][] = [];
  const result = await run("ok", {
    onProgress: (phase, fraction) => seen.push([phase, fraction]),
  });
  assert.deepEqual(result, {
    echoed: { hello: "world" },
    method: "clips.render",
  });
  assert.deepEqual(seen, [["rendering", 0.5]]);
});

test("engine failures keep their code and hide detail from the message", async () => {
  await assert.rejects(run("error"), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "DISK_FULL");
    assert.equal(error.detail, "no space");
    assert.ok(!error.message.includes("no space"));
    return true;
  });
  await assert.rejects(
    run("weird-code"),
    (error: unknown) => (error as EngineError).code === "INTERNAL",
  );
});

test("a process that dies, or speaks nonsense, is reported as a crash", async () => {
  await assert.rejects(
    run("silent-exit"),
    (error: unknown) => (error as EngineError).code === "CRASHED",
  );
  await assert.rejects(
    run("garbage"),
    (error: unknown) => (error as EngineError).code === "CRASHED",
  );
  await assert.rejects(
    run("wrong-protocol"),
    (error: unknown) => (error as EngineError).code === "CRASHED",
  );
});

test("a missing executable is reported as unavailable", async () => {
  await assert.rejects(
    runEngine({
      executable: join(tmpdir(), "no-such-engine.exe"),
      method: "x",
      params: {},
    }),
    (error: unknown) => (error as EngineError).code === "TOOL_UNAVAILABLE",
  );
});

test("cancelling sends a cancel line and an engine that ignores it is killed", async () => {
  const polite = new AbortController();
  const stopped = run("polite", { signal: polite.signal });
  setTimeout(() => polite.abort(), 400);
  await assert.rejects(
    stopped,
    (error: unknown) => (error as EngineError).code === "CANCELLED",
  );
  const deaf = new AbortController();
  const started = Date.now();
  const killed = run("deaf", { signal: deaf.signal, cancelGraceMs: 300 });
  setTimeout(() => deaf.abort(), 400);
  await assert.rejects(
    killed,
    (error: unknown) => (error as EngineError).code === "CANCELLED",
  );
  assert.ok(Date.now() - started < 10_000);
  await assert.rejects(
    run("ok", { signal: AbortSignal.abort() }),
    (error: unknown) => (error as EngineError).code === "CANCELLED",
  );
});

test("a job that runs past its limit is killed and reported as a timeout", async () => {
  await assert.rejects(
    run("hang", { timeoutMs: 600 }),
    (error: unknown) => (error as EngineError).code === "TIMEOUT",
  );
});

async function manifestFor(
  directory: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  await mkdir(join(directory, "engine"), { recursive: true });
  await writeFile(join(directory, "engine", "urushi-engine"), bytes);
  await writeFile(
    join(directory, "engine", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      protocol: 1,
      platform: "linux",
      executable: "urushi-engine",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...overrides,
    }),
  );
}

test("the packaged engine is accepted only when it matches its manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engine-manifest-"));
  try {
    assert.equal(await resolveEngine(directory), null);
    await manifestFor(directory, Buffer.from("engine bytes"));
    assert.equal(
      await resolveEngine(directory),
      join(directory, "engine", "urushi-engine"),
    );
    // Same size, different content.
    await writeFile(
      join(directory, "engine", "urushi-engine"),
      Buffer.from("engine bytez"),
    );
    await assert.rejects(resolveEngine(directory), /integrity/u);
    await manifestFor(directory, Buffer.from("x"), {
      executable: "../escape",
    });
    await assert.rejects(resolveEngine(directory), /not valid/u);
    assert.equal(
      await resolveEngine(directory, "C:/dev/engine.exe"),
      "C:/dev/engine.exe",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the face model is fetched once, verified, and never kept when wrong", async () => {
  const bytes = Buffer.from("pretend model bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let served = 0;
  let body = bytes;
  const server = createServer((_request, response) => {
    served += 1;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const source = {
    url: `http://127.0.0.1:${port}/model.onnx`,
    size: bytes.length,
    sha256,
    allowHost: () => true,
  };
  const directory = await mkdtemp(join(tmpdir(), "face-model-"));
  try {
    const first = await ensureFaceModel(directory, undefined, source);
    assert.equal(served, 1);
    assert.equal(await ensureFaceModel(directory, undefined, source), first);
    assert.equal(served, 1, "a verified cached file is not fetched again");
    // A damaged cache entry is replaced.
    await writeFile(first, Buffer.from("tampered tampered!!"));
    await ensureFaceModel(directory, undefined, source);
    assert.equal(served, 2);
    // Wrong bytes from the server are refused and leave nothing behind.
    const other = await mkdtemp(join(tmpdir(), "face-model-bad-"));
    try {
      body = Buffer.from("something else entirely");
      await assert.rejects(
        ensureFaceModel(other, undefined, source),
        /integrity|downloaded/u,
      );
      const leftovers = await readdir(
        join(other, "yunet", sha256.slice(0, 16)),
      );
      assert.deepEqual(leftovers, []);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    await assert.rejects(
      ensureFaceModel("relative/path", undefined, source),
      /absolute/u,
    );
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
