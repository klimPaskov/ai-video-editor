"""Copy reviewed source into a fresh guest workspace without a host mount."""
import io
import json
import subprocess
import tarfile
import uuid
from pathlib import Path

from audit_publication import audit_blob
from desktop_environment import NAME, ROOT, validate_inspection
from workspace_files import source_files

inspection = json.loads(subprocess.check_output(['docker', 'inspect', NAME], text=True))[0]
validate_inspection(inspection)
bundle = io.BytesIO()
with tarfile.open(fileobj=bundle, mode='w') as archive:
    for source in source_files(ROOT):
        relative = source.relative_to(ROOT).as_posix()
        if source.is_symlink():
            raise ValueError('Source links are not copied')
        data = source.read_bytes()
        audit_blob(relative, data, '100644')
        entry = tarfile.TarInfo(relative)
        entry.mode, entry.size = 0o644, len(data)
        archive.addfile(entry, io.BytesIO(data))
destination = '/home/node/workspaces/' + str(uuid.uuid4()) + '/codex-video-edit'
subprocess.run(['docker', 'exec', NAME, 'mkdir', '-p', destination], check=True)
subprocess.run(['docker', 'exec', '-i', NAME, 'tar', '-x', '--no-same-owner', '-C', destination],
               input=bundle.getvalue(), check=True)
private = ROOT / 'local-data/desktop'
private.mkdir(parents=True, exist_ok=True)
(private / 'workspace.json').write_text(json.dumps({'container': NAME, 'path': destination}), encoding='utf-8')
print(destination)
