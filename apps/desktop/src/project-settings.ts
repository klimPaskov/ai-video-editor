import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

/** Small per-project choices kept as JSON in the app's data folder. */
export class ProjectSettingsStore<T extends object> {
  private readonly root: string;
  private readonly validate: (value: unknown) => asserts value is T;
  private readonly defaults: T;

  constructor(
    root: string,
    validate: (value: unknown) => asserts value is T,
    defaults: T,
  ) {
    this.root = root;
    this.validate = validate;
    this.defaults = defaults;
  }

  private file(projectId: string): string {
    if (!idPattern.test(projectId)) throw new Error("Invalid project.");
    return join(this.root, `${projectId}.json`);
  }

  async get(projectId: string): Promise<T> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.file(projectId), "utf8"),
      );
      this.validate(value);
      return value;
    } catch {
      return { ...this.defaults };
    }
  }

  async set(projectId: string, value: T): Promise<T> {
    this.validate(value);
    const file = this.file(projectId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staged = `${file}.${process.pid}.tmp`;
    await writeFile(staged, JSON.stringify(value), { mode: 0o600 });
    await rename(staged, file);
    return { ...value };
  }
}
