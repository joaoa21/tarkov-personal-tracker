import type {
  HideoutItemRequirement,
  HideoutLevel,
  HideoutStation,
  TarkovItem,
  TarkovMap,
  TarkovTask,
  TarkovTrader,
  TaskItemRequirement,
  TaskKeyRequirement,
  TaskRequirement,
  TaskObjectiveSummary,
  TaskRewardItem,
  TaskTraderStandingReward,
  VendorPrice,
} from "./types";

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isRecord(value)) return asId(value.id ?? value._id);
  return "";
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toRecordArray(value: unknown): AnyRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return Object.values(value).filter(isRecord);
  return [];
}

function toPriceRecordArray(value: unknown): AnyRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (isRecord(entry)) return [entry];
      const numeric = nullableNumber(entry);
      return numeric !== null ? [{ priceRUB: numeric, source: String(index) }] : [];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (isRecord(entry)) {
      return [{
        ...entry,
        trader: entry.trader ?? entry.traderId ?? entry.vendorId ?? key,
        source: entry.source ?? key,
      }];
    }
    const numeric = nullableNumber(entry);
    if (numeric === null) return [];
    return [{ trader: key, source: key, priceRUB: numeric }];
  });
}

function toUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return [];
}

function findCollection(payload: unknown, preferredKeys: string[]): AnyRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  for (const key of preferredKeys) {
    if (!(key in payload)) continue;
    const rows = toRecordArray(payload[key]);
    if (rows.length) return rows;
  }

  if ("data" in payload) {
    const nested = findCollection(payload.data, preferredKeys);
    if (nested.length) return nested;
  }

  const keys = Object.keys(payload);
  if (keys.length > 0 && keys.every((key) => key === "data" || key === "translations")) {
    return [];
  }

  return toRecordArray(payload);
}

function localized(raw: AnyRecord, key: string, fallback = "") {
  const primary = asString(raw[key], fallback);
  const english = asString(raw[`${key}En`], primary);
  return { primary, english };
}

function foundInRaidFrom(raw: AnyRecord): boolean {
  if (typeof raw.foundInRaid === "boolean") return raw.foundInRaid;
  if (isRecord(raw.attributes)) {
    const value = raw.attributes.foundInRaid;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value === "true";
  }
  if (Array.isArray(raw.attributes)) {
    return raw.attributes.some((entry) => {
      if (!isRecord(entry)) return false;
      if (entry.name !== "foundInRaid" && entry.type !== "foundInRaid") return false;
      return entry.value === true || entry.value === "true";
    });
  }
  return false;
}

export function normalizeTraders(payload: unknown): TarkovTrader[] {
  const rawTraders = findCollection(payload, ["traders"]);
  return rawTraders.flatMap((raw): TarkovTrader[] => {
    const id = asId(raw.id ?? raw._id);
    if (!id) return [];
    const name = localized(raw, "name", id);
    return [{
      id,
      name: name.primary,
      nameEn: name.english,
      imageLink: asString(raw.imageLink) || null,
    }];
  });
}

