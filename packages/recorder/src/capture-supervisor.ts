/**
 * Runs one FFmpeg capture for the app and ends it when the app goes away.
 *
 * FFmpeg ignores a closed pipe, so a capture started by an app that then
 * crashes would keep recording the screen. This supervisor forwards the
 * app's stdin (where "q" asks FFmpeg to finish) and FFmpeg's output. When
 * its stdin closes or its parent process changes, it asks FFmpeg to finish
 * cleanly and kills it if it has not exited 10 s later.
 *
 * Usage: <node> capture-supervisor <ffmpeg> <ffmpeg arguments...>
 */
import { spawn } from "node:child_process";

const [executable, ...args] = process.argv.slice(2);
if (!executable) process.exit(2);
const child = spawn(executable, args, {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
// Output to an app that has gone away is dropped.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);
child.stdin.on("error", () => undefined);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let ending = false;
function finish(): void {
  if (ending) return;
  ending = true;
  child.stdin.end("q\n");
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
}
process.stdin.on("data", (chunk: Buffer) => {
  if (!ending) child.stdin.write(chunk);
});
process.stdin.on("end", finish);
process.stdin.on("error", finish);
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) finish();
}, 500).unref();
child.once("error", () => process.exit(1));
child.once("exit", (code) => process.exit(code ?? 1));
