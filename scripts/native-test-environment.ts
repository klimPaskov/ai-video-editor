import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";

export type NativeTestEnvironment = "docker" | "wsl2" | "cloud";

export interface NativeTestEnvironmentEvidence {
  platform: string;
  uid: number | undefined;
  display: string | undefined;
  dockerMarker: boolean;
  wslTestMarker: string | undefined;
  wslDistroName: string | undefined;
  kernelRelease: string;
  wslConfig: string;
  mounts: string;
  wslInterop: string | undefined;
  wslGui: string | undefined;
  waylandDisplay: string | undefined;
  pulseServer: string | undefined;
  wslEnv: string | undefined;
  /** Explicit opt-in for an ephemeral cloud agent VM. */
  cloudTestMarker?: string | undefined;
  /** The cloud VM's environment-runner installation is present. */
  cloudRunner?: boolean | undefined;
  /** Any hosting-session credential file is readable by the test process. */
  hostingCredentialReadable?: boolean | undefined;
}

function hasHostMounts(mountTable: string): boolean {
  return mountTable.split(/\r?\n/u).some((line) => {
    const fields = line.trim().split(/\s+/u);
    const mountPoint = fields[1]?.replaceAll("\\040", " ") ?? "";
    const fileSystem = fields[2] ?? "";
    if (mountPoint === "/mnt/wsl" && fileSystem === "tmpfs") return false;
    if (mountPoint === "/tmp/.X11-unix" && fileSystem === "tmpfs") return false;
    if (mountPoint === "/tmp/.X11-unix" && fileSystem === "tmpfs") return false;
    return (
      fileSystem === "drvfs" ||
      /^\/mnt\/[a-z](?:\/|$)/iu.test(mountPoint) ||
      mountPoint === "/mnt/wsl" ||
      mountPoint.startsWith("/mnt/wsl/") ||
      mountPoint === "/mnt/wslg" ||
      mountPoint.startsWith("/mnt/wslg/") ||
      mountPoint === "/tmp/.X11-unix"
    );
  });
}

function wslSetting(
  configuration: string,
  requiredSection: string,
  requiredKey: string,
): string | undefined {
  let section = "";
  for (const rawLine of configuration.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim().toLowerCase();
      continue;
    }
    if (section !== requiredSection) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === requiredKey)
      return line
        .slice(separator + 1)
        .trim()
        .toLowerCase();
  }
  return undefined;
}

function isPublicIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second, third] = address.split(".").map(Number);
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 &&
      (second === 0 || second === 168 || (second === 88 && third === 99))) ||
    (first === 198 &&
      (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    (first !== undefined && first >= 224)
  );
}

