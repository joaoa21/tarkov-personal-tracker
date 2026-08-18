import {
  CURRENCY_BY_ITEM_ID,
  type CurrencyCode,
  type HideoutStation,
  type ItemNeed,
  type NeedSource,
  type ProfileProgress,
  type TarkovItem,
  type TarkovTask,
} from "./types";

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export function detectCurrency(item: TarkovItem): CurrencyCode | null {
  const byId = CURRENCY_BY_ITEM_ID.get(item.id);
  if (byId) return byId;

  const names = [item.name, item.nameEn, item.shortName, item.shortNameEn].map(normalizeName);
  if (names.some((name) => ["roubles", "rubles", "rublos", "rub", "₽"].includes(name))) return "RUB";
  if (names.some((name) => ["dollars", "dólares", "dolares", "usd", "$"].includes(name))) return "USD";
  if (names.some((name) => ["euros", "eur", "€"].includes(name))) return "EUR";
  return null;
}

function finalizeNeed(
  item: TarkovItem,
  totalNeeded: number,
  foundInRaidNeeded: number,
  sources: NeedSource[],
  progress: ProfileProgress,
): ItemNeed {
  const currency = detectCurrency(item);
  const owned = currency ? progress.wallet[currency] : (progress.inventory[item.id] ?? 0);
  return {
    item,
    currency,
    totalNeeded,
    owned,
    missing: Math.max(0, totalNeeded - owned),
    foundInRaidNeeded,
    sources,
  };
}

export function buildHideoutNeeds(
  stations: HideoutStation[],
  items: TarkovItem[],
  progress: ProfileProgress,
): ItemNeed[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const accumulator = new Map<string, { totalNeeded: number; fir: number; sources: NeedSource[] }>();

  for (const station of stations) {
    const currentLevel = progress.hideoutLevels[station.id] ?? 0;
    for (const level of station.levels) {
      if (level.level <= currentLevel) continue;
      for (const requirement of level.itemRequirements) {
        const existing = accumulator.get(requirement.itemId) ?? { totalNeeded: 0, fir: 0, sources: [] };
        existing.totalNeeded += requirement.count;
        if (requirement.foundInRaid) existing.fir += requirement.count;
        existing.sources.push({
          kind: "hideout",
          count: requirement.count,
          foundInRaid: requirement.foundInRaid,
          label: `${station.name} Nv.${level.level}`,
          labelEn: `${station.nameEn} Lv.${level.level}`,
          stationId: station.id,
          level: level.level,
        });
        accumulator.set(requirement.itemId, existing);
      }
    }
  }

  return [...accumulator.entries()]
    .flatMap(([itemId, need]): ItemNeed[] => {
      const item = itemMap.get(itemId);
      if (!item) return [];
      return [finalizeNeed(item, need.totalNeeded, need.fir, need.sources, progress)];
    })
    .sort(sortNeeds);
}

export function taskIsCompleted(task: TarkovTask, progress: ProfileProgress): boolean {
  if (progress.completedTasks[task.id]) return true;
  return (task.aliasIds ?? []).some((id) => Boolean(progress.completedTasks[id]));
}

export function buildQuestNeeds(
  tasks: TarkovTask[],
  items: TarkovItem[],
  progress: ProfileProgress,
  options: { kappaOnly?: boolean } = {},
): ItemNeed[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const accumulator = new Map<string, { totalNeeded: number; fir: number; sources: NeedSource[] }>();

  for (const task of tasks) {
    if (taskIsCompleted(task, progress)) continue;
    if (options.kappaOnly && !task.kappaRequired) continue;

    for (const requirement of task.itemRequirements) {
      // Multiple IDs normally mean "any of these variants". Counting every option
      // would inflate stash requirements, so keep those visible in the quest page
      // but do not invent a quantity for each alternative in Items to Keep.
      if (requirement.itemIds.length !== 1) continue;
      const itemId = requirement.itemIds[0];
      if (!itemId || !itemMap.has(itemId)) continue;

      const existing = accumulator.get(itemId) ?? { totalNeeded: 0, fir: 0, sources: [] };
      existing.totalNeeded += requirement.count;
      if (requirement.foundInRaid) existing.fir += requirement.count;
      existing.sources.push({
        kind: "quest",
        count: requirement.count,
        foundInRaid: requirement.foundInRaid,
        label: task.name,
        labelEn: task.nameEn,
        taskId: task.id,
        kappaRequired: task.kappaRequired,
        lightkeeperRequired: task.lightkeeperRequired,
      });
      accumulator.set(itemId, existing);
    }

    // Quest keys are reusable: even if the same key is required by several pending
    // tasks, owning one copy satisfies the stash requirement. OR-groups are handled
    // in the dedicated Keys page and are not counted as if every alternative were mandatory.
    for (const requirement of task.keyRequirements) {
      if (requirement.keyIds.length !== 1) continue;
      const itemId = requirement.keyIds[0];
      if (!itemId || !itemMap.has(itemId)) continue;
      const existing = accumulator.get(itemId) ?? { totalNeeded: 0, fir: 0, sources: [] };
      existing.totalNeeded = Math.max(existing.totalNeeded, 1);
      existing.sources.push({
        kind: "quest-key",
        count: 1,
        foundInRaid: false,
        label: task.name,
        labelEn: task.nameEn,
        taskId: task.id,
        kappaRequired: task.kappaRequired,
        lightkeeperRequired: task.lightkeeperRequired,
      });
      accumulator.set(itemId, existing);
    }
  }

  return [...accumulator.entries()]
    .flatMap(([itemId, need]): ItemNeed[] => {
      const item = itemMap.get(itemId);
      if (!item) return [];
      return [finalizeNeed(item, need.totalNeeded, need.fir, need.sources, progress)];
    })
    .sort(sortNeeds);
}

