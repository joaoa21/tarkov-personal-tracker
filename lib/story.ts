// Story-mode chapters. tarkov.dev builds this data but strips it from its
// public API ("not ready for prime time"), so the chapters are read from the
// official EFT wiki and parsed here.

export type StoryStep = {
  /** Stable across wiki edits that don't touch this step's text. */
  id: string;
  text: string;
  optional: boolean;
  /** Branch / choice this step belongs to (e.g. "If you refuse Mr. Kerman's offer"). */
  branch: string | null;
};

export type StoryChapter = {
  id: string;
  title: string;
  wikiUrl: string;
  iconFile: string | null;
  bannerFile: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  description: string;
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
    steps.push({ id: `${slug}-${hash(`${key}|${occurrence}`)}`, text, optional, branch });
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
    wikiUrl: `${WIKI_BASE}/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    iconFile: infobox(wikitext, "icon") || null,
    bannerFile: infobox(wikitext, "image") || null,
    // Replaced by direct CDN urls in the API route when the wiki resolves them.
    iconUrl: wikiFileUrl(infobox(wikitext, "icon")),
    bannerUrl: wikiFileUrl(infobox(wikitext, "image")),
    description: cleanWikiText(description),
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
