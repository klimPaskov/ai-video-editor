import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { mediaIdPattern } from "../../domain/src/library.ts";
import {
  assertInitialProjectSnapshot,
  assertTwoSourceInitialProjectSnapshot,
  createInitialProject,
  createTwoSourceInitialProject,
  projectCanonicalJson,
  projectStages,
} from "../../domain/src/project.ts";
import type {
  InitialProjectSnapshot,
  ProjectStage,
  TwoSourceInitialProjectSnapshot,
  TwoSourceTimingEvidence,
} from "../../domain/src/project.ts";
import type {
  MediaLibrary,
  VerifiedPresentationTiming,
} from "../../media-engine/src/library.ts";
import { sameProjectStorePath, serializeProjectStore } from "./serialize.ts";

const jsonLimit = 8 * 1024 * 1024;
type ProjectBaseline = InitialProjectSnapshot | TwoSourceInitialProjectSnapshot;
function timingEvidence(
  timing: VerifiedPresentationTiming,
): TwoSourceTimingEvidence {
  return {
    timeBaseNumerator: timing.timeBaseNumerator,
    timeBaseDenominator: timing.timeBaseDenominator,
    firstPts: timing.firstPts,
    lastPts: timing.lastPts,
    lastDurationTicks: timing.lastDurationTicks,
    frameCount: timing.frameCount,
    presentationEndUs: timing.presentationEndUs,
  };
}
function assertBaseline(value: unknown): asserts value is ProjectBaseline {
  if (
    value &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === "1.1"
  )
    assertTwoSourceInitialProjectSnapshot(value);
  else assertInitialProjectSnapshot(value);
}
function invalid(): never {
  throw new Error(
    "The project could not be opened or saved. Check its local files and try again.",
  );
}
const transientWindowsRenameCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
const windowsRenameRetryDelaysMs = [25, 50, 100, 200, 400] as const;

