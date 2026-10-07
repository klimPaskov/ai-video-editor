"""Audit the staged Git snapshot, never copy worktree secrets to output."""
import re
import subprocess
from pathlib import Path, PurePosixPath
from workspace_files import is_agent_source

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_PARTS = frozenset({
    'node_modules', 'private', 'projects', 'recordings', 'exports', 'models',
    'checkpoints', 'credentials', '.codex', '.claude', '.venv', '__pycache__',
    'test-results', 'local-data',
})
MEDIA_SUFFIXES = frozenset({
    '.mp4', '.mov', '.mkv', '.webm', '.wav', '.flac', '.mp3', '.avi', '.raw',
    '.exe', '.dll', '.zip', '.dmp', '.log', '.ttf', '.otf', '.woff', '.woff2',
})
SECRET_PATTERNS = [
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}'),
    re.compile(rb'github_pat_[A-Za-z0-9_]{40,}'),
    re.compile(rb'sk-(?:proj-)?[A-Za-z0-9_-]{32,}'),
]


def audit_blob(path: str, data: bytes, mode: str):
    policy_path = path.casefold()
    parsed = PurePosixPath(policy_path)
    if mode not in {'100644', '100755'}:
        raise ValueError('Symlink/submodule or unsupported Git mode: ' + path)
    if parsed.name == 'claude.local.md':
        raise ValueError('Private Claude project context staged: ' + path)
    if any(part in PRIVATE_PARTS for part in parsed.parts) and not is_agent_source(policy_path):
        raise ValueError('Private/generated path staged: ' + path)
    if policy_path.startswith(('test-results/', 'local-data/')):
        raise ValueError('Private evidence staged: ' + path)
    if policy_path.startswith('fixtures/user-example/') and policy_path != 'fixtures/user-example/readme.md':
        raise ValueError('User example staged: ' + path)
    if parsed.name.startswith('.env') and parsed.name != '.env.example':
        raise ValueError('Environment credentials staged: ' + path)
    if parsed.suffix.lower() in MEDIA_SUFFIXES:
        raise ValueError('Runtime/media binary requires separate permission: ' + path)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError('Large file requires separate review: ' + path)
    if any(pattern.search(data) for pattern in SECRET_PATTERNS):
        raise ValueError('Potential credential in staged content: ' + path)
    # Reviewed PNGs only: UI references, and documentation screenshots that
    # scripts/capture_screenshots.ts renders from synthetic media.
    if b'\x00' in data and not (
        policy_path.startswith(('docs/references/screenshots/', 'docs/images/'))
        and parsed.suffix == '.png'
    ):
        raise ValueError('Unreviewed binary: ' + path)


def audit_index(root: Path):
    entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=root).split(b'\0')
    count = 0
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        mode, oid, stage = metadata.decode('ascii').split()
        if stage != '0':
            raise ValueError('Unresolved index conflict')
        path = raw_path.decode('utf-8')
        data = subprocess.check_output(['git', 'cat-file', 'blob', oid], cwd=root)
        audit_blob(path, data, mode)
        count += 1
    if not count:
        raise ValueError('No staged source to audit')
    return count


if __name__ == '__main__':
    print(f'Staged snapshot audited: {audit_index(ROOT)} files. Manual diff review is still required.')
