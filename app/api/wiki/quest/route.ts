import { NextRequest, NextResponse } from "next/server";

const API = "https://escapefromtarkov.fandom.com/api.php";
const WIKI = "https://escapefromtarkov.fandom.com/wiki";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return named[entity.toLowerCase()] ?? all;
  });
}

function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

async function fandom(params: Record<string, string>) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ format: "json", formatversion: "2", ...params })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "TarkovPersonalTracker/0.12 (personal quest companion)" },
    next: { revalidate: 21600 },
  });
  if (!response.ok) throw new Error(`Fandom HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function resolvePage(title: string) {
  const exact = await fandom({
    action: "query",
    prop: "info|pageimages",
    inprop: "url",
    piprop: "thumbnail|original",
    pithumbsize: "900",
    redirects: "1",
    titles: title,
  });

  if (isRecord(exact) && isRecord(exact.query) && Array.isArray(exact.query.pages)) {
    const page = exact.query.pages.find((entry) => isRecord(entry) && !entry.missing);
    if (isRecord(page)) return page;
  }

  const search = await fandom({ action: "query", list: "search", srsearch: `intitle:\"${title}\"`, srlimit: "5" });
  if (!isRecord(search) || !isRecord(search.query) || !Array.isArray(search.query.search)) return null;
  const hit = search.query.search.find(isRecord);
  if (!hit || typeof hit.title !== "string") return null;

  const resolved = await fandom({
    action: "query",
    prop: "info|pageimages",
    inprop: "url",
    piprop: "thumbnail|original",
    pithumbsize: "900",
    redirects: "1",
    titles: hit.title,
  });
  if (!isRecord(resolved) || !isRecord(resolved.query) || !Array.isArray(resolved.query.pages)) return null;
  return resolved.query.pages.find((entry) => isRecord(entry) && !entry.missing) as JsonRecord | undefined ?? null;
}

export async function GET(request: NextRequest) {
  const title = request.nextUrl.searchParams.get("title")?.trim();
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

  try {
    const page = await resolvePage(title);
    if (!page) {
      return NextResponse.json({ available: false, pageTitle: title, url: `${WIKI}/${encodeURIComponent(title.replace(/ /g, "_"))}`, thumbnail: null, guideText: "", sections: [] });
    }

    const pageTitle = typeof page.title === "string" ? page.title : title;
    const pageId = typeof page.pageid === "number" ? String(page.pageid) : "";
    const fullurl = typeof page.fullurl === "string" ? page.fullurl : `${WIKI}/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
    const thumbnail = isRecord(page.thumbnail) && typeof page.thumbnail.source === "string" ? page.thumbnail.source : null;

    let sections: string[] = [];
    let guideText = "";
    if (pageId) {
      const parsed = await fandom({ action: "parse", pageid: pageId, prop: "sections" });
      if (isRecord(parsed) && isRecord(parsed.parse) && Array.isArray(parsed.parse.sections)) {
        sections = parsed.parse.sections.flatMap((section): string[] => isRecord(section) && typeof section.line === "string" ? [section.line] : []);
        const guideSection = parsed.parse.sections.find((section) => isRecord(section) && typeof section.line === "string" && /^(guide|walkthrough)$/i.test(section.line.trim()));
        if (isRecord(guideSection) && typeof guideSection.index === "string") {
          const guide = await fandom({ action: "parse", pageid: pageId, section: guideSection.index, prop: "text" });
          if (isRecord(guide) && isRecord(guide.parse) && typeof guide.parse.text === "string") {
            guideText = htmlToText(guide.parse.text).slice(0, 3500);
          }
        }
      }
    }

    return NextResponse.json({ available: true, pageTitle, url: fullurl, thumbnail, guideText, sections });
  } catch (error) {
    return NextResponse.json({
      available: false,
      pageTitle: title,
      url: `${WIKI}/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      thumbnail: null,
      guideText: "",
      sections: [],
      error: error instanceof Error ? error.message : "Wiki unavailable",
    });
  }
}
