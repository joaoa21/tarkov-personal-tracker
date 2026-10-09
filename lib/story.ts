// Story-mode chapters. tarkov.dev builds this data but strips it from its
// public API ("not ready for prime time"), so the chapters are read from the
// official EFT wiki and parsed here.

export type StoryStep = {
  /** Stable across wiki edits that don't touch this step's text. */
  id: string;
  text: string;
  /** Official in-game Portuguese text, when the step matched a game string. */
  textPt: string | null;
  optional: boolean;
  /** Branch / choice this step belongs to (e.g. "If you refuse Mr. Kerman's offer"). */
  branch: string | null;
};

export type StoryChapter = {
  id: string;
  title: string;
  titlePt: string | null;
  wikiUrl: string;
  iconFile: string | null;
  bannerFile: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  description: string;
  descriptionPt: string | null;
  requirements: string[];
  rewards: string[];
  steps: StoryStep[];
  previous: string | null;
  leadsTo: string | null;
};

export type StoryData = {
  chapters: StoryChapter[];
  fetchedAt: string;
  source: string;
};

export const WIKI_BASE = "https://escapefromtarkov.fandom.com/wiki";

/** Tour opens the story and The Ticket (after Falling Skies) closes it; the rest run in parallel. */
const CHAPTER_ORDER = ["Tour", "Falling Skies", "Batya", "The Unheard", "Blue Fire", "Accidental Witness", "They Are Already Here", "The Labyrinth", "Boreas", "The Ticket"];

export function chapterRank(title: string) {
  const index = CHAPTER_ORDER.indexOf(title);
  return index < 0 ? CHAPTER_ORDER.length - 1.5 : index;
}

export function wikiFileUrl(fileName: string | null | undefined) {
  const name = fileName?.trim();
  if (!name) return null;
  return `${WIKI_BASE}/Special:FilePath/${encodeURIComponent(name.replace(/ /g, "_"))}`;
}

export function chapterSlug(title: string) {
  return title.toLowerCase().replace(/\(story chapter\)/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hash(value: string) {
  let h = 5381;
  for (let index = 0; index < value.length; index += 1) h = ((h * 33) ^ value.charCodeAt(index)) >>> 0;
  return h.toString(36);
}

/** Wiki markup → plain text. */
export function cleanWikiText(value: string) {
  return value
    .replace(/\[\[File:[^\]]*?\|([^|\]]*?) ending\|[^\]]*\]\]/gi, " ⟨$1⟩")
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function section(wikitext: string, name: string) {
  const lines = wikitext.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^==\\s*${name}\\s*==\\s*$`, "i").test(line));
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^==[^=]/.test(line)) break;
    body.push(line);
  }
  return body;
}

function infobox(wikitext: string, field: string) {
  const match = wikitext.match(new RegExp(`^\\|\\s*${field}\\s*=(.*)$`, "im"));
  return match ? match[1].trim() : "";
}

/** Plain lines of a prose/bullet section, skipping galleries and tables. */
function proseLines(lines: string[]) {
  const output: string[] = [];
  let inGallery = false;
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/<gallery/i.test(line)) inGallery = true;
    if (inGallery) {
      if (/<\/gallery>/i.test(line)) inGallery = false;
      continue;
    }
    if (line.startsWith("{|")) inTable = true;
    if (inTable) {
      if (line.startsWith("|}")) inTable = false;
      continue;
    }
    if (!line || line.startsWith("<li") || line.startsWith("</li") || line.startsWith("=")) continue;
    const text = cleanWikiText(line.replace(/^\*+\s*/, ""));
    if (text) output.push(line.startsWith("*") ? `• ${text}` : text);
  }
  return output;
}

function parseSteps(lines: string[], slug: string): StoryStep[] {
  const steps: StoryStep[] = [];
  const seen = new Map<string, number>();
  let branch: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^<hr\s*\/?>$/i.test(line)) { branch = null; continue; }
    const heading = line.match(/^={3,}\s*(.*?)\s*={3,}$/) ?? line.match(/^'''(.+)'''$/);
    if (heading) { branch = cleanWikiText(heading[1]) || null; continue; }
    const bullet = line.match(/^(\*+)\s*(.*)$/);
    if (!bullet) continue;
    const optional = /\(\s*''\s*optional\s*''\s*\)|^\(optional\)/i.test(bullet[2]);
    const text = cleanWikiText(bullet[2].replace(/\(\s*''\s*optional\s*''\s*\)/i, "")).replace(/^\(optional\)\s*/i, "");
    if (!text) continue;
    const key = `${branch ?? ""}|${text}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    steps.push({ id: `${slug}-${hash(`${key}|${occurrence}`)}`, text, textPt: null, optional, branch });
  }
  return steps;
}

