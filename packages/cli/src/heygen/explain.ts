// `diff --explain`: pixels find which drawn element fails, HeyGen's video model says what differs in it. Its route
// samples at most 2 fps at low resolution, so each frame is a thumbnail: the element's box is cut from both videos at
// native resolution, the original above yours (left of yours for a tall box), padded to near-square and scaled until
// the element is about 600 px, over a short window slowed so 2 fps sees about 12 fps. The question is fixed and never
// carries the score, the verdict or a guess at the cause, which would prime the answer. An answer is a lead: unverified
// until the frames and the pixels confirm it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { askVideo, HEYGEN_FPS, slowBy, underInlineCap } from "../commands/analyze.js";
import type { DiffResult } from "../measure/diff.js";
import { round, type Roi, type VideoInfo } from "../measure/media.js";
import { toFilmTime } from "./reverseDraft.js";

// Pixels kept around the box, the grey line between the two sides, the widest picture sent, and its long side.
const MARGIN = 6;
const GAP = 8;
const MAX_ASPECT = 1.25;
const LONG_SIDE = 1200;
// The window is widened this much each side to see the element arrive and leave; longer than MAX_S, its first and
// last PIECE_S seconds are asked apart. Frames a second the model should see.
const LEAD_S = 0.25;
const MAX_S = 4;
const PIECE_S = 2;
const EXPLAIN_FPS = 12;
const PARALLEL = 4;

/** What a difference is about: how the element looks, or how it moves. */
const APPEARANCE = ["words", "font", "weight", "size", "position", "colour", "material", "doubled"];
const MOTION = ["appears", "changes", "leaves", "timing"];

const str = { type: "string" };
const num = { type: "number" };
const EXPLAIN_SCHEMA = {
  type: "object",
  properties: {
    matches: { type: "boolean" },
    differences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          aspect: { type: "string", enum: [...APPEARANCE, ...MOTION, "other"] },
          original: str,
          yours: str,
          start: num,
          end: num,
        },
        required: ["aspect", "original", "yours", "start", "end"],
      },
    },
  },
  required: ["matches", "differences"],
};

export type Layout = "original above yours" | "original left of yours";

/** The one question, worded for where each side sits. */
export function explainQuestion(layout: Layout): string {
  const [first, second] = layout === "original above yours" ? ["TOP", "BOTTOM"] : ["LEFT", "RIGHT"];
  return `${first} is the original video, ${second} is a recreation of the same moment. Both are cut to the same box around one drawn element: text, a number, a badge or a card. The person, the scenery and anything behind the element were remade on purpose: ignore them.

Compare only the drawn element. List each way the ${second} one differs from the ${first} one: the words or letters, font, weight or italic, size, position, colour, material (solid, gradient, glass, chrome, outline, glow, shadow), doubled or ghosted letters, how it appears, how it changes while on screen, how it leaves, and timing. Say what each side shows. If the drawn element matches, set matches to true and list nothing. Report only what you can see in the frames.`;
}

/** The box with a margin, on even pixels inside the frame. */
function cropOf([x, y, w, h]: Roi, fw: number, fh: number): Roi {
  const even = (v: number) => Math.floor(v / 2) * 2;
  const x0 = even(Math.max(0, x - MARGIN));
  const y0 = even(Math.max(0, y - MARGIN));
  return [
    x0,
    y0,
    Math.max(2, even(Math.min(fw, x + w + MARGIN) - x0)),
    Math.max(2, even(Math.min(fh, y + h + MARGIN) - y0)),
  ];
}

/** How a box is laid out for the model: both sides, padded to near-square, scaled to LONG_SIDE. */
export function layoutOf(
  box: Roi,
  fw: number,
  fh: number,
): { crop: Roi; layout: Layout; size: [number, number]; filter: string } {
  const crop = cropOf(box, fw, fh);
  const [, , w, h] = crop;
  const above = w >= h;
  const [sw, sh] = above ? [w, 2 * h + GAP] : [2 * w + GAP, h];
  const even = (v: number) => Math.ceil(v / 2) * 2;
  const [pw, ph] = [even(Math.max(sw, sh / MAX_ASPECT)), even(Math.max(sh, sw / MAX_ASPECT))];
  const k = LONG_SIDE / Math.max(pw, ph);
  const size: [number, number] = [even(pw * k), even(ph * k)];
  const cut = `crop=${w}:${h}:${crop[0]}:${crop[1]},setsar=1`;
  const filter = [
    `[0:v]${cut},pad=${above ? `${w}:${h + GAP}` : `${w + GAP}:${h}`}:0:0:color=gray[a]`,
    `[1:v]scale=${fw}:${fh},${cut}[b]`,
    `[a][b]${above ? "vstack" : "hstack"},pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:color=black,scale=${size[0]}:${size[1]}:flags=lanczos`,
  ].join(";");
  return { crop, layout: above ? "original above yours" : "original left of yours", size, filter };
}

/** The film seconds asked about: the window widened a little, or its two ends when it is long. */
export function piecesOf([a, b]: [number, number], duration: number): [number, number][] {
  const [s, e] = [Math.max(0, a - LEAD_S), Math.min(duration, b + LEAD_S)];
  if (e - s <= MAX_S) return [[round(s, 3), round(e, 3)]];
  return [
    [round(s, 3), round(s + PIECE_S, 3)],
    [round(e - PIECE_S, 3), round(e, 3)],
  ];
}

