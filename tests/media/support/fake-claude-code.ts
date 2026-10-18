/**
 * TEST DOUBLE ONLY. Emulates the Claude Code 2.1.285 CLI behaviors observed in
 * the isolated guest (auth status JSON, the browser-login wait, the stream-json
 * initialize/turn/interrupt messages) so the bridge can be unit tested without
 * an account. It is never packaged and makes no network requests. Production
 * always runs the user's installed, unmodified Claude Code.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = process.env.CLAUDE_CONFIG_DIR ?? "";
const statePath = join(root, "fake-state.json");
const scenarioPath = join(root, "fake-scenario.json");
const logPath = join(root, "fake-log.jsonl");
const args = process.argv.slice(2);

type State = { loggedIn: boolean; method: string };
const readState = (): State =>
  existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
    : { loggedIn: false, method: "none" };
const writeState = (state: State) =>
  writeFileSync(statePath, JSON.stringify(state));
const scenario = (): string =>
  existsSync(scenarioPath)
    ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as { kind: string }).kind
    : "reply";
appendFileSync(
  logPath,
  `${JSON.stringify({
    args,
    inheritedSecret: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ),
    disabledMemory: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1",
  })}\n`,
);
const out = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/**
 * Scripted assistant for native tests: drives the real editor MCP server named
 * in --mcp-config the way a model would (read, add a graphic, look at it) and
 * reports each call in the stream, so the packaged app runs the whole path
 * without a model or an account.
 */
async function connectEditor(
  allowed: string[],
  assistant: (content: unknown[], error?: string) => void,
  base: Record<string, unknown>,
) {
  const config = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8")) as {
    mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
  };
  const [serverName, server] = Object.entries(config.mcpServers)[0]!;
  const projectId = /The active project_id is "([^"]+)"/u.exec(
    flag("--system-prompt") ?? "",
  )?.[1];
  if (!projectId) throw new Error("no project id in the system prompt");
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const reply = JSON.parse(line) as Record<string, unknown>;
    pending.get(reply.id as number)?.(reply);
  });
  let next = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const call = async (name: string, input: Record<string, unknown>) => {
    const wire = `mcp__${serverName}__${name.replaceAll(".", "_")}`;
    if (!allowed.includes(wire)) throw new Error(`not allowed: ${wire}`);
    const id = `toolu_${next + 1}`;
    assistant([{ type: "tool_use", id, name: wire, input }]);
    const reply = (await rpc("tools/call", { name, arguments: input }))
      .result as { content: Array<Record<string, unknown>>; isError: boolean };
    out({
      type: "user",
      ...base,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: reply.content },
        ],
      },
    });
    if (reply.isError) throw new Error(`${name} failed`);
    return reply.content;
  };
  /** Like call, but returns a refused call's error instead of failing. */
  const attempt = async (name: string, input: Record<string, unknown>) => {
    try {
      return { ok: true, content: await call(name, input) };
    } catch {
      return { ok: false, content: [] };
    }
  };
  return { call, attempt, projectId, close: () => child.stdin.end() };
}

async function scriptedFullEdit(
  allowed: string[],
  assistant: (content: unknown[], error?: string) => void,
  result: (ok: boolean, extra?: Record<string, unknown>) => void,
  base: Record<string, unknown>,
): Promise<void> {
  const { call, projectId, close } = await connectEditor(
    allowed,
    assistant,
    base,
  );
  const summary = JSON.parse(
    (
      await call("timeline.get_summary", {
        schema_version: "1.0",
        project_id: projectId,
      })
    )[0]!.text as string,
  ) as Record<string, unknown>;
  const head = {
    schema_version: "1.0",
    request_id: `scripted-${Date.now()}`,
    project_id: projectId,
    draft_id: summary.draft_id,
    base_revision_id: summary.base_revision_id,
    expected_sequence: summary.draft_sequence,
    expected_timeline_sha256: summary.timeline_sha256,
    reason: "Add an opening title.",
  };
  await call("graphics.set", {
    ...head,
    pass_group_id: "scripted-graphics",
    start_us: 0,
    duration_us: 1_000_000,
    name: "Opening title",
    layer: 1,
    html: '<h1 class="t">Scripted title</h1>',
    css: ".t { position: absolute; left: 24px; top: 24px; margin: 0; font: 700 28px sans-serif; color: #fff; background: rgb(30 90 200); padding: 6px 12px }",
  });
  const pictures = await call("media.get_frames", {
    schema_version: "1.0",
    project_id: projectId,
    times_us: [500_000],
    max_width: 320,
  });
  const image = pictures.find((item) => item.type === "image");
  appendFileSync(
    logPath,
    `${JSON.stringify({
      scriptedPicture: {
        mimeType: image?.mimeType ?? null,
        bytes:
          typeof image?.data === "string"
            ? Buffer.from(image.data, "base64").length
            : 0,
      },
    })}\n`,
  );
  if (typeof image?.data === "string")
    writeFileSync(
      join(root, "scripted-picture.jpg"),
      Buffer.from(image.data, "base64"),
    );
  close();
  assistant([{ type: "text", text: "Added an opening title and checked it." }]);
  result(true);
}

