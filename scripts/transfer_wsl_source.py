"""Stream only the current Git index snapshot into the isolated WSL2 test guest."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path, PurePosixPath
from workspace_files import is_agent_source

ROOT = Path(__file__).resolve().parents[1]
TARGET = "/home/node/workspaces/ai-video-editor-wsl"
FORBIDDEN_PARTS = {".git", "node_modules", "test-results", "local-data"}
FORBIDDEN_NAMES = {"auth.json", "credentials.json", ".credentials.json", "settings.local.json", "claude.local.md", "id_rsa", "id_ed25519"}
FORBIDDEN_SUFFIXES = {
    ".mp3",
    ".mp4",
    ".m4a",
    ".mkv",
    ".mov",
    ".wav",
    ".webm",
    ".flac",
    ".aiff",
    ".aac",
    ".ogg",
    ".avi",
    ".mpeg",
    ".mpg",
    ".auth",
    ".pem",
}


def discover_test_distribution() -> str:
    listing = subprocess.run(
        ["wsl.exe", "--list", "--quiet"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    encoding = "utf-16-le" if b"\x00" in listing[:64] else "utf-8-sig"
    names = listing.decode(encoding).replace("\x00", "").splitlines()
    candidates = sorted(
        name.strip()
        for name in names
        if name.strip().lower().endswith("-test-recovered")
    )
    if len(candidates) != 1:
        raise SystemExit(
            "Expected one isolated WSL distro ending in '-test-recovered'; "
            "preserve existing distros and resolve the test guest before transfer."
        )
    return candidates[0]


def run_wsl(distribution: str, *arguments: str) -> None:
    subprocess.run(
        ["wsl.exe", "--distribution", distribution, *arguments],
        cwd=ROOT,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )


def main() -> int:
    distribution = discover_test_distribution()
    tree = subprocess.run(
        ["git", "write-tree"], cwd=ROOT, check=True, capture_output=True
    ).stdout.strip().decode("ascii")
    listing = subprocess.run(
        ["git", "ls-tree", "-r", "-z", tree],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.split(b"\0")
    names: list[str] = []
    for item in listing:
        if not item:
            continue
        metadata, raw_name = item.split(b"\t", 1)
        if metadata.split()[0] == b"120000":
            raise SystemExit("The Git snapshot contains an unreviewed symbolic link")
        names.append(raw_name.decode("utf-8"))
    if not names:
        raise SystemExit("Refusing to transfer an empty source snapshot")
    for name in names:
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or any(part in FORBIDDEN_PARTS for part in path.parts)
            or path.name.lower() in FORBIDDEN_NAMES
            or path.suffix.lower() in FORBIDDEN_SUFFIXES
            or ('.claude' in tuple(part.casefold() for part in path.parts) and not is_agent_source(name))
        ):
            raise SystemExit("The Git snapshot includes a private or media path")

    isolation_check = f"""
set -eu
grep -qi microsoft-standard-wsl2 /proc/sys/kernel/osrelease
python3 - <<'PY'
from configparser import ConfigParser
from pathlib import Path
import re
config = ConfigParser()
config.read('/etc/wsl.conf')
assert config.get('automount', 'enabled', fallback='true').lower() == 'false'
assert config.get('interop', 'enabled', fallback='true').lower() == 'false'
assert config.get('interop', 'appendWindowsPath', fallback='true').lower() == 'false'
mounts = Path('/proc/mounts').read_text(encoding='utf-8')
assert not any(
    fields[2] == 'drvfs' or re.match(r'^/mnt/[a-z](?:/|$)', fields[1], re.I)
    for line in mounts.splitlines()
    if len(fields := line.split()) >= 3
)
PY
if [ -e {TARGET} ]; then
  test -d {TARGET} && test ! -L {TARGET}
  test "$(stat -c %u {TARGET})" = 1000
  grep -q '"name": "ai-video-editor"' {TARGET}/package.json
fi
"""
    run_wsl(distribution, "--user", "root", "--exec", "/bin/sh", "-c", isolation_check)
    run_wsl(distribution, "--user", "root", "--exec", "/bin/mkdir", "-p", "/home/node/workspaces")
    run_wsl(
        distribution,
        "--user",
        "root",
        "--exec",
        "/bin/chown",
        "1000:1001",
        "/home/node",
        "/home/node/workspaces",
    )

    archive = subprocess.Popen(
        [
            "git",
            "archive",
            "--format=tar",
            "--prefix=ai-video-editor-wsl/",
            tree,
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    tar = subprocess.Popen(
        [
            "wsl.exe",
            "--distribution",
            distribution,
            "--user",
            "ubuntu",
            "--exec",
            "/usr/bin/tar",
            "--no-same-owner",
            "-xf",
            "-",
            "-C",
            "/home/node/workspaces",
        ],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    assert archive.stdout is not None and tar.stdin is not None
    try:
        while chunk := archive.stdout.read(1024 * 1024):
            tar.stdin.write(chunk)
    except BrokenPipeError:
        pass
    finally:
        archive.stdout.close()
        tar.stdin.close()
    archive_error = archive.stderr.read() if archive.stderr else b""
    tar_error = tar.stderr.read() if tar.stderr else b""
    archive_status = archive.wait()
    tar_status = tar.wait()
    if archive_status or tar_status:
        raise SystemExit(
            "Source transfer failed; diagnostic output was suppressed to keep the guest boundary closed."
        )
    print(f"Transferred {len(names)} Git-index files into the isolated WSL2 guest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
