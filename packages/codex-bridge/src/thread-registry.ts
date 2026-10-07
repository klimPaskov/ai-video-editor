import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildThreadResumeRequest,
  decodeThreadSession,
  type ThreadFeaturePolicy,
  type ThreadResumeRequest,
  type ThreadRuntimePolicy,
} from "./thread-protocol.ts";

const REGISTRY_FILE = "project-threads.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const queues = new Map<string, Promise<void>>();

function canonicalPath(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export class ProjectThreadRegistryError extends Error {
  readonly code:
    "configuration" | "corrupt" | "missing" | "conflict" | "storage";

  constructor(
    code: "configuration" | "corrupt" | "missing" | "conflict" | "storage",
  ) {
    const messages = {
      configuration: "The Codex project-thread registry is misconfigured.",
      corrupt: "The Codex project-thread registry is damaged.",
      missing: "This project does not have a Codex thread yet.",
      conflict: "This project is already bound to a different Codex thread.",
      storage: "The Codex project-thread registry could not be saved.",
    } as const;
    super(messages[code]);
    this.name = "ProjectThreadRegistryError";
    this.code = code;
  }
}

export type ProjectThreadToolRoute = "mcp" | "dynamic";

export interface ProjectThreadBinding {
  projectId: string;
  threadId: string;
  toolRoute: ProjectThreadToolRoute;
}

interface RegistryState {
  schemaVersion: 2;
  entries: ProjectThreadBinding[];
}

function validProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(value)
  );
}

function validThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function decodeRegistry(value: unknown): RegistryState {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) {
    throw new ProjectThreadRegistryError("corrupt");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    !Array.isArray(record.entries)
  ) {
    throw new ProjectThreadRegistryError("corrupt");
  }
  const projects = new Set<string>();
  const threads = new Set<string>();
  const entries: RegistryState["entries"] = [];
  for (const entry of record.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== (record.schemaVersion === 1 ? 2 : 3)
    ) {
      throw new ProjectThreadRegistryError("corrupt");
    }
    const item = entry as Record<string, unknown>;
    if (
      !validProjectId(item.projectId) ||
      !validThreadId(item.threadId) ||
      (record.schemaVersion === 2 &&
        item.toolRoute !== "mcp" &&
        item.toolRoute !== "dynamic") ||
      (record.schemaVersion === 1 && Object.hasOwn(item, "toolRoute")) ||
      projects.has(item.projectId) ||
      threads.has(item.threadId)
    ) {
      throw new ProjectThreadRegistryError("corrupt");
    }
    projects.add(item.projectId);
    threads.add(item.threadId);
    entries.push({
      projectId: item.projectId,
      threadId: item.threadId,
      toolRoute:
        record.schemaVersion === 1
          ? "mcp"
          : (item.toolRoute as ProjectThreadToolRoute),
    });
  }
  entries.sort((a, b) => a.projectId.localeCompare(b.projectId, "en"));
  return { schemaVersion: 2, entries };
}

async function serialize<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = canonicalPath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => {}).then(() => current);
  queues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

/** Main-process registry. Renderer-facing code supplies a project ID, never a thread ID. */
export class ProjectThreadRegistry {
  private readonly root: string;
  private readonly path: string;

  private constructor(root: string, path: string) {
    this.root = root;
    this.path = path;
  }

  static async open(root: string): Promise<ProjectThreadRegistry> {
    if (!isAbsolute(root) || root.includes("\0") || root.length > 4096) {
      throw new ProjectThreadRegistryError("configuration");
    }
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const canonical = await realpath(root);
      if (canonicalPath(canonical) !== canonicalPath(root)) throw new Error();
      return new ProjectThreadRegistry(
        canonical,
        join(canonical, REGISTRY_FILE),
      );
    } catch {
      throw new ProjectThreadRegistryError("configuration");
    }
  }

  async bindingForProject(
    projectId: string,
  ): Promise<ProjectThreadBinding | null> {
    this.assertProjectId(projectId);
    return serialize(this.root, async () => {
      const state = await this.read();
      const binding = state.entries.find(
        (entry) => entry.projectId === projectId,
      );
      return binding ? { ...binding } : null;
    });
  }

  async threadForProject(projectId: string): Promise<string | null> {
    return (await this.bindingForProject(projectId))?.threadId ?? null;
  }

  async bindFromThreadResponse(
    projectId: string,
    response: unknown,
    expectedPolicy: ThreadRuntimePolicy,
    toolRoute: ProjectThreadToolRoute = "mcp",
  ): Promise<string> {
    this.assertProjectId(projectId);
    if (toolRoute !== "mcp" && toolRoute !== "dynamic") {
      throw new ProjectThreadRegistryError("configuration");
    }
    const { threadId } = decodeThreadSession(response, expectedPolicy);
    return serialize(this.root, async () => {
      const state = await this.read();
      const existing = state.entries.find(
        (entry) => entry.projectId === projectId,
      );
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.toolRoute !== toolRoute
        ) {
          throw new ProjectThreadRegistryError("conflict");
        }
        return existing.threadId;
      }
      if (state.entries.some((entry) => entry.threadId === threadId)) {
        throw new ProjectThreadRegistryError("conflict");
      }
      state.entries.push({ projectId, threadId, toolRoute });
      state.entries.sort((a, b) =>
        a.projectId.localeCompare(b.projectId, "en"),
      );
      await this.write(state);
      return threadId;
    });
  }

  async resumeRequestForProject(
    projectId: string,
    policy: ThreadRuntimePolicy,
    featurePolicy?: ThreadFeaturePolicy,
  ): Promise<ThreadResumeRequest> {
    const threadId = await this.threadForProject(projectId);
    if (!threadId) throw new ProjectThreadRegistryError("missing");
    return buildThreadResumeRequest(threadId, policy, featurePolicy);
  }

  private assertProjectId(projectId: string): void {
    if (!validProjectId(projectId)) {
      throw new ProjectThreadRegistryError("configuration");
    }
  }

  private async read(): Promise<RegistryState> {
    try {
      const info = await lstat(this.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size === 0 ||
        info.size > MAX_REGISTRY_BYTES
      ) {
        throw new ProjectThreadRegistryError("corrupt");
      }
      return decodeRegistry(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schemaVersion: 2, entries: [] };
      }
      if (error instanceof ProjectThreadRegistryError) throw error;
      throw new ProjectThreadRegistryError("corrupt");
    }
  }

  private async write(state: RegistryState): Promise<void> {
    const pending = join(
      this.root,
      `.${REGISTRY_FILE}.${randomUUID()}.pending`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(pending, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(pending, this.path);
    } catch {
      await handle?.close().catch(() => {});
      await unlink(pending).catch(() => {});
      throw new ProjectThreadRegistryError("storage");
    }
  }
}

export const projectThreadRegistryInternals = { decodeRegistry };