/**
 * Scripted rough cut for native tests: reads the timeline, confirms that a
 * decorating tool is refused during a rough cut, removes the earlier take
 * named by the request's evidence and looks at the result.
 */
async function scriptedRoughCut(
  allowed: string[],
  assistant: (content: unknown[], error?: string) => void,
  result: (ok: boolean, extra?: Record<string, unknown>) => void,
  base: Record<string, unknown>,
  request: string,
): Promise<void> {
  const { call, attempt, projectId, close } = await connectEditor(
    allowed,
    assistant,
    base,
  );
  const read = async () =>
    JSON.parse(
      (
        await call("timeline.get_summary", {
          schema_version: "1.0",
          project_id: projectId,
        })
      )[0]!.text as string,
    ) as Record<string, unknown>;
  const summary = await read();
  const head = {
    schema_version: "1.0",
    request_id: `scripted-${Date.now()}`,
    project_id: projectId,
    draft_id: summary.draft_id,
    base_revision_id: summary.base_revision_id,
    expected_sequence: summary.draft_sequence,
    expected_timeline_sha256: summary.timeline_sha256,
  };
  const refused = await attempt("zoom.set", {
    ...head,
    pass_group_id: "scripted-zoom",
    reason: "Not allowed in a rough cut.",
    start_us: 0,
    end_us: 500_000,
    center_x: 0.5,
    center_y: 0.5,
    scale: 1.5,
  });
  // The evidence names the earlier copy of repeated wording; the story keeps
  // the final take, so remove that copy.
  const repeated =
    /earlier copy of repeated wording · source \S+ \d+–\d+ · edit (\d+)–(\d+)/u.exec(
      request,
    );
  const evidence = [...request.matchAll(/ · edit (\d+)–(\d+)/gu)];
  appendFileSync(
    logPath,
    `${JSON.stringify({ scriptedRoughCut: { refusedDecoration: !refused.ok, evidence: evidence.length, repeated: Boolean(repeated) } })}\n`,
  );
  if (!repeated) throw new Error("no repeated wording in the evidence");
  await call("cut.delete_range", {
    ...head,
    request_id: `scripted-cut-${Date.now()}`,
    pass_group_id: "scripted-rough-cut",
    reason: "Keep the final complete take.",
    start_us: Number(repeated[1]),
    end_us: Number(repeated[2]),
  });
  await call("media.get_frames", {
    schema_version: "1.0",
    project_id: projectId,
    times_us: [0],
    max_width: 320,
  });
  close();
  assistant([
    {
      type: "text",
      text: "Kept the final complete take and removed the earlier one.",
    },
  ]);
  result(true);
}

