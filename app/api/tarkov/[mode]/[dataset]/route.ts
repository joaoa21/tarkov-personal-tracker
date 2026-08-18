import { NextResponse } from "next/server";
import type { GameMode } from "@/lib/types";

// These API routes proxy live Tarkov data. Keep the route handler dynamic in
// production hosts such as Netlify/OpenNext so query-dependent responses are
// never reused as a Next.js route-cache entry.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MODES = new Set<GameMode>(["regular", "pve", "pvp-season"]);
const DATASETS = new Set(["items", "hideout", "tasks", "traders", "maps", "uses", "sell-prices"]);
const BILINGUAL_KEYS = new Set(["name", "shortName", "description", "title"]);

type JsonRecord = Record<string, unknown>;
type TarkovEnvelope = { data: unknown; translations?: unknown };


const ITEM_USES_QUERY = `
  query TrackerItemUses($id: ID!, $gameMode: GameMode!, $lang: LanguageCode!) {
    item(id: $id, gameMode: $gameMode, lang: $lang) {
      id
      bartersUsing {
        id
        level
        buyLimit
        trader { id name imageLink }
        taskUnlock { id name }
        requiredItems {
          count
          quantity
          item { id name shortName iconLink gridImageLink }
        }
        rewardItems {
          count
          quantity
          item { id name shortName iconLink gridImageLink }
        }
      }
      craftsUsing {
        id
        level
        duration
        station { id name imageLink }
        taskUnlock { id name }
        requiredItems {
          count
          quantity
          item { id name shortName iconLink gridImageLink }
        }
        rewardItems {
          count
          quantity
          item { id name shortName iconLink gridImageLink }
        }
      }
    }
  }
`;


const VISIBLE_TRADER_PRICE_QUERY = `
  query TrackerVisibleTraderPrices($ids: [ID], $gameMode: GameMode!) {
    items(ids: $ids, gameMode: $gameMode, lang: en) {
      id
      traderPrices {
        price
        priceRUB
        currency
        trader { id name normalizedName }
      }
    }
  }
`;

const VISIBLE_ITEM_PRICE_QUERY = `
  query TrackerVisibleItemSellPrices($ids: [ID], $gameMode: GameMode!) {
    items(ids: $ids, gameMode: $gameMode, lang: en) {
      id
      sellFor {
        price
        priceRUB
        source
        vendor {
          name
          normalizedName
          ... on TraderOffer {
            trader { id name normalizedName }
          }
        }
      }
    }
  }
`;

const ITEM_PRICE_QUERY = `
  query TrackerItemSellPrices($gameMode: GameMode!) {
    items(gameMode: $gameMode, lang: en) {
      id
      sellFor {
        price
        priceRUB
        source
        vendor {
          name
          normalizedName
          ... on TraderOffer {
            trader {
              id
              name
              normalizedName
            }
          }
        }
      }
    }
  }
`;

function normalizeGraphTraderOffers(entries: unknown): Array<{ vendorId: string | null; vendorName: string; vendorNameEn: string; priceRUB: number; source: string | null }> {
  const offers = Array.isArray(entries) ? entries : [];
  return offers.flatMap((offer) => {
    if (!isRecord(offer)) return [];
    const source = typeof offer.source === "string" ? offer.source : null;
    const sourceLower = source?.toLowerCase() ?? "";
    const vendor = isRecord(offer.vendor) ? offer.vendor : null;
    const trader = vendor && isRecord(vendor.trader) ? vendor.trader : null;
    const vendorNameRaw = trader && typeof trader.name === "string"
      ? trader.name
      : vendor && typeof vendor.name === "string"
        ? vendor.name
        : source ?? "Trader";
    const vendorNameLower = vendorNameRaw.toLowerCase();
    if (sourceLower === "fleamarket" || sourceLower === "flea market" || vendorNameLower.includes("flea")) return [];
    const priceRUB = numeric(offer.priceRUB, numeric(offer.price, 0));
    if (!(priceRUB > 0)) return [];
    const vendorId = trader && typeof trader.id === "string" ? trader.id : null;
    return [{
      vendorId,
      vendorName: vendorNameRaw,
      vendorNameEn: vendorNameRaw,
      priceRUB,
      source,
    }];
  });
}