export function mergeNeeds(
  groups: ItemNeed[][],
  progress: ProfileProgress,
): ItemNeed[] {
  const accumulator = new Map<string, { item: TarkovItem; totalNeeded: number; fir: number; sources: NeedSource[] }>();

  for (const group of groups) {
    for (const need of group) {
      const existing = accumulator.get(need.item.id) ?? {
        item: need.item,
        totalNeeded: 0,
        fir: 0,
        sources: [],
      };
      existing.totalNeeded += need.totalNeeded;
      existing.fir += need.foundInRaidNeeded;
      existing.sources.push(...need.sources);
      accumulator.set(need.item.id, existing);
    }
  }

  return [...accumulator.values()]
    .map((entry) => finalizeNeed(entry.item, entry.totalNeeded, entry.fir, entry.sources, progress))
    .sort(sortNeeds);
}

function sortNeeds(a: ItemNeed, b: ItemNeed) {
  if (Boolean(a.currency) !== Boolean(b.currency)) return a.currency ? 1 : -1;
  if (a.missing !== b.missing) return b.missing - a.missing;
  return a.item.name.localeCompare(b.item.name);
}

function isFleaOffer(source: string | null | undefined, vendor: string | null | undefined) {
  const haystack = `${source ?? ""} ${vendor ?? ""}`.toLowerCase();
  return haystack.includes("flea") || haystack.includes("ragfair");
}

export function fleaPrice(item: TarkovItem): number | null {
  if (item.avg24hPrice && item.avg24hPrice > 0) return item.avg24hPrice;
  if (item.lastLowPrice && item.lastLowPrice > 0) return item.lastLowPrice;
  return null;
}

export function bestTraderPrice(item: TarkovItem): { vendor: string; vendorEn: string; price: number } | null {
  const candidates = item.sellFor
    .filter((offer) => !isFleaOffer(offer.source, offer.vendorName))
    .flatMap((offer) => offer.priceRUB && offer.priceRUB > 0
      ? [{ vendor: offer.vendorName, vendorEn: offer.vendorNameEn ?? offer.vendorName, price: offer.priceRUB }]
      : []);
  return candidates.sort((a, b) => b.price - a.price)[0] ?? null;
}

export function bestSellPrice(item: TarkovItem): { vendor: string; vendorEn: string; price: number } | null {
  const candidates: Array<{ vendor: string; vendorEn: string; price: number }> = [];
  const flea = fleaPrice(item);
  const trader = bestTraderPrice(item);
  if (flea) candidates.push({ vendor: "Flea (média 24h)", vendorEn: "Flea (24h average)", price: flea });
  if (trader) candidates.push(trader);
  return candidates.sort((a, b) => b.price - a.price)[0] ?? null;
}

export function valuePerSlot(item: TarkovItem): number | null {
  const best = bestSellPrice(item);
  if (!best) return null;
  return Math.round(best.price / Math.max(1, item.width * item.height));
}

export type TaskChainState = "completed" | "chain-ready" | "blocked-by-task";

function requirementNeedsCompletion(statuses: string[]) {
  if (!statuses.length) return true;
  return statuses.some((status) => {
    const normalized = status.toLowerCase();
    return normalized.includes("complete") || normalized.includes("success") || normalized === "done";
  });
}

/**
 * Returns only quest-chain state. It intentionally does not claim the quest is
 * currently active in EFT because trader loyalty, reputation and patch-specific
 * gates can still apply outside the dependency graph we can verify reliably.
 */
export function taskChainState(task: TarkovTask, progress: ProfileProgress): TaskChainState {
  if (taskIsCompleted(task, progress)) return "completed";
  return missingTaskRequirements(task, progress).length === 0 ? "chain-ready" : "blocked-by-task";
}

export function missingTaskRequirements(task: TarkovTask, progress: ProfileProgress): string[] {
  const missing = new Set<string>();
  for (const requirement of task.taskRequirements) {
    if (!requirementNeedsCompletion(requirement.statuses)) continue;
    if (!progress.completedTasks[requirement.taskId]) missing.add(requirement.taskId);
  }
  return [...missing];
}

// Backwards-compatible helper for any older UI code.
export function taskProgressState(task: TarkovTask, progress: ProfileProgress) {
  const chain = taskChainState(task, progress);
  if (chain === "completed") return "completed" as const;
  if (chain === "blocked-by-task" || progress.playerLevel < task.minPlayerLevel) return "future" as const;
  return "available" as const;
}

export function taskAncestors(taskId: string, tasks: TarkovTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const walk = (id: string) => {
    const task = byId.get(id);
    if (!task) return;
    for (const requirement of task.taskRequirements) {
      if (!requirementNeedsCompletion(requirement.statuses)) continue;
      if (visited.has(requirement.taskId)) continue;
      visited.add(requirement.taskId);
      walk(requirement.taskId);
    }
  };
  walk(taskId);
  return [...visited];
}

export function walletAmount(progress: ProfileProgress, currency: CurrencyCode) {
  return Math.max(0, Math.floor(progress.wallet[currency] ?? 0));
}
