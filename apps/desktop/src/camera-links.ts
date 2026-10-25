import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mediaIdPattern } from "../../../packages/domain/src/library.ts";

/**
 * Which camera recording goes with which screen recording of a project. The
 * camera is a recording in the media library (hash-checked like every other
 * source), linked from here; the link is the app's own note and the
 * recordings are never changed. `offsetUs` is the camera's time minus the
 * screen recording's time at the same moment.
 */
export interface CameraLink {
  sourceId: string;
  mediaId: string;
  offsetUs: number;
}

export const cameraOffsetLimitUs = 600_000_000;

export function assertCameraLink(value: unknown): asserts value is CameraLink {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid camera link.");
  const link = value as Record<string, unknown>;
  const keys = Object.keys(link);
  if (
    keys.length !== 3 ||
    !["sourceId", "mediaId", "offsetUs"].every((key) => keys.includes(key)) ||
    typeof link.sourceId !== "string" ||
    !mediaIdPattern.test(link.sourceId) ||
    typeof link.mediaId !== "string" ||
    !mediaIdPattern.test(link.mediaId) ||
    !Number.isSafeInteger(link.offsetUs) ||
    Math.abs(link.offsetUs as number) > cameraOffsetLimitUs
  )
    throw new Error("Invalid camera link.");
}

/** The links of every project, one small file each. */
export class CameraLinks {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private file(projectId: string): string {
    if (!mediaIdPattern.test(projectId)) throw new Error("Invalid project.");
    return path.join(this.root, `${projectId}.json`);
  }

  async get(projectId: string): Promise<CameraLink[]> {
    try {
      const value = JSON.parse(await readFile(this.file(projectId), "utf8"));
      if (!Array.isArray(value) || value.length > 16) return [];
      for (const link of value) assertCameraLink(link);
      return value as CameraLink[];
    } catch {
      return [];
    }
  }

  async forSource(
    projectId: string,
    sourceId: string,
  ): Promise<CameraLink | null> {
    return (
      (await this.get(projectId)).find((link) => link.sourceId === sourceId) ??
      null
    );
  }

  /** Links a camera to a screen recording, replacing its earlier link. */
  async set(projectId: string, link: CameraLink): Promise<void> {
    assertCameraLink(link);
    const links = (await this.get(projectId)).filter(
      (item) => item.sourceId !== link.sourceId,
    );
    links.push(link);
    await this.write(projectId, links);
  }

  async remove(projectId: string, sourceId: string): Promise<boolean> {
    const links = await this.get(projectId);
    const rest = links.filter((link) => link.sourceId !== sourceId);
    if (rest.length === links.length) return false;
    if (rest.length) await this.write(projectId, rest);
    else await rm(this.file(projectId), { force: true });
    return true;
  }

  private async write(projectId: string, links: CameraLink[]): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.file(projectId);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(links, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
  }
}