async function fetchVisibleGraphQlTraderPrices(mode: GameMode, ids: string[]) {
  const gameMode = mode === "pve" ? "pve" : "regular";
  let lastError: unknown = null;

  // Prefer the direct traderPrices field. It is deprecated in GraphQL, but it
  // is still backed by the same current trader-price data used to build
  // sellFor and is considerably simpler/less fragile than resolving Vendor.
  for (const query of [VISIBLE_TRADER_PRICE_QUERY, VISIBLE_ITEM_PRICE_QUERY]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        const response = await fetch("https://api.tarkov.dev/graphql", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables: { ids, gameMode } }),
        });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
        const payload = await response.json() as unknown;
        if (!isRecord(payload)) throw new Error("GraphQL response was not an object");
        const data = isRecord(payload.data) ? payload.data : null;
        const items = data && Array.isArray(data.items) ? data.items : [];
        if (!items.length && Array.isArray(payload.errors) && payload.errors.length) {
          throw new Error("GraphQL returned errors without price data");
        }

        const result: Record<string, ReturnType<typeof normalizeGraphTraderOffers>> = {};
        let foundAny = false;
        for (const entry of items) {
          if (!isRecord(entry)) continue;
          const id = typeof entry.id === "string" ? entry.id : "";
          if (!id) continue;

          let offers: ReturnType<typeof normalizeGraphTraderOffers> = [];
          if (Array.isArray(entry.traderPrices)) {
            offers = entry.traderPrices.flatMap((rawPrice) => {
              if (!isRecord(rawPrice)) return [];
              const trader = isRecord(rawPrice.trader) ? rawPrice.trader : null;
              const vendorName = trader && typeof trader.name === "string" ? trader.name : "Trader";
              const priceRUB = numeric(rawPrice.priceRUB, numeric(rawPrice.price, 0));
              if (!(priceRUB > 0)) return [];
              return [{
                vendorId: trader && typeof trader.id === "string" ? trader.id : null,
                vendorName,
                vendorNameEn: vendorName,
                priceRUB,
                source: vendorName.toLowerCase(),
              }];
            });
          } else {
            offers = normalizeGraphTraderOffers(entry.sellFor);
          }
          result[id] = offers;
          if (offers.length) foundAny = true;
        }

        // If the deprecated direct field returned no usable data at all,
        // transparently retry with the sellFor query below.
        if (!foundAny && query === VISIBLE_TRADER_PRICE_QUERY) break;
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not load visible trader prices");
}

async function fetchGraphQlTraderPrices(mode: GameMode): Promise<Map<string, unknown[]>> {
  // Tarkov.dev's GraphQL schema currently exposes regular + PvE. Season uses
  // the same NPC trader sell values as regular; its Flea prices still come
  // from the season-specific json dataset.
  const gameMode = mode === "pve" ? "pve" : "regular";
  const response = await fetch("https://api.tarkov.dev/graphql", {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: ITEM_PRICE_QUERY, variables: { gameMode } }),
  });

  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  if (!isRecord(payload)) throw new Error("GraphQL response was not an object");
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error("GraphQL returned errors");
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const items = data && Array.isArray(data.items) ? data.items : [];
  const result = new Map<string, unknown[]>();

  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id || !Array.isArray(entry.sellFor)) continue;

    // Only overlay NPC trader offers. Flea remains mode-specific and is
    // represented by avg24hPrice/lastLowPrice from json.tarkov.dev.
    const traderOffers = entry.sellFor.filter((offer) => {
      if (!isRecord(offer)) return false;
      const source = typeof offer.source === "string" ? offer.source.toLowerCase() : "";
      const vendor = isRecord(offer.vendor) ? offer.vendor : null;
      const vendorName = vendor && typeof vendor.name === "string" ? vendor.name.toLowerCase() : "";
      return source !== "fleamarket" && !vendorName.includes("flea");
    });

    if (traderOffers.length) result.set(id, traderOffers);
  }

  return result;
}