export function parseStoryChapter(title: string, wikitext: string): StoryChapter {
  const slug = chapterSlug(title);
  const description = section(wikitext, "Description").join(" ").match(/\{\{quote\|([\s\S]*?)\}\}/i)?.[1] ?? "";
  const linkTarget = (value: string) => value.match(/\[\[([^\]|]+)/)?.[1]?.trim() ?? null;
  return {
    id: slug,
    title: title.replace(/\s*\(story chapter\)/i, ""),
    titlePt: null,
    wikiUrl: `${WIKI_BASE}/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    iconFile: infobox(wikitext, "icon") || null,
    bannerFile: infobox(wikitext, "image") || null,
    // Replaced by direct CDN urls in the API route when the wiki resolves them.
    iconUrl: wikiFileUrl(infobox(wikitext, "icon")),
    bannerUrl: wikiFileUrl(infobox(wikitext, "image")),
    description: cleanWikiText(description),
    descriptionPt: null,
    requirements: proseLines(section(wikitext, "Requirements")),
    rewards: proseLines(section(wikitext, "Rewards")),
    steps: parseSteps(section(wikitext, "Objectives"), slug),
    previous: linkTarget(infobox(wikitext, "previous")),
    leadsTo: linkTarget(infobox(wikitext, "leads to")),
  };
}

/** Steps that count toward chapter progress: required ones, from the main line or any branch. */
export function storyChapterProgress(chapter: StoryChapter, done: Record<string, boolean>) {
  const required = chapter.steps.filter((step) => !step.optional);
  const completed = required.filter((step) => done[step.id]).length;
  return { completed, total: required.length };
}

// ---------------------------------------------------------------------------
// Official Portuguese text. tarkov.dev's tasks_pt / tasks_en locale files keep
// the story strings even though the story itself is stripped from the API, so
// each wiki step is matched to the game's English string and swapped for the
// game's Portuguese one.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(["the", "a", "an", "any", "to", "of", "in", "on", "at", "for", "from", "and"]);
const OBJECTIVE_KEY = /^[0-9a-f]{24}$/;

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/<[^>]+>/g, " ").replace(/(\d),(\d)/g, "$1$2").replace(/[^a-z0-9]+/g, " ").trim();
}

function matchWords(normalized: string) {
  return new Set(normalized.split(" ").filter((word) => word && !STOPWORDS.has(word) && !/^\d+$/.test(word)));
}

function numbersIn(normalized: string) {
  return normalized.split(" ").filter((word) => /^\d+$/.test(word));
}

type LocaleIndex = {
  exact: Map<string, string>;
  candidates: Array<{ key: string; normalized: string; words: Set<string> }>;
};

function buildLocaleIndex(english: Record<string, unknown>): LocaleIndex {
  const exact = new Map<string, string>();
  const candidates: LocaleIndex["candidates"] = [];
  for (const [key, value] of Object.entries(english)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = normalizeForMatch(value);
    if (!exact.has(normalized)) exact.set(normalized, key);
    if (OBJECTIVE_KEY.test(key)) candidates.push({ key, normalized, words: matchWords(normalized) });
  }
  return { exact, candidates };
}

function dice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Portuguese for an English wiki line, or null when no game string is close enough. */
function translateLine(text: string, index: LocaleIndex, portuguese: Record<string, unknown>, fuzzy: boolean) {
  const normalized = normalizeForMatch(text);
  const exactKey = index.exact.get(normalized);
  const exactPt = exactKey ? portuguese[exactKey] : null;
  if (typeof exactPt === "string" && exactPt.trim()) return exactPt.trim();
  if (!fuzzy) return null;

  const words = matchWords(normalized);
  if (words.size < 2) return null;
  const sourceNumbers = new Set(numbersIn(normalized));
  let best: { key: string; normalized: string; score: number } | null = null;
  for (const candidate of index.candidates) {
    // The game string must say the same thing as the wiki line: nothing extra
    // ("... on Interchange"), no different numbers ("5.0" vs "4.0"), and at
    // most one wiki word left out, so choices like "keep it or hand it over"
    // are never collapsed into one of the options.
    let extraWord = false;
    for (const word of candidate.words) if (!words.has(word)) { extraWord = true; break; }
    if (extraWord) continue;
    if (words.size - candidate.words.size > 1) continue;
    if (numbersIn(candidate.normalized).some((value) => !sourceNumbers.has(value))) continue;
    const score = dice(words, candidate.words);
    if (!best || score > best.score) best = { key: candidate.key, normalized: candidate.normalized, score };
  }
  if (!best) return null;
  const pt = portuguese[best.key];
  if (typeof pt !== "string" || !pt.trim()) return null;
  // The wiki often spells out counts ("Eliminate any 15 targets") that the
  // game shows in a separate counter; keep them visible.
  const candidateNumbers = new Set([...numbersIn(best.normalized), ...numbersIn(normalizeForMatch(pt.replace(/(\d)\.(\d{3})/g, "$1$2")))]);
  const extra = numbersIn(normalized).filter((value) => !candidateNumbers.has(value)).map((value) => Number(value).toLocaleString("pt-BR"));
  return extra.length ? `${pt.trim()} (${extra.join(", ")})` : pt.trim();
}

export function applyPortuguese(chapters: StoryChapter[], english: Record<string, unknown>, portuguese: Record<string, unknown>) {
  const index = buildLocaleIndex(english);
  for (const chapter of chapters) {
    chapter.titlePt = translateLine(chapter.title, index, portuguese, false);
    chapter.descriptionPt = chapter.description ? translateLine(chapter.description, index, portuguese, false) : null;
    for (const step of chapter.steps) step.textPt = translateLine(step.text, index, portuguese, true);
  }
  return chapters;
}