export function normalizeItems(payload: unknown, traders: TarkovTrader[] = []): TarkovItem[] {
  const rawItems = findCollection(payload, ["items"]);
  const traderMap = new Map(traders.map((trader) => [trader.id, trader]));

  return rawItems.flatMap((raw): TarkovItem[] => {
    const id = asId(raw.id ?? raw._id);
    if (!id) return [];

    const name = localized(raw, "name", id);
    const shortName = localized(raw, "shortName", name.primary);
    // Current json.tarkov.dev publishes NPC buy prices as `sellToTrader`.
    // Keep legacy/GraphQL variants as fallbacks so older snapshots still work.
    const rawSellFor = [
      ...toPriceRecordArray(raw.sellToTrader),
      ...toPriceRecordArray(raw.sellFor),
      ...toPriceRecordArray(raw.traderPrices),
      ...toPriceRecordArray(raw.traderSellPrices),
    ];

    const sellFor: VendorPrice[] = rawSellFor.flatMap((price): VendorPrice[] => {
      const priceRUB = nullableNumber(price.priceRUB)
        ?? nullableNumber(price.priceRub)
        ?? nullableNumber(price.roublePrice)
        ?? nullableNumber(price.rublePrice)
        ?? nullableNumber(price.valueRUB)
        ?? nullableNumber(price.price);
      if (priceRUB === null || priceRUB <= 0) return [];

      const vendorRecord = isRecord(price.vendor) ? price.vendor : null;
      const vendorId =
        asId(price.trader) ||
        asId(price.traderId) ||
        (vendorRecord ? asId(vendorRecord.trader) || asId(vendorRecord.trader_id) || asId(vendorRecord.traderId) : "") ||
        asId(price.vendor) ||
        null;

      const trader = vendorId ? traderMap.get(vendorId) : undefined;
      let vendorName = trader?.name ?? "";
      let vendorNameEn = trader?.nameEn ?? null;

      if (!vendorName && vendorRecord) {
        vendorName = asString(vendorRecord.name);
        vendorNameEn = asString(vendorRecord.nameEn) || vendorName || null;
      }

      const source = asString(price.source) || null;

      // `source` can itself be the trader slug (therapist, prapor, etc.).
      // Prefer the translated trader record when we can resolve the id.
      if (!vendorName && source) {
        const sourceTrader = traders.find((candidate) => {
          const names = [candidate.name, candidate.nameEn]
            .filter(Boolean)
            .map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
          return names.includes(source.toLowerCase().replace(/[^a-z0-9]/g, ""));
        });
        if (sourceTrader) {
          vendorName = sourceTrader.name;
          vendorNameEn = sourceTrader.nameEn;
        }
      }

      if (!vendorName) vendorName = source ?? (vendorId || "Unknown");
      if (!vendorNameEn) vendorNameEn = vendorName;

      return [{ vendorId, vendorName, vendorNameEn, priceRUB, source }];
    });

    const dedupedSellFor = Array.from(new Map(sellFor.map((offer) => [
      `${offer.vendorId ?? offer.vendorName}|${offer.priceRUB}|${offer.source ?? ""}`,
      offer,
    ])).values());

    const types = Array.isArray(raw.types)
      ? raw.types.filter((entry): entry is string => typeof entry === "string")
      : [];
    const properties = isRecord(raw.properties) ? raw.properties : null;

    return [{
      id,
      name: name.primary,
      nameEn: name.english,
      shortName: shortName.primary,
      shortNameEn: shortName.english,
      width: Math.max(1, asNumber(raw.width, 1)),
      height: Math.max(1, asNumber(raw.height, 1)),
      iconLink: asString(raw.iconLink) || null,
      gridImageLink:
        asString(raw.gridImageLink) ||
        asString(raw.image512pxLink) ||
        asString(raw.baseImageLink) ||
        null,
      avg24hPrice: nullableNumber(raw.avg24hPrice),
      low24hPrice: nullableNumber(raw.low24hPrice),
      high24hPrice: nullableNumber(raw.high24hPrice),
      lastLowPrice: nullableNumber(raw.lastLowPrice),
      sellFor: dedupedSellFor,
      types,
      keyUses: properties ? nullableNumber(properties.uses) : null,
    }];
  });
}

function normalizeRequirement(raw: unknown): HideoutItemRequirement | null {
  if (!isRecord(raw)) return null;
  const itemId = asId(raw.item) || asId(raw.itemId) || asId(raw.requiredItem);
  const count = asNumber(raw.count, asNumber(raw.quantity, asNumber(raw.amount, asNumber(raw.value, 0))));
  if (!itemId || count <= 0) return null;
  return { itemId, count, foundInRaid: foundInRaidFrom(raw) };
}

