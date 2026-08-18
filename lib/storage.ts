import { GAME_MODES } from "./types";
import type { AvatarPreset, GameMode, ProfileProgress } from "./types";

export const EMPTY_PROGRESS: ProfileProgress = {
  playerLevel: 1,
  wallet: { RUB: 0, USD: 0, EUR: 0 },
  hideoutLevels: {},
  inventory: {},
  completedTasks: {},
  preferredDuplicateKeys: {},
  avatarPreset: "knight",
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