function payloadContainsTraderPrices(payload: unknown): boolean {
  if (!isEnvelope(payload) || !isRecord(payload.data)) return false;

  // Current static items payload is { data: { items: { [id]: item } } }.
  // Older snapshots exposed the item map directly under data, so support both.
  const itemContainer = isRecord(payload.data.items) ? payload.data.items : payload.data;
  for (const value of Object.values(itemContainer)) {
    if (!isRecord(value)) continue;
    if (Array.isArray(value.sellToTrader) && value.sellToTrader.length) return true;
    if (Array.isArray(value.traderPrices) && value.traderPrices.length) return true;
    if (Array.isArray(value.sellFor) && value.sellFor.length) return true;
  }
  return false;
}

function overlayItemSellFor(payload: unknown, prices: Map<string, unknown[]>): unknown {
  if (!isEnvelope(payload) || !isRecord(payload.data) || prices.size === 0) return payload;

  const data: JsonRecord = { ...payload.data };
  for (const [key, value] of Object.entries(data)) {
    if (!isRecord(value)) continue;
    const id = typeof value.id === "string"
      ? value.id
      : typeof value._id === "string"
        ? value._id
        : key;
    const sellFor = prices.get(id);
    if (!sellFor) continue;
    data[key] = { ...value, sellFor };
  }

  return { ...payload, data };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is TarkovEnvelope {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "data");
}

function translationMap(payload: unknown): JsonRecord {
  if (!isEnvelope(payload) || !isRecord(payload.data)) return {};
  return payload.data;
}

function translateString(value: string, primary: JsonRecord, english: JsonRecord) {
  const primaryValue = primary[value];
  const englishValue = english[value];
  const pt = typeof primaryValue === "string"
    ? primaryValue
    : typeof englishValue === "string"
      ? englishValue
      : value;
  const en = typeof englishValue === "string" ? englishValue : pt;
  return { pt, en };
}

function bilingualize(value: unknown, primary: JsonRecord, english: JsonRecord): unknown {
  if (Array.isArray(value)) return value.map((entry) => bilingualize(entry, primary, english));
  if (!isRecord(value)) {
    if (typeof value !== "string") return value;
    return translateString(value, primary, english).pt;
  }

  const output: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      const translated = translateString(entry, primary, english);
      output[key] = translated.pt;
      if (BILINGUAL_KEYS.has(key)) output[`${key}En`] = translated.en;
    } else {
      output[key] = bilingualize(entry, primary, english);
    }
  }
  return output;
}


