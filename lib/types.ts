export type GameMode = "regular" | "pve" | "pvp-season";

export const GAME_MODES: Array<{ id: GameMode; label: string; shortLabel: string }> = [
  { id: "pve", label: "PvE", shortLabel: "PVE" },
  { id: "regular", label: "PvP", shortLabel: "PVP" },
  { id: "pvp-season", label: "Season", shortLabel: "SEASON" },
];

export type CurrencyCode = "RUB" | "USD" | "EUR";

export const CURRENCY_ITEM_IDS: Record<CurrencyCode, string> = {
  RUB: "5449016a4bdc2d6f028b456f",
  USD: "5696686a4bdc2da3298b456a",
  EUR: "569668774bdc2da2298b4568",
};

export const CURRENCY_BY_ITEM_ID = new Map<string, CurrencyCode>(
  Object.entries(CURRENCY_ITEM_IDS).map(([currency, itemId]) => [itemId, currency as CurrencyCode]),
);

export type VendorPrice = {
  vendorId: string | null;
  vendorName: string;
  vendorNameEn: string | null;
  priceRUB: number | null;
  source: string | null;
};

export type TarkovItem = {
  id: string;
  name: string;
  nameEn: string;
  shortName: string;
  shortNameEn: string;
  width: number;
  height: number;
  iconLink: string | null;
  gridImageLink: string | null;
  avg24hPrice: number | null;
  low24hPrice: number | null;
  high24hPrice: number | null;
  lastLowPrice: number | null;
  sellFor: VendorPrice[];
  types: string[];
  keyUses: number | null;
};


export type UsageItem = {
  id: string;
  name: string;
  nameEn: string;
  shortName: string;
  shortNameEn: string;
  iconLink: string | null;
  gridImageLink: string | null;
};

export type UsageContainedItem = {
  item: UsageItem;
  count: number;
};

export type UsageUnlock = {
  id: string;
  name: string;
  nameEn: string;
};

export type ItemBarterUse = {
  id: string;
  trader: {
    id: string;
    name: string;
    nameEn: string;
    imageLink: string | null;
  };
  level: number;
  buyLimit: number | null;
  taskUnlock: UsageUnlock | null;
  requiredItems: UsageContainedItem[];
  rewardItems: UsageContainedItem[];
};

export type ItemCraftUse = {
  id: string;
  station: {
    id: string;
    name: string;
    nameEn: string;
    imageLink: string | null;
  };
  level: number;
  duration: number;
  taskUnlock: UsageUnlock | null;
  requiredItems: UsageContainedItem[];
  rewardItems: UsageContainedItem[];
};

export type ItemUsesData = {
  itemId: string;
  barters: ItemBarterUse[];
  crafts: ItemCraftUse[];
};

export type TarkovTrader = {
  id: string;
  name: string;
  nameEn: string;
  imageLink: string | null;
};

export type HideoutItemRequirement = {
  itemId: string;
  count: number;
  foundInRaid: boolean;
};

export type HideoutLevel = {
  id: string;
  level: number;
  itemRequirements: HideoutItemRequirement[];
};

export type HideoutStation = {
  id: string;
  name: string;
  nameEn: string;
  imageLink: string | null;
  levels: HideoutLevel[];
};

export type TaskRequirement = {
  taskId: string;
  statuses: string[];
};

export type TaskItemRequirement = {
  itemIds: string[];
  count: number;
  foundInRaid: boolean;
  objectiveId: string;
  objectiveType: string;
  description: string;
  descriptionEn: string;
};

export type TaskKeyRequirement = {
  keyIds: string[];
  objectiveId: string;
  description: string;
  descriptionEn: string;
  optional: boolean;
};


export type TaskObjectiveSummary = {
  id: string;
  type: string;
  description: string;
  descriptionEn: string;
  mapIds: string[];
  count: number | null;
  foundInRaid: boolean;
  itemIds: string[];
};

export type TaskRewardItem = {
  itemId: string;
  count: number;
};

export type TaskTraderStandingReward = {
  traderId: string;
  standing: number;
};

export type QuestWikiData = {
  available: boolean;
  pageTitle: string;
  url: string;
  thumbnail: string | null;
  guideText: string;
  sections: string[];
};

export type TarkovTask = {
  id: string;
  name: string;
  nameEn: string;
  traderId: string | null;
  traderName: string;
  traderNameEn: string;
  /** Loyalty level of the quest giver required by the game for this task. */
  traderLoyaltyLevel: number;
  minPlayerLevel: number;
  kappaRequired: boolean;
  lightkeeperRequired: boolean;
  wikiLink: string | null;
  taskImageLink: string | null;
  mapId: string | null;
  experience: number;
  objectives: TaskObjectiveSummary[];
  rewardItems: TaskRewardItem[];
  traderStandingRewards: TaskTraderStandingReward[];
  taskRequirements: TaskRequirement[];
  itemRequirements: TaskItemRequirement[];
  keyRequirements: TaskKeyRequirement[];
  /** Alternate upstream ids merged into this canonical task. */
  aliasIds?: string[];
};

export type TarkovMap = {
  id: string;
  name: string;
  nameEn: string;
  lockKeyIds: string[];
  accessKeyIds: string[];
};


export type AvatarPreset = "knight" | "big-pipe" | "birdeye";

export const AVATAR_PRESETS: Array<{ id: AvatarPreset; label: string; image: string; position: string }> = [
  { id: "knight", label: "Knight", image: "https://assets.tarkov.dev/knight-poster.jpg", position: "50% 24%" },
  { id: "big-pipe", label: "Big Pipe", image: "https://assets.tarkov.dev/big-pipe-poster.jpg", position: "50% 22%" },
  { id: "birdeye", label: "Birdeye", image: "https://assets.tarkov.dev/birdeye-poster.jpg", position: "50% 22%" },
];

export type Wallet = Record<CurrencyCode, number>;

export type ProfileProgress = {
  playerLevel: number;
  wallet: Wallet;
  hideoutLevels: Record<string, number>;
  inventory: Record<string, number>;
  completedTasks: Record<string, boolean>;
  preferredDuplicateKeys: Record<string, boolean>;
  avatarPreset?: AvatarPreset;
};

export type NeedSource = {
  kind: "hideout" | "quest" | "quest-key";
  count: number;
  foundInRaid: boolean;
  label: string;
  labelEn: string;
  stationId?: string;
  level?: number;
  taskId?: string;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
};

export type ItemNeed = {
  item: TarkovItem;
  currency: CurrencyCode | null;
  totalNeeded: number;
  owned: number;
  missing: number;
  foundInRaidNeeded: number;
  sources: NeedSource[];
};

export type KeyQuestUse = {
  taskId: string;
  taskName: string;
  taskNameEn: string;
  kappaRequired: boolean;
  lightkeeperRequired: boolean;
  alternativeKeyIds: string[];
  optional: boolean;
};

export type KeyInfo = {
  item: TarkovItem;
  owned: number;
  maps: TarkovMap[];
  questUses: KeyQuestUse[];
  pendingQuestUses: KeyQuestUse[];
  marked: boolean;
  keepDuplicates: boolean;
};

export type KeepFilter = "all" | "hideout" | "quests" | "kappa";
export type TaskStatusFilter = "all" | "chain-ready" | "blocked" | "completed";
