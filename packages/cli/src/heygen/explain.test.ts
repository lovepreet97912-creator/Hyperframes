import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { findFFmpeg, findFFprobe } from "../browser/ffmpeg.js";

vi.mock("../cloud/auth.js", () => ({
  resolveCloudAuthHeaders: async () => ({ "x-api-key": "k" }),
  resolveCloudBaseUrl: () => "https://api.test",
}));

const { attachDiagnoses, explainQuestion, explainTargets, layoutOf, piecesOf, targetsOf } =
  await import("./explain.js");
const { diffVideos } = await import("../measure/diff.js");
const { parseSegments } = await import("../measure/segments.js");
const { probeVideo } = await import("../measure/media.js");
const ffmpeg = findFFmpeg();
const noTools = !ffmpeg || !findFFprobe();
const dir = mkdtempSync(join(tmpdir(), "hf-explain-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("explain layout", () => {
  it("stacks a wide box, puts a tall one side by side, and keeps the picture near-square and large", () => {
    const wide = layoutOf([147, 590, 786, 150], 1080, 1920);
    expect(wide.layout).toBe("original above yours");
    expect(wide.crop).toEqual([140, 584, 798, 162]);
    expect(Math.max(...wide.size)).toBe(1200);
    expect(Math.max(...wide.size) / Math.min(...wide.size)).toBeLessThanOrEqual(1.26);
    // The element spans the picture's width.
    expect(wide.size[0]).toBe(1200);
    const tall = layoutOf([108, 174, 60, 118], 720, 1280);
    expect(tall.layout).toBe("original left of yours");
    expect(tall.filter).toContain("hstack");
    // A small box is scaled up, never down to a thumbnail.
    expect(Math.min(...tall.size)).toBeGreaterThan(600);
  });

  it("widens a short window a little and asks a long one at its two ends", () => {
    expect(piecesOf([2.64, 3.44], 36)).toEqual([[2.39, 3.69]]);
    expect(piecesOf([11.14, 19.69], 36)).toEqual([
      [10.89, 12.89],
      [17.94, 19.94],
    ]);
    expect(piecesOf([0, 1], 1)).toEqual([[0, 1]]);
  });
});

describe.skipIf(noTools)("diff --explain", () => {
  it("asks the fixed question about each failing drawn element at native size and files the answer under it", async () => {
    // Three white strokes over a plain blue picture; yours draws them 24 px to the right.
    const strokes = (x0: number) =>
      [0, 14, 28].map((x) => `drawbox=x=${x0 + x}:y=110:w=6:h=24:color=white:t=fill`).join(",");
    const make = (name: string, x0: number) => {
      const out = join(dir, name);
      execFileSync(ffmpeg!, [
        ...["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x2050a0:s=320x180:r=30:d=3"],
        ...["-vf", strokes(x0), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "0", out],
      ]);
      return out;
    };
    const [ref, yours] = [make("ref.mp4", 120), make("off.mp4", 144)];
    const md =
      "## S01 · 0–3 s · Label over a presenter\nPixels: regenerated\nRegenerated: 0, 0, 320, 180\nDrawn: 118, 108, 42, 28, 1.0–2.0 s\nDrawn: 10, 10, 40, 20, 0–1 s\n";
    const result = await diffVideos({
      reference: ref,
      yours,
      segments: parseSegments(md),
      outDir: join(dir, "diff"),
    });
    const targets = targetsOf(result);
    // The empty second box passes, so only the label is asked about.
    expect(targets).toEqual([{ id: "S01.D1", box: [118, 108, 42, 28], window: [1, 2] }]);
    expect(targetsOf(result, ["S01.D2"]).map((t) => t.id)).toEqual(["S01.D2"]);

    const sent: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      // The clip is slowed 6x, so 4.5 s in it is 0.75 s after the window starts.
      return reply({
        data: {
          id: "a1",
          status: "completed",
          usage: { input_tokens: 812, output_tokens: 90 },
          output: {
            json: {
              matches: false,
              differences: [
                { aspect: "position", original: "left", yours: "right", start: 4.5, end: 9 },
              ],
            },
          },
        },
      });
    });
    const found = await explainTargets(targets, {
      reference: probeVideo(ref),
      yours: probeVideo(yours),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.test/v3/video-analyses");
    const body = sent[0]!.body!;
    const prompt = String(body.prompt);
    expect(prompt.startsWith(explainQuestion("original above yours"))).toBe(true);
    // Neither the score nor the verdict reaches the model.
    expect(prompt).not.toMatch(/score|ssim|fail|pass|0\.\d/i);
    // The video is the two crops, upscaled near-square, slowed for 2 fps.
    const video = join(dir, "sent.mp4");
    const sentVideo = body.video;
    if (typeof sentVideo !== "object" || sentVideo === null || !("data" in sentVideo))
      throw new Error("no video sent");
    writeFileSync(video, Buffer.from(String(sentVideo.data), "base64"));
    const info = probeVideo(video);
    expect([info.width, info.height]).toEqual(layoutOf([118, 108, 42, 28], 320, 180).size);
    expect(info.duration).toBeGreaterThan(8);
    expect(info.audio).toBe(false);

    attachDiagnoses(result, found);
    const d = result.segments![0]!.drawn![0]!;
    expect(d.diagnosis).toMatchObject({
      unverified: true,
      window: [[0.75, 2.25]],
      matches: false,
      differences: [
        { aspect: "position", original: "left", yours: "right", start: 1.5, end: 2.25 },
      ],
      layout: "original above yours",
      input_tokens: 812,
      jobs: ["a1"],
    });
    expect(result.segments![0]!.drawn![1]!.diagnosis).toBeUndefined();
  });
});