function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numeric(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function fetchGraphQlItemUsesLanguage(mode: GameMode, itemId: string, lang: "pt" | "en") {
  const gameMode = mode === "pve" ? "pve" : "regular";
  const response = await fetch("https://api.tarkov.dev/graphql", {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      query: ITEM_USES_QUERY,
      variables: { id: itemId, gameMode, lang },
    }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  if (!isRecord(payload)) throw new Error("GraphQL response was not an object");
  // GraphQL can legitimately return partial data together with `errors`.
  // Prefer usable item data instead of failing the whole request.
  const data = isRecord(payload.data) ? payload.data : null;
  const item = data && isRecord(data.item) ? data.item : null;
  if (item) return item;
  if (Array.isArray(payload.errors) && payload.errors.length) throw new Error("GraphQL returned errors without item data");
  return null;
}

function mergeUsageItem(primary: unknown, english: unknown) {
  const pt = isRecord(primary) ? primary : {};
  const en = isRecord(english) ? english : {};
  const id = text(pt.id, text(en.id));
  const name = text(pt.name, text(en.name, id));
  const nameEn = text(en.name, name);
  const shortName = text(pt.shortName, text(en.shortName, name));
  const shortNameEn = text(en.shortName, shortName);
  return {
    id, name, nameEn, shortName, shortNameEn,
    iconLink: text(pt.iconLink, text(en.iconLink)) || null,
    gridImageLink: text(pt.gridImageLink, text(en.gridImageLink)) || null,
  };
}

function mergeContained(primary: unknown, english: unknown) {
  const ptItems = records(primary);
  const enById = new Map(records(english).map((entry) => {
    const item = isRecord(entry.item) ? entry.item : {};
    return [text(item.id), entry] as const;
  }));
  return ptItems.flatMap((entry) => {
    const ptItem = isRecord(entry.item) ? entry.item : null;
    const id = ptItem ? text(ptItem.id) : "";
    if (!id) return [];
    const enEntry = enById.get(id);
    const enItem = enEntry && isRecord(enEntry.item) ? enEntry.item : null;
    return [{
      item: mergeUsageItem(ptItem, enItem),
      count: numeric(entry.count, numeric(entry.quantity, 0)),
    }];
  });
}

function mergeUnlock(primary: unknown, english: unknown) {
  if (!isRecord(primary) && !isRecord(english)) return null;
  const pt = isRecord(primary) ? primary : {};
  const en = isRecord(english) ? english : {};
  const id = text(pt.id, text(en.id));
  if (!id) return null;
  const name = text(pt.name, text(en.name, id));
  return { id, name, nameEn: text(en.name, name) };
}

function normalizeItemUses(itemId: string, primary: JsonRecord | null, english: JsonRecord | null) {
  const ptBarters = primary ? records(primary.bartersUsing) : [];
  const enBarterById = new Map((english ? records(english.bartersUsing) : []).map((entry) => [text(entry.id), entry] as const));
  const barters = ptBarters.flatMap((entry) => {
    const id = text(entry.id);
    const en = enBarterById.get(id) ?? {};
    const ptTrader = isRecord(entry.trader) ? entry.trader : {};
    const enTrader = isRecord(en.trader) ? en.trader : {};
    const traderId = text(ptTrader.id, text(enTrader.id));
    if (!id || !traderId) return [];
    const traderName = text(ptTrader.name, text(enTrader.name, traderId));
    return [{
      id,
      trader: {
        id: traderId,
        name: traderName,
        nameEn: text(enTrader.name, traderName),
        imageLink: text(ptTrader.imageLink, text(enTrader.imageLink)) || null,
      },
      level: Math.max(1, Math.floor(numeric(entry.level, 1))),
      buyLimit: entry.buyLimit === null || entry.buyLimit === undefined ? null : numeric(entry.buyLimit, 0),
      taskUnlock: mergeUnlock(entry.taskUnlock, en.taskUnlock),
      requiredItems: mergeContained(entry.requiredItems, en.requiredItems),
      rewardItems: mergeContained(entry.rewardItems, en.rewardItems),
    }];
  });

  const ptCrafts = primary ? records(primary.craftsUsing) : [];
  const enCraftById = new Map((english ? records(english.craftsUsing) : []).map((entry) => [text(entry.id), entry] as const));
  const crafts = ptCrafts.flatMap((entry) => {
    const id = text(entry.id);
    const en = enCraftById.get(id) ?? {};
    const ptStation = isRecord(entry.station) ? entry.station : {};
    const enStation = isRecord(en.station) ? en.station : {};
    const stationId = text(ptStation.id, text(enStation.id));
    if (!id || !stationId) return [];
    const stationName = text(ptStation.name, text(enStation.name, stationId));
    return [{
      id,
      station: {
        id: stationId,
        name: stationName,
        nameEn: text(enStation.name, stationName),
        imageLink: text(ptStation.imageLink, text(enStation.imageLink)) || null,
      },
      level: Math.max(1, Math.floor(numeric(entry.level, 1))),
      duration: Math.max(0, numeric(entry.duration, 0)),
      taskUnlock: mergeUnlock(entry.taskUnlock, en.taskUnlock),
      requiredItems: mergeContained(entry.requiredItems, en.requiredItems),
      rewardItems: mergeContained(entry.rewardItems, en.rewardItems),
    }];
  });

  barters.sort((a, b) => a.trader.name.localeCompare(b.trader.name) || a.level - b.level);
  crafts.sort((a, b) => a.station.name.localeCompare(b.station.name) || a.level - b.level);
  return { itemId, barters, crafts };
}


function asRefId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isRecord(value)) return text(value.id, text(value._id));
  return "";
}

function collectionFrom(payload: unknown, keys: string[]): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) return Object.values(value).filter(isRecord);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "data")) {
    const nested = collectionFrom(payload.data, keys);
    if (nested.length) return nested;
  }
  const values = Object.values(payload).filter(isRecord);
  return values;
}

