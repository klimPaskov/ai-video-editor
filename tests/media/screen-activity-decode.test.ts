import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeScreenActivity } from "../../packages/media-engine/src/screen-activity.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

test("a box that blinks in one corner of a real video is found there, and nothing else is", async () => {
  const folder = await mkdtemp(join(tmpdir(), "activity-"));
  try {
    const file = join(folder, "screen.mkv");
    // 8 s of grey; from 3 s to 5 s a box in the lower right flashes.
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x303030:s=640x360:r=10:d=8",
        "-vf",
        "drawbox=x=420:y=200:w=160:h=110:color=white:t=fill:enable='between(t,3,5)*lt(mod(t,0.4),0.2)'",
        "-c:v",
        "ffv1",
        file,
      ],
      timeoutMs: 60_000,
    });
    const targets = await analyzeScreenActivity({
      ffmpeg: "ffmpeg",
      path: file,
    });
    assert.equal(targets.length, 1);
    const [target] = targets;
    assert.ok(target!.startUs >= 2_600_000 && target!.startUs <= 3_600_000);
    assert.ok(target!.endUs >= 4_400_000 && target!.endUs <= 5_400_000);
    assert.ok(target!.x >= 0.55 && target!.x + target!.width <= 1);
    assert.ok(target!.y >= 0.5 && target!.y + target!.height <= 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