function normalizeLevel(raw: unknown): HideoutLevel | null {
  if (!isRecord(raw)) return null;
  const level = asNumber(raw.level, asNumber(raw.stage, -1));
  if (level < 0) return null;
  const requirements = findCollection(raw, ["itemRequirements", "requiredItems", "items"]);
  return {
    id: asId(raw.id) || `level-${level}`,
    level,
    itemRequirements: requirements
      .map(normalizeRequirement)
      .filter((entry): entry is HideoutItemRequirement => entry !== null),
  };
}

export function normalizeHideout(payload: unknown): HideoutStation[] {
  const rawStations = findCollection(payload, ["hideoutStations", "stations", "hideout"]);
  return rawStations.flatMap((raw): HideoutStation[] => {
    const id = asId(raw.id ?? raw._id ?? raw.areaId);
    if (!id) return [];
    const name = localized(raw, "name", id);
    const levels = findCollection(raw.levels, [])
      .map(normalizeLevel)
      .filter((entry): entry is HideoutLevel => entry !== null)
      .sort((a, b) => a.level - b.level);
    if (!levels.length) return [];
    return [{
      id,
      name: name.primary,
      nameEn: name.english,
      imageLink: asString(raw.imageLink) || null,
      levels,
    }];
  });
}

function normalizeTaskRequirement(raw: unknown): TaskRequirement | null {
  if (!isRecord(raw)) return null;
  const taskId = asId(raw.task) || asId(raw.taskId);
  if (!taskId) return null;
  const statuses = Array.isArray(raw.status)
    ? raw.status.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(raw.statuses)
      ? raw.statuses.filter((entry): entry is string => typeof entry === "string")
      : [];
  return { taskId, statuses };
}

function normalizeTaskItemRequirement(raw: unknown): TaskItemRequirement | null {
  if (!isRecord(raw)) return null;
  const type = asString(raw.type);
  const typeLower = type.toLowerCase();
  if (typeLower.includes("questitem")) return null;

  const itemIds = [asId(raw.item), ...(
    Array.isArray(raw.items) ? raw.items.map(asId) : []
  )].filter(Boolean);
  const uniqueItemIds = [...new Set(itemIds)];
  const count = asNumber(raw.count, asNumber(raw.quantity, 0));

  const looksLikeStashRequirement =
    typeLower === "giveitem" ||
    typeLower === "finditem" ||
    typeLower === "haveitem" ||
    (uniqueItemIds.length > 0 && foundInRaidFrom(raw));

  if (!looksLikeStashRequirement || !uniqueItemIds.length || count <= 0) return null;
  const description = localized(raw, "description", type || "Item objective");
  return {
    itemIds: uniqueItemIds,
    count,
    foundInRaid: foundInRaidFrom(raw),
    objectiveId: asId(raw.id) || `${type}-${uniqueItemIds.join("-")}`,
    objectiveType: type,
    description: description.primary,
    descriptionEn: description.english,
  };
}

function dedupeTaskItemRequirements(requirements: TaskItemRequirement[]): TaskItemRequirement[] {
  // Tarkov task data can expose the same physical requirement more than once,
  // most commonly as separate "find" and "hand over" objectives. Those
  // objectives refer to the same stack of items and must not be added twice.
  // Collapse identical item sets + quantities inside one task, preserving FIR
  // whenever any duplicate says the items must be found in raid.
  const bySignature = new Map<string, TaskItemRequirement>();

  for (const requirement of requirements) {
    const itemIds = [...requirement.itemIds].sort();
    const signature = `${itemIds.join(",")}|${requirement.count}`;
    const existing = bySignature.get(signature);

    if (!existing) {
      bySignature.set(signature, { ...requirement, itemIds });
      continue;
    }

    bySignature.set(signature, {
      ...existing,
      foundInRaid: existing.foundInRaid || requirement.foundInRaid,
      // Prefer the objective that explicitly carries FIR so the quest detail
      // remains as informative as possible.
      objectiveId: requirement.foundInRaid && !existing.foundInRaid
        ? requirement.objectiveId
        : existing.objectiveId,
      objectiveType: requirement.foundInRaid && !existing.foundInRaid
        ? requirement.objectiveType
        : existing.objectiveType,
      description: requirement.foundInRaid && !existing.foundInRaid
        ? requirement.description
        : existing.description,
      descriptionEn: requirement.foundInRaid && !existing.foundInRaid
        ? requirement.descriptionEn
        : existing.descriptionEn,
    });
  }

  return [...bySignature.values()];
}

