"""Observe and operate only the isolated Linux X11 desktop, never host input."""
import argparse
import ctypes as c
import configparser
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


def validate_runtime():
    if (sys.platform != 'linux' or not hasattr(os, 'getuid') or os.getuid() != 1000
            or os.environ.get('DISPLAY') != ':99'):
        raise RuntimeError('Guest input requires Docker or verified WSL2, Linux UID 1000, and display :99')
    if Path('/.dockerenv').is_file():
        return
    if (os.environ.get('AI_VIDEO_EDITOR_WSL_TEST') != '1'
            or not os.environ.get('WSL_DISTRO_NAME', '').endswith('-test-recovered')
            or any(os.environ.get(key) for key in
                   ('WSL_INTEROP', 'WSL2_GUI_APPS_ENABLED', 'WSLENV',
                    'WAYLAND_DISPLAY', 'PULSE_SERVER'))):
        raise RuntimeError('Guest input requires Docker or verified WSL2 with integration disabled')
    if 'microsoft-standard-wsl2' not in Path('/proc/sys/kernel/osrelease').read_text().lower():
        raise RuntimeError('Guest input requires Docker or a verified WSL2 kernel')
    configuration = configparser.ConfigParser()
    configuration.read('/etc/wsl.conf')
    if (configuration.get('automount', 'enabled', fallback='true').lower() != 'false'
            or configuration.get('interop', 'enabled', fallback='true').lower() != 'false'
            or configuration.get('interop', 'appendWindowsPath', fallback='true').lower() != 'false'):
        raise RuntimeError('Guest input requires Docker or WSL2 with automount and interop disabled')
    for line in Path('/proc/mounts').read_text().splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        mount_point = re.sub(r'\\040', ' ', fields[1])
        if mount_point == '/mnt/wsl' and fields[2] == 'tmpfs':
            resolver_dir = Path('/mnt/wsl')
            resolver_dir_stat = resolver_dir.stat()
            hosts_file = resolver_dir / 'hosts'
            resolver_file = resolver_dir / 'resolv.conf'
            hosts_stat = hosts_file.stat()
            resolver_stat = resolver_file.stat()
            if (resolver_dir_stat.st_uid != 0 or resolver_dir_stat.st_mode & 0o777 != 0o755
                    or sorted(path.name for path in resolver_dir.iterdir()) != ['hosts', 'resolv.conf']
                    or hosts_stat.st_uid != 0 or hosts_stat.st_mode & 0o777 != 0o644
                    or resolver_stat.st_uid != 0 or resolver_stat.st_mode & 0o777 != 0o644):
                raise RuntimeError('The private WSL resolver mount is invalid')
            manifest = json.loads((Path(__file__).resolve().parents[2] / 'scripts/wsl-public-hosts.json').read_text())
            allowed = set(manifest['hostnames'])
            mapped = set()
            for line in hosts_file.read_text().splitlines():
                fields = line.split()
                if not fields:
                    continue
                if fields[0] == '127.0.0.1':
                    if fields[1:] != ['localhost']:
                        raise RuntimeError('The private WSL hosts file is invalid')
                elif fields[0] == '::1':
                    if fields[1:] != ['localhost', 'ip6-localhost', 'ip6-loopback']:
                        raise RuntimeError('The private WSL hosts file is invalid')
                elif len(fields) == 2 and ipaddress.ip_address(fields[0]).is_global and fields[1] in allowed:
                    mapped.add(fields[1])
                else:
                    raise RuntimeError('The private WSL hosts file is invalid')
            if mapped != allowed or hosts_file.read_text() != Path('/etc/hosts').read_text():
                raise RuntimeError('The private WSL hosts mapping is incomplete')
            resolver_lines = [
                line.strip()
                for line in resolver_file.read_text().splitlines()
                if line.strip() and not line.strip().startswith('#')
            ]
            if resolver_lines != ['nameserver 127.0.0.1', 'options timeout:1 attempts:1']:
                raise RuntimeError('The private WSL resolver configuration is invalid')
            if resolver_file.read_text() != Path('/etc/resolv.conf').read_text():
                raise RuntimeError('The WSL resolver escaped the private test namespace')
            continue
        if mount_point == '/tmp/.X11-unix' and fields[2] == 'tmpfs':
            x11_socket_dir = Path('/tmp/.X11-unix').stat()
            if x11_socket_dir.st_uid != 0 or x11_socket_dir.st_mode & 0o1777 != 0o1777:
                raise RuntimeError('The WSL X11 socket directory is not private')
            continue
        if (fields[2] == 'drvfs' or re.match(r'^/mnt/[a-z](?:/|$)', mount_point, re.I)
                or mount_point == '/mnt/wsl' or mount_point.startswith('/mnt/wsl/')
                or mount_point == '/mnt/wslg' or mount_point.startswith('/mnt/wslg/')
                or mount_point == '/tmp/.X11-unix'):
            raise RuntimeError('Guest input requires Docker or WSL2 with host, Docker, and WSLg mounts removed')
    mount_pairs = {
        (line.split()[1], line.split()[2])
        for line in Path('/proc/mounts').read_text().splitlines()
        if len(line.split()) >= 3
    }
    if {('/mnt/wsl', 'tmpfs'), ('/etc/hosts', 'tmpfs'),
            ('/tmp/.X11-unix', 'tmpfs')} - mount_pairs:
        raise RuntimeError('The private WSL resolver mount is unavailable')


