// What `analyze --preset reverse` asks HeyGen's video model, adapted from light-reverse's observation prompt to any
// kind of video: the draft a rebuild corrects against the frames, in the shape REVERSE.md needs.

export const REVERSE_PROMPT = `You are watching a video that will be rebuilt as an editable HTML motion project by
someone who cannot see it. Watch it from start to end. Return one JSON document matching the schema, nothing else.

Be concrete: exact on-screen text (case, punctuation, line breaks), colours as hex, sizes and positions as shares of
the frame (0-1), times in seconds with two decimals. Say what you are unsure of in "questions" instead of guessing.

Segments follow the video's own units: split at hard cuts and layout changes, never inside one continuous move;
windows are contiguous and cover the whole clip. For each segment say where its pixels come from: "drawn" (text,
shapes, UI, charts, icons: buildable in HTML), "footage" (live action or screen recording), "person" (a presenter or
talking head), "ai" (generated imagery), or "mixed".

Name effects precisely in actions: flash, glow, blur, shadow, bounce, scale, slide, fade, mask reveal, type-on.
A key that lights up white for six frames is a six-frame flash, not a pop-in. Groups (piles, fans, grids, particles,
lists): count, arrangement, order, change rate. Letters whose insides show a photo or other text are a knockout.

"recurring" lists elements that appear in more than one segment or change role (a circle that becomes the O of a
word). "media" lists every photographic or filmed region with its box. "questions" (at most 16, most important first)
are where a second observer with native frames must look to confirm or correct you: every text onset, every cursor
click, every fast motion or one-frame flash, every transition, whether motion is smooth or stepped (on twos).`;

const str = { type: "string" };
const num = { type: "number" };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const arr = (items: unknown) => ({ type: "array", items });

export const REVERSE_SCHEMA = obj({
  summary: str,
  audio: obj({ kind: str, speech: str, beats: str }),
  look: str,
  palette: arr(obj({ hex: str, role: str })),
  type: arr(obj({ role: str, traits: str, guess: str })),
  motion_rules: arr(str),
  segments: arr(
    obj({
      id: str,
      start: num,
      end: num,
      title: str,
      pixels: { type: "string", enum: ["drawn", "footage", "person", "ai", "mixed"] },
      start_state: str,
      copy: arr(str),
      actions: arr(obj({ start: num, end: num, what: str })),
      relations: str,
      end_state: str,
    }),
  ),
  recurring: arr(obj({ name: str, what: str, segments: arr(str) })),
  media: arr(obj({ segment: str, start: num, end: num, roi: arr(num), kind: str, what: str })),
  risks: arr(obj({ segment: str, claim: str })),
  questions: arr(obj({ segment: str, start: num, question: str })),
});

export const DESCRIBE_SCHEMA = obj({
  answer: str,
  moments: arr(obj({ start: num, end: num, what: str })),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every start and end in `answer` divided by `slow` and moved by `offset`: the clip's clock back to the film's. */
export function toFilmTime(answer: unknown, slow: number, offset: number): unknown {
  if (Array.isArray(answer)) return answer.map((v) => toFilmTime(v, slow, offset));
  if (!isRecord(answer)) return answer;
  return Object.fromEntries(
    Object.entries(answer).map(([k, v]) => [
      k,
      typeof v === "number" && (k === "start" || k === "end")
        ? Math.round((v / slow + offset) * 100) / 100
        : toFilmTime(v, slow, offset),
    ]),
  );
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The parts' drafts as one: lists joined in time order, segments renumbered S01.., the first part's prose first. */
export function mergeDrafts(parts: unknown[]): Record<string, unknown> {
  const drafts = parts.filter(isRecord);
  const joined = (key: string) => drafts.flatMap((d) => list(d[key]));
  const unique = (key: string, by: string) => {
    const seen = new Set<string>();
    return joined(key).filter((v) => {
      const id = isRecord(v) ? String(v[by] ?? "") : String(v);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const renumber = new Map<string, string>();
  const segments = drafts.flatMap((d, p) =>
    list(d.segments)
      .filter(isRecord)
      .map((s) => {
        const id = `S${String(renumber.size + 1).padStart(2, "0")}`;
        renumber.set(`${p}:${String(s.id)}`, id);
        return { ...s, id };
      }),
  );
  const relabel = (key: string) =>
    drafts.flatMap((d, p) =>
      list(d[key]).map((v) =>
        isRecord(v) && typeof v.segment === "string"
          ? { ...v, segment: renumber.get(`${p}:${v.segment}`) ?? v.segment }
          : v,
      ),
    );
  return {
    summary: drafts
      .map((d) => d.summary)
      .filter(Boolean)
      .join(" "),
    audio: drafts[0]?.audio ?? null,
    look: drafts[0]?.look ?? "",
    palette: unique("palette", "hex"),
    type: unique("type", "traits"),
    motion_rules: unique("motion_rules", ""),
    segments,
    recurring: unique("recurring", "name"),
    media: relabel("media"),
    risks: relabel("risks"),
    questions: relabel("questions"),
  };
}