function normalizeRequirementKind(value: unknown): string {
  return asString(value).toLowerCase().replace(/[^a-z]/g, "");
}

function taskStartRequirementCandidates(raw: AnyRecord): AnyRecord[] {
  const candidates: AnyRecord[] = [
    ...toRecordArray(raw.traderLevelRequirements),
    ...toRecordArray(raw.traderRequirements),
  ];

  // Patch 1.1 moved most side tasks behind trader LL gates. Depending on the
  // upstream extractor/version, those start conditions can arrive either as
  // normalized `traderRequirements` or in the game's original
  // `conditions.AvailableForStart` shape.
  const conditions = isRecord(raw.conditions) ? raw.conditions : null;
  if (conditions) {
    for (const key of ["AvailableForStart", "availableForStart", "Start", "start"]) {
      candidates.push(...toRecordArray(conditions[key]));
    }
  } else {
    candidates.push(...toRecordArray(raw.conditions));
  }

  for (const key of [
    "availableForStart",
    "startRequirements",
    "requirementsAvailableForStart",
    "startConditions",
    "requirements",
  ]) {
    candidates.push(...toRecordArray(raw[key]));
  }

  return candidates;
}

function normalizeTaskLoyaltyLevel(raw: AnyRecord, traderId: string | null): number {
  const levels: number[] = [];

  for (const requirement of taskStartRequirementCandidates(raw)) {
    const requirementTraderId =
      asId(requirement.trader) ||
      asId(requirement.traderId) ||
      asId(requirement.target);
    if (traderId && requirementTraderId && requirementTraderId !== traderId) continue;

    const requirementType = normalizeRequirementKind(requirement.requirementType);
    const conditionType = normalizeRequirementKind(requirement.conditionType);
    const genericType = normalizeRequirementKind(requirement.type);
    const kind = requirementType || conditionType || genericType;

    const explicitLevel = asNumber(
      requirement.level,
      asNumber(requirement.loyaltyLevel, asNumber(requirement.traderLevel, 0)),
    );
    const value = asNumber(requirement.value, 0);

    let level = explicitLevel;

    // Normalized tarkov.dev/TarkovTracker shape.
    if (level <= 0 && (kind === "level" || kind === "traderlevel" || kind === "traderloyalty")) {
      level = value;
    }

    // Raw BSG quest conditions use TraderLoyalty for the 1.1 task buckets.
    // Some extractors expose the same gate as TraderStanding. Only treat an
    // integer in the real LL range as a loyalty rank so reputation thresholds
    // such as 0.20 / 0.35 / 0.60 are never mistaken for LLs.
    if (
      level <= 0 &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 4 &&
      (
        conditionType === "traderloyalty" ||
        conditionType === "traderstanding" ||
        requirementType === "traderloyalty" ||
        requirementType === "traderlevel" ||
        kind === ""
      )
    ) {
      level = value;
    }

    if (Number.isFinite(level) && level >= 1 && level <= 4) {
      levels.push(Math.floor(level));
    }
  }

  const direct = asNumber(
    raw.traderLoyaltyLevel,
    asNumber(raw.loyaltyLevel, asNumber(raw.traderLevel, 0)),
  );
  if (direct >= 1 && direct <= 4) levels.push(Math.floor(direct));

  // LL is an explicit assignment in Tarkov 1.1; player level and the old
  // quest-chain prerequisites are different gates and must not be used to
  // infer this bucket. Tasks with no loyalty condition remain LL1.
  return levels.length ? Math.max(...levels) : 1;
}

