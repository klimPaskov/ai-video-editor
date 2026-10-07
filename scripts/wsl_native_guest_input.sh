#!/bin/sh
set -eu

guest_distro_name=${WSL_DISTRO_NAME:-}
case "$guest_distro_name" in
  *-test-recovered) ;;
  *) echo "Guest input requires the recovered WSL2 test distro." >&2; exit 2 ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  echo "Guest input requires the recovered WSL2 test distro." >&2
  exit 2
fi
pid_file=/home/ubuntu/.local/run/ai-video-editor-wsl-mountns.pid
if [ ! -f "$pid_file" ]; then
  echo "The isolated native-test mount namespace is not active." >&2
  exit 2
fi
read -r mount_namespace_pid expected_namespace < "$pid_file"
case "$mount_namespace_pid" in
  ''|*[!0-9]*) echo "Invalid isolated mount-namespace identity." >&2; exit 2 ;;
esac
case "$expected_namespace" in
  mnt:\[*\]) ;;
  *) echo "Invalid isolated mount-namespace token." >&2; exit 2 ;;
esac
if [ ! -r "/proc/$mount_namespace_pid/ns/mnt" ] || \
   [ "$(readlink "/proc/$mount_namespace_pid/ns/mnt")" != "$expected_namespace" ] || \
   [ "$(awk '$1 == "Uid:" {print $2}' "/proc/$mount_namespace_pid/status")" != 0 ]; then
  echo "The isolated native-test mount namespace has exited." >&2
  exit 2
fi
exec nsenter --target "$mount_namespace_pid" --mount -- \
  /usr/bin/setpriv --reuid=1000 --regid=1001 --clear-groups \
  /usr/bin/env -i \
    HOME=/home/ubuntu \
    PATH=/home/ubuntu/.local/node-v24.15.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISPLAY=:99 \
    LANG=C.UTF-8 \
    TMPDIR=/tmp \
    XDG_RUNTIME_DIR=/home/ubuntu/.local/run \
    WSL_DISTRO_NAME="$guest_distro_name" \
    AI_VIDEO_EDITOR_WSL_TEST=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    /usr/bin/python3 /home/node/workspaces/ai-video-editor-wsl/tests/desktop/guest-input.py "$@"
