import assert from "node:assert/strict";
import test from "node:test";
import {
  validateNativeTestEnvironment,
  type NativeTestEnvironmentEvidence,
} from "../../scripts/native-test-environment.ts";

const wslEvidence: NativeTestEnvironmentEvidence = {
  platform: "linux",
  uid: 1000,
  display: ":99",
  dockerMarker: false,
  wslTestMarker: "1",
  wslDistroName: "private-test-recovered",
  kernelRelease: "6.6.87.2-microsoft-standard-WSL2",
  wslConfig:
    "[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n",
  mounts:
    "/dev/root / ext4 rw 0 0\ntmpfs /mnt/wsl tmpfs rw 0 0\ntmpfs /tmp/.X11-unix tmpfs rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n",
  wslInterop: undefined,
  wslGui: undefined,
  waylandDisplay: undefined,
  pulseServer: undefined,
  wslEnv: undefined,
};

test("accepts the no-host-mount Docker native test boundary", () => {
  assert.equal(
    validateNativeTestEnvironment({
      ...wslEvidence,
      dockerMarker: true,
      wslTestMarker: undefined,
      wslDistroName: undefined,
    }),
    "docker",
  );
});

test("accepts WSL2 only with automount, interop, WSLg and host mounts disabled", () => {
  assert.equal(validateNativeTestEnvironment(wslEvidence), "wsl2");
});

test("rejects WSL2 host drives, shared sockets, or enabled integration", () => {
  for (const rejected of [
    { ...wslEvidence, mounts: `${wslEvidence.mounts}C: /mnt/c drvfs rw 0 0\n` },
    {
      ...wslEvidence,
      mounts: `${wslEvidence.mounts}tmpfs /mnt/wslg tmpfs rw 0 0\n`,
    },
    { ...wslEvidence, wslInterop: "/run/WSL/1_interop" },
    { ...wslEvidence, wslGui: "1" },
    {
      ...wslEvidence,
      wslConfig: wslEvidence.wslConfig.replace("enabled=false", "enabled=true"),
    },
    { ...wslEvidence, wslDistroName: "Ubuntu-24.04" },
  ])
    assert.throws(() => validateNativeTestEnvironment(rejected));
});

test("rejects a privileged process, unexpected display, or non-WSL host", () => {
  for (const rejected of [
    { ...wslEvidence, uid: 0 },
    { ...wslEvidence, display: ":0" },
    { ...wslEvidence, kernelRelease: "6.1.0-linux" },
    { ...wslEvidence, wslTestMarker: undefined },
  ])
    assert.throws(() => validateNativeTestEnvironment(rejected));
});

const cloudEvidence: NativeTestEnvironmentEvidence = {
  ...wslEvidence,
  wslTestMarker: undefined,
  wslDistroName: undefined,
  kernelRelease: "6.18.44-fc-v77",
  wslConfig: "",
  mounts: "/dev/vda / ext4 rw 0 0\ntmpfs /dev/shm tmpfs rw 0 0\n",
  cloudTestMarker: "1",
  cloudRunner: true,
  hostingCredentialReadable: false,
};

test("accepts an opted-in cloud agent VM with unreadable hosting credentials", () => {
  assert.equal(validateNativeTestEnvironment(cloudEvidence), "cloud");
});

test("rejects a cloud VM that is privileged, unmarked or can read hosting credentials", () => {
  for (const rejected of [
    { ...cloudEvidence, hostingCredentialReadable: true },
    { ...cloudEvidence, hostingCredentialReadable: undefined },
    { ...cloudEvidence, cloudRunner: false },
    { ...cloudEvidence, cloudTestMarker: "yes" },
    { ...cloudEvidence, kernelRelease: "6.8.0-generic" },
    { ...cloudEvidence, kernelRelease: "6.6.87.2-microsoft-fc-WSL2" },
    { ...cloudEvidence, wslTestMarker: "1" },
    { ...cloudEvidence, uid: 0 },
    { ...cloudEvidence, display: ":0" },
    {
      ...cloudEvidence,
      mounts: `${cloudEvidence.mounts}C: /mnt/c drvfs rw 0 0\n`,
    },
  ])
    assert.throws(() => validateNativeTestEnvironment(rejected));
});