function normalizeTaskKeyRequirements(raw: unknown): TaskKeyRequirement[] {
  if (!isRecord(raw)) return [];
  const groups = toUnknownArray(raw.requiredKeys);
  if (!groups.length) return [];
  const description = localized(raw, "description", asString(raw.type) || "Quest key");
  const objectiveId = asId(raw.id) || asString(raw.type) || "key-objective";

  return groups.flatMap((group, index): TaskKeyRequirement[] => {
    const values = Array.isArray(group) ? group : [group];
    const keyIds = [...new Set(values.map(asId).filter(Boolean))];
    if (!keyIds.length) return [];
    return [{
      keyIds,
      objectiveId: `${objectiveId}-keys-${index}`,
      description: description.primary,
      descriptionEn: description.english,
      optional: asBoolean(raw.optional),
    }];
  });
}


function normalizeTaskObjectiveSummary(raw: unknown): TaskObjectiveSummary | null {
  if (!isRecord(raw)) return null;
  const id = asId(raw.id) || asString(raw.type) || "objective";
  const description = localized(raw, "description", asString(raw.type) || "Objetivo");
  const itemIds = [...new Set([
    asId(raw.item),
    asId(raw.questItem),
    asId(raw.markerItem),
    ...toUnknownArray(raw.items).map(asId),
  ].filter(Boolean))];
  const mapIds = [...new Set(toUnknownArray(raw.maps ?? raw.map_ids).map(asId).filter(Boolean))];
  const count = nullableNumber(raw.count ?? raw.quantity ?? raw.value);
  return {
    id,
    type: asString(raw.type, "objective"),
    description: description.primary,
    descriptionEn: description.english,
    mapIds,
    count,
    foundInRaid: foundInRaidFrom(raw),
    itemIds,
  };
}

function normalizeTaskRewardItems(raw: unknown): TaskRewardItem[] {
  if (!isRecord(raw)) return [];
  return toRecordArray(raw.items).flatMap((entry): TaskRewardItem[] => {
    const itemId = asId(entry.item ?? entry.itemId ?? entry.id);
    const count = asNumber(entry.count, asNumber(entry.quantity, 1));
    if (!itemId || count <= 0) return [];
    return [{ itemId, count }];
  });
}

function normalizeTaskTraderStanding(raw: unknown): TaskTraderStandingReward[] {
  if (!isRecord(raw)) return [];
  return toRecordArray(raw.traderStanding).flatMap((entry): TaskTraderStandingReward[] => {
    const traderId = asId(entry.trader ?? entry.traderId);
    const standing = nullableNumber(entry.standing ?? entry.value);
    if (!traderId || standing === null) return [];
    return [{ traderId, standing }];
  });
}

function dedupeObjectives(values: TaskObjectiveSummary[]): TaskObjectiveSummary[] {
  const seen = new Map<string, TaskObjectiveSummary>();
  for (const objective of values) {
    const key = objective.id || `${objective.type}|${objective.descriptionEn}`;
    if (!seen.has(key)) seen.set(key, objective);
  }
  return [...seen.values()];
}

function dedupeRewardItems(values: TaskRewardItem[]): TaskRewardItem[] {
  const byItem = new Map<string, TaskRewardItem>();
  for (const reward of values) {
    const current = byItem.get(reward.itemId);
    if (!current || reward.count > current.count) byItem.set(reward.itemId, reward);
  }
  return [...byItem.values()];
}

function dedupeStandingRewards(values: TaskTraderStandingReward[]): TaskTraderStandingReward[] {
  const byTrader = new Map<string, TaskTraderStandingReward>();
  for (const reward of values) {
    const current = byTrader.get(reward.traderId);
    if (!current || Math.abs(reward.standing) > Math.abs(current.standing)) byTrader.set(reward.traderId, reward);
  }
  return [...byTrader.values()];
}

function normalizeTaskIdentityPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function taskMergeScore(task: TarkovTask): number {
  return (task.kappaRequired ? 100 : 0)
    + (task.lightkeeperRequired ? 80 : 0)
    + task.taskRequirements.length * 8
    + task.itemRequirements.length * 4
    + task.keyRequirements.length * 3
    + (task.wikiLink ? 2 : 0)
    + (task.taskImageLink ? 2 : 0)
    + task.objectives.length * 2
    + task.rewardItems.length;
}