def main():
    validate_runtime()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'click', 'key'])
    parser.add_argument('values', nargs='*')
    args = parser.parse_args()
    x = c.CDLL('libX11.so.6')
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = c.c_void_p
    x.XCloseDisplay.argtypes = [c.c_void_p]
    x.XFlush.argtypes = [c.c_void_p]
    x.XDisplayWidth.argtypes = [c.c_void_p, c.c_int]
    x.XDisplayHeight.argtypes = [c.c_void_p, c.c_int]
    display = x.XOpenDisplay(b':99')
    if not display:
        raise RuntimeError('Guest display is unavailable')
    try:
        width, height = x.XDisplayWidth(display, 0), x.XDisplayHeight(display, 0)
        if (width, height) != (1440, 900):
            raise RuntimeError('Unexpected guest display geometry')
        if args.action == 'capture':
            if args.values:
                parser.error('Capture has no input arguments')
        else:
            xt = c.CDLL('libXtst.so.6')
            xt.XTestFakeMotionEvent.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_ulong]
            xt.XTestFakeButtonEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
            xt.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
            if args.action == 'click':
                if len(args.values) != 2:
                    parser.error('Click requires x and y from the last guest screenshot')
                px, py = map(int, args.values)
                if not (0 <= px < width and 0 <= py < height):
                    parser.error('Click is outside the guest display')
                accepted = [xt.XTestFakeMotionEvent(display, 0, px, py, 0),
                            xt.XTestFakeButtonEvent(display, 1, 1, 0),
                            xt.XTestFakeButtonEvent(display, 1, 0, 0)]
                if not all(accepted):
                    raise RuntimeError('Guest XTEST rejected click input')
            else:
                permitted = {'Tab', 'Shift_L+Tab', 'Escape', 'Return', 'Up', 'Down',
                             'Home', 'End', 'Control_L+comma'}
                if len(args.values) != 1 or args.values[0] not in permitted:
                    parser.error('Unsupported guest test key')
                x.XStringToKeysym.argtypes = [c.c_char_p]
                x.XStringToKeysym.restype = c.c_ulong
                x.XKeysymToKeycode.argtypes = [c.c_void_p, c.c_ulong]
                x.XKeysymToKeycode.restype = c.c_ubyte
                keys = [x.XKeysymToKeycode(display, x.XStringToKeysym(k.encode('ascii')))
                        for k in args.values[0].split('+')]
                if not all(keys):
                    raise RuntimeError('Guest key mapping unavailable')
                accepted = []
                try:
                    for key in keys:
                        accepted.append(xt.XTestFakeKeyEvent(display, key, 1, 0))
                finally:
                    for key in reversed(keys):
                        accepted.append(xt.XTestFakeKeyEvent(display, key, 0, 0))
                    x.XFlush(display)
                if not all(accepted):
                    raise RuntimeError('Guest XTEST rejected key input')
            x.XFlush(display)
            time.sleep(0.2)
    finally:
        x.XCloseDisplay(display)
    folder = Path('/home/node/evidence/visual')
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / (str(uuid.uuid4()) + '.png')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                    '-f', 'x11grab', '-video_size', f'{width}x{height}', '-i', ':99',
                    '-frames:v', '1', '-threads', '1', str(output)],
                   check=True, timeout=20, capture_output=True)
    record = {'action': args.action, 'values': args.values, 'screenshot': str(output),
              'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
              'display': ':99', 'width': width, 'height': height, 'hostInput': False}
    output.with_suffix('.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps(record))


if __name__ == '__main__':
    main()