function staticUsageItem(value: unknown, fallbackEntry?: JsonRecord) {
  const source = isRecord(value) ? value : {};
  const id = asRefId(value) || asRefId(fallbackEntry?.itemId) || asRefId(fallbackEntry?.id);
  const name = text(source.name, text(fallbackEntry?.name, id));
  const shortName = text(source.shortName, text(fallbackEntry?.shortName, name));
  return {
    id,
    name,
    nameEn: text(source.nameEn, name),
    shortName,
    shortNameEn: text(source.shortNameEn, shortName),
    iconLink: text(source.iconLink) || null,
    gridImageLink: text(source.gridImageLink, text(source.image512pxLink, text(source.baseImageLink))) || null,
  };
}

function staticContained(value: unknown) {
  type Contained = { item: ReturnType<typeof staticUsageItem>; count: number };

  const parseEntry = (entry: unknown, fallbackItemId = "", fallbackCount = 1): Contained[] => {
    // Some JSON snapshots use a bare item id, or an object-map of itemId -> count.
    if (typeof entry === "string" || typeof entry === "number") {
      const primitiveId = typeof entry === "string" ? entry : fallbackItemId;
      const itemId = primitiveId || fallbackItemId;
      if (!itemId) return [];
      const count = typeof entry === "number" ? entry : fallbackCount;
      if (!(count > 0)) return [];
      return [{ item: staticUsageItem(itemId, { id: itemId }), count }];
    }
    if (!isRecord(entry)) return [];

    const itemValue = entry.item
      ?? entry.itemId
      ?? entry.requiredItem
      ?? entry.rewardItem
      ?? entry.outputItem
      ?? entry.resultItem
      ?? fallbackItemId;
    const item = staticUsageItem(itemValue, { ...entry, id: asRefId(itemValue) || fallbackItemId });
    if (!item.id) return [];
    const count = numeric(
      entry.count,
      numeric(entry.quantity, numeric(entry.amount, numeric(entry.value, numeric(entry.stackCount, fallbackCount)))),
    );
    if (!(count > 0)) return [];
    return [{ item, count }];
  };

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseEntry(entry));
  }

  if (isRecord(value)) {
    // A single ContainedItem object.
    if (
      Object.prototype.hasOwnProperty.call(value, "item")
      || Object.prototype.hasOwnProperty.call(value, "itemId")
      || Object.prototype.hasOwnProperty.call(value, "requiredItem")
      || Object.prototype.hasOwnProperty.call(value, "rewardItem")
    ) {
      return parseEntry(value);
    }

    // Or a compact object-map: { "itemId": 2 } / { "itemId": { count: 2 } }.
    return Object.entries(value).flatMap(([itemId, entry]) => {
      if (isRecord(entry)) return parseEntry(entry, itemId);
      const count = numeric(entry, 0);
      return count > 0 ? parseEntry(itemId, itemId, count) : [];
    });
  }

  return parseEntry(value);
}

function staticUnlock(value: unknown) {
  const id = asRefId(value);
  if (!id) return null;
  const raw = isRecord(value) ? value : {};
  const name = text(raw.name, id);
  return { id, name, nameEn: text(raw.nameEn, name) };
}