function dedupeTaskRequirements(requirements: TaskRequirement[]): TaskRequirement[] {
  const seen = new Map<string, TaskRequirement>();
  for (const requirement of requirements) {
    const statuses = [...requirement.statuses].sort();
    const signature = `${requirement.taskId}|${statuses.join(",")}`;
    if (!seen.has(signature)) seen.set(signature, { ...requirement, statuses });
  }
  return [...seen.values()];
}

function dedupeTaskKeyRequirements(requirements: TaskKeyRequirement[]): TaskKeyRequirement[] {
  const seen = new Map<string, TaskKeyRequirement>();
  for (const requirement of requirements) {
    const keyIds = [...requirement.keyIds].sort();
    const signature = keyIds.join(",");
    const existing = seen.get(signature);
    if (!existing) {
      seen.set(signature, { ...requirement, keyIds });
      continue;
    }
    // If either copy says the key is mandatory, keep it mandatory.
    seen.set(signature, { ...existing, optional: existing.optional && requirement.optional });
  }
  return [...seen.values()];
}

function mergeDuplicateTasks(a: TarkovTask, b: TarkovTask): TarkovTask {
  const preferred = taskMergeScore(b) > taskMergeScore(a) ? b : a;
  const other = preferred === a ? b : a;
  const allIds = [...new Set([
    preferred.id,
    ...(preferred.aliasIds ?? []),
    other.id,
    ...(other.aliasIds ?? []),
  ])];

  return {
    ...preferred,
    kappaRequired: a.kappaRequired || b.kappaRequired,
    lightkeeperRequired: a.lightkeeperRequired || b.lightkeeperRequired,
    minPlayerLevel: Math.max(a.minPlayerLevel, b.minPlayerLevel),
    traderLoyaltyLevel: Math.max(a.traderLoyaltyLevel, b.traderLoyaltyLevel),
    wikiLink: preferred.wikiLink ?? other.wikiLink,
    taskImageLink: preferred.taskImageLink ?? other.taskImageLink,
    mapId: preferred.mapId ?? other.mapId,
    experience: Math.max(a.experience, b.experience),
    objectives: dedupeObjectives([...a.objectives, ...b.objectives]),
    rewardItems: dedupeRewardItems([...a.rewardItems, ...b.rewardItems]),
    traderStandingRewards: dedupeStandingRewards([...a.traderStandingRewards, ...b.traderStandingRewards]),
    taskRequirements: dedupeTaskRequirements([...a.taskRequirements, ...b.taskRequirements]),
    itemRequirements: dedupeTaskItemRequirements([...a.itemRequirements, ...b.itemRequirements]),
    keyRequirements: dedupeTaskKeyRequirements([...a.keyRequirements, ...b.keyRequirements]),
    aliasIds: allIds.filter((id) => id !== preferred.id),
  };
}

