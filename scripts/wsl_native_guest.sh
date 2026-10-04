#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "The WSL isolation wrapper must begin as root." >&2
  exit 2
fi
guest_distro_name=${WSL_DISTRO_NAME:-}
case "$guest_distro_name" in
  *-test-recovered) ;;
  *)
    echo "The dedicated recovered WSL test guest is required." >&2
    exit 2
    ;;
esac
export WSL_DISTRO_NAME="$guest_distro_name"
if [ -n "${P5_MODEL_CACHE_SOURCE:-}" ]; then
  cache_source=$(realpath -- "$P5_MODEL_CACHE_SOURCE")
  case "$cache_source" in
    /home/node/workspaces/ai-video-editor-wsl/test-results/*) P5_MODEL_CACHE_SOURCE=$cache_source ;;
    *) echo "The model cache must remain inside the private WSL test results." >&2; exit 2 ;;
  esac
fi
case "$(cat /proc/sys/kernel/osrelease)" in
  *microsoft-standard-WSL2*) ;;
  *) echo "A WSL2 kernel is required." >&2; exit 2 ;;
esac
python3 - <<'PY'
from configparser import ConfigParser
from pathlib import Path
import re

config = ConfigParser()
config.read("/etc/wsl.conf")
if config.get("automount", "enabled", fallback="true").lower() != "false":
    raise SystemExit("WSL Windows-drive automount must be disabled.")
if config.get("interop", "enabled", fallback="true").lower() != "false":
    raise SystemExit("WSL Windows interop must be disabled.")
if config.get("interop", "appendWindowsPath", fallback="true").lower() != "false":
    raise SystemExit("Windows executable paths must be disabled.")
mounts = Path("/proc/mounts").read_text(encoding="utf-8")
if any(
    fields[2] == "drvfs" or re.match(r"^/mnt/[a-z](?:/|$)", fields[1], re.I)
    for line in mounts.splitlines()
    if len(fields := line.split()) >= 3
):
    raise SystemExit("Host-drive mounts must be absent before isolation.")
PY
if [ "$#" -eq 0 ]; then
  echo "Provide a build or native-test command." >&2
  exit 2
fi

mkdir -p /root/.local/run /home/ubuntu/.local/run
chmod 700 /root/.local/run
python3 - <<'PY'
import ipaddress
import json
from pathlib import Path
import subprocess

manifest = json.loads(
    Path('/home/node/workspaces/ai-video-editor-wsl/scripts/wsl-public-hosts.json').read_text()
)
lines = ['127.0.0.1 localhost', '::1 localhost ip6-localhost ip6-loopback']
for host in manifest['hostnames']:
    result = subprocess.run(
        ['getent', 'ahostsv4', host], check=True, capture_output=True, text=True
    )
    addresses = sorted(
        {line.split()[0] for line in result.stdout.splitlines() if line.split()}
    )
    if not addresses:
        raise SystemExit(f'No DNS address for the reviewed test endpoint: {host}')
    for address in addresses:
        if not ipaddress.IPv4Address(address).is_global:
            raise SystemExit(f'Non-public DNS address for the reviewed test endpoint: {host}')
        lines.append(f'{address} {host}')
Path('/root/.local/run/ai-video-editor-wsl-hosts').write_text(
    '\n'.join(lines) + '\n', encoding='utf-8'
)
PY
chmod 600 /root/.local/run/ai-video-editor-wsl-hosts
unshare --mount --propagation private --fork /bin/sh -s -- wsl-native-guest "$@" <<'WSL_GUEST_RUNNER'
set -eu
[ "${1:-}" = "wsl-native-guest" ] || {
  echo "Native guest command marker is missing." >&2
  exit 2
}
shift
mount --make-rprivate /
for shared in /mnt/wslg /mnt/wsl /tmp/.X11-unix; do
  if mountpoint -q "$shared"; then umount -R "$shared"; fi
done
mkdir -p /mnt/wsl
mount -t tmpfs -o size=1m,mode=755,nosuid,nodev,noexec tmpfs /mnt/wsl
cp /root/.local/run/ai-video-editor-wsl-hosts /mnt/wsl/hosts
printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > /mnt/wsl/resolv.conf
chown root:root /mnt/wsl/hosts /mnt/wsl/resolv.conf
chmod 644 /mnt/wsl/hosts /mnt/wsl/resolv.conf
mount --bind /mnt/wsl/hosts /etc/hosts
mkdir -p /tmp/.X11-unix /home/ubuntu/.local/tmp/ai-video-editor
mount -t tmpfs -o size=8m,mode=1777,nosuid,nodev,noexec tmpfs /tmp/.X11-unix
chown 1000:1001 /home/ubuntu/.local/tmp/ai-video-editor
chmod 700 /home/ubuntu/.local/tmp/ai-video-editor
python3 - <<'PY'
from pathlib import Path
import re

mount_pairs = set()
for line in Path('/proc/mounts').read_text(encoding='utf-8').splitlines():
    fields = line.split()
    if len(fields) < 3:
        continue
    target = fields[1]
    fstype = fields[2]
    mount_pairs.add((target, fstype))
    if fstype == 'drvfs' or re.match(r'^/mnt/[a-z](?:/|$)', target, re.I):
        if target != '/mnt/wsl' or fstype != 'tmpfs':
            raise SystemExit('Host-drive mounts are forbidden.')
    if target.startswith('/mnt/wsl/') or target == '/mnt/wslg' or target.startswith('/mnt/wslg/'):
        raise SystemExit('Docker and WSLg mounts are forbidden.')
    if target == '/tmp/.X11-unix' and fstype == 'tmpfs':
        continue
    if target == '/tmp/.X11-unix':
        raise SystemExit('The host X11 socket is forbidden.')
if (('/mnt/wsl', 'tmpfs') not in mount_pairs or ('/etc/hosts', 'tmpfs') not in mount_pairs
        or ('/tmp/.X11-unix', 'tmpfs') not in mount_pairs):
    raise SystemExit('The private hosts and X11 mappings are not mounted.')
assert sorted(path.name for path in Path('/mnt/wsl').iterdir()) == ['hosts', 'resolv.conf']
assert Path('/etc/hosts').read_text() == Path('/mnt/wsl/hosts').read_text()
resolver = Path('/mnt/wsl/resolv.conf')
stat = resolver.stat()
assert stat.st_uid == 0 and stat.st_mode & 0o777 == 0o644
assert resolver.read_text() == 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n'
PY
unset WSL_INTEROP WSL2_GUI_APPS_ENABLED WSLENV WAYLAND_DISPLAY PULSE_SERVER PIPEWIRE_REMOTE
mkdir -p /home/ubuntu/.local/run /home/node/workspaces/ai-video-editor-wsl/test-results
chown 1000:1001 /home/ubuntu/.local/run /home/node/workspaces/ai-video-editor-wsl/test-results
chmod 700 /home/ubuntu/.local/run /home/node/workspaces/ai-video-editor-wsl/test-results
if [ "$(stat -c %u /home/node/workspaces/ai-video-editor-wsl)" != 1000 ]; then
  echo "The workspace must belong to UID 1000." >&2
  exit 3
fi
setpriv --reuid=1000 --regid=1001 --clear-groups /usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac >/dev/null 2>&1 &
xvfb_pid=$!
mount_namespace_pid=/home/ubuntu/.local/run/ai-video-editor-wsl-mountns.pid
printf "%s %s\n" "$$" "$(readlink "/proc/$$/ns/mnt")" > "$mount_namespace_pid"
chmod 600 "$mount_namespace_pid"
cleanup() {
  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
  rm -f "$mount_namespace_pid"
}
trap cleanup EXIT HUP INT TERM
ready=false
for attempt in $(seq 1 40); do
  if setpriv --reuid=1000 --regid=1001 --clear-groups /usr/bin/xdpyinfo -display :99 >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done
if [ "$ready" != true ]; then
  echo "Private Xvfb did not become ready." >&2
  exit 3
fi
cd /home/node/workspaces/ai-video-editor-wsl
setpriv --reuid=1000 --regid=1001 --clear-groups /usr/bin/env -i \
  HOME=/home/ubuntu \
  PATH=/home/ubuntu/.local/node-v24.15.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  DISPLAY=:99 \
  LANG=C.UTF-8 \
  TMPDIR=/home/ubuntu/.local/tmp/ai-video-editor \
  XDG_RUNTIME_DIR=/home/ubuntu/.local/run \
  WSL_DISTRO_NAME="$WSL_DISTRO_NAME" \
  AI_VIDEO_EDITOR_WSL_TEST=1 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  ONNXRUNTIME_NODE_INSTALL=skip \
  P5_MODEL_CACHE_SOURCE="${P5_MODEL_CACHE_SOURCE:-}" \
  "$@"
WSL_GUEST_RUNNER