async function assertPrivateWslResolver(): Promise<void> {
  assert.deepEqual((await readdir("/mnt/wsl")).sort(), [
    "hosts",
    "resolv.conf",
  ]);
  const mounts = (await readFile("/proc/mounts", "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 3)
    .map((fields) => `${fields[1]}:${fields[2]}`);
  assert.ok(mounts.includes("/mnt/wsl:tmpfs"));
  assert.ok(mounts.includes("/etc/hosts:tmpfs"));
  assert.ok(mounts.includes("/tmp/.X11-unix:tmpfs"));
  const resolverDirectory = await lstat("/mnt/wsl");
  assert.equal(resolverDirectory.isDirectory(), true);
  assert.equal(resolverDirectory.uid, 0);
  assert.equal(resolverDirectory.mode & 0o777, 0o755);
  const x11SocketDirectory = await lstat("/tmp/.X11-unix");
  assert.equal(x11SocketDirectory.isDirectory(), true);
  assert.equal(x11SocketDirectory.uid, 0);
  assert.equal(x11SocketDirectory.mode & 0o1777, 0o1777);
  const manifest = JSON.parse(
    await readFile(new URL("./wsl-public-hosts.json", import.meta.url), "utf8"),
  ) as { schema_version: string; hostnames: string[] };
  assert.equal(manifest.schema_version, "1.0");
  assert.ok(Array.isArray(manifest.hostnames) && manifest.hostnames.length > 0);

  const hostsPath = "/mnt/wsl/hosts";
  const hostsStat = await lstat(hostsPath);
  assert.equal(hostsStat.isFile(), true);
  assert.equal(hostsStat.isSymbolicLink(), false);
  assert.equal(hostsStat.uid, 0);
  assert.equal(hostsStat.mode & 0o777, 0o644);
  const hostsText = await readFile(hostsPath, "utf8");
  assert.equal(await readFile("/etc/hosts", "utf8"), hostsText);
  const mappedHosts = new Set<string>();
  for (const line of hostsText.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length === 1 && fields[0] === "") continue;
    if (fields[0] === "127.0.0.1") {
      assert.deepEqual(fields.slice(1), ["localhost"]);
      continue;
    }
    if (fields[0] === "::1") {
      assert.deepEqual(fields.slice(1), [
        "localhost",
        "ip6-localhost",
        "ip6-loopback",
      ]);
      continue;
    }
    assert.ok(isPublicIpv4(fields[0]!));
    assert.equal(fields.length, 2);
    assert.ok(manifest.hostnames.includes(fields[1]!));
    mappedHosts.add(fields[1]!);
  }
  assert.deepEqual([...mappedHosts].sort(), [...manifest.hostnames].sort());

  const resolverPath = "/mnt/wsl/resolv.conf";
  const resolverStat = await lstat(resolverPath);
  assert.equal(resolverStat.isFile(), true);
  assert.equal(resolverStat.isSymbolicLink(), false);
  assert.equal(resolverStat.uid, 0);
  assert.equal(resolverStat.mode & 0o777, 0o644);
  const resolverText = await readFile(resolverPath, "utf8");
  const resolverLines = resolverText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.deepEqual(resolverLines, [
    "nameserver 127.0.0.1",
    "options timeout:1 attempts:1",
  ]);
  assert.equal(await readFile("/etc/resolv.conf", "utf8"), resolverText);
}

export function validateNativeTestEnvironment(
  evidence: NativeTestEnvironmentEvidence,
): NativeTestEnvironment {
  assert.equal(evidence.platform, "linux");
  assert.equal(evidence.uid, 1000, "Native test apps must be unprivileged");
  assert.equal(evidence.display, ":99");
  assert.equal(
    hasHostMounts(evidence.mounts),
    false,
    "Host-drive and WSL integration mounts are forbidden",
  );
  if (evidence.dockerMarker) return "docker";
  if (evidence.cloudTestMarker !== undefined) {
    // An ephemeral Firecracker agent VM, never the user's own machine. The
    // hosting session's Claude credential must stay unreadable so that no
    // test can run signed in with a credential the user did not create.
    assert.equal(evidence.cloudTestMarker, "1");
    assert.equal(evidence.cloudRunner, true);
    assert.match(evidence.kernelRelease, /-fc-/u);
    assert.doesNotMatch(evidence.kernelRelease, /microsoft/iu);
    assert.equal(evidence.wslTestMarker, undefined);
    assert.equal(
      evidence.hostingCredentialReadable,
      false,
      "Hosting-session credentials must be unreadable",
    );
    return "cloud";
  }

  assert.equal(evidence.wslTestMarker, "1");
  assert.match(evidence.wslDistroName ?? "", /-test-recovered$/u);
  assert.match(evidence.kernelRelease, /microsoft.*wsl2/iu);
  assert.equal(wslSetting(evidence.wslConfig, "automount", "enabled"), "false");
  assert.equal(wslSetting(evidence.wslConfig, "interop", "enabled"), "false");
  assert.equal(
    wslSetting(evidence.wslConfig, "interop", "appendwindowspath"),
    "false",
  );
  for (const value of [
    evidence.wslInterop,
    evidence.wslGui,
    evidence.waylandDisplay,
    evidence.pulseServer,
    evidence.wslEnv,
  ])
    assert.equal(value, undefined, "Host WSL integration must be disabled");
  return "wsl2";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    return value.isDirectory() && !value.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Fixed location of the cloud host's own Claude session credentials. */
const hostingCredentialDirectory = "/home/claude/.claude/remote";

async function hostingCredentialReadable(): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(hostingCredentialDirectory);
  } catch (error) {
    // Absent is unreadable; an unlistable directory is checked by name below.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    names = [".oauth_token", ".api_key", ".session_ingress_token"];
  }
  for (const name of names)
    try {
      await access(`${hostingCredentialDirectory}/${name}`, constants.R_OK);
      return true;
    } catch {
      // Not readable by this process.
    }
  return false;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    return value.isFile() && !value.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function assertNativeTestEnvironment(): Promise<NativeTestEnvironment> {
  const dockerMarker = await isFile("/.dockerenv");
  const [kernelRelease, mounts] = await Promise.all([
    readFile("/proc/sys/kernel/osrelease", "utf8"),
    readFile("/proc/mounts", "utf8"),
  ]);
  const cloudTestMarker = process.env.AI_VIDEO_EDITOR_CLOUD_TEST;
  const wslConfig =
    dockerMarker || cloudTestMarker !== undefined
      ? ""
      : await readFile("/etc/wsl.conf", "utf8");
  const environment = validateNativeTestEnvironment({
    platform: process.platform,
    uid: process.getuid?.(),
    display: process.env.DISPLAY,
    dockerMarker,
    wslTestMarker: process.env.AI_VIDEO_EDITOR_WSL_TEST,
    wslDistroName: process.env.WSL_DISTRO_NAME,
    kernelRelease,
    wslConfig,
    mounts,
    wslInterop: process.env.WSL_INTEROP,
    wslGui: process.env.WSL2_GUI_APPS_ENABLED,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    pulseServer: process.env.PULSE_SERVER,
    wslEnv: process.env.WSLENV,
    cloudTestMarker,
    cloudRunner: await isDirectory("/opt/env-runner"),
    hostingCredentialReadable: await hostingCredentialReadable(),
  });
  if (environment === "wsl2") {
    await assertPrivateWslResolver();
  }
  return environment;
}
