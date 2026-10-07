# Security

## Reporting a vulnerability

Please report security issues privately through **Report a vulnerability** on this repository's Security tab. If that option is not shown, open an issue asking for a private contact, without details of the problem. Never include recordings, credentials or private logs in public issues.

## Design

- The interface runs sandboxed with context isolation and a strict Content Security Policy, and loads only packaged local content. All file, device, process and network access happens in the main process behind validated IPC.
- Source media is immutable; all edits are reversible draft transactions.
- AI assistants edit only through a fixed set of guarded tools with bounded, path-free inputs. Transcripts, file names and metadata are treated as untrusted data, never as instructions.
- Claude credentials are handled only by Claude Code; API keys are encrypted with the operating system's secure storage.
- Screen capture stops when the app quits or crashes.

More detail: [Security and privacy specification](docs/21_SECURITY_PRIVACY.md).
