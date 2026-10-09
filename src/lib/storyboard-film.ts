/**
 * Storyboard film — "grid to full film" (九宫格→一键整片).
 *
 * Field-proven flow (2026-08 real-product test): feed the storyboard grid's
 * cropped cells as reference images into Seedance 2.5 reference-to-video with a
 * timecoded multi-shot prompt (@ImageN cites shot N's keyframe, dialogue is
 * assigned per segment) — the model cuts natively between shots, keeps the
 * person/product consistent across cuts, and speaks the lines verbatim with
 * continuous audio. One generation replaces N i2v calls + concat, and the
 * soundtrack never has splice seams.
 *
 * Pure functions only (prompt building + duration math); the route does the I/O.
 */
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import { stripPauseMarks } from "@/lib/voice-markup";
import { getVideoParamSpec } from "@/lib/providers/atlas-video-params";

/** Seedance 2.5 duration bounds (schema: integer 4-30 seconds) */
export const FILM_MIN_SECONDS = 4;
export const FILM_MAX_SECONDS = 30;

/** Shot-type labels for segment lines, zh/en */
const SHOT_TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  hook: { zh: "钩子镜", en: "hook shot" },
  pain_point: { zh: "痛点镜", en: "pain-point shot" },
  product_reveal: { zh: "商品镜", en: "product shot" },
  demo: { zh: "演示镜", en: "demo shot" },
  social_proof: { zh: "背书镜", en: "social-proof shot" },
  cta: { zh: "转化镜", en: "CTA shot" },
};

const CJK_RE = /[一-鿿]/;

/** Raw total of the script's shot durations in seconds (not clamped) */
export function filmTotalSeconds(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0);
}

/** Fallback model for the one-call film pass, used when the configured model can't take references. */
export const FILM_FALLBACK_MODEL = "bytedance/seedance-2.5/reference-to-video";

export interface FilmModelChoice {
  /** The model that will actually be billed */
  model: string;
  /** The configured model this replaced, when the pipeline had to switch away from it */
  swappedFrom?: string;
}

/**
 * Resolve the model the film pass will actually bill.
 *
 * The one-call film pass needs a reference-to-video model, so anything else gets replaced by
 * the flagship fallback. That swap used to happen silently in the page handlers, which billed
 * people on a pricier model than the one sitting in their settings (issue #28). It stays a
 * swap — the pass genuinely cannot run without references — but `swappedFrom` makes it
 * reportable, so callers can show it and take consent before any money moves.
 */
export function resolveFilmModel(configured?: string | null): FilmModelChoice {
  const model = configured?.trim();
  if (model && /^seedance-(2\.0(?:-mini)?|2\.5)$/.test(model)) return { model };
  if (model && model.includes("/reference-to-video")) return { model };
  return { model: FILM_FALLBACK_MODEL, ...(model ? { swappedFrom: model } : {}) };
}

/** The model's own longest single generation, when its schema declares a duration enum. */
export function modelMaxSeconds(modelId?: string | null): number | undefined {
  if (modelId === "seedance-2.0") return 15;
  const durations = modelId ? filmModelSpec(modelId)?.durationEnum : undefined;
  return durations?.length ? Math.max(...durations) : undefined;
}

export interface FilmDurationFit {
  /** Seconds actually submitted */
  seconds: number;
  /** Rounded raw script total */
  scriptSeconds: number;
  /** Upper bound applied: the lower of the film cap and the model's own ceiling */
  cap: number;
  /** The script is longer than this model can render in one call — the tail would be cut */
  overflow: boolean;
}

/**
 * Duration the film pass will request, against a specific model's ceiling.
 *
 * Models differ: Seedance 2.5 renders up to 30s, MiniMax H3 stops at 15s. Clamping only to the
 * generic 30s cap meant a 30s script on a 15s model was snapped down provider-side and came back
 * as a silently truncated film. `overflow` lets callers refuse the spend instead.
 */
export function filmDurationFit(shots: Shot[], modelId?: string | null): FilmDurationFit {
  const scriptSeconds = Math.round(filmTotalSeconds(shots));
  const cap = Math.min(FILM_MAX_SECONDS, modelMaxSeconds(modelId) ?? FILM_MAX_SECONDS);
  return {
    seconds: Math.min(cap, Math.max(FILM_MIN_SECONDS, scriptSeconds)),
    scriptSeconds,
    cap,
    overflow: scriptSeconds > cap,
  };
}