if (args[0] === "--version") {
  process.stdout.write("2.1.285 (Claude Code)\n");
} else if (args[0] === "auth" && args[1] === "status") {
  const state = readState();
  process.stdout.write(
    `${JSON.stringify(
      {
        loggedIn: state.loggedIn,
        authMethod: state.loggedIn ? state.method : "none",
        apiProvider: "firstParty",
        configDirectory: root,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = state.loggedIn ? 0 : 1;
} else if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(
    "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fixture\nPaste code here if prompted > ",
  );
  if (scenario() !== "login_never")
    setTimeout(() => writeState({ loggedIn: true, method: "claude.ai" }), 300);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "logout") {
  writeState({ loggedIn: false, method: "none" });
  process.stdout.write(
    "Successfully logged out from your Anthropic account.\n",
  );
} else if (args[0] === "-p") {
  const sessionId = flag("--resume") ?? flag("--session-id") ?? "none";
  const kind = scenario();
  if (kind === "resume_missing" && flag("--resume")) {
    process.stderr.write("No conversation found with session ID\n");
    process.exit(1);
  }
  const allowed = (flag("--allowedTools") ?? "").split(",").filter(Boolean);
  const mcpPath = flag("--mcp-config");
  const server = mcpPath
    ? Object.keys(
        (
          JSON.parse(readFileSync(mcpPath, "utf8")) as {
            mcpServers: Record<string, unknown>;
          }
        ).mcpServers,
      )[0]
    : undefined;
  const base = { session_id: sessionId, parent_tool_use_id: null };
  const init = (tools: string[]) =>
    out({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools,
      mcp_servers: server ? [{ name: server, status: "connected" }] : [],
      model: "claude-opus-5-5",
      permissionMode: flag("--permission-mode"),
      slash_commands: [],
      skills: [],
      capabilities: ["interrupt_receipt_v1"],
    });
  const assistant = (content: unknown[], error?: string) =>
    out({
      type: "assistant",
      ...base,
      message: { role: "assistant", content },
      ...(error ? { error } : {}),
    });
  const result = (ok: boolean, extra: Record<string, unknown> = {}) =>
    out({
      type: "result",
      subtype: "success",
      is_error: !ok,
      session_id: sessionId,
      result: ok ? "done" : "failed",
      ...extra,
    });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const request = message.request as Record<string, unknown> | undefined;
      if (
        message.type === "control_request" &&
        request?.subtype === "initialize"
      ) {
        out({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {
              models: [
                {
                  value: "default",
                  displayName: "Default (recommended)",
                  description:
                    "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
                  supportedEffortLevels: [
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ],
                },
                {
                  value: "sonnet",
                  displayName: "Sonnet",
                  description:
                    "Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok",
                  supportedEffortLevels: ["low", "medium", "high"],
                },
                {
                  value: "haiku",
                  displayName: "Haiku",
                  description: "Haiku 4.5 · Fastest",
                },
              ],
              account: readState().loggedIn
                ? { tokenSource: "claude.ai", subscriptionType: "max" }
                : { tokenSource: "none" },
            },
          },
        });
      } else if (
        message.type === "control_request" &&
        request?.subtype === "interrupt"
      ) {
        out({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
        result(false, { subtype: "error_during_execution" });
      } else if (message.type === "user") {
        if (!readState().loggedIn) {
          init(allowed);
          assistant(
            [{ type: "text", text: "Not logged in · Please run /login" }],
            "authentication_failed",
          );
          result(false);
          continue;
        }
        if (kind === "extra_tool") {
          init([...allowed, "Bash"]);
          continue;
        }
        init(allowed);
        if (kind === "bad_tool_use") {
          assistant([
            { type: "tool_use", id: "toolu_bad", name: "Bash", input: {} },
          ]);
        } else if (kind === "rate") {
          assistant([{ type: "text", text: "limit" }], "rate_limit");
          result(false);
        } else if (kind === "hang") {
          assistant([
            { type: "tool_use", id: "toolu_wait", name: allowed[0], input: {} },
          ]);
        } else if (kind === "edit") {
          const split = allowed.find((name) => name.endsWith("cut_split"))!;
          assistant([
            { type: "tool_use", id: "toolu_split", name: split, input: {} },
          ]);
          out({
            type: "user",
            ...base,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_split",
                  content: "{}",
                },
              ],
            },
          });
          assistant([{ type: "text", text: "Split the clip." }]);
          result(true);
        } else if (kind === "scripted_rough_cut") {
          const content = (message.message as { content?: unknown })?.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((part) =>
                      typeof (part as { text?: unknown }).text === "string"
                        ? (part as { text: string }).text
                        : "",
                    )
                    .join("\n")
                : "";
          void scriptedRoughCut(allowed, assistant, result, base, text).catch(
            (error: unknown) => {
              appendFileSync(
                logPath,
                `${JSON.stringify({ scriptedError: String(error).slice(0, 200) })}\n`,
              );
              result(false);
            },
          );
        } else if (kind === "scripted_full_edit") {
          void scriptedFullEdit(allowed, assistant, result, base).catch(
            (error: unknown) => {
              appendFileSync(
                logPath,
                `${JSON.stringify({ scriptedError: String(error).slice(0, 200) })}\n`,
              );
              result(false);
            },
          );
        } else if (kind === "slow_reply") {
          // Lets a test record commits while the turn is still running.
          setTimeout(() => {
            assistant([{ type: "text", text: "Edited the video." }]);
            result(true);
          }, 600);
        } else {
          for (const text of ["Hel", "lo"])
            out({
              type: "stream_event",
              ...base,
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              },
            });
          assistant([{ type: "text", text: "Hello" }]);
          result(true);
        }
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  process.exitCode = 2;
}
