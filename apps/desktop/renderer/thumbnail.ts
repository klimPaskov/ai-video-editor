import { thumbnailLimits } from "../../../packages/domain/src/publish.ts";

/**
 * The thumbnail of a finished video: a frame of the footage, filling the
 * 1280 by 720 picture, with the title large at the bottom over a soft shade.
 * It uses only the person's footage; nothing is generated.
 */
export function composeThumbnail(
  picture: HTMLCanvasElement,
  title: string,
): HTMLCanvasElement {
  const { width, height } = thumbnailLimits;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A picture cannot be drawn here.");
  // Fill: scale the frame to cover, centred.
  const scale = Math.max(width / picture.width, height / picture.height);
  const drawWidth = picture.width * scale;
  const drawHeight = picture.height * scale;
  context.drawImage(
    picture,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  const shade = context.createLinearGradient(0, height * 0.35, 0, height);
  shade.addColorStop(0, "rgb(0 0 0 / 0%)");
  shade.addColorStop(1, "rgb(0 0 0 / 82%)");
  context.fillStyle = shade;
  context.fillRect(0, 0, width, height);
  // Title: up to three lines, as large as fits, bold with an outline.
  const words = title.trim().split(/\s+/u).filter(Boolean);
  const margin = 56;
  const maxWidth = width - margin * 2;
  let size = 104;
  let lines: string[] = [];
  for (; size >= 52; size -= 6) {
    context.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= 3) break;
  }
  lines = lines.slice(0, 3);
  context.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
  context.textBaseline = "alphabetic";
  context.lineJoin = "round";
  context.lineWidth = Math.max(6, size / 9);
  const lineHeight = size * 1.08;
  const top = height - margin - lineHeight * (lines.length - 1);
  lines.forEach((line, index) => {
    const y = top + lineHeight * index;
    context.strokeStyle = "rgb(0 0 0 / 85%)";
    context.strokeText(line, margin, y);
    context.fillStyle = "#fff";
    context.fillText(line, margin, y);
  });
  return canvas;
}

/** The picture as base64 JPEG, lowering the quality until it fits 2 MB. */
export async function jpegBase64(canvas: HTMLCanvasElement): Promise<string> {
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= thumbnailLimits.bytes - 4096) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return btoa(binary);
    }
  }
  throw new Error("The thumbnail is too large to save.");
}
