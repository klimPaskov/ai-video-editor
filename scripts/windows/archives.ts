import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, createGunzip, inflateRawSync } from "node:zlib";
import { once } from "node:events";

/**
 * Minimal, strict readers for the two archive types the Windows build
 * consumes (an FFmpeg ZIP and an npm tarball). They extract only entries the
 * caller names, refuse anything unusual and never write outside the target.
 */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** A relative archive path with no traversal, drive, or backslash tricks. */
export function isSafeArchivePath(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 512 &&
    !name.includes("\0") &&
    !name.includes("\\") &&
    !name.startsWith("/") &&
    !/^[A-Za-z]:/u.test(name) &&
    name.split("/").every((part) => part !== ".." && part !== ".")
  );
}

export function insideDirectory(directory: string, target: string): boolean {
  const base = resolve(directory);
  const full = resolve(target);
  return full === base || full.startsWith(base + sep);
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  offset: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

const maxEntryBytes = 512 * 1024 * 1024;

export function listZip(zip: Buffer): ZipEntry[] {
  const searchFrom = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let index = zip.length - 22; index >= searchFrom; index -= 1)
    if (zip.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  if (eocd < 0) throw new ArchiveError("Not a ZIP archive");
  const count = zip.readUInt16LE(eocd + 10);
  const directorySize = zip.readUInt32LE(eocd + 12);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new ArchiveError("ZIP64 archives are not supported");
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50)
      throw new ArchiveError("Corrupt ZIP directory");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const attributes = zip.readUInt32LE(cursor + 38) >>> 16;
    const offset = zip.readUInt32LE(cursor + 42);
    if (flags & 0x1) throw new ArchiveError("Encrypted ZIP entry");
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      offset === 0xffffffff
    )
      throw new ArchiveError("ZIP64 entries are not supported");
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const type = attributes & 0xf000;
    entries.push({
      name,
      size,
      compressedSize,
      method,
      crc,
      offset,
      isDirectory: name.endsWith("/"),
      isSymbolicLink: type === 0xa000,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if (entry.isDirectory || entry.isSymbolicLink)
    throw new ArchiveError("Not a regular file entry");
  if (!isSafeArchivePath(entry.name.replace(/\/$/u, "")))
    throw new ArchiveError("Unsafe ZIP entry name");
  if (entry.size > maxEntryBytes) throw new ArchiveError("ZIP entry too large");
  const header = entry.offset;
  if (header + 30 > zip.length || zip.readUInt32LE(header) !== 0x04034b50)
    throw new ArchiveError("Corrupt ZIP entry");
  const dataStart =
    header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
  const raw = zip.subarray(dataStart, dataStart + entry.compressedSize);
  if (raw.length !== entry.compressedSize)
    throw new ArchiveError("Truncated ZIP entry");
  let data: Buffer;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8)
    data = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
  else throw new ArchiveError("Unsupported ZIP compression");
  if (data.length !== entry.size || crc32(data) !== entry.crc)
    throw new ArchiveError("ZIP entry failed its integrity check");
  return data;
}

/** Reads one ZIP and returns the verified bytes of each requested path. */
export async function extractZipFiles(
  zipPath: string,
  wanted: ReadonlyMap<string, string>,
  writeFileTo: (destination: string, data: Buffer) => Promise<void>,
): Promise<void> {
  const zip = await readFile(zipPath);
  const entries = new Map(listZip(zip).map((entry) => [entry.name, entry]));
  for (const [name, destination] of wanted) {
    const entry = entries.get(name);
    if (!entry) throw new ArchiveError(`Missing from the ZIP: ${name}`);
    await writeFileTo(destination, readZipEntry(zip, entry));
  }
}

interface TarHeader {
  name: string;
  size: number;
  type: string;
}

function octal(block: Buffer, start: number, length: number): number {
  const text = block
    .toString("ascii", start, start + length)
    .replace(/\0.*$/su, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new ArchiveError("Corrupt tar header");
  return Number.parseInt(text, 8);
}

function paxValue(data: Buffer, key: string): string | undefined {
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space < 0) break;
    const length = Number.parseInt(data.toString("ascii", cursor, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, cursor + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === key)
      return record.slice(equals + 1);
    cursor += length;
  }
  return undefined;
}

