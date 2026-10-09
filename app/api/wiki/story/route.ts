import { NextResponse } from "next/server";
import { applyPortuguese, chapterRank, parseStoryChapter, type StoryChapter, type StoryData } from "@/lib/story";

export const dynamic = "force-dynamic";

const API = "https://escapefromtarkov.fandom.com/api.php";
const CACHE_MS = 6 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let cache: { expires: number; data: StoryData } | null = null;

async function fandom(params: Record<string, string>) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ format: "json", formatversion: "2", ...params })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "TarkovPersonalTracker/0.13 (personal quest companion)" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Fandom HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function chapterTitles(): Promise<string[]> {
  const payload = await fandom({ action: "query", list: "categorymembers", cmtitle: "Category:Story chapters", cmlimit: "50", cmnamespace: "0" });
  const members = isRecord(payload) && isRecord(payload.query) && Array.isArray(payload.query.categorymembers) ? payload.query.categorymembers : [];
  return members.flatMap((member) => isRecord(member) && typeof member.title === "string" && member.title !== "Story chapters" ? [member.title] : []);
}

async function chapterWikitext(title: string) {
  const payload = await fandom({ action: "parse", page: title, prop: "wikitext", redirects: "1" });
  const wikitext = isRecord(payload) && isRecord(payload.parse) ? payload.parse.wikitext : null;
  if (typeof wikitext !== "string") throw new Error(`No wikitext for ${title}`);
  return wikitext;
}

/** File names → direct CDN urls (Special:FilePath redirects are blocked for hotlinking). */
async function resolveImages(fileNames: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (let index = 0; index < fileNames.length; index += 40) {
    const batch = fileNames.slice(index, index + 40);
    const payload = await fandom({ action: "query", prop: "imageinfo", iiprop: "url", iiurlwidth: "900", titles: batch.map((name) => `File:${name}`).join("|") });
    const pages = isRecord(payload) && isRecord(payload.query) && Array.isArray(payload.query.pages) ? payload.query.pages : [];
    for (const page of pages) {
      if (!isRecord(page) || typeof page.title !== "string" || !Array.isArray(page.imageinfo)) continue;
      const info = page.imageinfo.find(isRecord);
      const url = info && (typeof info.thumburl === "string" ? info.thumburl : typeof info.url === "string" ? info.url : null);
      if (url) resolved.set(page.title.replace(/^File:/, "").replace(/_/g, " "), url);
    }
  }
  return resolved;
}

async function gameLocale(lang: "en" | "pt"): Promise<JsonRecord> {
  // The story is shared by every mode; its strings survive in the tasks locale files.
  const response = await fetch(`https://json.tarkov.dev/regular/tasks_${lang}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`tasks_${lang} HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  return isRecord(payload) && isRecord(payload.data) ? payload.data : {};
}

async function loadStory(): Promise<StoryData> {
  const titles = await chapterTitles();
  if (!titles.length) throw new Error("No story chapters found on the wiki");
  const results = await Promise.allSettled(titles.map(async (title) => parseStoryChapter(title, await chapterWikitext(title))));
  const chapters = results.flatMap((result): StoryChapter[] => (result.status === "fulfilled" && result.value.steps.length ? [result.value] : []));
  if (!chapters.length) throw new Error("Could not parse any story chapter");

  try {
    const files = [...new Set(chapters.flatMap((chapter) => [chapter.iconFile, chapter.bannerFile]).filter((name): name is string => Boolean(name)))];
    const images = await resolveImages(files.map((name) => name.replace(/_/g, " ")));
    for (const chapter of chapters) {
      if (chapter.iconFile) chapter.iconUrl = images.get(chapter.iconFile.replace(/_/g, " ")) ?? chapter.iconUrl;
      if (chapter.bannerFile) chapter.bannerUrl = images.get(chapter.bannerFile.replace(/_/g, " ")) ?? chapter.bannerUrl;
    }
  } catch {
    // Images are decorative; keep the Special:FilePath fallbacks.
  }

  try {
    const [english, portuguese] = await Promise.all([gameLocale("en"), gameLocale("pt")]);
    applyPortuguese(chapters, english, portuguese);
  } catch {
    // Without the locale files the chapters simply stay in English.
  }

  chapters.sort((a, b) => chapterRank(a.title) - chapterRank(b.title) || a.title.localeCompare(b.title));
  return { chapters, fetchedAt: new Date().toISOString(), source: "escapefromtarkov.fandom.com" };
}

export async function GET() {
  try {
    if (!cache || cache.expires < Date.now()) {
      cache = { expires: Date.now() + CACHE_MS, data: await loadStory() };
    }
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, max-age=1800, s-maxage=21600, stale-while-revalidate=3600" },
    });
  } catch (error) {
    // Serve a stale copy rather than nothing when the wiki hiccups.
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json(
      { error: `Não foi possível carregar os capítulos da Wiki (${error instanceof Error ? error.message : "erro desconhecido"}).` },
      { status: 502 },
    );
  }
}