export interface FilmSpendEstimate {
  /** USD per second of output, as published by the platform (its cheapest tier) */
  unitUsd: number;
  seconds: number;
  /** unitUsd x seconds — the floor, only reached at the base resolution tier */
  minUsd: number;
  /** what the run bills at the requested tier, using measured tier multipliers */
  maxUsd: number;
  /** 1 at the base tier; >1 where the tier was measured to cost more */
  tierMultiplier: number;
}

/**
 * Cost multiplier over the published base rate, by resolution tier.
 *
 * Providers price resolution tiers as separate products, but the catalog publishes ONE
 * base_price per model — the cheapest tier. Measured on Atlas (2026-09, 5s reference-to-video,
 * 9:16 vertical, actual invoiced cost):
 *
 *   Seedance 2.5 @1080p  $2.98 / 5s = $0.596/s  vs  $0.134 base  ->  4.45x
 *   Wan 3.0      @1080p  $0.80 / 5s = $0.160/s  vs  $0.040 base  ->  4.00x
 *   Wan 3.0      @720p   $0.40 / 5s = $0.080/s  vs  $0.040 base  ->  2.00x
 *
 * The published base rate therefore tracks the lowest tier (480p), not 720p, and the steps
 * follow pixel count (each tier is ~2.25x the pixels of the one below). Rounded UP on purpose:
 * a quoted price that reads low is exactly what let a 30s run bill several times its advertised
 * rate without anyone noticing (issue #28), so the spend cap compares against the high end.
 *
 * Sanity check against that report: $0.134 x 30s x 4.5 = $18.1, against an actual bill of ~$22
 * on the pricier 1080p-sr upscale tier.
 */
export const RESOLUTION_COST_MULTIPLIER: { minHeight: number; multiplier: number }[] = [
  { minHeight: 1080, multiplier: 4.5 },
  { minHeight: 720, multiplier: 2 },
];

/**
 * Multiplier for a requested output size; 1 (the base tier) when nothing larger matches.
 *
 * Keyed on the SHORT side, matching how the provider names its tiers and how pickResolution
 * chooses one: a 9:16 "720p" frame is 720x1280, so keying on height alone would misread every
 * portrait video as a tier higher than it is.
 */
export function tierMultiplierFor(width: number | undefined, height: number | undefined): number {
  const sides = [width, height].filter((n): n is number => Number.isFinite(n));
  if (sides.length === 0) return 1;
  const shortSide = Math.min(...sides);
  const hit = RESOLUTION_COST_MULTIPLIER.filter((r) => shortSide >= r.minHeight).sort(
    (a, b) => b.minHeight - a.minHeight
  )[0];
  return hit?.multiplier ?? 1;
}

/**
 * Estimated cost range for one film generation.
 *
 * Atlas publishes video pricing per second of output (`price.actual.base_price`, already
 * discounted; models that declare a `unit` all say "second", and every rate spot-checked
 * against the model docs matched exactly). Callers should render the arithmetic, not just the
 * total — showing "$0.134/s x 30s" keeps the per-second assumption visible instead of burying
 * it in a single number that nobody can sanity-check.
 *
 * Returns undefined when the platform publishes no price: an unknown cost must read as
 * unknown, never as zero (issue #28).
 */
export function estimateFilmSpend(
  unitUsd: number | undefined,
  seconds: number,
  output?: { width?: number; height?: number }
): FilmSpendEstimate | undefined {
  if (unitUsd === undefined || !Number.isFinite(unitUsd) || unitUsd < 0) return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const minUsd = round(unitUsd * seconds);
  const tierMultiplier = tierMultiplierFor(output?.width, output?.height);
  return { unitUsd, seconds, minUsd, maxUsd: round(minUsd * tierMultiplier), tierMultiplier };
}

