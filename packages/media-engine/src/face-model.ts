import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { MediaError } from "./process.ts";

/**
 * The face model used to frame vertical clips: YuNet from the OpenCV Zoo
 * (MIT, Copyright (c) 2020 Shiqi Yu). It is fetched on first use, verified
 * against this pin and never bundled unreviewed. The Rust engine checks the
 * same size and hash again before it loads the file (`engine-clips`).
 *
 * The bytes are served from a pinned commit of a public repository that
 * carries the file unchanged; any other source works as long as it matches
 * the hash.
 */
export const faceModel = Object.freeze({
  id: "opencv/opencv_zoo face_detection_yunet 2023mar",
  file: "face_detection_yunet_2023mar.onnx",
  license: "MIT",
  size: 232_589,
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  url: "https://raw.githubusercontent.com/bridge-mind/bridgeclip/b996820ef80fa324a3ad233bef1aac5cc6936804/engine/assets/models/face_detection_yunet_2023mar.onnx",
});

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export interface FaceModelSource {
  url: string;
  size: number;
  sha256: string;
  /** Only the pinned host may serve the file unless a test says otherwise. */
  allowHost?: (host: string) => boolean;
}

const pinned: FaceModelSource = {
  url: faceModel.url,
  size: faceModel.size,
  sha256: faceModel.sha256,
  allowHost: (host) => host === "raw.githubusercontent.com",
};

/**
 * Makes sure the model is in `cacheRoot` and returns its path. An existing
 * file is re-hashed; a download is checked before it is renamed into place.
 */
export async function ensureFaceModel(
  cacheRoot: string,
  signal?: AbortSignal,
  source: FaceModelSource = pinned,
): Promise<string> {
  if (!isAbsolute(cacheRoot))
    throw new MediaError("INVALID_INPUT", "The model folder must be absolute.");
  const directory = resolve(cacheRoot, "yunet", source.sha256.slice(0, 16));
  const path = join(directory, faceModel.file);
  const existing = await lstat(path).catch(() => null);
  if (
    existing?.isFile() &&
    !existing.isSymbolicLink() &&
    existing.size === source.size &&
    (await sha256(path)) === source.sha256
  )
    return path;
  if (existing) await rm(path, { force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const failed = () =>
    new MediaError(
      signal?.aborted ? "CANCELLED" : "PROCESS_FAILED",
      "The face model could not be downloaded.",
    );
  const response = await fetch(source.url, {
    ...(signal ? { signal } : {}),
    redirect: "follow",
  }).catch(() => {
    throw failed();
  });
  const finalUrl = new URL(response.url || source.url);
  if (
    !response.ok ||
    (source === pinned && finalUrl.protocol !== "https:") ||
    (source.allowHost && !source.allowHost(finalUrl.hostname))
  )
    throw failed();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== source.size ||
    createHash("sha256").update(bytes).digest("hex") !== source.sha256
  )
    throw new MediaError(
      "FIDELITY_MISMATCH",
      "The face model failed its integrity check.",
    );
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return path;
}
