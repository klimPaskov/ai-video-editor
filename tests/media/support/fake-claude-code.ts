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
