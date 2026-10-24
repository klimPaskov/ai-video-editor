import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertSoundAsset,
  soundLimits,
  type SoundAsset,
} from "../../domain/src/sounds.ts";

/**
 * The audio files of a project (music and sound effects for sound layers).
 * A file is copied into the project's own folder, hashed and never changed;
 * a layer names it by id and hash. The copy is what gets probed, so the
 * file the user chose cannot change between checking and use.
 */

export type SoundAssetErrorCode =
  "invalid" | "not_audio" | "too_large" | "limit" | "missing" | "changed";

export class SoundAssetError extends Error {
  readonly code: SoundAssetErrorCode;
  constructor(code: SoundAssetErrorCode, message: string) {
    super(message);
    this.name = "SoundAssetError";
    this.code = code;
  }
}

/** What an audio probe reports about a file; it throws for non-audio. */
export interface SoundProbe {
  (
    path: string,
    signal?: AbortSignal,
  ): Promise<{
    durationUs: number;
    sampleRate: number;
    channels: number;
  }>;
}

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const assetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function fail(code: SoundAssetErrorCode, message: string): never {
  throw new SoundAssetError(code, message);
}

/** A display name from a file name: no folders, no controls, bounded. */
export function soundNameFrom(path: string): string {
  const base = basename(path.replaceAll("\\", "/"));
  const name = base
    .slice(0, base.length - extname(base).length || base.length)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return [...(name || "Audio")].slice(0, soundLimits.maxNameChars).join("");
}

export class SoundAssetStore {
  private readonly root: string;
  private readonly probe: SoundProbe;
  private readonly queues = new Map<string, Promise<unknown>>();

  /** `root` is the project store folder; assets live in `<root>/<project>/sounds`. */
  constructor(root: string, probe: SoundProbe) {
    this.root = root;
    this.probe = probe;
  }

  private folder(projectId: string): string {
    if (!projectIdPattern.test(projectId)) fail("invalid", "Invalid project.");
    return join(this.root, projectId, "sounds");
  }

  /** Runs work for one project one at a time, in order. */
  private serial<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(projectId, next);
    return next;
  }

  async list(projectId: string): Promise<SoundAsset[]> {
    const folder = this.folder(projectId);
    let raw: string;
    try {
      raw = await readFile(join(folder, "index.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > soundLimits.maxAssets)
      fail("invalid", "The project's audio list is damaged.");
    const ids = new Set<string>();
    for (const asset of parsed) {
      assertSoundAsset(asset);
      if (ids.has(asset.asset_id))
        fail("invalid", "The project's audio list is damaged.");
      ids.add(asset.asset_id);
    }
    return parsed as SoundAsset[];
  }

  /**
   * Adds an audio file to the project (or returns the asset already holding
   * the same bytes). The original file is only read.
   */
  import(
    projectId: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<SoundAsset> {
    const folder = this.folder(projectId);
    return this.serial(projectId, async () => {
      const info = await lstat(sourcePath).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink())
        fail("invalid", "Choose an audio file.");
      if (info.size < 1 || info.size > soundLimits.maxFileBytes)
        fail("too_large", "Audio files can be up to 512 MB.");
      const existing = await this.list(projectId);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = join(folder, `.import-${randomUUID()}.tmp`);
      const hash = createHash("sha256");
      let size = 0;
      try {
        await pipeline(
          createReadStream(sourcePath),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              hash.update(chunk);
              size += chunk.length;
              if (size > soundLimits.maxFileBytes)
                done(new SoundAssetError("too_large", "Too large."));
              else done(null, chunk);
            },
          }),
          createWriteStream(temporary, { mode: 0o600 }),
          ...(signal ? [{ signal }] : []),
        );
        const sha256 = hash.digest("hex");
        const duplicate = existing.find((asset) => asset.sha256 === sha256);
        if (duplicate) {
          await rm(temporary, { force: true });
          return duplicate;
        }
        if (existing.length >= soundLimits.maxAssets)
          fail("limit", "A project can hold up to 256 audio files.");
        let probed: Awaited<ReturnType<SoundProbe>>;
        try {
          probed = await this.probe(temporary, signal);
        } catch {
          fail("not_audio", "That file has no audio this app can read.");
        }
        const extension = extname(sourcePath).toLowerCase();
        const assetId = randomUUID();
        const asset: SoundAsset = {
          asset_id: assetId,
          name: soundNameFrom(sourcePath),
          sha256,
          duration_us: probed.durationUs,
          sample_rate: probed.sampleRate,
          channels: probed.channels,
          size_bytes: size,
        };
        assertSoundAsset(asset);
        const file = join(
          folder,
          `${assetId}${/^\.[a-z0-9]{1,5}$/u.test(extension) ? extension : ""}`,
        );
        await rename(temporary, file);
        try {
          await this.writeIndex(folder, [...existing, asset]);
        } catch (error) {
          await rm(file, { force: true });
          throw error;
        }
        return asset;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  private async writeIndex(
    folder: string,
    assets: SoundAsset[],
  ): Promise<void> {
    const target = join(folder, "index.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(assets), { mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * The asset and the path of its file, after checking that the bytes are
   * the ones that were added (size and SHA-256).
   */
  async resolve(
    projectId: string,
    assetId: string,
    expectedSha256?: string,
  ): Promise<{ asset: SoundAsset; path: string }> {
    if (!assetIdPattern.test(assetId)) fail("invalid", "Invalid audio file.");
    const asset = (await this.list(projectId)).find(
      (item) => item.asset_id === assetId,
    );
    if (!asset) fail("missing", "That audio file is not in the project.");
    if (expectedSha256 !== undefined && asset.sha256 !== expectedSha256)
      fail(
        "changed",
        "That audio file is not the one this layer was made for.",
      );
    const folder = this.folder(projectId);
    // The extension was kept from the original name; find the file by id.
    const name = (await readdir(folder)).find(
      (entry) =>
        entry === assetId ||
        (entry.startsWith(`${assetId}.`) && !entry.endsWith(".tmp")),
    );
    if (!name) fail("missing", "That audio file is missing from the project.");
    const path = join(folder, name);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== asset.size_bytes
    )
      fail("changed", "That audio file was changed.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path))
      hash.update(chunk as Buffer);
    if (hash.digest("hex") !== asset.sha256)
      fail("changed", "That audio file was changed.");
    return { asset, path };
  }
}
