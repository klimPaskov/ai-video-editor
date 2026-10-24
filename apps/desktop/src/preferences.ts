import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertPreferences } from "../../../packages/domain/src/preferences.ts";
import type { Preferences } from "../../../packages/domain/src/preferences.ts";

const pending = new Map<string, Promise<unknown>>();
const loadError =
  "Interface settings could not be loaded. Check local storage access and restart the application.";
const saveError =
  "Interface settings could not be saved. Check local storage access and try again.";
function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Main-owned userData directory only. Preferences never contain media or paths. */
export class PreferencesStore {
  private readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root))
      throw new Error("Settings storage must use an absolute directory.");
    this.root = resolve(root);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = (pending.get(this.root) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    pending.set(this.root, result);
    void result
      .finally(() => {
        if (pending.get(this.root) === result) pending.delete(this.root);
      })
      .catch(() => undefined);
    return result;
  }
  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const stat = await lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      resolve(await realpath(this.root)) !== this.root
    )
      throw new Error(loadError);
  }
  private async current(): Promise<Preferences> {
    await this.directory();
    const path = join(this.root, "preferences.json");
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 1024 ||
        stat.nlink !== 1
      )
        throw new Error(loadError);
    } catch (error) {
      if (missing(error)) return { interfaceScale: 1 };
      throw error;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 || stat.nlink !== 1)
        throw new Error(loadError);
      const value: unknown = JSON.parse(
        await handle.readFile({ encoding: "utf8" }),
      );
      assertPreferences(value);
      return {
        interfaceScale: value.interfaceScale,
        ...(value.assetPolicy ? { assetPolicy: value.assetPolicy } : {}),
        ...(value.theme ? { theme: structuredClone(value.theme) } : {}),
      };
    } finally {
      await handle.close();
    }
  }
  read(): Promise<Preferences> {
    return this.serialize(async () => {
      try {
        return await this.current();
      } catch {
        throw new Error(loadError);
      }
    });
  }
  write(value: unknown): Promise<Preferences> {
    // Snapshot caller data before awaiting; renderer mutation cannot change a queued write.
    assertPreferences(value);
    const snapshot: Preferences = {
      interfaceScale: value.interfaceScale,
      ...(value.assetPolicy ? { assetPolicy: value.assetPolicy } : {}),
      ...(value.theme ? { theme: structuredClone(value.theme) } : {}),
    };
    return this.serialize(async () => {
      let staged: string | undefined;
      try {
        // A damaged settings file must not be silently replaced.
        await this.current();
        staged = join(this.root, `.preferences-${randomUUID()}.tmp`);
        const handle = await open(staged, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.current();
        await rename(staged, join(this.root, "preferences.json"));
        staged = undefined;
        return { ...snapshot };
      } catch {
        throw new Error(saveError);
      } finally {
        // Only our uncommitted random temporary settings file, never source media.
        if (staged) await unlink(staged).catch(() => undefined);
      }
    });
  }
}