/** Retry short Windows file-scanner/handle locks without weakening atomic publish. */
export async function renameProjectDirectoryWithRetry(
  operation: typeof rename,
  source: string,
  destination: string,
  platform = process.platform,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation(source, destination);
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      const delayMs = windowsRenameRetryDelaysMs[attempt];
      if (
        platform !== "win32" ||
        typeof code !== "string" ||
        !transientWindowsRenameCodes.has(code) ||
        delayMs === undefined
      )
        throw error;
      await wait(delayMs);
    }
  }
}
async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameProjectStorePath(await realpath(path), path)
  )
    invalid();
}
async function json(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > jsonLimit
  )
    invalid();
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.size > jsonLimit)
      invalid();
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
async function writeNew(path: string, value: unknown): Promise<void> {
  const content = projectCanonicalJson(value);
  if (Buffer.byteLength(content) > jsonLimit) invalid();
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${content}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Initial project baseline and stage persistence; later edits use the shared transaction engine. */
export class ProjectStore {
  private readonly root: string;
  private readonly library: MediaLibrary;
  private readonly verifiedTimings = new Map<string, TwoSourceTimingEvidence>();
  constructor(rootAbsolute: string, library: MediaLibrary) {
    if (!isAbsolute(rootAbsolute)) invalid();
    this.root = resolve(rootAbsolute);
    this.library = library;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    return serializeProjectStore(this.root, work);
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await safeDirectory(this.root);
  }
  private folder(id: string): string {
    if (!mediaIdPattern.test(id)) invalid();
    return join(this.root, id);
  }
  private async read(id: string): Promise<ProjectBaseline> {
    const folder = this.folder(id);
    await safeDirectory(folder);
    const baseline = await json(join(folder, "baseline.json"));
    assertBaseline(baseline);
    if (
      baseline.project.project_id !== id ||
      !sameProjectStorePath(baseline.project.storage.project_root, folder) ||
      baseline.project.workflow_step !== "record_import" ||
      baseline.project.updated_at !== baseline.project.created_at
    )
      invalid();
    const project = await json(join(folder, "project.json"));
    const combined: unknown = { ...baseline, project };
    assertBaseline(combined);
    const expected = {
      ...baseline.project,
      workflow_step: combined.project.workflow_step,
      updated_at: combined.project.updated_at,
    };
    if (
      projectCanonicalJson(expected) !== projectCanonicalJson(combined.project)
    )
      invalid();
    const sources =
      baseline.schema_version === "1.1" ? baseline.sources : [baseline.source];
    const probes =
      baseline.schema_version === "1.1"
        ? baseline.source_probes
        : [baseline.source_probe];
    for (let index = 0; index < sources.length; index++) {
      const expectedSource = sources[index]!;
      const source = await this.library.verifiedSource(
        expectedSource.source_id,
      );
      if (
        source.managedPath !== expectedSource.managed_path ||
        source.originalPath !== expectedSource.original_path ||
        source.sha256 !== expectedSource.sha256 ||
        source.sizeBytes !== expectedSource.size_bytes ||
        projectCanonicalJson(source.probe) !==
          projectCanonicalJson(probes[index])
      )
        invalid();
      if (baseline.schema_version === "1.1") {
        const timingKey = `${expectedSource.source_id}:${source.sha256}`;
        let measured = this.verifiedTimings.get(timingKey);
        if (!measured) {
          measured = timingEvidence(
            await this.library.verifiedPresentationTiming(
              expectedSource.source_id,
            ),
          );
          this.verifiedTimings.set(timingKey, measured);
        }
        if (
          projectCanonicalJson(measured) !==
          projectCanonicalJson(baseline.source_timings[index])
        )
          invalid();
      }
    }
    return combined;
  }
  private async publish(snapshot: ProjectBaseline): Promise<void> {
    const projectId = snapshot.project.project_id,
      folder = this.folder(projectId),
      staged = join(this.root, `.creating-${projectId}`);
    await mkdir(staged, { mode: 0o700 });
    await writeNew(join(staged, "baseline.json"), snapshot);
    await writeNew(join(staged, "project.json"), snapshot.project);
    await safeDirectory(this.root);
    await safeDirectory(staged);
    try {
      await lstat(folder);
      invalid();
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    await renameProjectDirectoryWithRetry(rename, staged, folder);
  }
  createFromMedia(mediaId: string): Promise<InitialProjectSnapshot> {
    return this.serialize(async () => {
      await this.initialize();
      const source = await this.library.verifiedSource(mediaId);
      const projectId = randomUUID(),
        timelineId = randomUUID(),
        revisionId = randomUUID();
      const folder = this.folder(projectId);
      const snapshot = createInitialProject({
        projectId,
        timelineId,
        revisionId,
        sourceId: mediaId,
        name: source.summary.name.slice(0, 160),
        createdAt: new Date().toISOString(),
        projectRoot: folder,
        originalPath: source.originalPath,
        managedPath: source.managedPath,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
        probe: source.probe,
      });
      assertInitialProjectSnapshot(snapshot);
      await this.publish(snapshot);
      return snapshot;
    });
  }
  createFromTwoMedia(
    firstMediaId: string,
    secondMediaId: string,
  ): Promise<TwoSourceInitialProjectSnapshot> {
    return this.serialize(async () => {
      await this.initialize();
      if (firstMediaId === secondMediaId) invalid();
      const first = await this.library.verifiedSource(firstMediaId),
        second = await this.library.verifiedSource(secondMediaId);
      const firstTiming =
          await this.library.verifiedPresentationTiming(firstMediaId),
        secondTiming =
          await this.library.verifiedPresentationTiming(secondMediaId);
      const projectId = randomUUID(),
        folder = this.folder(projectId);
      const snapshot = createTwoSourceInitialProject({
        projectId,
        timelineId: randomUUID(),
        revisionId: randomUUID(),
        name: first.summary.name.slice(0, 160),
        createdAt: new Date().toISOString(),
        projectRoot: folder,
        sources: [
          {
            sourceId: firstMediaId,
            originalPath: first.originalPath,
            managedPath: first.managedPath,
            sha256: first.sha256,
            sizeBytes: first.sizeBytes,
            probe: first.probe,
            timing: timingEvidence(firstTiming),
          },
          {
            sourceId: secondMediaId,
            originalPath: second.originalPath,
            managedPath: second.managedPath,
            sha256: second.sha256,
            sizeBytes: second.sizeBytes,
            probe: second.probe,
            timing: timingEvidence(secondTiming),
          },
        ],
      });
      assertTwoSourceInitialProjectSnapshot(snapshot);
      await this.publish(snapshot);
      return snapshot;
    });
  }
  list(): Promise<ProjectBaseline[]> {
    return this.serialize(async () => {
      await this.initialize();
      const entries = await readdir(this.root);
      if (entries.length > 1000) invalid();
      const result: ProjectBaseline[] = [];
      for (const entry of entries.sort()) {
        // Interrupted, unpublished directories remain private for explicit later recovery/cleanup.
        if (
          entry.startsWith(".creating-") &&
          mediaIdPattern.test(entry.slice(10))
        ) {
          await safeDirectory(join(this.root, entry));
          continue;
        }
        result.push(await this.read(entry));
      }
      return result;
    });
  }
  open(projectId: string): Promise<ProjectBaseline> {
    return this.serialize(async () => {
      await this.initialize();
      return this.read(projectId);
    });
  }
  /** Internal verified read for DraftTransactionStore while it owns the shared root queue. */
  async readForDraftTransaction(projectId: string): Promise<ProjectBaseline> {
    await this.initialize();
    return this.read(projectId);
  }
  navigate(projectId: string, stage: ProjectStage): Promise<ProjectBaseline> {
    return this.serialize(async () => {
      if (!projectStages.includes(stage)) invalid();
      await this.initialize();
      const snapshot = await this.read(projectId);
      snapshot.project.workflow_step = stage;
      snapshot.project.updated_at = new Date(
        Math.max(Date.now(), Date.parse(snapshot.project.updated_at)),
      ).toISOString();
      assertBaseline(snapshot);
      const folder = this.folder(projectId),
        staged = join(folder, `.project-${randomUUID()}.tmp`);
      let unpublished = true;
      try {
        await writeNew(staged, snapshot.project);
        await safeDirectory(this.root);
        await safeDirectory(folder);
        // Revalidate committed state before replacing only navigation metadata.
        await this.read(projectId);
        await rename(staged, join(folder, "project.json"));
        unpublished = false;
        return snapshot;
      } finally {
        if (unpublished) await unlink(staged).catch(() => undefined);
      }
    });
  }
}