/** Parse the platform's published price string into a number, tolerating absent/dirty values. */
export function parseUnitUsd(raw: string | number | undefined | null): number | undefined {
  if (raw == null) return undefined;
  // Number("") is 0, which would turn an absent price into "free" — the one reading we must never produce
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The integer duration actually submitted to the model: rounded sum clamped to 4..30 */
export function filmRequestSeconds(shots: Shot[], modelId?: string | null): number {
  return filmDurationFit(shots, modelId).seconds;
}

/** Trim trailing zeros: 3 -> "3", 7.5 -> "7.5" */
function fmtSec(x: number): string {
  return String(Number(x.toFixed(1)));
}

/**
 * Dialogue-density check for native-voice generation (Seedance official guidance: overstuffed
 * lines break lip sync toward the end of a segment — the community guide cites ~12 words / 10s
 * for English). Our field E2E showed the model tolerates denser lines, so the thresholds below
 * only flag egregious overflow rather than enforcing the guide's strict budget: the script
 * engine already targets ~3 zh chars/sec, so 5 chars/sec (zh) and 2.6 words/sec (en) mean the
 * line physically cannot be spoken naturally inside its shot.
 */
export const DIALOGUE_MAX_ZH_CHARS_PER_SEC = 5;
export const DIALOGUE_MAX_EN_WORDS_PER_SEC = 2.6;

export interface DialogueDensityWarning {
  /** zero-based shot index */
  index: number;
  seconds: number;
  /** zh: CJK+word chars counted; en: whitespace-separated words */
  count: number;
  limit: number;
}

/** Flags shots whose voiceover is too dense to lip-sync inside its duration. Pure function. */
export function dialogueDensityWarnings(shots: Shot[]): DialogueDensityWarning[] {
  const out: DialogueDensityWarning[] = [];
  shots.forEach((s, index) => {
    // density counts speakable characters only — the [pause] marker takes no speaking time
    const line = stripPauseMarks((s.voiceover ?? "").trim());
    const seconds = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0;
    if (!line || seconds <= 0) return;
    if (CJK_RE.test(line)) {
      // count letter/digit/CJK chars only — punctuation takes no speaking time
      const count = Array.from(line).filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
      const limit = Math.ceil(seconds * DIALOGUE_MAX_ZH_CHARS_PER_SEC);
      if (count > limit) out.push({ index, seconds, count, limit });
    } else {
      const count = line.split(/\s+/).filter(Boolean).length;
      const limit = Math.ceil(seconds * DIALOGUE_MAX_EN_WORDS_PER_SEC);
      if (count > limit) out.push({ index, seconds, count, limit });
    }
  });
  return out;
}

export interface ReferenceQuotaCheck {
  ok: boolean;
  count: number;
  /** The model's schema limit, when known */
  limit?: number;
}

/**
 * Pre-spend reference-image quota gate: a submission whose reference count exceeds the
 * model's published schema limit is a GUARANTEED upstream rejection — catching it before
 * the (billed) submit is free money. Models without a known limit pass unchecked
 * (never block on a guess); the classic overflow is 9 grid keyframes + 1 presenter
 * sheet = 10 refs against Seedance's 9-image cap.
 */
export function referenceQuotaCheck(referenceImageCount: number, modelId: string): ReferenceQuotaCheck {
  const limit = filmModelSpec(modelId)?.maxReferenceImages;
  if (limit === undefined) return { ok: true, count: referenceImageCount };
  return { ok: referenceImageCount <= limit, count: referenceImageCount, limit };
}

function filmModelSpec(modelId: string) {
  if (modelId === "seedance-2.0") modelId = "seedance-2.0-mini";
  const id = /^seedance-(2\.0(?:-mini)?|2\.5)$/.test(modelId)
    ? `bytedance/${modelId}/reference-to-video`
    : modelId;
  return getVideoParamSpec(id);
}

/**
 * Build the single-call multi-shot film prompt. Language follows the script:
 * any CJK in descriptions/voiceovers → Chinese, otherwise English (the model
 * speaks the dialogue verbatim, so the prompt must match the dialogue language).
 *
 * With refs.characterSheet the reference_images array leads with the presenter's
 * multi-view sheet, so @Image1 becomes the identity anchor and the shot keyframes
 * shift to @Image2..N+1 — the prompt's citations follow the same offset.
 */
export function buildStoryboardFilmPrompt(
  shots: Shot[],
  characters?: ScriptCharacter[] | null,
  refs?: { characterSheet?: boolean },
  opts?: {
    /**
     * Raw phone-shot texture block (default on — the film chain is UGC by design).
     * Pass false when a styled global look drives the visuals instead, so the
     * "ungraded phone footage" wording doesn't fight the styled look.
     */
    realism?: boolean;
  }
): string {
  const zh = shots.some((s) => CJK_RE.test(`${s.description ?? ""}${s.voiceover ?? ""}`));
  const total = filmRequestSeconds(shots);
  const cast = (characters ?? []).filter((c) => (c.name ?? "").trim());
  // single named character → attribute dialogue to them; otherwise a generic on-camera creator
  const soloName = cast.length === 1 ? (cast[0].name ?? "").trim() : "";
  const speaker = soloName || (zh ? "出镜人物" : "the on-camera creator");
  const multiCast = cast.length > 1;
  // per-line speaker attribution (multi-character dialogue MUST name its speaker, or the
  // model hands lines to whoever is centered); the anchor stays ONE short clause — full
  // appearance repeated per line dilutes attention (identity lives in the cast block)
  const charById = new Map(cast.map((c) => [c.id, c]));
  const shortAnchor = (c: ScriptCharacter): string =>
    (c.appearance ?? "").split(/[，、；,;]/)[0].trim().slice(0, 14);
  // shot keyframes start at @Image1, or @Image2 when the character sheet leads the array
  const offset = refs?.characterSheet ? 1 : 0;

  // timecode boundaries follow the script's own durations, proportionally scaled
  // onto the requested total so segments always tile the full film exactly
  const rawTotal = filmTotalSeconds(shots) || shots.length;
  const scale = total / rawTotal;
  let cursor = 0;
  const segments = shots.map((s, i) => {
    const start = cursor;
    const rawLen = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : rawTotal / shots.length;
    cursor = i === shots.length - 1 ? total : Math.min(total, cursor + rawLen * scale);
    const label = SHOT_TYPE_LABELS[String(s.type)]?.[zh ? "zh" : "en"] ?? (zh ? "分镜" : "shot");
    // the model speaks lines verbatim — the [pause] breath marker must never reach it
    const line = stripPauseMarks((s.voiceover ?? "").trim());
    const imgN = i + 1 + offset;
    // camera moves come from the script (LLM writes them with the e-commerce preset vocabulary,
    // or the user picks a preset per shot) — dropping them here would flatten every shot to a
    // static frame, so the film pass carries them through
    const cam = (s.camera ?? "").trim();
    // dialogue rides Seedance 2.5's official sound-bracket syntax: `{}` marks "lines to be
    // spoken aloud", separating them from scene description at the token level (the official
    // guide reserves () for music, <> for sound effects, {} for dialogue, 【】 for captions)
    // multi-character: name the speaker on every line (one short appearance clause as a
    // disambiguating anchor); solo/no-cast keeps the legacy unattributed wording
    const speakerOfLine = multiCast && s.characterId ? charById.get(s.characterId) : undefined;
    const whoZh = speakerOfLine
      ? `，由${speakerOfLine.name}${shortAnchor(speakerOfLine) ? `（${shortAnchor(speakerOfLine)}）` : ""}说出`
      : "";
    const whoEn = speakerOfLine
      ? ` by ${speakerOfLine.name}${shortAnchor(speakerOfLine) ? ` (${shortAnchor(speakerOfLine)})` : ""}`
      : "";
    if (zh) {
      const dialogue = line ? `台词（逐字说出${whoZh}）：{${line}}` : "（无台词，只保留环境音与动作声）";
      const camPart = cam ? `运镜：${cam}。` : "";
      return `[${fmtSec(start)}-${fmtSec(cursor)}秒] 镜头${i + 1}（${label}，画面以 @图片${imgN} 为基准）：${s.description ?? ""}。${camPart}${dialogue}`;
    }
    const dialogue = line ? `Dialogue (spoken verbatim${whoEn}): {${line}}` : "(no dialogue — ambient and action sounds only)";
    const camPart = cam ? `Camera: ${cam}. ` : "";
    return `[${fmtSec(start)}-${fmtSec(cursor)}s] Shot ${i + 1} (${label}, framing follows @Image${imgN}): ${s.description ?? ""}. ${camPart}${dialogue}`;
  });

  // material-binding statement (official rule: state the upload-order → role mapping up front —
  // it is the #1 stability factor once the reference count grows past a handful) doubling as the
  // official keyframe-order declaration for strict shot alignment
  const lastImg = shots.length + offset;
  const bindingZh = refs?.characterSheet
    ? `素材对应：@图片1 是出镜人物定妆照（仅作身份参考）；@图片2 至 @图片${lastImg} 依次为镜头1至镜头${shots.length}的关键帧，以此顺序作为各镜头的画面基准。`
    : `素材对应：@图片1 至 @图片${lastImg} 依次为镜头1至镜头${shots.length}的关键帧，以此顺序作为各镜头的画面基准。`;
  const bindingEn = refs?.characterSheet
    ? `Reference mapping: @Image1 is the presenter's reference sheet (identity only); @Image2 through @Image${lastImg} are the keyframes for shots 1-${shots.length} in order — use them as each shot's framing anchor in that order.`
    : `Reference mapping: @Image1 through @Image${lastImg} are the keyframes for shots 1-${shots.length} in order — use them as each shot's framing anchor in that order.`;

  // raw phone-shot texture block, all positive wording (the official guide: Seedance's negative
  // channel only covers captions/audio — visual negatives are placebos, so "ungraded" is stated
  // as what the image IS, not what to avoid). Skin stays at "natural, pores kept" — no flaw
  // stacking (the two-round A/B lesson: listed blemishes produce off-putting faces).
  const realism = opts?.realism !== false;
  const realismZh = `画质与质感：真实手机直出质感，色彩自然未调色、带混合色温；人物肤质自然真实、保留毛孔细节不磨皮；构图带轻微手持感。`;
  const realismEn = `Texture: raw ungraded phone-footage look with mixed color temperature; natural realistic skin with visible pores, no beauty smoothing; framing carries a slight handheld feel.`;

  // cast identity block: every character's name + appearance as the cross-shot anchor;
  // the direction convention kills the #1 two-hander confusion ("left" = whose left?)
  const castZh = cast.length
    ? `人物设定（下文提到角色一律用角色名指代，外观以此为准；台词与画面中的左/右一律指画面方向）：${cast.map((c) => `${c.name}（${c.appearance ?? ""}）`).join("；")}。`
    : "";
  const castEn = cast.length
    ? `Cast (refer to characters strictly by these names, appearance as written; "left/right" always means screen direction): ${cast.map((c) => `${c.name} (${c.appearance ?? ""})`).join("; ")}.`
    : "";
  // studio-backdrop strip: reference sheets are shot on a plain gray 2x2 board — without this
  // line the model happily drags the gray backdrop or the grid split into real scenes
  const sheetStripZh = `人物需自然融入各分镜自身的场景与光线，不得把定妆照的浅灰影棚背景、四格分格或边框带进任何镜头画面。`;
  const sheetStripEn = `Blend the person naturally into each shot's own scene and lighting — never carry the sheet's plain gray studio backdrop, its 2x2 split or borders into any shot.`;

  if (zh) {
    return [
      `竖屏 9:16 UGC 手机实拍感带货短视频，总时长约 ${total} 秒，共 ${shots.length} 个镜头，严格按下面的时间段硬切，一次生成整片。`,
      bindingZh,
      castZh,
      `全局一致性：所有镜头是同一支视频——同一人物、同一发型与同一身衣服、同一场景与光线方向；商品外观在所有镜头中保持完全一致。`,
      refs?.characterSheet
        ? `@图片1 是${soloName || "出镜人物"}的四视图定妆照——全片人物的脸型、发型、体型与服装必须与其完全一致（定妆照只作人物参考，不作为任何分镜画面）。${sheetStripZh}`
        : "",
      multiCast
        ? `有台词的镜头：由该镜标注的角色自然说出台词，原声逐字说出，口型与语速对齐，语气像日常聊天而不是播音腔；无台词的镜头不要出现说话声。`
        : `有台词的镜头：${speaker}对着镜头自然说话，原声逐字说出该镜台词，口型与语速对齐，语气像日常聊天而不是播音腔；无台词的镜头不要出现说话声。`,
      realism ? realismZh : "",
      // caption ban (positive frame line) + the official negative channel, which covers exactly
      // captions and audio: on-screen text is AI video's #1 tell, and bgm belongs to the
      // composer's own mixing stage, not the generation
      `画面中不出现任何字幕、文字、编号或水印。不要字幕。`,
      `无bgm，只生成台词人声、环境音与动作音。`,
      `分镜（@图片N 是对应镜头的画面基准，人物、场景与构图以其为准）：`,
      ...segments,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Vertical 9:16 UGC phone-shot style short video, about ${total} seconds total, ${shots.length} shots with hard cuts exactly at the timecodes below, generated as one continuous film.`,
    bindingEn,
    castEn,
    `Global consistency: every shot belongs to the same video — same person, same hair and outfit, same location and light direction; the product looks identical in every shot.`,
    refs?.characterSheet
      ? `@Image1 is the four-view reference sheet of ${soloName || "the presenter"} — the person's face, hair, build and outfit must match it exactly throughout (identity reference only, never a shot frame). ${sheetStripEn}`
      : "",
    // non-Chinese dialogue needs an explicit language declaration (official 2.5 guidance)
    shots.some((s) => (s.voiceover ?? "").trim()) ? `Dialogue language: English.` : "",
    multiCast
      ? `Shots with dialogue: the character named on that shot speaks the line verbatim with matching lip sync, casual everyday tone rather than announcer voice; shots without dialogue must contain no speech.`
      : `Shots with dialogue: ${speaker} talks to the camera naturally and speaks the lines verbatim with matching lip sync, casual everyday tone rather than announcer voice; shots without dialogue must contain no speech.`,
    realism ? realismEn : "",
    `No captions, on-screen text, numbers or watermarks anywhere in the frame. No subtitles.`,
    `No bgm — only the spoken dialogue, ambient and action sounds.`,
    `Shot list (@ImageN anchors the corresponding shot's framing — person, scene and composition follow it):`,
    ...segments,
  ]
    .filter(Boolean)
    .join("\n");
}