export function normalizeTasks(payload: unknown, traders: TarkovTrader[] = []): TarkovTask[] {
  const rawTasks = findCollection(payload, ["tasks"]);
  const traderMap = new Map(traders.map((trader) => [trader.id, trader]));

  const normalized = rawTasks.flatMap((raw): TarkovTask[] => {
    const id = asId(raw.id ?? raw._id);
    if (!id) return [];
    const name = localized(raw, "name", id);
    const traderId = asId(raw.trader) || null;
    const trader = traderId ? traderMap.get(traderId) : undefined;

    let rawTraderName = "";
    let rawTraderNameEn = "";
    if (isRecord(raw.trader)) {
      const localizedTrader = localized(raw.trader, "name", "");
      rawTraderName = localizedTrader.primary;
      rawTraderNameEn = localizedTrader.english;
    }

    const objectives = findCollection(raw, ["objectives"]);

    return [{
      id,
      name: name.primary,
      nameEn: name.english,
      traderId,
      traderName: trader?.name || rawTraderName || traderId || "—",
      traderNameEn: trader?.nameEn || rawTraderNameEn || trader?.name || rawTraderName || traderId || "—",
      traderLoyaltyLevel: normalizeTaskLoyaltyLevel(raw, traderId),
      minPlayerLevel: Math.max(1, asNumber(raw.minPlayerLevel, 1)),
      kappaRequired: asBoolean(raw.kappaRequired),
      lightkeeperRequired: asBoolean(raw.lightkeeperRequired),
      wikiLink: asString(raw.wikiLink) || null,
      taskImageLink: asString(raw.taskImageLink) || null,
      mapId: asId(raw.map) || null,
      experience: Math.max(0, asNumber(raw.experience, 0)),
      objectives: findCollection(raw, ["objectives"])
        .map(normalizeTaskObjectiveSummary)
        .filter((entry): entry is TaskObjectiveSummary => entry !== null),
      rewardItems: normalizeTaskRewardItems(isRecord(raw.finishRewards) ? raw.finishRewards : {}),
      traderStandingRewards: normalizeTaskTraderStanding(isRecord(raw.finishRewards) ? raw.finishRewards : {}),
      taskRequirements: findCollection(raw, ["taskRequirements"])
        .map(normalizeTaskRequirement)
        .filter((entry): entry is TaskRequirement => entry !== null),
      itemRequirements: dedupeTaskItemRequirements(
        objectives
          .map(normalizeTaskItemRequirement)
          .filter((entry): entry is TaskItemRequirement => entry !== null),
      ),
      keyRequirements: objectives.flatMap(normalizeTaskKeyRequirements),
      aliasIds: [],
    }];
  });

  // Upstream can temporarily contain legacy/current ids for the same visible
  // quest after patches. Merge only when both the quest giver and the English
  // display name are identical, so genuinely different tasks are not hidden.
  const byIdentity = new Map<string, TarkovTask>();
  for (const task of normalized) {
    const traderIdentity = task.traderId || normalizeTaskIdentityPart(task.traderNameEn || task.traderName);
    const nameIdentity = normalizeTaskIdentityPart(task.nameEn || task.name);
    const signature = `${traderIdentity}|${nameIdentity}`;
    const existing = byIdentity.get(signature);
    byIdentity.set(signature, existing ? mergeDuplicateTasks(existing, task) : task);
  }

  const deduped = [...byIdentity.values()];
  const aliasToCanonical = new Map<string, string>();
  for (const task of deduped) {
    aliasToCanonical.set(task.id, task.id);
    for (const alias of task.aliasIds ?? []) aliasToCanonical.set(alias, task.id);
  }

  // Rewrite dependency edges that point at a merged legacy id to the canonical
  // task id, then collapse any duplicated edges created by that rewrite.
  return deduped.map((task) => ({
    ...task,
    taskRequirements: dedupeTaskRequirements(task.taskRequirements.map((requirement) => ({
      ...requirement,
      taskId: aliasToCanonical.get(requirement.taskId) ?? requirement.taskId,
    }))),
  }));
}

function idsFromRefs(value: unknown): string[] {
  return [...new Set(toUnknownArray(value).map(asId).filter(Boolean))];
}

export function normalizeMaps(payload: unknown): TarkovMap[] {
  const rawMaps = findCollection(payload, ["maps"]);
  return rawMaps.flatMap((raw): TarkovMap[] => {
    const id = asId(raw.id ?? raw._id);
    if (!id) return [];
    const name = localized(raw, "name", id);
    const lockKeyIds = findCollection(raw, ["locks"])
      .map((lock) => asId(lock.key) || asId(lock.keyId))
      .filter(Boolean);
    const accessKeyIds = idsFromRefs(raw.accessKeys);
    return [{
      id,
      name: name.primary,
      nameEn: name.english,
      lockKeyIds: [...new Set(lockKeyIds)],
      accessKeyIds,
    }];
  });
}
