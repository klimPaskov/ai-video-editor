import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCaptionSettings,
  defaultCaptionSettings,
  type CaptionSettings,
} from "../../../packages/domain/src/captions.ts";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

/** Per-project caption choices in the app's data folder. */
export class CaptionSettingsStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private file(projectId: string): string {
    if (!idPattern.test(projectId)) throw new Error("Invalid project.");
    return join(this.root, `${projectId}.json`);
  }

  async get(projectId: string): Promise<CaptionSettings> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.file(projectId), "utf8"),
      );
      assertCaptionSettings(value);
      return value;
    } catch {
      return { ...defaultCaptionSettings };
    }
  }

  async set(
    projectId: string,
    settings: CaptionSettings,
  ): Promise<CaptionSettings> {
    assertCaptionSettings(settings);
    const file = this.file(projectId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staged = `${file}.${process.pid}.tmp`;
    await writeFile(staged, JSON.stringify(settings), { mode: 0o600 });
    await rename(staged, file);
    return { ...settings };
  }
}