function normalizeStaticItemUses(itemId: string, barterPayload: unknown, craftPayload: unknown) {
  const barterRows = collectionFrom(barterPayload, ["barters"]);
  const craftRows = collectionFrom(craftPayload, ["crafts"]);

  const barters = barterRows.flatMap((entry) => {
    const requiredItems = staticContained(entry.requiredItems ?? entry.requirements ?? entry.itemsRequired);
    if (!requiredItems.some((required) => required.item.id === itemId)) return [];
    // json.tarkov.dev /barters publishes the single barter reward as `offeredItem`.
    // Legacy GraphQL/KV snapshots used `rewardItems`, so retain those fallbacks.
    const rewardItems = staticContained(entry.offeredItem ?? entry.rewardItems ?? entry.rewardItem ?? entry.rewards ?? entry.reward ?? entry.itemsRewarded ?? entry.itemsReward ?? entry.outputItems ?? entry.outputItem ?? entry.resultItems ?? entry.result ?? entry.items);
    const traderValue = entry.trader ?? entry.traderId ?? entry.source;
    const traderRaw = isRecord(traderValue) ? traderValue : {};
    const traderId = asRefId(traderValue) || text(entry.traderId) || text(entry.source);
    if (!traderId) return [];
    const traderName = text(traderRaw.name, traderId);
    return [{
      id: asRefId(entry.id ?? entry._id) || `barter-${traderId}-${itemId}-${barterRows.indexOf(entry)}`,
      trader: {
        id: traderId,
        name: traderName,
        nameEn: text(traderRaw.nameEn, traderName),
        imageLink: text(traderRaw.imageLink) || null,
      },
      level: Math.max(1, Math.floor(numeric(entry.level, numeric(entry.traderLevel, numeric(entry.minTraderLevel, 1))))),
      buyLimit: entry.buyLimit === null || entry.buyLimit === undefined ? null : numeric(entry.buyLimit, 0),
      taskUnlock: staticUnlock(entry.taskUnlock ?? entry.task ?? entry.unlockTask),
      requiredItems,
      rewardItems,
    }];
  });

  const crafts = craftRows.flatMap((entry) => {
    const requiredItems = staticContained(entry.requiredItems ?? entry.requirements ?? entry.itemsRequired);
    if (!requiredItems.some((required) => required.item.id === itemId)) return [];
    // json.tarkov.dev /crafts publishes the craft output as `productItem`.
    const rewardItems = staticContained(entry.productItem ?? entry.rewardItems ?? entry.rewardItem ?? entry.rewards ?? entry.reward ?? entry.itemsRewarded ?? entry.itemsReward ?? entry.outputItems ?? entry.outputItem ?? entry.resultItems ?? entry.result ?? entry.items);
    const stationValue = entry.station ?? entry.stationId ?? entry.hideoutStation ?? entry.source;
    const stationRaw = isRecord(stationValue) ? stationValue : {};
    const stationId = asRefId(stationValue) || text(entry.stationId) || text(entry.source);
    if (!stationId) return [];
    const stationName = text(stationRaw.name, stationId);
    return [{
      id: asRefId(entry.id ?? entry._id) || `craft-${stationId}-${itemId}-${craftRows.indexOf(entry)}`,
      station: {
        id: stationId,
        name: stationName,
        nameEn: text(stationRaw.nameEn, stationName),
        imageLink: text(stationRaw.imageLink) || null,
      },
      level: Math.max(1, Math.floor(numeric(entry.level, numeric(entry.stationLevel, 1)))),
      duration: Math.max(0, numeric(entry.duration, numeric(entry.durationSeconds, 0))),
      taskUnlock: staticUnlock(entry.taskUnlock ?? entry.task ?? entry.unlockTask),
      requiredItems,
      rewardItems,
    }];
  });

  return { itemId, barters, crafts };
}

const staticUsesCache = new Map<string, { expires: number; payload: unknown }>();

async function fetchStaticUsageDataset(url: string) {
  const cached = staticUsesCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.payload;
  const payload = await fetchJson(url);
  staticUsesCache.set(url, { expires: Date.now() + 30 * 60 * 1000, payload });
  return payload;
}

async function fetchStaticItemUses(mode: GameMode, itemId: string) {
  // json.tarkov.dev supports all three modes, including pvp-season.
  const [barters, crafts] = await Promise.all([
    fetchStaticUsageDataset(`https://json.tarkov.dev/${mode}/barters`),
    fetchStaticUsageDataset(`https://json.tarkov.dev/${mode}/crafts`),
  ]);
  return normalizeStaticItemUses(itemId, barters, crafts);
}

