import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findFFmpeg } from "../browser/ffmpeg.js";
import { probeVideo } from "../measure/media.js";
import { prepare } from "./analyze.js";

const ffmpeg = findFFmpeg();
const dir = mkdtempSync(join(tmpdir(), "hf-analyze-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("analyze", () => {
  it.skipIf(!ffmpeg)("sends the whole part when it slows it down", async () => {
    const src = join(dir, "src.mp4");
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=d=4:s=320x240:r=30",
      src,
    ]);
    const info = await probeVideo(src);
    const out = join(dir, "part.mp4");
    writeFileSync(out, prepare(info, [1, 3], 3, dir));
    expect((await probeVideo(out)).duration).toBeCloseTo(6, 0);
  });
});
