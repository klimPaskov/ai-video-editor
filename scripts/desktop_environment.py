"""Provision an isolated native display without mounting host files."""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = 'ai-video-editor-desktop'
IMAGE = 'ai-video-editor-desktop:p0'
LABEL = 'dev.ai-video-editor.environment=isolated-native-test'


def start_arguments() -> list[str]:
    return ['docker', 'run', '-d', '--name', NAME, '--label', LABEL,
            '--init', '--user', '1000:1000', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true',
            '--security-opt', f'seccomp={ROOT / "tests/desktop/seccomp.json"}',
            '--shm-size=1g', '--pids-limit=512', '--memory=4g', '--cpus=4', IMAGE]


def validate_inspection(value: dict) -> None:
    config, host = value['Config'], value['HostConfig']
    if config.get('Labels', {}).get('dev.ai-video-editor.environment') != 'isolated-native-test':
        raise ValueError('Container is not the project test environment')
    if config.get('User') != '1000:1000':
        raise ValueError('Desktop must run as the unprivileged test user')
    if value.get('Mounts') or host.get('Privileged') or host.get('Devices') or host.get('DeviceRequests') or host.get('CapAdd'):
        raise ValueError('Host mounts, devices and elevated container privileges are forbidden')
    if host.get('NetworkMode', 'default') not in ('default', 'bridge') or host.get('IpcMode', 'private') != 'private' or host.get('PidMode', '') != '':
        raise ValueError('Shared or host namespaces are forbidden')
    if 'ALL' not in host.get('CapDrop', []):
        raise ValueError('Capabilities must be dropped')
    options = host.get('SecurityOpt', [])
    if not any(x in ('no-new-privileges', 'no-new-privileges:true') for x in options):
        raise ValueError('Privilege escalation must be disabled')
    profiles = [x.removeprefix('seccomp=') for x in options if x.startswith('seccomp=')]
    expected_profile = json.loads((ROOT / 'tests/desktop/seccomp.json').read_text(encoding='utf-8'))
    if len(profiles) != 1:
        raise ValueError('Explicit restricted seccomp profile required')
    try:
        if json.loads(profiles[0]) != expected_profile:
            raise ValueError('Seccomp profile does not match the reviewed configuration')
    except json.JSONDecodeError as error:
        raise ValueError('Invalid seccomp configuration') from error
    expected = {'5900/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5909'}]}
    if host.get('PortBindings') not in ({}, expected):
        raise ValueError('No published ports or the historical loopback viewer binding are allowed')
    if not value['State']['Running']:
        raise ValueError('Desktop container is not running')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build', 'start', 'check', 'probe-setup', 'probe'])
    args = parser.parse_args()
    if args.action == 'build':
        subprocess.run(['docker', 'build', '-t', IMAGE, str(ROOT / 'tests/desktop')], check=True)
    elif args.action == 'start':
        # A name collision fails. Never replace/delete an existing environment.
        subprocess.run(start_arguments(), check=True)
    else:
        result = subprocess.run(['docker', 'inspect', NAME], check=True, capture_output=True, text=True)
        validate_inspection(json.loads(result.stdout)[0])
        subprocess.run(['docker', 'exec', NAME, 'xdpyinfo'], check=True, stdout=subprocess.DEVNULL)
        if args.action == 'probe-setup':
            # Explicit source allowlist; never send a repository/private tree.
            names = ['package.json', 'package-lock.json', 'main.cjs', 'preload.cjs',
                     'index.html', 'renderer.js', 'verify.cjs']
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as bundle:
                for name in names:
                    source = ROOT / 'tests/desktop/probe' / name
                    if source.is_symlink() or not source.is_file():
                        raise ValueError(f'Probe source must be a regular file: {name}')
                    data = source.read_bytes()
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(data), 0o644
                    bundle.addfile(entry, io.BytesIO(data))
            destination = '/home/node/native-smoke'
            subprocess.run(['docker', 'exec', NAME, 'mkdir', '-p', destination], check=True)
            subprocess.run(['docker', 'exec', '-i', NAME, 'tar', '-x', '--no-same-owner', '-C', destination],
                           input=archive.getvalue(), check=True)
            for command in (['npm', 'ci', '--ignore-scripts'], ['node', 'node_modules/electron/install.js']):
                subprocess.run(['docker', 'exec', '-w', destination, NAME, *command], check=True)
        elif args.action == 'probe':
            subprocess.run(['docker', 'exec', '-w', '/home/node/native-smoke', NAME, 'npm', 'test'], check=True)
        print('Isolated container and virtual display verified; product and visual acceptance remain separate.')


if __name__ == '__main__':
    main()