/** Reads exactly `length` bytes from an async byte stream with lookahead. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async fill(wanted: number): Promise<void> {
    while (!this.ended && this.buffer.length < wanted) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
  async read(length: number): Promise<Buffer | null> {
    await this.fill(length);
    if (this.buffer.length === 0 && this.ended) return null;
    if (this.buffer.length < length) throw new ArchiveError("Truncated tar");
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }
  /** Streams up to `length` bytes in bounded pieces. */
  async *pieces(length: number): AsyncGenerator<Buffer> {
    let left = length;
    while (left > 0) {
      await this.fill(1);
      if (this.buffer.length === 0) throw new ArchiveError("Truncated tar");
      const take = Math.min(left, this.buffer.length, 1 << 20);
      yield this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      left -= take;
    }
  }
}

export interface ExtractedFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Streams a .tgz and writes only the requested regular files. `wanted` maps an
 * archive path (for example `package/vendor/.../codex.exe`) to a destination.
 */
export async function extractTarGzFiles(
  archivePath: string,
  wanted: ReadonlyMap<string, string>,
): Promise<Map<string, ExtractedFile>> {
  const found = new Map<string, ExtractedFile>();
  const reader = new ByteReader(
    createReadStream(archivePath).pipe(createGunzip()),
  );
  let longName: string | undefined;
  let paxName: string | undefined;
  for (;;) {
    const header = await reader.read(512);
    if (header === null) break;
    if (header.every((byte) => byte === 0)) continue;
    const prefix = header.toString("ascii", 345, 500).replace(/\0.*$/su, "");
    const baseName = header.toString("utf8", 0, 100).replace(/\0.*$/su, "");
    const entry: TarHeader = {
      name:
        prefix && header.toString("ascii", 257, 262) === "ustar"
          ? `${prefix}/${baseName}`
          : baseName,
      size: octal(header, 124, 12),
      type: String.fromCharCode(header[156] || 0x30),
    };
    const padded = Math.ceil(entry.size / 512) * 512;
    if (entry.type === "x" || entry.type === "g" || entry.type === "L") {
      const data = Buffer.concat(await collect(reader.pieces(entry.size)));
      await skip(reader, padded - entry.size);
      if (entry.type === "x") paxName = paxValue(data, "path");
      else if (entry.type === "L")
        longName = data.toString("utf8").replace(/\0.*$/su, "");
      continue;
    }
    const name = paxName ?? longName ?? entry.name;
    paxName = undefined;
    longName = undefined;
    if (!isSafeArchivePath(name)) throw new ArchiveError("Unsafe tar entry");
    const destination = wanted.get(name);
    if (destination === undefined) {
      await skip(reader, padded);
      continue;
    }
    if (entry.type !== "0" && entry.type !== "\0")
      throw new ArchiveError(`Not a regular file in the archive: ${name}`);
    await mkdir(dirname(destination), { recursive: true });
    const out = createWriteStream(destination, { mode: 0o644 });
    const hash = createHash("sha256");
    for await (const piece of reader.pieces(entry.size)) {
      hash.update(piece);
      if (!out.write(piece)) await once(out, "drain");
    }
    out.end();
    await once(out, "close");
    await skip(reader, padded - entry.size);
    found.set(name, {
      path: destination,
      size: entry.size,
      sha256: hash.digest("hex"),
    });
  }
  for (const name of wanted.keys())
    if (!found.has(name))
      throw new ArchiveError(`Missing from the tarball: ${name}`);
  return found;
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const piece of source) out.push(Buffer.from(piece));
  return out;
}

async function skip(reader: ByteReader, length: number): Promise<void> {
  for await (const piece of reader.pieces(length)) void piece;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function joinInside(directory: string, ...parts: string[]): string {
  const target = join(directory, ...parts);
  if (!insideDirectory(directory, target))
    throw new ArchiveError("Path escapes its directory");
  return target;
}
