// Renders the Urushi icon SVGs into the PNG sizes and the Windows .ico the app,
// installer and packager use. Run: node scripts/brand/make_icons.mjs
// (needs `sharp`, which is not an app dependency: install it for this step).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dirname, "..", "..");
const brand = join(root, "docs", "brand", "urushi");
const out = join(root, "apps", "desktop", "assets");
await mkdir(out, { recursive: true });

const full = await readFile(join(brand, "urushi-icon.svg"));
const small = await readFile(join(brand, "urushi-icon-small.svg"));
const png = (svg, size) =>
  sharp(svg, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

// The simplified drawing below 64 px, where bristle gaps would blur away.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = [];
for (const size of sizes)
  frames.push({ size, data: await png(size < 64 ? small : full, size) });

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
const directory = Buffer.alloc(16 * frames.length);
let offset = 6 + directory.length;
frames.forEach(({ size, data }, index) => {
  const at = index * 16;
  directory.writeUInt8(size === 256 ? 0 : size, at);
  directory.writeUInt8(size === 256 ? 0 : size, at + 1);
  directory.writeUInt8(0, at + 2);
  directory.writeUInt8(0, at + 3);
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
await writeFile(
  join(out, "icon.ico"),
  Buffer.concat([header, directory, ...frames.map((frame) => frame.data)]),
);
await writeFile(join(out, "icon-256.png"), frames[frames.length - 1].data);
await writeFile(join(out, "icon-512.png"), await png(full, 512));
await writeFile(join(out, "icon-1024.png"), await png(full, 1024));
console.log("icons written to", out);
