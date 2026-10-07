import { spawn, type ChildProcess } from "node:child_process";

/**
 * Forcefully ends a process and everything it started. On Windows a
 * package-manager shim (such as Chocolatey's `ffmpeg.exe`) runs the real
 * program as its child, and terminating only the shim would leave it
 * running, so the whole tree is ended with `taskkill /T`.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill("SIGKILL"));
    return;
  }
  child.kill("SIGKILL");
}
