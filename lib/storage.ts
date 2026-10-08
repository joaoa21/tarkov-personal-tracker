import { GAME_MODES } from "./types";
import type { AvatarPreset, Faction, GameMode, ProfileProgress } from "./types";

export const EMPTY_PROGRESS: ProfileProgress = {
  playerLevel: 1,
  wallet: { RUB: 0, USD: 0, EUR: 0 },
  hideoutLevels: {},
  inventory: {},
  completedTasks: {},
  preferredDuplicateKeys: {},
  avatarPreset: "knight",
  faction: null,
  prestigeLevel: 0,
  storySteps: {},
  storyChapters: {},
};

const BACKUP_APP_ID = "tarkov-personal-tracker";
const BACKUP_VERSION = 1;

export type TrackerBackup = {
  app: typeof BACKUP_APP_ID;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  modes: Record<GameMode, ProfileProgress>;
};

function key(mode: GameMode) {
  return `tarkov-personal-tracker:${mode}:progress:v1`;
}

function resetSnapshotKey(mode: GameMode) {
  return `tarkov-personal-tracker:${mode}:pre-reset:v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]) => {
      const amount = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(amount)) return [];
      return [[id, Math.max(0, Math.floor(amount))]];
    }),
  );
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => [id, Boolean(raw)]));
}

export function sanitizeProgress(value: unknown): ProfileProgress {
  const parsed = isRecord(value) ? value : {};
  const wallet = isRecord(parsed.wallet) ? parsed.wallet : {};
  const rawLevel = typeof parsed.playerLevel === "number" ? parsed.playerLevel : Number(parsed.playerLevel ?? 1);
  const playerLevel = Number.isFinite(rawLevel) ? Math.max(1, Math.floor(rawLevel)) : 1;
  const avatarPreset = ["knight", "big-pipe", "birdeye"].includes(String(parsed.avatarPreset))
    ? (parsed.avatarPreset as AvatarPreset)
    : "knight";

  const faction: Faction | null = parsed.faction === "BEAR" || parsed.faction === "USEC" ? parsed.faction : null;
  const rawPrestige = typeof parsed.prestigeLevel === "number" ? parsed.prestigeLevel : Number(parsed.prestigeLevel ?? 0);
  const prestigeLevel = Number.isFinite(rawPrestige) ? Math.min(10, Math.max(0, Math.floor(rawPrestige))) : 0;

  const money = (currency: "RUB" | "USD" | "EUR") => {
    const raw = typeof wallet[currency] === "number" ? wallet[currency] : Number(wallet[currency] ?? 0);
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  };

  return {
    playerLevel,
    wallet: { RUB: money("RUB"), USD: money("USD"), EUR: money("EUR") },
    hideoutLevels: sanitizeNumberRecord(parsed.hideoutLevels),
    inventory: sanitizeNumberRecord(parsed.inventory),
    completedTasks: sanitizeBooleanRecord(parsed.completedTasks),
    preferredDuplicateKeys: sanitizeBooleanRecord(parsed.preferredDuplicateKeys),
    avatarPreset,
    faction,
    prestigeLevel,
    storySteps: sanitizeBooleanRecord(parsed.storySteps),
    storyChapters: sanitizeBooleanRecord(parsed.storyChapters),
  };
}

export function loadProgress(mode: GameMode): ProfileProgress {
  if (typeof window === "undefined") return structuredClone(EMPTY_PROGRESS);
  try {
    const raw = window.localStorage.getItem(key(mode));
    if (!raw) return structuredClone(EMPTY_PROGRESS);
    return sanitizeProgress(JSON.parse(raw));
  } catch {
    return structuredClone(EMPTY_PROGRESS);
  }
}

export function saveProgress(mode: GameMode, progress: ProfileProgress) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(mode), JSON.stringify(progress));
}

export function createTrackerBackup(): TrackerBackup {
  if (typeof window === "undefined") throw new Error("Backup só pode ser criado no navegador.");
  const modes = Object.fromEntries(
    GAME_MODES.map(({ id }) => [id, loadProgress(id)]),
  ) as Record<GameMode, ProfileProgress>;
  return {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    modes,
  };
}

export function restoreTrackerBackup(value: unknown): TrackerBackup {
  if (typeof window === "undefined") throw new Error("Backup só pode ser restaurado no navegador.");
  if (!isRecord(value) || value.app !== BACKUP_APP_ID || value.version !== BACKUP_VERSION || !isRecord(value.modes)) {
    throw new Error("Arquivo de backup inválido ou incompatível com esta versão do tracker.");
  }

  const modes = {} as Record<GameMode, ProfileProgress>;
  for (const { id } of GAME_MODES) {
    if (!(id in value.modes)) throw new Error(`O backup não contém os dados do modo ${id}.`);
    modes[id] = sanitizeProgress(value.modes[id]);
  }

  for (const { id } of GAME_MODES) saveProgress(id, modes[id]);

  return {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    modes,
  };
}

export type ResetScope = {
  quests: boolean;
  story: boolean;
  hideout: boolean;
  level: boolean;
  wallet: boolean;
  stash: boolean;
  keys: boolean;
};

export type ResetSnapshot = {
  savedAt: string;
  progress: ProfileProgress;
};

/**
 * Builds a fresh character for a prestige / wipe. Profile identity (portrait,
 * faction) and the "always keep duplicate keys" preferences are preserved.
 */
export function resetProgress(
  current: ProfileProgress,
  scope: ResetScope,
  keyItemIds: Set<string>,
  nextPrestigeLevel: number,
): ProfileProgress {
  const inventory = Object.fromEntries(
    Object.entries(current.inventory).filter(([itemId]) => {
      const isKey = keyItemIds.has(itemId);
      return isKey ? !scope.keys : !scope.stash;
    }),
  );
  return {
    ...current,
    playerLevel: scope.level ? 1 : current.playerLevel,
    wallet: scope.wallet ? { RUB: 0, USD: 0, EUR: 0 } : current.wallet,
    hideoutLevels: scope.hideout ? {} : current.hideoutLevels,
    completedTasks: scope.quests ? {} : current.completedTasks,
    storySteps: scope.story ? {} : current.storySteps,
    storyChapters: scope.story ? {} : current.storyChapters,
    inventory,
    prestigeLevel: Math.min(10, Math.max(0, Math.floor(nextPrestigeLevel))),
  };
}

export function saveResetSnapshot(mode: GameMode, progress: ProfileProgress) {
  if (typeof window === "undefined") return;
  try {
    const snapshot: ResetSnapshot = { savedAt: new Date().toISOString(), progress };
    window.localStorage.setItem(resetSnapshotKey(mode), JSON.stringify(snapshot));
  } catch {
    // Storage can be full or blocked; the reset still proceeds.
  }
}

export function loadResetSnapshot(mode: GameMode): ResetSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(resetSnapshotKey(mode));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.savedAt !== "string") return null;
    return { savedAt: parsed.savedAt, progress: sanitizeProgress(parsed.progress) };
  } catch {
    return null;
  }
}

export function clearResetSnapshot(mode: GameMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(resetSnapshotKey(mode));
  } catch {
    // ignore
  }
}