export interface Difference {
  aspect: string;
  original: string;
  yours: string;
  start?: number;
  end?: number;
}

export interface Diagnosis {
  /** A lead from a video model, never a verdict: look at the box's frames and confirm with pixels before fixing. */
  unverified: true;
  /** The film seconds the model watched (one or two pieces). */
  window: [number, number][];
  matches: boolean | null;
  differences: Difference[];
  layout: Layout;
  /** The picture sent, in pixels, and the input tokens the route counted (low ones mean it saw thumbnails). */
  size: [number, number];
  input_tokens: number | null;
  jobs: string[];
}

export interface Target {
  id: string;
  box: Roi;
  window: [number, number];
}

/** What `--explain` asks about: every failing drawn element and failing SSIM segment's worst cell, or those named. */
export function targetsOf(result: DiffResult, only?: string[]): Target[] {
  const wanted = (id: string, pass: boolean | null) => (only ? only.includes(id) : pass === false);
  return (result.segments ?? []).flatMap((s) => [
    ...(s.drawn ?? [])
      .filter((d) => wanted(d.id, d.pass))
      .map((d) => ({ id: d.id, box: d.box, window: d.window })),
    ...(s.worst_cell && wanted(s.id, s.pass)
      ? [
          {
            id: s.id,
            box: s.worst_cell.roi,
            window: [
              Math.max(s.window[0], s.worst_cell.t - PIECE_S / 2),
              Math.min(s.window[1], s.worst_cell.t + PIECE_S / 2),
            ] as [number, number],
          },
        ]
      : []),
  ]);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface ExplainOptions {
  reference: VideoInfo;
  yours: VideoInfo;
  model?: string;
  oauth?: boolean;
  project?: string;
  log?: (message: string) => void;
}

/** One target asked piece by piece. */
// fallow-ignore-next-line complexity
async function explainOne(t: Target, o: ExplainOptions, dir: string): Promise<Diagnosis> {
  const { layout, size, filter } = layoutOf(t.box, o.reference.width, o.reference.height);
  const pieces = piecesOf(t.window, Math.min(o.reference.duration, o.yours.duration));
  const differences: Difference[] = [];
  const matches: boolean[] = [];
  const jobs: string[] = [];
  let tokens: number | null = null;
  for (const [n, [a, b]] of pieces.entries()) {
    const slow = slowBy(EXPLAIN_FPS, b - a);
    const video = underInlineCap(
      dir,
      `${t.id}-${n}`,
      (crf, out) => [
        ...["-y", "-ss", String(a), "-t", String(b - a), "-i", o.reference.path],
        ...["-ss", String(a), "-t", String(b - a), "-i", o.yours.path],
        ...["-filter_complex", `${filter},setpts=${slow}*PTS`, "-r", String(HEYGEN_FPS * 2)],
        ...["-an", "-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv420p", out],
      ],
      b - a,
    );
    const prompt = [
      explainQuestion(layout),
      `This clip is ${round((b - a) * slow, 2)} s long${slow > 1 ? `: it plays at 1/${round(slow, 2)} speed and has no sound; judge motion as if at normal speed` : ""}. Give times in seconds of this clip.`,
    ].join("\n\n");
    o.log?.(`explain: ${t.id} ${a}–${b} s`);
    const asked = await askVideo(video, prompt, EXPLAIN_SCHEMA, {
      model: o.model,
      oauth: o.oauth,
      project: o.project,
      what: `diff --explain ${basename(o.yours.path)} ${t.id} ${a}-${b}s`,
    });
    jobs.push(asked.job);
    const used = isRecord(asked.usage) ? asked.usage.input_tokens : undefined;
    if (typeof used === "number") tokens = (tokens ?? 0) + used;
    const answer = toFilmTime(asked.answer, slow, a);
    if (!isRecord(answer)) continue;
    if (typeof answer.matches === "boolean") matches.push(answer.matches);
    for (const d of Array.isArray(answer.differences) ? answer.differences : [])
      if (isRecord(d))
        differences.push({
          aspect: String(d.aspect ?? "other"),
          original: String(d.original ?? ""),
          yours: String(d.yours ?? ""),
          ...(typeof d.start === "number" ? { start: d.start } : {}),
          ...(typeof d.end === "number" ? { end: d.end } : {}),
        });
  }
  return {
    unverified: true,
    window: pieces,
    matches: matches.length ? matches.every(Boolean) && !differences.length : null,
    differences,
    layout,
    size,
    input_tokens: tokens,
    jobs,
  };
}

/** Each target's diagnosis, a few at a time, by id. */
export async function explainTargets(
  targets: Target[],
  o: ExplainOptions,
): Promise<Map<string, Diagnosis>> {
  const out = new Map<string, Diagnosis>();
  const dir = mkdtempSync(join(tmpdir(), "hf-explain-"));
  try {
    const queue = [...targets];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let t = queue.shift(); t; t = queue.shift())
          out.set(t.id, await explainOne(t, o, dir));
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** Each diagnosis written under its box in the result. */
export function attachDiagnoses(result: DiffResult, found: Map<string, Diagnosis>): void {
  for (const s of result.segments ?? []) {
    for (const d of s.drawn ?? []) d.diagnosis = found.get(d.id) ?? d.diagnosis;
    if (s.worst_cell) s.worst_cell.diagnosis = found.get(s.id) ?? s.worst_cell.diagnosis;
  }
}
