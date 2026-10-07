"""Enumerate source without walking dependencies, generated data or private evidence."""
import os
import hashlib
import re
from pathlib import Path, PurePosixPath

EXCLUDED = frozenset({
    '.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', 'out',
    'coverage', 'private', 'projects', 'recordings', 'exports', 'models',
    'checkpoints', 'credentials', '.codex', '.claude', 'test-results', 'local-data',
})


def is_agent_source(path: str) -> bool:
    """Admit reviewed project guidance, never account or generated runtime data."""
    parts = PurePosixPath(path.casefold()).parts
    if (len(parts) == 3 and parts[:2] == ('.codex', 'agents')
            and (parts[2] == 'routing.json' or parts[2].endswith('.md'))):
        return True
    if parts in (('.claude', 'readme.md'), ('.claude', 'settings.json')):
        return True
    if (len(parts) == 3 and parts[0] == '.claude'
            and parts[1] in {'agents', 'rules'} and parts[2].endswith('.md')):
        return re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', parts[2][:-3]) is not None
    return (len(parts) == 4 and parts[:2] == ('.claude', 'skills')
            and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', parts[2]) is not None
            and parts[3] == 'skill.md')


def source_files(root: Path):
    for current, directories, files in os.walk(root, followlinks=False):
        relative = Path(current).relative_to(root)
        policy_relative = relative.as_posix().casefold()
        directories[:] = sorted(d for d in directories if (d.casefold() not in EXCLUDED
                                or (policy_relative == '.' and d.casefold() in {'.codex', '.claude'}))
                                )
        if policy_relative == '.codex':
            directories[:] = [d for d in directories if d.casefold() == 'agents']
        elif policy_relative == '.codex/agents':
            directories[:] = []
        elif policy_relative == '.claude':
            directories[:] = [d for d in directories if d.casefold() in {'agents', 'rules', 'skills'}]
        elif policy_relative in {'.claude/agents', '.claude/rules'} or policy_relative.startswith('.claude/skills/'):
            directories[:] = []
        if policy_relative == 'fixtures/user-example':
            directories[:] = []
        for directory in directories:
            candidate = Path(current) / directory
            if candidate.is_symlink():
                yield candidate
        for name in sorted(files):
            if name.casefold() == 'claude.local.md':
                continue
            if (policy_relative == '.codex' or policy_relative.startswith('.codex/')) and not is_agent_source((relative / name).as_posix()):
                continue
            if (policy_relative == '.claude' or policy_relative.startswith('.claude/')) and not is_agent_source((relative / name).as_posix()):
                continue
            if policy_relative == 'fixtures/user-example' and name.casefold() != 'readme.md':
                continue
            yield Path(current) / name


def source_digest(path: Path):
    """Hash text with Git's LF normalization; binary reference bytes stay exact."""
    data = path.read_bytes()
    if b'\x00' not in data:
        data = data.replace(b'\r\n', b'\n')
    return hashlib.sha256(data).hexdigest()