async function fetchGraphQlItemUses(mode: GameMode, itemId: string) {
  const [pt, en] = await Promise.all([
    fetchGraphQlItemUsesLanguage(mode, itemId, "pt"),
    fetchGraphQlItemUsesLanguage(mode, itemId, "en"),
  ]);
  return normalizeItemUses(itemId, pt, en);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ mode: string; dataset: string }> },
) {
  const { mode, dataset } = await context.params;

  if (!MODES.has(mode as GameMode) || !DATASETS.has(dataset)) {
    return NextResponse.json(
      { error: "Unsupported Tarkov dataset or game mode." },
      { status: 400 },
    );
  }

  if (dataset === "sell-prices") {
    const rawIds = new URL(request.url).searchParams.get("ids") ?? "";
    const ids = Array.from(new Set(rawIds.split(",").map((id) => id.trim()).filter((id) => /^[a-fA-F0-9]{24}$/.test(id)))).slice(0, 40);
    if (!ids.length) return NextResponse.json({ data: {} });
    try {
      const prices = await fetchVisibleGraphQlTraderPrices(mode as GameMode, ids);
      return NextResponse.json({ data: prices }, {
        headers: { "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=120" },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      // This is an enhancement endpoint. Return a soft failure so the static JSON
      // prices remain usable instead of breaking Raid Mode.
      return NextResponse.json({ data: {}, warning: detail }, { status: 200 });
    }
  }

  if (dataset === "uses") {
    const itemId = new URL(request.url).searchParams.get("itemId")?.trim() ?? "";
    if (!/^[a-fA-F0-9]{24}$/.test(itemId)) {
      return NextResponse.json({ error: "A valid Tarkov itemId is required." }, { status: 400 });
    }
    try {
      // Prefer the current static JSON API. The legacy GraphQL service is
      // maintained for compatibility but is known to be intermittently unavailable.
      const payload = await fetchStaticItemUses(mode as GameMode, itemId);
      return NextResponse.json(payload, {
        headers: {
          // Item Intelligence is keyed by ?itemId=. Do not let a hosting/CDN
          // layer reuse another item's payload. The large upstream barter/craft
          // datasets are already cached inside this function instance.
          "Cache-Control": "no-store, max-age=0",
          "Netlify-CDN-Cache-Control": "no-store",
          "Netlify-Vary": "query=itemId",
          "X-Tarkov-Item-Id": itemId,
        },
      });
    } catch (staticError) {
      try {
        const payload = await fetchGraphQlItemUses(mode as GameMode, itemId);
        return NextResponse.json(payload, {
          headers: {
            "Cache-Control": "no-store, max-age=0",
            "Netlify-CDN-Cache-Control": "no-store",
            "Netlify-Vary": "query=itemId",
            "X-Tarkov-Item-Id": itemId,
          },
        });
      } catch (graphError) {
        const staticDetail = staticError instanceof Error ? staticError.message : "unknown static error";
        const graphDetail = graphError instanceof Error ? graphError.message : "unknown GraphQL error";
        return NextResponse.json(
          { error: `Could not load item usages (JSON: ${staticDetail}; GraphQL: ${graphDetail}).` },
          { status: 502 },
        );
      }
    }
  }

  const baseUrl = `https://json.tarkov.dev/${mode}/${dataset}`;

  try {
    const basePayload = await fetchJson(baseUrl);
    let payload = basePayload;

    if (isEnvelope(basePayload) && Array.isArray(basePayload.translations) && basePayload.translations.length) {
      const [ptResult, enResult] = await Promise.allSettled([
        fetchJson(`${baseUrl}_pt`),
        fetchJson(`${baseUrl}_en`),
      ]);
      const pt = ptResult.status === "fulfilled" ? translationMap(ptResult.value) : {};
      const en = enResult.status === "fulfilled" ? translationMap(enResult.value) : {};
      payload = bilingualize(basePayload, pt, en);
    }

    if (dataset === "items" && !payloadContainsTraderPrices(payload)) {
      try {
        const graphPrices = await fetchGraphQlTraderPrices(mode as GameMode);
        payload = overlayItemSellFor(payload, graphPrices);
      } catch {
        // The static JSON dataset remains the source of truth. Do not flood the
        // dev console when the legacy GraphQL service is unavailable.
      }
    }

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": dataset === "items"
          ? "public, max-age=300, s-maxage=1800, stale-while-revalidate=300"
          : "public, max-age=900, s-maxage=7200, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json(
      { error: `Could not reach json.tarkov.dev (${detail}).` },
      { status: 502 },
    );
  }
}
