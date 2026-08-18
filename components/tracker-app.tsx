"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ModeSwitcher } from "./mode-switcher";
import {
  bestSellPrice,
  bestTraderPrice,
  buildHideoutNeeds,
  buildQuestNeeds,
  fleaPrice,
  mergeNeeds,
  taskAncestors,
  taskChainState,
  taskIsCompleted,
  missingTaskRequirements,
  valuePerSlot,
} from "@/lib/hideout-engine";
import { buildKeyInfos, keyRaidDecision } from "@/lib/key-engine";
import { normalizeHideout, normalizeItems, normalizeMaps, normalizeTasks, normalizeTraders } from "@/lib/normalize";
import { createTrackerBackup, EMPTY_PROGRESS, loadProgress, restoreTrackerBackup, saveProgress } from "@/lib/storage";
import { AVATAR_PRESETS, CURRENCY_BY_ITEM_ID } from "@/lib/types";
import type {
  CurrencyCode,
  GameMode,
  HideoutStation,
  ItemNeed,
  ItemUsesData,
  UsageContainedItem,
  VendorPrice,
  KeepFilter,
  KeyInfo,
  ProfileProgress,
  QuestWikiData,
  AvatarPreset,
  TarkovItem,
  TarkovMap,
  TarkovTask,
  TarkovTrader,
  TaskStatusFilter,
} from "@/lib/types";

type View = "keep" | "hideout" | "raid" | "keys" | "profile" | "quests" | "board" | "kappa" | "lightkeeper";
type QuestBoardFilter = "all" | "fir" | "keys" | "kappa" | "lightkeeper";
const KEEP_COVER_GRACE_MS = 3000;

const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

function money(value: number | null | undefined) {
  return value && value > 0 ? `₽${number.format(value)}` : "—";
}

function currencyAmount(currency: CurrencyCode, value: number) {
  if (currency === "RUB") return `₽${number.format(value)}`;
  if (currency === "USD") return `$${number.format(value)}`;
  return `€${number.format(value)}`;
}

function dual(primary: string, english: string) {
  const a = primary.trim();
  const b = english.trim();
  if (!b || a.toLocaleLowerCase() === b.toLocaleLowerCase()) return a;
  return `${a} (${b})`;
}

function searchText(...values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ").toLocaleLowerCase();
}

type QuestBoardItem = {
  item: TarkovItem;
  required: number;
  globalMissing: number;
  foundInRaid: boolean;
  questNames: string[];
  questNamesEn: string[];
  kappa: boolean;
  lightkeeper: boolean;
};

type QuestBoardKey = {
  info: KeyInfo;
  questNames: string[];
  questNamesEn: string[];
  kappa: boolean;
  lightkeeper: boolean;
};

type QuestBoardTrader = {
  trader: TarkovTrader;
  pendingTasks: number;
  items: QuestBoardItem[];
  keys: QuestBoardKey[];
};


function stationMax(station: HideoutStation) {
  return station.levels.reduce((max, level) => Math.max(max, level.level), 0);
}

function ItemImage({ item, onInspect }: { item: TarkovItem; onInspect?: (item: TarkovItem) => void }) {
  const src = item.gridImageLink ?? item.iconLink;
  const content = src ? <img src={src} alt="" className="item-image" /> : <span className="item-placeholder">?</span>;
  if (onInspect) {
    return <button type="button" className="item-image-wrap item-image-button" onClick={() => onInspect(item)} aria-label={`Ver usos de ${item.name}`}>{content}</button>;
  }
  return <div className="item-image-wrap">{content}</div>;
}

function PmcAvatar({ mode, level, avatarPreset = "knight" }: { mode: GameMode; level: number; avatarPreset?: AvatarPreset }) {
  const portrait = AVATAR_PRESETS.find((preset) => preset.id === avatarPreset) ?? AVATAR_PRESETS[0];

  return (
    <div className={`pmc-avatar pmc-portrait pmc-photo ${mode}`} aria-label={`PMC level ${level}`}>
      <img
        src={portrait.image}
        alt={`Retrato de ${portrait.label}`}
        className="pmc-profile-photo"
        style={{ objectPosition: portrait.position }}
        referrerPolicy="no-referrer"
      />
      <div className="pmc-photo-vignette" aria-hidden="true" />
      <span className="pmc-level-badge">{level}</span>
      <span className="pmc-avatar-tag">PMC</span>
      <div className="pmc-avatar-scan" />
    </div>
  );
}


export function TrackerApp() {
  const [mode, setMode] = useState<GameMode>("pve");
  const [view, setView] = useState<View>("keep");
  const [keepFilter, setKeepFilter] = useState<KeepFilter>("all");
  const [taskFilter, setTaskFilter] = useState<TaskStatusFilter>("all");
  const [boardFilter, setBoardFilter] = useState<QuestBoardFilter>("all");
  const [keyMapFilter, setKeyMapFilter] = useState("all");
  const [traderFilter, setTraderFilter] = useState("all");
  const [items, setItems] = useState<TarkovItem[]>([]);
  const [stations, setStations] = useState<HideoutStation[]>([]);
  const [tasks, setTasks] = useState<TarkovTask[]>([]);
  const [traders, setTraders] = useState<TarkovTrader[]>([]);
  const [maps, setMaps] = useState<TarkovMap[]>([]);
  const [progress, setProgress] = useState<ProfileProgress>(EMPTY_PROGRESS);
  const [progressMode, setProgressMode] = useState<GameMode | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [raidTraderPriceOverrides, setRaidTraderPriceOverrides] = useState<Record<string, VendorPrice[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<TarkovItem | null>(null);
  const [selectedItemUses, setSelectedItemUses] = useState<ItemUsesData | null>(null);
  const [itemUsesLoading, setItemUsesLoading] = useState(false);
  const [itemUsesError, setItemUsesError] = useState<string | null>(null);
  const [itemUsesCache, setItemUsesCache] = useState<Record<string, ItemUsesData>>({});
  const [selectedTask, setSelectedTask] = useState<TarkovTask | null>(null);
  const [questWiki, setQuestWiki] = useState<QuestWikiData | null>(null);
  const [questWikiLoading, setQuestWikiLoading] = useState(false);
  const [questWikiError, setQuestWikiError] = useState<string | null>(null);
  const [questWikiCache, setQuestWikiCache] = useState<Record<string, QuestWikiData>>({});
  const [recentlyCoveredKeep, setRecentlyCoveredKeep] = useState<Set<string>>(() => new Set());
  const [backupStatus, setBackupStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const keepCoverTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => { setRaidTraderPriceOverrides({}); }, [mode]);

  useEffect(() => {
    return () => {
      Object.values(keepCoverTimers.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    Object.values(keepCoverTimers.current).forEach((timer) => clearTimeout(timer));
    keepCoverTimers.current = {};
    setRecentlyCoveredKeep(new Set());
  }, [mode, keepFilter]);

  useEffect(() => {
    setProgress(loadProgress(mode));
    setProgressMode(mode);
  }, [mode]);

  useEffect(() => {
    if (progressMode === mode) saveProgress(mode, progress);
  }, [mode, progress, progressMode]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`/api/tarkov/${mode}/items`).then(checkJson("itens")),
      fetch(`/api/tarkov/${mode}/hideout`).then(checkJson("Hideout")),
      fetch(`/api/tarkov/${mode}/tasks`).then(checkJson("missões")),
      fetch(`/api/tarkov/${mode}/traders`).then(checkJson("traders")),
      fetch(`/api/tarkov/${mode}/maps`).then(checkJson("mapas")),
    ])
      .then(([itemsPayload, hideoutPayload, tasksPayload, tradersPayload, mapsPayload]) => {
        if (cancelled) return;
        const normalizedTraders = normalizeTraders(tradersPayload);
        const normalizedItems = normalizeItems(itemsPayload, normalizedTraders);
        const normalizedStations = normalizeHideout(hideoutPayload);
        const normalizedTasks = normalizeTasks(tasksPayload, normalizedTraders);
        const normalizedMaps = normalizeMaps(mapsPayload);
        setTraders(normalizedTraders);
        setItems(normalizedItems);
        setStations(normalizedStations);
        setTasks(normalizedTasks);
        setMaps(normalizedMaps);
        if (!normalizedItems.length || !normalizedStations.length || !normalizedTasks.length || !normalizedMaps.length) {
          setError("A API respondeu, mas algum dataset veio em formato inesperado.");
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Erro inesperado ao carregar dados.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    // Use a real EFT item icon from the Tarkov.dev dataset once it is available.
    // Killa's helmet reads clearly even at favicon size; the local SVG remains the fallback.
    const faviconItem = items.find((item) => item.id === "5c0e874186f7745dc7616606")
      ?? items.find((item) => searchText(item.name, item.nameEn, item.shortName, item.shortNameEn).includes("killa"));
    const faviconUrl = faviconItem?.iconLink ?? faviconItem?.gridImageLink;
    if (!faviconUrl) return;

    const iconLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    if (!iconLinks.length) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = faviconUrl;
      document.head.appendChild(link);
      return () => link.remove();
    }

    const previousHrefs = iconLinks.map((link) => link.href);
    iconLinks.forEach((link) => { link.href = faviconUrl; });
    return () => iconLinks.forEach((link, index) => { link.href = previousHrefs[index]; });
  }, [items]);

  const hideoutNeeds = useMemo(() => buildHideoutNeeds(stations, items, progress), [stations, items, progress]);
  const questNeeds = useMemo(() => buildQuestNeeds(tasks, items, progress), [tasks, items, progress]);
  const kappaNeeds = useMemo(() => buildQuestNeeds(tasks, items, progress, { kappaOnly: true }), [tasks, items, progress]);
  const allNeeds = useMemo(() => mergeNeeds([hideoutNeeds, questNeeds], progress), [hideoutNeeds, questNeeds, progress]);
  const allNeedByItem = useMemo(() => new Map(allNeeds.map((need) => [need.item.id, need])), [allNeeds]);
  const itemMap = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const keyInfos = useMemo(() => buildKeyInfos(items, maps, tasks, progress), [items, maps, tasks, progress]);
  const keyInfoByItem = useMemo(() => new Map(keyInfos.map((info) => [info.item.id, info])), [keyInfos]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const questNeedByItem = useMemo(() => new Map(questNeeds.map((need) => [need.item.id, need])), [questNeeds]);
  const questBoardTraders = useMemo<QuestBoardTrader[]>(() => {
    const traderById = new Map(traders.map((trader) => [trader.id, trader]));
    const groups = new Map<string, { pendingTasks: Set<string>; items: Map<string, QuestBoardItem>; keys: Map<string, QuestBoardKey> }>();

    const ensure = (traderId: string) => {
      const current = groups.get(traderId) ?? { pendingTasks: new Set<string>(), items: new Map<string, QuestBoardItem>(), keys: new Map<string, QuestBoardKey>() };
      groups.set(traderId, current);
      return current;
    };

    for (const task of tasks) {
      if (taskIsCompleted(task, progress) || !task.traderId) continue;
      const group = ensure(task.traderId);
      group.pendingTasks.add(task.id);

      for (const requirement of task.itemRequirements) {
        if (requirement.itemIds.length !== 1) continue;
        const itemId = requirement.itemIds[0];
        const item = itemMap.get(itemId);
        if (!item) continue;
        const need = questNeedByItem.get(itemId);
        if (!need || need.currency) continue;
        const existing = group.items.get(itemId) ?? {
          item, required: 0, globalMissing: need.missing, foundInRaid: false,
          questNames: [], questNamesEn: [], kappa: false, lightkeeper: false,
        };
        existing.required += requirement.count;
        existing.globalMissing = need.missing;
        existing.foundInRaid ||= requirement.foundInRaid;
        if (!existing.questNames.includes(task.name)) existing.questNames.push(task.name);
        if (!existing.questNamesEn.includes(task.nameEn)) existing.questNamesEn.push(task.nameEn);
        existing.kappa ||= task.kappaRequired;
        existing.lightkeeper ||= task.lightkeeperRequired;
        group.items.set(itemId, existing);
      }
    }

    for (const info of keyInfos) {
      for (const use of info.pendingQuestUses) {
        const task = taskById.get(use.taskId);
        if (!task?.traderId) continue;
        const group = ensure(task.traderId);
        group.pendingTasks.add(task.id);
        const existing = group.keys.get(info.item.id) ?? {
          info, questNames: [], questNamesEn: [], kappa: false, lightkeeper: false,
        };
        if (!existing.questNames.includes(task.name)) existing.questNames.push(task.name);
        if (!existing.questNamesEn.includes(task.nameEn)) existing.questNamesEn.push(task.nameEn);
        existing.kappa ||= task.kappaRequired;
        existing.lightkeeper ||= task.lightkeeperRequired;
        group.keys.set(info.item.id, existing);
      }
    }

    return [...groups.entries()].flatMap(([traderId, group]) => {
      const trader = traderById.get(traderId);
      if (!trader) return [];
      return [{
        trader,
        pendingTasks: group.pendingTasks.size,
        items: [...group.items.values()].sort((a, b) => Number(b.globalMissing > 0) - Number(a.globalMissing > 0) || Number(b.foundInRaid) - Number(a.foundInRaid) || b.globalMissing - a.globalMissing || b.required - a.required || a.item.name.localeCompare(b.item.name)),
        keys: [...group.keys.values()].sort((a, b) => Number(a.info.owned > 0) - Number(b.info.owned > 0) || a.info.item.name.localeCompare(b.info.item.name)),
      }];
    }).sort((a, b) => a.trader.name.localeCompare(b.trader.name));
  }, [tasks, traders, progress, itemMap, questNeedByItem, keyInfos, taskById]);

  const selectedNeeds = keepFilter === "hideout" ? hideoutNeeds
    : keepFilter === "quests" ? questNeeds
      : keepFilter === "kappa" ? kappaNeeds
        : allNeeds;

  const physicalSelectedNeeds = selectedNeeds.filter((need) =>
    !need.currency && (need.missing > 0 || recentlyCoveredKeep.has(need.item.id)),
  );
  const filteredNeeds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const visible = !needle
      ? physicalSelectedNeeds
      : physicalSelectedNeeds.filter((need) =>
          searchText(need.item.name, need.item.nameEn, need.item.shortName, need.item.shortNameEn).includes(needle),
        );
    return [...visible].sort((a, b) => {
      const aCovered = recentlyCoveredKeep.has(a.item.id) && a.missing === 0;
      const bCovered = recentlyCoveredKeep.has(b.item.id) && b.missing === 0;
      if (aCovered !== bCovered) return aCovered ? 1 : -1;
      return b.missing - a.missing || a.item.name.localeCompare(b.item.name);
    });
  }, [physicalSelectedNeeds, query, recentlyCoveredKeep]);

  const raidCandidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length < 2) return [];
    return items
      .filter((item) => searchText(item.name, item.nameEn, item.shortName, item.shortNameEn).includes(needle))
      .sort((a, b) => (valuePerSlot(b) ?? 0) - (valuePerSlot(a) ?? 0))
      .slice(0, 30);
  }, [items, query]);

  useEffect(() => {
    if (view !== "raid" || !raidCandidates.length) return;
    const missingIds = raidCandidates
      .filter((item) => !bestTraderPrice(item) && !Object.prototype.hasOwnProperty.call(raidTraderPriceOverrides, item.id))
      .map((item) => item.id);
    if (!missingIds.length) return;

    const controller = new AbortController();
    fetch(`/api/tarkov/${mode}/sell-prices?ids=${encodeURIComponent(missingIds.join(","))}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: unknown) => {
        if (!payload || typeof payload !== "object" || !("data" in payload)) return;
        const data = (payload as { data?: unknown }).data;
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        const next: Record<string, VendorPrice[]> = {};
        for (const [itemId, rawOffers] of Object.entries(data as Record<string, unknown>)) {
          if (!Array.isArray(rawOffers)) continue;
          next[itemId] = rawOffers.filter((offer): offer is VendorPrice => {
            if (!offer || typeof offer !== "object") return false;
            const candidate = offer as Partial<VendorPrice>;
            return typeof candidate.vendorName === "string" && typeof candidate.priceRUB === "number" && candidate.priceRUB > 0;
          }).map((offer) => {
            const translatedTrader = offer.vendorId ? traders.find((trader) => trader.id === offer.vendorId) : undefined;
            return translatedTrader
              ? { ...offer, vendorName: translatedTrader.name, vendorNameEn: translatedTrader.nameEn }
              : offer;
          });
        }
        setRaidTraderPriceOverrides((current) => ({ ...current, ...next }));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [view, mode, raidCandidates, raidTraderPriceOverrides, traders]);

  const raidItems = useMemo(() => raidCandidates
    .map((item) => {
      const overlay = raidTraderPriceOverrides[item.id];
      if (!overlay?.length) return item;
      return { ...item, sellFor: [...item.sellFor, ...overlay] };
    })
    .sort((a, b) => (valuePerSlot(b) ?? 0) - (valuePerSlot(a) ?? 0)),
  [raidCandidates, raidTraderPriceOverrides]);

  const mapOptions = useMemo(() => {
    const used = new Set(keyInfos.flatMap((info) => info.maps.map((map) => map.id)));
    return maps.filter((map) => used.has(map.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [keyInfos, maps]);

  const filteredKeys = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return keyInfos.filter((info) => {
      if (keyMapFilter === "unmapped" && info.maps.length > 0) return false;
      if (keyMapFilter !== "all" && keyMapFilter !== "unmapped" && !info.maps.some((map) => map.id === keyMapFilter)) return false;
      if (!needle) return true;
      return searchText(
        info.item.name,
        info.item.nameEn,
        info.item.shortName,
        info.item.shortNameEn,
        ...info.maps.flatMap((map) => [map.name, map.nameEn]),
        ...info.questUses.flatMap((use) => [use.taskName, use.taskNameEn]),
      ).includes(needle);
    });
  }, [keyInfos, keyMapFilter, query]);

  const finishedStations = stations.filter(
    (station) => (progress.hideoutLevels[station.id] ?? 0) >= stationMax(station),
  ).length;
  const hideoutPhysicalNeeds = hideoutNeeds.filter((need) => !need.currency && need.missing > 0);
  const missingUnits = hideoutPhysicalNeeds.reduce((sum, need) => sum + need.missing, 0);
  const currencyNeeds = hideoutNeeds.filter((need) => need.currency && need.missing > 0);
  const completedCount = tasks.filter((task) => taskIsCompleted(task, progress)).length;
  const kappaTasks = tasks.filter((task) => task.kappaRequired);
  const lightkeeperTasks = tasks.filter((task) => task.lightkeeperRequired);
  const hideoutPercent = stations.length ? Math.round((finishedStations / stations.length) * 100) : 0;
  const questPercent = tasks.length ? Math.round((completedCount / tasks.length) * 100) : 0;
  const kappaCompleted = kappaTasks.filter((task) => taskIsCompleted(task, progress)).length;
  const lightkeeperCompleted = lightkeeperTasks.filter((task) => taskIsCompleted(task, progress)).length;

  function setStationLevel(stationId: string, level: number) {
    setProgress((current) => ({ ...current, hideoutLevels: { ...current.hideoutLevels, [stationId]: level } }));
  }

  function setOwned(itemId: string, amount: number) {
    const safe = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
    setProgress((current) => ({ ...current, inventory: { ...current.inventory, [itemId]: safe } }));
  }

  function setKeepOwned(need: ItemNeed, amount: number) {
    const safe = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
    const itemId = need.item.id;
    const existingTimer = keepCoverTimers.current[itemId];
    if (existingTimer) {
      clearTimeout(existingTimer);
      delete keepCoverTimers.current[itemId];
    }

    if (safe >= need.totalNeeded) {
      setRecentlyCoveredKeep((current) => {
        const next = new Set(current);
        next.add(itemId);
        return next;
      });
      keepCoverTimers.current[itemId] = setTimeout(() => {
        setRecentlyCoveredKeep((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
        delete keepCoverTimers.current[itemId];
      }, KEEP_COVER_GRACE_MS);
    } else {
      setRecentlyCoveredKeep((current) => {
        if (!current.has(itemId)) return current;
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }

    setOwned(itemId, safe);
  }

  function setDuplicateKeyPreference(itemId: string, enabled: boolean) {
    setProgress((current) => ({
      ...current,
      preferredDuplicateKeys: { ...current.preferredDuplicateKeys, [itemId]: enabled },
    }));
  }

  function setPlayerLevel(amount: number) {
    const safe = Math.max(1, Math.floor(Number.isFinite(amount) ? amount : 1));
    setProgress((current) => ({ ...current, playerLevel: safe }));
  }

  function setWallet(currency: CurrencyCode, amount: number) {
    const safe = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
    setProgress((current) => ({ ...current, wallet: { ...current.wallet, [currency]: safe } }));
  }

  function setAvatarPreset(avatarPreset: AvatarPreset) {
    setProgress((current) => ({ ...current, avatarPreset }));
  }

  function exportTrackerBackup() {
    try {
      const backup = createTrackerBackup();
      // Make sure the currently rendered state wins even if the save effect has not flushed yet.
      backup.modes[mode] = progress;
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tarkov-tracker-backup-${date}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setBackupStatus({ kind: "success", message: "Backup exportado. Guarde o arquivo para restaurar seu progresso no site online ou em outro navegador." });
    } catch (reason) {
      setBackupStatus({ kind: "error", message: reason instanceof Error ? reason.message : "Não foi possível exportar o backup." });
    }
  }

  async function importTrackerBackup(file: File) {
    try {
      const raw = await file.text();
      const parsed: unknown = JSON.parse(raw);
      if (!window.confirm("Importar este backup vai substituir o progresso atual de PvE, PvP e Season neste navegador. Deseja continuar?")) return;
      const restored = restoreTrackerBackup(parsed);
      setProgress(restored.modes[mode]);
      setProgressMode(mode);
      setBackupStatus({ kind: "success", message: `Backup restaurado com sucesso. Dados de PvE, PvP e Season foram importados.` });
    } catch (reason) {
      setBackupStatus({ kind: "error", message: reason instanceof Error ? reason.message : "Não foi possível importar este arquivo." });
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  }

  function setTaskCompleted(taskId: string, completed: boolean) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    const ids = task ? [task.id, ...(task.aliasIds ?? [])] : [taskId];
    setProgress((current) => {
      const completedTasks = { ...current.completedTasks };
      for (const id of ids) completedTasks[id] = completed;
      return { ...current, completedTasks };
    });
  }

  function markCurrentTask(taskId: string) {
    const ancestors = taskAncestors(taskId, tasks);
    setProgress((current) => {
      const completedTasks = { ...current.completedTasks };
      for (const id of ancestors) completedTasks[id] = true;
      const currentTask = tasks.find((candidate) => candidate.id === taskId);
      completedTasks[taskId] = false;
      for (const alias of currentTask?.aliasIds ?? []) completedTasks[alias] = false;
      return { ...current, completedTasks };
    });
  }

  async function inspectItem(item: TarkovItem) {
    const cacheKey = `${mode}:${item.id}`;
    setSelectedItem(item);
    setItemUsesError(null);
    const cached = itemUsesCache[cacheKey];
    if (cached) {
      setSelectedItemUses(cached);
      setItemUsesLoading(false);
      return;
    }

    setSelectedItemUses(null);
    setItemUsesLoading(true);
    try {
      const response = await fetch(`/api/tarkov/${mode}/uses?itemId=${encodeURIComponent(item.id)}`);
      if (!response.ok) throw new Error("Não foi possível carregar as trocas/receitas deste item.");
      const payload = await response.json() as ItemUsesData;
      if (!payload || payload.itemId !== item.id || !Array.isArray(payload.barters) || !Array.isArray(payload.crafts)) {
        throw new Error("A API respondeu em um formato inesperado.");
      }
      setItemUsesCache((current) => ({ ...current, [cacheKey]: payload }));
      setSelectedItemUses(payload);
    } catch (reason) {
      setItemUsesError(reason instanceof Error ? reason.message : "Erro ao carregar usos do item.");
    } finally {
      setItemUsesLoading(false);
    }
  }

  function closeItemUses() {
    setSelectedItem(null);
    setSelectedItemUses(null);
    setItemUsesError(null);
  }

  async function inspectTask(task: TarkovTask) {
    const cacheKey = task.nameEn || task.name;
    setSelectedTask(task);
    setQuestWikiError(null);
    const cached = questWikiCache[cacheKey];
    if (cached) {
      setQuestWiki(cached);
      setQuestWikiLoading(false);
      return;
    }
    setQuestWiki(null);
    setQuestWikiLoading(true);
    try {
      const response = await fetch(`/api/wiki/quest?title=${encodeURIComponent(cacheKey)}`);
      if (!response.ok) throw new Error("Não foi possível consultar a Wiki agora.");
      const payload = await response.json() as QuestWikiData;
      setQuestWikiCache((current) => ({ ...current, [cacheKey]: payload }));
      setQuestWiki(payload);
    } catch (reason) {
      setQuestWikiError(reason instanceof Error ? reason.message : "Wiki indisponível.");
    } finally {
      setQuestWikiLoading(false);
    }
  }

  function closeTaskIntel() {
    setSelectedTask(null);
    setQuestWiki(null);
    setQuestWikiError(null);
  }

  function switchView(next: View) {
    setView(next);
    setQuery("");
    if (next === "quests" || next === "kappa" || next === "lightkeeper") setTraderFilter("all");
    if (next === "board") setBoardFilter("all");
  }

  return (
    <main className="shell">
      <header className="game-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <div className="eyebrow">PERSONAL TARKOV COMPANION</div>
            <h1>TARKOV <em>//</em> TRACKER</h1>
          </div>
        </div>
        <ModeSwitcher mode={mode} onChange={(next) => { setMode(next); setQuery(""); setTraderFilter("all"); closeItemUses(); closeTaskIntel(); }} />
      </header>

      <section className="pmc-command-card">
        <div className="pmc-profile-main">
          <PmcAvatar mode={mode} level={progress.playerLevel} avatarPreset={progress.avatarPreset} />
          <div className="pmc-identity">
            <div className="pmc-kicker"><span className={`mode-dot ${mode}`} /> PERFIL ATIVO</div>
            <div className="pmc-name-row">
              <div>
                <strong>PMC</strong>
                <span>{mode === "pve" ? "Persistent PvE" : mode === "regular" ? "Persistent PvP" : "Seasonal PMC"}</span>
              </div>
              <button type="button" className="profile-edit-link" onClick={() => switchView("profile")}>EDITAR PERFIL</button>
            </div>
            <div className="pmc-level-line">
              <span>LEVEL</span>
              <b>{progress.playerLevel}</b>
              <i />
            </div>
          </div>
        </div>
        <div className="wallet-panel">
          <div className="wallet-title">STASH VALUE / CASH</div>
          <div className="wallet-grid">
            <div className="wallet-stat rub"><span>RUB</span><strong>{currencyAmount("RUB", progress.wallet.RUB)}</strong><small>Roubles</small></div>
            <div className="wallet-stat usd"><span>USD</span><strong>{currencyAmount("USD", progress.wallet.USD)}</strong><small>Dollars</small></div>
            <div className="wallet-stat eur"><span>EUR</span><strong>{currencyAmount("EUR", progress.wallet.EUR)}</strong><small>Euros</small></div>
          </div>
        </div>
      </section>

      <section className="summary-grid game-summary-grid">
        <button className="summary-card game-stat-card" type="button" onClick={() => switchView("hideout")}>
          <div className="game-stat-head"><span>HIDEOUT</span><b>{hideoutPercent}%</b></div>
          <strong>{finishedStations}<i>/ {stations.length || "—"}</i></strong>
          <small>estações maximizadas</small>
          <div className="stat-progress"><i style={{ width: `${hideoutPercent}%` }} /></div>
        </button>
        <button className="summary-card game-stat-card" type="button" onClick={() => switchView("keep")}>
          <div className="game-stat-head"><span>ITEMS TO KEEP</span><b>STASH</b></div>
          <strong>{allNeeds.filter((need) => !need.currency && need.missing > 0).length}</strong>
          <small>tipos ainda necessários</small>
          <div className="stat-meta-line"><span>Hideout + Quests</span><span>PT / EN</span></div>
        </button>
        <button className="summary-card game-stat-card" type="button" onClick={() => switchView("keep")}>
          <div className="game-stat-head"><span>MATERIAIS</span><b>PHYSICAL</b></div>
          <strong>{number.format(missingUnits)}</strong>
          <small>unidades físicas do Hideout</small>
          <div className="stat-meta-line"><span>sem moedas</span><span>restantes</span></div>
        </button>
        <button className="summary-card game-stat-card quest-stat-card" type="button" onClick={() => switchView("quests")}>
          <div className="game-stat-head"><span>QUESTS</span><b>{questPercent}%</b></div>
          <strong>{completedCount}<i>/ {tasks.length || "—"}</i></strong>
          <small>concluídas neste personagem</small>
          <div className="stat-progress"><i style={{ width: `${questPercent}%` }} /></div>
          <div className="quest-mini-meta"><span>Kappa {kappaCompleted}/{kappaTasks.length}</span><span>LK {lightkeeperCompleted}/{lightkeeperTasks.length}</span></div>
        </button>
      </section>

      <nav className="tabs game-tabs">
        <button className={view === "keep" ? "tab active" : "tab"} onClick={() => switchView("keep")}><span className="tab-icon">▦</span><span>Items to Keep</span></button>
        <button className={view === "hideout" ? "tab active" : "tab"} onClick={() => switchView("hideout")}><span className="tab-icon">⌂</span><span>Hideout</span></button>
        <button className={view === "raid" ? "tab active" : "tab"} onClick={() => switchView("raid")}><span className="tab-icon">⌖</span><span>Raid Mode</span></button>
        <button className={view === "keys" ? "tab active" : "tab"} onClick={() => switchView("keys")}><span className="tab-icon">◆</span><span>Chaves</span></button>
        <button className={view === "profile" ? "tab active" : "tab"} onClick={() => switchView("profile")}><span className="tab-icon">◉</span><span>Perfil</span></button>
        <button className={view === "quests" ? "tab active" : "tab"} onClick={() => switchView("quests")}><span className="tab-icon">✓</span><span>Quests</span></button>
        <button className={view === "board" ? "tab active" : "tab"} onClick={() => switchView("board")}><span className="tab-icon">▥</span><span>Quest Board</span></button>
        <button className={view === "kappa" ? "tab active" : "tab"} onClick={() => switchView("kappa")}><span className="tab-icon">K</span><span>Kappa</span></button>
        <button className={view === "lightkeeper" ? "tab active" : "tab"} onClick={() => switchView("lightkeeper")}><span className="tab-icon">L</span><span>Lightkeeper</span></button>
      </nav>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-panel"><span className="spinner" /> Carregando items, Hideout, quests, traders e mapas de {mode}…</div>}

      {!loading && view === "keep" && (
        <section>
          <div className="section-heading">
            <div><div className="eyebrow">STASH PLANNER</div><h2>O que guardar</h2><p>Missões agora também incluem chaves obrigatórias quando existe uma única chave válida. Grupos de chaves alternativas ficam na área Chaves para não inflar quantidades.</p></div>
            <input className="search" placeholder="Buscar PT ou EN…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="subtabs">
            {([["all", "Todos os itens"], ["hideout", "Hideout"], ["quests", "Missões"], ["kappa", "Kappa"]] as Array<[KeepFilter, string]>).map(([id, label]) => (
              <button key={id} className={keepFilter === id ? "subtab active" : "subtab"} onClick={() => setKeepFilter(id)}>{label}</button>
            ))}
          </div>
          <div className="item-list">
            {filteredNeeds.map((need) => <KeepRow key={need.item.id} need={need} recentlyCovered={recentlyCoveredKeep.has(need.item.id) && need.missing === 0} onOwned={(amount) => setKeepOwned(need, amount)} onInspect={inspectItem} />)}
            {!filteredNeeds.length && <div className="empty">Nenhum item encontrado.</div>}
          </div>
        </section>
      )}

      {!loading && view === "hideout" && (
        <section>
          <div className="section-heading"><div><div className="eyebrow">PROFILE PROGRESS</div><h2>Níveis do Hideout</h2><p>Português primeiro e inglês em parênteses. Selecione o nível já construído em cada estação.</p></div></div>
          <div className="station-grid">
            {stations.map((station) => {
              const current = progress.hideoutLevels[station.id] ?? 0;
              const max = stationMax(station);
              return (
                <article className="station-card" key={station.id}>
                  <div className="station-title">{station.imageLink ? <img src={station.imageLink} alt="" /> : null}<div><h3>{dual(station.name, station.nameEn)}</h3><span>Nível {current} / {max}</span></div></div>
                  <div className="level-buttons">{Array.from({ length: max + 1 }, (_, level) => <button key={level} type="button" className={current === level ? "level active" : "level"} onClick={() => setStationLevel(station.id, level)}>{level}</button>)}</div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {!loading && view === "raid" && (
        <section>
          <div className="raid-hero"><div className="eyebrow">FAST LOOT CHECK</div><h2>Raid Mode</h2><p>Chaves agora levam em conta sua coleção, quests pendentes, mapa, Marked Keys e as que você marcou para sempre manter repetidas.</p><input autoFocus className="raid-search" placeholder="Ex.: dorm, resort, marked, virtex, ledx…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="raid-results">{raidItems.map((item) => <RaidRow key={item.id} item={item} need={allNeedByItem.get(item.id)} keyInfo={keyInfoByItem.get(item.id)} owned={progress.inventory[item.id] ?? 0} onOwned={setOwned} onInspect={inspectItem} />)}{query.trim().length >= 2 && !raidItems.length && <div className="empty">Nenhum item encontrado.</div>}</div>
        </section>
      )}

      {!loading && view === "keys" && (
        <KeysSection
          keys={filteredKeys}
          allKeys={keyInfos}
          maps={mapOptions}
          mapFilter={keyMapFilter}
          setMapFilter={setKeyMapFilter}
          query={query}
          setQuery={setQuery}
          onOwned={setOwned}
          onDuplicatePreference={setDuplicateKeyPreference}
          onInspect={inspectItem}
        />
      )}

      {!loading && view === "profile" && (
        <section>
          <div className="section-heading"><div><div className="eyebrow">CURRENT CHARACTER</div><h2>Perfil atual</h2><p>Level e moedas ficam separados por PvE, PvP e Season.</p></div></div>
          <div className="profile-grid">
            <ProfileField label="Nível do PMC" prefix="LVL" value={progress.playerLevel} min={1} onChange={setPlayerLevel} />
            <ProfileField label="Rublos" prefix="₽" value={progress.wallet.RUB} onChange={(value) => setWallet("RUB", value)} />
            <ProfileField label="Dólares" prefix="$" value={progress.wallet.USD} onChange={(value) => setWallet("USD", value)} />
            <ProfileField label="Euros" prefix="€" value={progress.wallet.EUR} onChange={(value) => setWallet("EUR", value)} />
          </div>
          <div className="avatar-picker-panel">
            <div className="eyebrow">PMC PORTRAIT</div>
            <h3>Escolha o retrato do operador</h3>
            <p>Retratos oficiais dos Goons carregados pelo assets.tarkov.dev.</p>
            <div className="avatar-picker-grid">
              {AVATAR_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={progress.avatarPreset === preset.id ? "avatar-choice active" : "avatar-choice"}
                  onClick={() => setAvatarPreset(preset.id)}
                >
                  <img src={preset.image} alt={preset.label} style={{ objectPosition: preset.position }} />
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="backup-panel">
            <div className="backup-panel-copy">
              <div className="eyebrow">TRACKER BACKUP</div>
              <h3>Backup do progresso</h3>
              <p>Exporta PvE, PvP e Season em um único arquivo. Use a importação para levar seu progresso do localhost para o Netlify, outro PC ou outro navegador.</p>
              <div className="backup-mode-summary">
                <span>● PvE</span><span>● PvP</span><span>● Season</span>
              </div>
            </div>
            <div className="backup-actions">
              <button type="button" className="backup-button primary" onClick={exportTrackerBackup}>⇩ EXPORTAR BACKUP</button>
              <button type="button" className="backup-button" onClick={() => backupInputRef.current?.click()}>⇧ IMPORTAR BACKUP</button>
              <input
                ref={backupInputRef}
                className="backup-file-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTrackerBackup(file); }}
              />
            </div>
            {backupStatus && <div className={`backup-status ${backupStatus.kind}`}>{backupStatus.message}</div>}
          </div>
          <div className="currency-needs"><div className="eyebrow">HIDEOUT CASH REQUIREMENTS</div><h3>Custos monetários restantes</h3><div className="currency-cards">{(["RUB", "USD", "EUR"] as CurrencyCode[]).map((currency) => { const need = currencyNeeds.find((entry) => entry.currency === currency); return <div className="currency-card" key={currency}><span>{currency}</span><strong>{currencyAmount(currency, need?.missing ?? 0)}</strong><small>{need ? `${currencyAmount(currency, need.totalNeeded)} necessários · ${currencyAmount(currency, need.owned)} em caixa` : "Nada faltando para os upgrades restantes"}</small></div>; })}</div></div>
        </section>
      )}

      {!loading && view === "board" && (
        <QuestBoardSection
          traders={questBoardTraders}
          progress={progress}
          filter={boardFilter}
          setFilter={setBoardFilter}
          query={query}
          setQuery={setQuery}
          onInspect={inspectItem}
        />
      )}

      {!loading && (view === "quests" || view === "kappa" || view === "lightkeeper") && (
        <QuestSection
          view={view}
          tasks={view === "kappa" ? kappaTasks : view === "lightkeeper" ? lightkeeperTasks : tasks}
          progress={progress}
          itemMap={itemMap}
          traders={traders}
          traderFilter={traderFilter}
          setTraderFilter={setTraderFilter}
          query={query}
          setQuery={setQuery}
          filter={taskFilter}
          setFilter={setTaskFilter}
          onCompleted={setTaskCompleted}
          onCurrent={markCurrentTask}
          onInspectTask={inspectTask}
        />
      )}

      {selectedItem && (
        <ItemUsesModal
          item={selectedItem}
          data={selectedItemUses}
          loading={itemUsesLoading}
          error={itemUsesError}
          itemMap={itemMap}
          traders={traders}
          stations={stations}
          taskMap={taskMap}
          need={allNeedByItem.get(selectedItem.id)}
          owned={progress.inventory[selectedItem.id] ?? 0}
          onOwned={setOwned}
          onClose={closeItemUses}
        />
      )}
      {selectedTask && (
        <QuestIntelModal
          task={selectedTask}
          tasks={tasks}
          wiki={questWiki}
          wikiLoading={questWikiLoading}
          wikiError={questWikiError}
          progress={progress}
          itemMap={itemMap}
          traders={traders}
          maps={maps}
          onOwned={setOwned}
          onOpenTask={inspectTask}
          onClose={closeTaskIntel}
        />
      )}
    </main>
  );
}

function checkJson(label: string) {
  return async (response: Response) => {
    if (!response.ok) throw new Error(`Falha ao carregar ${label}.`);
    return response.json() as Promise<unknown>;
  };
}

function formatDuration(seconds: number) {
  if (!seconds || seconds <= 0) return "tempo não informado";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}min` : ""}`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.max(1, Math.round(seconds))} s`;
}

function UsageItems({ items, selectedItemId, label, itemMap }: { items: UsageContainedItem[]; selectedItemId: string; label: string; itemMap: Map<string, TarkovItem> }) {
  return (
    <div className="usage-item-group">
      <span>{label}</span>
      <div className="usage-item-list">
        {items.map((entry, index) => {
          const fullItem = itemMap.get(entry.item.id);
          const display = fullItem ?? entry.item;
          const src = display.gridImageLink ?? display.iconLink;
          return (
            <div className={entry.item.id === selectedItemId ? "usage-mini-item selected" : "usage-mini-item"} key={`${entry.item.id}-${index}`}>
              <div className="usage-mini-thumb">{src ? <img src={src} alt="" /> : <b>?</b>}</div>
              <div><strong>{dual(display.shortName, display.shortNameEn)}</strong><small>{dual(display.name, display.nameEn)}</small></div>
              <em>×{number.format(entry.count)}</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemUsesModal({ item, data, loading, error, itemMap, traders, stations, taskMap, need, owned, onOwned, onClose }: { item: TarkovItem; data: ItemUsesData | null; loading: boolean; error: string | null; itemMap: Map<string, TarkovItem>; traders: TarkovTrader[]; stations: HideoutStation[]; taskMap: Map<string, TarkovTask>; need?: ItemNeed; owned: number; onOwned: (id: string, amount: number) => void; onClose: () => void }) {
  const total = (data?.barters.length ?? 0) + (data?.crafts.length ?? 0);
  const totalNeeded = need?.totalNeeded ?? 0;
  const missing = Math.max(0, totalNeeded - owned);
  const traderMap = new Map(traders.map((trader) => [trader.id, trader] as const));
  const stationMap = new Map(stations.map((station) => [station.id, station] as const));
  return (
    <div className="item-uses-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="item-uses-modal" role="dialog" aria-modal="true" aria-label={`Usos de ${item.name}`}>
        <header className="item-uses-header">
          <div className="item-uses-identity">
            <ItemImage item={item} />
            <div><div className="eyebrow">ITEM INTELLIGENCE</div><h2>{dual(item.shortName, item.shortNameEn)}</h2><p>{dual(item.name, item.nameEn)}</p></div>
          </div>
          <button type="button" className="item-uses-close" onClick={onClose}>FECHAR ×</button>
        </header>

        <div className="item-uses-stash">
          <div className="item-uses-stash-owned">
            <span>Tenho no stash</span>
            <div className="item-uses-stash-control">
              <button type="button" aria-label="Diminuir quantidade" onClick={() => onOwned(item.id, Math.max(0, owned - 1))}>−</button>
              <input type="number" min="0" step="1" value={owned} onChange={(event) => onOwned(item.id, Number(event.target.value))} />
              <button type="button" aria-label="Aumentar quantidade" onClick={() => onOwned(item.id, owned + 1)}>+</button>
            </div>
          </div>
          <div className="item-uses-stash-stat">
            <span>Preciso</span>
            <strong>{number.format(totalNeeded)}</strong>
            <small>quests + Hideout rastreados</small>
          </div>
          <div className={missing > 0 ? "item-uses-stash-stat missing" : "item-uses-stash-stat covered"}>
            <span>Faltam</span>
            <strong>{number.format(missing)}</strong>
            <small>{totalNeeded <= 0 ? "sem necessidade atual" : missing > 0 ? `${need?.foundInRaidNeeded ?? 0} FIR ainda rastreados` : "✓ necessidade coberta"}</small>
          </div>
        </div>

        {loading && <div className="item-uses-loading"><span className="spinner" /> Consultando trocas e receitas...</div>}
        {error && <div className="error-banner item-uses-error">{error}</div>}
        {!loading && !error && data && (
          <>
            <div className="item-uses-summary">
              <div><span>Trocas de trader</span><strong>{data.barters.length}</strong></div>
              <div><span>Receitas Hideout</span><strong>{data.crafts.length}</strong></div>
              <div className={total > 0 ? "useful" : "neutral"}><span>Utilidade</span><strong>{total > 0 ? "TEM USO" : "SEM USO"}</strong></div>
            </div>

            {total === 0 && <div className="item-uses-empty"><strong>Nenhuma troca ou receita encontrada.</strong><p>Pelo dataset atual, este item não é ingrediente de barter de trader nem craft do Hideout.</p></div>}

            {data.barters.length > 0 && (
              <div className="item-uses-section">
                <div className="item-uses-section-title"><div><div className="eyebrow">TRADER BARTERS</div><h3>Trocas de traders</h3></div><span>{data.barters.length}</span></div>
                <div className="usage-recipes">
                  {data.barters.map((barter) => {
                    const trader = traderMap.get(barter.trader.id) ?? barter.trader;
                    const unlockTask = barter.taskUnlock ? taskMap.get(barter.taskUnlock.id) : null;
                    return (
                    <article className="usage-recipe" key={barter.id}>
                      <div className="usage-recipe-head">
                        <div className="usage-source">
                          {trader.imageLink ? <img src={trader.imageLink} alt="" /> : null}
                          <div><strong>{dual(trader.name, trader.nameEn)}</strong><span>LL {barter.level}{barter.buyLimit ? ` · limite ${barter.buyLimit}` : ""}</span></div>
                        </div>
                        {barter.taskUnlock && <span className="usage-unlock">🔒 {unlockTask ? dual(unlockTask.name, unlockTask.nameEn) : dual(barter.taskUnlock.name, barter.taskUnlock.nameEn)}</span>}
                      </div>
                      <div className="usage-equation">
                        <UsageItems items={barter.requiredItems} selectedItemId={item.id} label="ENTREGA" itemMap={itemMap} />
                        <div className="usage-arrow">→</div>
                        <UsageItems items={barter.rewardItems} selectedItemId={item.id} label="RECEBE" itemMap={itemMap} />
                      </div>
                    </article>
                    );
                  })}
                </div>
              </div>
            )}

            {data.crafts.length > 0 && (
              <div className="item-uses-section">
                <div className="item-uses-section-title"><div><div className="eyebrow">HIDEOUT RECIPES</div><h3>Receitas do Hideout</h3></div><span>{data.crafts.length}</span></div>
                <div className="usage-recipes">
                  {data.crafts.map((craft) => {
                    const station = stationMap.get(craft.station.id) ?? craft.station;
                    const unlockTask = craft.taskUnlock ? taskMap.get(craft.taskUnlock.id) : null;
                    return (
                    <article className="usage-recipe" key={craft.id}>
                      <div className="usage-recipe-head">
                        <div className="usage-source">
                          {station.imageLink ? <img src={station.imageLink} alt="" /> : null}
                          <div><strong>{dual(station.name, station.nameEn)}</strong><span>Nível {craft.level} · {formatDuration(craft.duration)}</span></div>
                        </div>
                        {craft.taskUnlock && <span className="usage-unlock">🔒 {unlockTask ? dual(unlockTask.name, unlockTask.nameEn) : dual(craft.taskUnlock.name, craft.taskUnlock.nameEn)}</span>}
                      </div>
                      <div className="usage-equation">
                        <UsageItems items={craft.requiredItems} selectedItemId={item.id} label="INGREDIENTES" itemMap={itemMap} />
                        <div className="usage-arrow">→</div>
                        <UsageItems items={craft.rewardItems} selectedItemId={item.id} label="PRODUZ" itemMap={itemMap} />
                      </div>
                    </article>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}


function QuestIntelModal({
  task,
  tasks,
  wiki,
  wikiLoading,
  wikiError,
  progress,
  itemMap,
  traders,
  maps,
  onOwned,
  onOpenTask,
  onClose,
}: {
  task: TarkovTask;
  tasks: TarkovTask[];
  wiki: QuestWikiData | null;
  wikiLoading: boolean;
  wikiError: string | null;
  progress: ProfileProgress;
  itemMap: Map<string, TarkovItem>;
  traders: TarkovTrader[];
  maps: TarkovMap[];
  onOwned: (id: string, amount: number) => void;
  onOpenTask: (task: TarkovTask) => void;
  onClose: () => void;
}) {
  const trader = task.traderId ? traders.find((entry) => entry.id === task.traderId) : undefined;
  const map = task.mapId ? maps.find((entry) => entry.id === task.mapId) : undefined;
  const previous = task.taskRequirements
    .map((requirement) => tasks.find((entry) => entry.id === requirement.taskId))
    .filter((entry): entry is TarkovTask => Boolean(entry));
  const leadsTo = tasks.filter((candidate) => candidate.taskRequirements.some((requirement) => requirement.taskId === task.id));
  const objectives = task.objectives.length
    ? task.objectives
    : task.itemRequirements.map((requirement) => ({
        id: requirement.objectiveId,
        type: requirement.objectiveType,
        description: requirement.description,
        descriptionEn: requirement.descriptionEn,
        mapIds: [],
        count: requirement.count,
        foundInRaid: requirement.foundInRaid,
        itemIds: requirement.itemIds,
      }));
  const heroImage = task.taskImageLink && !task.taskImageLink.includes("unknown-task") ? task.taskImageLink : wiki?.thumbnail ?? null;
  const status = taskChainState(task, progress);

  return (
    <div className="item-uses-backdrop quest-intel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="quest-intel-modal" role="dialog" aria-modal="true" aria-label={`Quest ${task.nameEn || task.name}`}>
        <header className="quest-intel-header">
          <div className="quest-intel-heading">
            {trader && <TraderAvatar trader={trader} large />}
            <div>
              <div className="eyebrow">QUEST INTELLIGENCE</div>
              <h2>{dual(task.name, task.nameEn)}</h2>
              <p>{task.traderName} · {map ? dual(map.name, map.nameEn) : "Local não informado"}</p>
            </div>
          </div>
          <button type="button" className="item-uses-close" onClick={onClose}>FECHAR ×</button>
        </header>

        <div className="quest-intel-overview">
          <div className="quest-intel-hero">
            {heroImage ? <img src={heroImage} alt="" referrerPolicy="no-referrer" /> : <div className="quest-intel-hero-placeholder">NO QUEST IMAGE</div>}
            <div className="quest-intel-hero-strip"><span>{status === "completed" ? "CONCLUÍDA" : status === "chain-ready" ? "CADEIA LIBERADA" : "BLOQUEADA"}</span><b>PMC LV. {task.minPlayerLevel}+</b></div>
          </div>
          <div className="quest-intel-data">
            <div className="eyebrow">QUEST DATA</div>
            <dl>
              <div><dt>Location</dt><dd>{map ? dual(map.name, map.nameEn) : "—"}</dd></div>
              <div><dt>Given by</dt><dd>{trader ? dual(trader.name, trader.nameEn) : task.traderName}</dd></div>
              <div><dt>Experience</dt><dd>{task.experience > 0 ? `+${number.format(task.experience)} XP` : "—"}</dd></div>
              <div><dt>Kappa</dt><dd>{task.kappaRequired ? "Required" : "No"}</dd></div>
            </dl>
            <div className="quest-intel-relations">
              <div><span>Previous</span>{previous.length ? previous.map((entry) => <button type="button" key={entry.id} onClick={() => onOpenTask(entry)}>{dual(entry.name, entry.nameEn)}</button>) : <em>—</em>}</div>
              <div><span>Leads to</span>{leadsTo.length ? leadsTo.slice(0, 6).map((entry) => <button type="button" key={entry.id} onClick={() => onOpenTask(entry)}>{dual(entry.name, entry.nameEn)}</button>) : <em>—</em>}</div>
            </div>
          </div>
        </div>

        <div className="quest-intel-content">
          <section className="quest-intel-section">
            <div className="quest-intel-title"><div><div className="eyebrow">MISSION</div><h3>Objetivos</h3></div><span>{objectives.length}</span></div>
            <div className="quest-objective-list">
              {objectives.map((objective, index) => (
                <div className="quest-objective" key={`${objective.id}-${index}`}>
                  <b>{index + 1}</b>
                  <div><strong>{dual(objective.description, objective.descriptionEn)}</strong><small>{objective.foundInRaid ? "FIR obrigatório" : objective.type}</small></div>
                </div>
              ))}
              {!objectives.length && <div className="quest-intel-empty">Objetivos detalhados não vieram no dataset atual.</div>}
            </div>
          </section>

          {(task.itemRequirements.length > 0 || task.keyRequirements.length > 0) && (
            <section className="quest-intel-section">
              <div className="quest-intel-title"><div><div className="eyebrow">RELATED ITEMS</div><h3>Itens e chaves</h3></div><span>{task.itemRequirements.length + task.keyRequirements.length}</span></div>
              <div className="quest-related-items">
                {task.itemRequirements.map((requirement, index) => {
                  const item = requirement.itemIds.map((id) => itemMap.get(id)).find((entry): entry is TarkovItem => Boolean(entry));
                  if (!item) return <div className="quest-related-unknown" key={`${requirement.objectiveId}-${index}`}>Item não identificado · ×{requirement.count}</div>;
                  const owned = progress.inventory[item.id] ?? 0;
                  const missing = Math.max(0, requirement.count - owned);
                  return (
                    <div className={missing > 0 ? "quest-related-item missing" : "quest-related-item covered"} key={`${requirement.objectiveId}-${item.id}-${index}`}>
                      <ItemImage item={item} />
                      <div className="quest-related-copy"><strong>{dual(item.shortName, item.shortNameEn)}</strong><span>{requirement.count} necessários{requirement.foundInRaid ? " · FIR" : ""}</span></div>
                      <div className="quest-related-owned"><small>TENHO</small><div><button type="button" onClick={() => onOwned(item.id, Math.max(0, owned - 1))}>−</button><input type="number" min="0" value={owned} onChange={(event) => onOwned(item.id, Number(event.target.value))} /><button type="button" onClick={() => onOwned(item.id, owned + 1)}>+</button></div><em>{missing > 0 ? `faltam ${missing}` : "✓ coberto"}</em></div>
                    </div>
                  );
                })}
                {task.keyRequirements.map((requirement, index) => {
                  const keyItems = requirement.keyIds.map((id) => itemMap.get(id)).filter((entry): entry is TarkovItem => Boolean(entry));
                  return keyItems.map((item) => {
                    const owned = progress.inventory[item.id] ?? 0;
                    return <div className={owned > 0 ? "quest-related-item key covered" : "quest-related-item key missing"} key={`key-${requirement.objectiveId}-${item.id}-${index}`}><ItemImage item={item} /><div className="quest-related-copy"><strong>🔑 {dual(item.shortName, item.shortNameEn)}</strong><span>{requirement.optional ? "chave opcional" : "chave necessária"}</span></div><div className="quest-related-owned"><small>TENHO</small><div><button type="button" onClick={() => onOwned(item.id, Math.max(0, owned - 1))}>−</button><input type="number" min="0" value={owned} onChange={(event) => onOwned(item.id, Number(event.target.value))} /><button type="button" onClick={() => onOwned(item.id, owned + 1)}>+</button></div><em>{owned > 0 ? "✓ no stash" : "falta"}</em></div></div>;
                  });
                })}
              </div>
            </section>
          )}

          <section className="quest-intel-section">
            <div className="quest-intel-title"><div><div className="eyebrow">REWARDS</div><h3>Recompensas</h3></div><span>{task.rewardItems.length + task.traderStandingRewards.length + (task.experience > 0 ? 1 : 0)}</span></div>
            <div className="quest-reward-grid">
              {task.experience > 0 && <div className="quest-reward xp"><span>XP</span><strong>+{number.format(task.experience)}</strong></div>}
              {task.traderStandingRewards.map((reward) => {
                const rewardTrader = traders.find((entry) => entry.id === reward.traderId);
                return <div className="quest-reward rep" key={`rep-${reward.traderId}`}><span>{rewardTrader?.name ?? "Trader"} REP</span><strong>{reward.standing > 0 ? "+" : ""}{reward.standing}</strong></div>;
              })}
              {task.rewardItems.map((reward, index) => {
                const rewardItem = itemMap.get(reward.itemId);
                const currency = CURRENCY_BY_ITEM_ID.get(reward.itemId);
                if (currency) return <div className="quest-reward cash" key={`${reward.itemId}-${index}`}><span>{currency}</span><strong>{currencyAmount(currency, reward.count)}</strong></div>;
                return <div className="quest-reward item" key={`${reward.itemId}-${index}`}>{rewardItem ? <ItemImage item={rewardItem} /> : null}<div><span>ITEM</span><strong>{rewardItem ? dual(rewardItem.shortName, rewardItem.shortNameEn) : reward.itemId.slice(0, 8)}</strong><small>×{number.format(reward.count)}</small></div></div>;
              })}
              {!task.rewardItems.length && !task.traderStandingRewards.length && task.experience <= 0 && <div className="quest-intel-empty">Recompensas não disponíveis no normalizador atual.</div>}
            </div>
          </section>

          <div className="quest-reference-actions">
            {wikiLoading ? (
              <span className="quest-reference-link loading"><span className="spinner" /> LOCALIZANDO GUIA NA WIKI...</span>
            ) : (
              <a
                href={wiki?.url ?? `https://escapefromtarkov.fandom.com/wiki/Special:Search?query=${encodeURIComponent(task.nameEn || task.name)}`}
                target="_blank"
                rel="noreferrer"
                className="quest-reference-link"
              >
                ABRIR GUIA NA WIKI ↗
              </a>
            )}
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${task.name} tarkov`)}`}
              target="_blank"
              rel="noreferrer"
              className="quest-reference-link youtube"
              title={`Buscar no YouTube em português: ${task.name} tarkov`}
            >
              YOUTUBE PT-BR ↗
            </a>
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${task.nameEn || task.name} tarkov`)}`}
              target="_blank"
              rel="noreferrer"
              className="quest-reference-link youtube"
              title={`Search YouTube in English: ${task.nameEn || task.name} tarkov`}
            >
              YOUTUBE EN ↗
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProfileField({ label, prefix, value, min = 0, onChange }: { label: string; prefix: string; value: number; min?: number; onChange: (value: number) => void }) {
  return <label className="profile-field"><span>{label}</span><div className="profile-input-wrap"><b>{prefix}</b><input type="number" min={min} step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} /></div></label>;
}

function KeepRow({ need, recentlyCovered, onOwned, onInspect }: { need: ItemNeed; recentlyCovered: boolean; onOwned: (amount: number) => void; onInspect: (item: TarkovItem) => void }) {
  const flea = fleaPrice(need.item);
  const trader = bestTraderPrice(need.item);
  const perSlot = valuePerSlot(need.item);
  return (
    <article className={`item-row${recentlyCovered ? " keep-row-covered" : ""}`}>
      <ItemImage item={need.item} onInspect={onInspect} />
      <div className="item-main">
        <div className="item-name"><strong>{dual(need.item.shortName, need.item.shortNameEn)}</strong><span>{dual(need.item.name, need.item.nameEn)}</span></div>
        <button type="button" className="usage-open-button" onClick={() => onInspect(need.item)}>↔ Trocas / Crafts</button>
        <div className="station-chips">
          {need.sources.slice(0, 5).map((source, index) => <span className={source.kind === "quest" || source.kind === "quest-key" ? "quest-chip" : ""} key={`${source.kind}-${source.taskId ?? source.stationId}-${index}`}>{source.kind === "quest-key" ? "🔑 " : ""}{source.count}× {dual(source.label, source.labelEn)}{source.foundInRaid ? " · FIR" : ""}{source.kappaRequired ? " · Kappa" : ""}</span>)}
          {need.sources.length > 5 && <span>+{need.sources.length - 5}</span>}
        </div>
        {recentlyCovered && <div className="keep-covered-note">✓ NECESSIDADE COBERTA · removendo da lista em alguns segundos</div>}
      </div>
      <div className="need-owned-stepper">
        <span>Tenho</span>
        <div className="stash-stepper">
          <button type="button" aria-label="Diminuir quantidade" onClick={() => onOwned(Math.max(0, need.owned - 1))}>−</button>
          <input type="number" min="0" value={need.owned} onChange={(event) => onOwned(Number(event.target.value))} />
          <button type="button" aria-label="Aumentar quantidade" onClick={() => onOwned(need.owned + 1)}>+</button>
        </div>
      </div>
      <div className="need-metric"><span>Preciso</span><strong>{number.format(need.totalNeeded)}</strong></div>
      <div className={need.missing > 0 ? "need-metric missing" : "need-metric done"}><span>Faltam</span><strong>{number.format(need.missing)}</strong>{need.foundInRaidNeeded > 0 && <small>{number.format(need.foundInRaidNeeded)} FIR</small>}</div>
      <div className="price-block"><span>Flea / trader</span><strong>{money(flea)} / {money(trader?.price)}</strong><small>{trader ? dual(trader.vendor, trader.vendorEn) : "sem trader"}{perSlot ? ` · ${money(perSlot)}/slot` : ""}</small></div>
    </article>
  );
}

function RaidRow({ item, need, keyInfo, owned, onOwned, onInspect }: { item: TarkovItem; need?: ItemNeed; keyInfo?: KeyInfo; owned: number; onOwned: (id: string, amount: number) => void; onInspect: (item: TarkovItem) => void }) {
  const flea = fleaPrice(item);
  const trader = bestTraderPrice(item);
  const best = bestSellPrice(item);
  const perSlot = valuePerSlot(item);
  const mustKeep = Boolean(need && !need.currency && need.missing > 0);
  const keyDecision = keyInfo ? keyRaidDecision(keyInfo) : null;
  const badgeLabel = keyDecision?.label ?? (mustKeep ? `GUARDE · faltam ${number.format(need?.missing ?? 0)}${need?.foundInRaidNeeded ? ` · ${number.format(need.foundInRaidNeeded)} FIR` : ""}` : "PODE VENDER");
  const badgeClass = keyDecision
    ? keyDecision.tone === "owned" ? "owned-badge" : "keep-badge"
    : mustKeep ? "keep-badge" : "sell-badge";

  return (
    <article
      className="raid-row raid-row-clickable"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, input, a, select, textarea")) return;
        onInspect(item);
      }}
      title={`Clique para ver trocas e receitas de ${item.shortName}`}
    >
      <ItemImage item={item} onInspect={onInspect} />
      <div className="item-main">
        <div className="item-name"><strong>{dual(item.shortName, item.shortNameEn)}</strong><span>{dual(item.name, item.nameEn)}</span></div>
        <div className="raid-item-actions">
          <span className={badgeClass}>{badgeLabel}</span>
          <button type="button" className="usage-open-button" onClick={() => onInspect(item)}>↔ Ver trocas / receitas</button>
        </div>
        {keyInfo && <div className="station-chips key-raid-chips">
          <span className={keyInfo.owned > 0 ? "owned-key-chip" : "missing-key-chip"}>🔑 Tenho: {keyInfo.owned}</span>
          {keyInfo.keepDuplicates && <span className="favorite-key-chip">⭐ Manter repetidas</span>}
          {keyInfo.marked && <span className="marked-chip">✦ Marked Key</span>}
          {keyInfo.item.keyUses && keyInfo.item.keyUses > 0 && <span>↻ {keyInfo.item.keyUses} usos máx.</span>}
          {keyInfo.maps.slice(0, 3).map((map) => <span key={map.id}>🗺 {dual(map.name, map.nameEn)}</span>)}
          {keyInfo.pendingQuestUses.slice(0, 2).map((use, index) => <span className="quest-chip" key={`${use.taskId}-${index}`}>🔑 {dual(use.taskName, use.taskNameEn)}{use.alternativeKeyIds.length > 1 ? " · alternativa" : ""}</span>)}
        </div>}
      </div>
      <div className="raid-owned-metric">
        <span>Tenho</span>
        <div className="raid-owned-control">
          <button type="button" aria-label="Diminuir quantidade" onClick={() => onOwned(item.id, Math.max(0, owned - 1))}>−</button>
          <input type="number" min="0" step="1" value={owned} onChange={(event) => onOwned(item.id, Number(event.target.value))} />
          <button type="button" aria-label="Aumentar quantidade" onClick={() => onOwned(item.id, owned + 1)}>+</button>
        </div>
        {need && !need.currency && (
          <small>
            preciso {number.format(need.totalNeeded)} · {need.missing > 0 ? `faltam ${number.format(need.missing)}` : "coberta"}
          </small>
        )}
      </div>
      <div className="raid-stat"><span>Flea 24h</span><strong>{money(flea)}</strong><small>média do mercado</small></div>
      <div className="raid-stat"><span>Melhor trader</span><strong>{money(trader?.price)}</strong><small>{trader ? dual(trader.vendor, trader.vendorEn) : "—"}</small></div>
      <div className="raid-stat"><span>Melhor venda</span><strong>{money(best?.price)}</strong><small>{best ? dual(best.vendor, best.vendorEn) : "—"}</small></div>
      <div className="raid-stat hot"><span>Valor / slot</span><strong>{money(perSlot)}</strong><small>{item.width}×{item.height} · {item.width * item.height} slots{keyInfo?.item.keyUses && keyInfo.item.keyUses > 0 ? ` · ${keyInfo.item.keyUses} usos máx.` : ""}</small></div>
    </article>
  );
}

function KeysSection({
  keys,
  allKeys,
  maps,
  mapFilter,
  setMapFilter,
  query,
  setQuery,
  onOwned,
  onDuplicatePreference,
  onInspect,
}: {
  keys: KeyInfo[];
  allKeys: KeyInfo[];
  maps: TarkovMap[];
  mapFilter: string;
  setMapFilter: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  onOwned: (id: string, amount: number) => void;
  onDuplicatePreference: (id: string, enabled: boolean) => void;
  onInspect: (item: TarkovItem) => void;
}) {
  const ownedTypes = allKeys.filter((info) => info.owned > 0).length;
  const markedOwned = allKeys.filter((info) => info.marked && info.owned > 0).length;
  return (
    <section>
      <div className="section-heading">
        <div><div className="eyebrow">KEY COLLECTION</div><h2>Chaves</h2><p>{ownedTypes}/{allKeys.length} tipos registrados como possuídos. Organizadas pelos mapas onde aparecem como chave de acesso/fechadura; missões pendentes e preços entram na mesma visão.</p></div>
        <input className="search" placeholder="Chave, mapa ou quest — PT/EN…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="key-summary-line"><span>🔑 {ownedTypes} tipos no stash</span><span>✦ {markedOwned} Marked possuídas</span><span>⭐ marque qualquer chave para sempre pegar repetidas</span></div>
      <div className="subtabs key-map-tabs">
        <button className={mapFilter === "all" ? "subtab active" : "subtab"} onClick={() => setMapFilter("all")}>Todos os mapas</button>
        {maps.map((map) => <button key={map.id} className={mapFilter === map.id ? "subtab active" : "subtab"} onClick={() => setMapFilter(map.id)}>{dual(map.name, map.nameEn)}</button>)}
        <button className={mapFilter === "unmapped" ? "subtab active" : "subtab"} onClick={() => setMapFilter("unmapped")}>Sem mapa identificado</button>
      </div>
      <div className="key-list">
        {keys.map((info) => <KeyRow key={info.item.id} info={info} onOwned={onOwned} onDuplicatePreference={onDuplicatePreference} onInspect={onInspect} />)}
        {!keys.length && <div className="empty">Nenhuma chave encontrada neste filtro.</div>}
      </div>
    </section>
  );
}

function KeyRow({ info, onOwned, onDuplicatePreference, onInspect }: { info: KeyInfo; onOwned: (id: string, amount: number) => void; onDuplicatePreference: (id: string, enabled: boolean) => void; onInspect: (item: TarkovItem) => void }) {
  const flea = fleaPrice(info.item);
  const trader = bestTraderPrice(info.item);
  const best = bestSellPrice(info.item);
  return (
    <article className={`key-row ${info.owned > 0 ? "owned" : "missing"}`}>
      <ItemImage item={info.item} onInspect={onInspect} />
      <div className="key-main">
        <div className="item-name"><strong>{dual(info.item.shortName, info.item.shortNameEn)}</strong><span>{dual(info.item.name, info.item.nameEn)}</span></div>
        <button type="button" className="usage-open-button" onClick={() => onInspect(info.item)}>↔ Trocas / Crafts</button>
        <div className="station-chips">
          {info.maps.length ? info.maps.map((map) => <span key={map.id}>🗺 {dual(map.name, map.nameEn)}</span>) : <span>Mapa não identificado pela API</span>}
          {info.marked && <span className="marked-chip">✦ Marked Key</span>}
          {info.item.keyUses !== null && info.item.keyUses > 0 && <span>{info.item.keyUses} usos máx.</span>}
        </div>
        {info.questUses.length > 0 && <div className="key-quest-lines">{info.questUses.slice(0, 4).map((use, index) => <span key={`${use.taskId}-${index}`} className={info.pendingQuestUses.some((pending) => pending.taskId === use.taskId) ? "pending" : ""}>🔑 {dual(use.taskName, use.taskNameEn)}{use.alternativeKeyIds.length > 1 ? ` · 1 de ${use.alternativeKeyIds.length} alternativas` : ""}{use.kappaRequired ? " · Kappa" : ""}</span>)}{info.questUses.length > 4 && <span>+{info.questUses.length - 4} missões</span>}</div>}
      </div>
      <div className="need-metric"><span>Tenho</span><input type="number" min="0" value={info.owned} onChange={(event) => onOwned(info.item.id, Number(event.target.value))} /></div>
      <div className="key-price"><span>Flea</span><strong>{money(flea)}</strong><small>24h</small></div>
      <div className="key-price"><span>Melhor trader</span><strong>{money(trader?.price)}</strong><small>{trader ? dual(trader.vendor, trader.vendorEn) : "—"}</small></div>
      <div className="key-price best"><span>Melhor venda</span><strong>{money(best?.price)}</strong><small>{best ? dual(best.vendor, best.vendorEn) : "—"}</small></div>
      <label className={`duplicate-toggle ${info.keepDuplicates ? "active" : ""}`}><input type="checkbox" checked={info.keepDuplicates} onChange={(event) => onDuplicatePreference(info.item.id, event.target.checked)} /><span>⭐</span><b>Manter repetidas</b></label>
    </article>
  );
}


function QuestBoardSection({
  traders,
  progress,
  filter,
  setFilter,
  query,
  setQuery,
  onInspect,
}: {
  traders: QuestBoardTrader[];
  progress: ProfileProgress;
  filter: QuestBoardFilter;
  setFilter: (value: QuestBoardFilter) => void;
  query: string;
  setQuery: (value: string) => void;
  onInspect: (item: TarkovItem) => void;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = traders.flatMap((group) => {
    const items = group.items.filter((entry) => {
      if (filter === "fir" && !entry.foundInRaid) return false;
      if (filter === "keys") return false;
      if (filter === "kappa" && !entry.kappa) return false;
      if (filter === "lightkeeper" && !entry.lightkeeper) return false;
      if (!needle) return true;
      return searchText(entry.item.name, entry.item.nameEn, entry.item.shortName, entry.item.shortNameEn, ...entry.questNames, ...entry.questNamesEn, group.trader.name, group.trader.nameEn).includes(needle);
    });
    const keys = group.keys.filter((entry) => {
      if (filter === "fir") return false;
      if (filter === "kappa" && !entry.kappa) return false;
      if (filter === "lightkeeper" && !entry.lightkeeper) return false;
      if (filter !== "all" && filter !== "keys" && filter !== "kappa" && filter !== "lightkeeper") return false;
      if (!needle) return true;
      return searchText(entry.info.item.name, entry.info.item.nameEn, entry.info.item.shortName, entry.info.item.shortNameEn, ...entry.questNames, ...entry.questNamesEn, group.trader.name, group.trader.nameEn).includes(needle);
    });
    if (!items.length && !keys.length && needle) return [];
    if (!items.length && !keys.length && filter !== "all") return [];
    return [{ ...group, items, keys }];
  });

  const totalItems = filtered.reduce((sum, group) => sum + group.items.length, 0);
  const missingItems = filtered.reduce((sum, group) => sum + group.items.filter((entry) => entry.globalMissing > 0).length, 0);
  const coveredItems = totalItems - missingItems;
  const totalKeys = filtered.reduce((sum, group) => sum + group.keys.filter((key) => key.info.owned <= 0).length, 0);

  return (
    <section className="quest-board-section">
      <div className="section-heading quest-board-heading">
        <div>
          <div className="eyebrow">DYNAMIC QUEST PLANNER</div>
          <h2>Quest Board</h2>
          <p>Itens físicos e chaves ligados às quests ainda não concluídas, organizados por trader. “Faltam” usa o déficit global real do seu stash; a quantidade grande é o requisito das quests daquele trader.</p>
        </div>
        <input className="search" placeholder="Item, quest ou trader — PT/EN…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="quest-board-toolbar">
        <div className="subtabs quest-board-filters">
          {([
            ["all", "Tudo"], ["fir", "Somente FIR"], ["keys", "Somente chaves"], ["kappa", "Kappa"], ["lightkeeper", "Lightkeeper"],
          ] as Array<[QuestBoardFilter, string]>).map(([id, label]) => (
            <button key={id} className={filter === id ? "subtab active" : "subtab"} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <div className="quest-board-summary"><span>{missingItems} itens faltando</span><span>{coveredItems} cobertos</span><span>{totalKeys} chaves faltando</span><span>{filtered.length} traders</span></div>
      </div>

      <div className="quest-board-scroll">
        <div className="quest-board-grid">
          {filtered.map((group) => (
            <article className="quest-board-column" key={group.trader.id}>
              <header className="quest-board-trader-head">
                <TraderAvatar trader={group.trader} large />
                <div><div className="eyebrow">TRADER</div><h3>{dual(group.trader.name, group.trader.nameEn)}</h3><span>{group.pendingTasks} quests pendentes</span></div>
              </header>

              <div className="quest-board-block">
                <div className="quest-board-block-title"><span>ITENS DE QUEST</span><b>{group.items.filter((entry) => entry.globalMissing > 0).length} faltando · {group.items.filter((entry) => entry.globalMissing <= 0).length} cobertos</b></div>
                <div className="quest-board-items">
                  {group.items.map((entry) => <QuestBoardItemRow key={entry.item.id} entry={entry} owned={progress.inventory[entry.item.id] ?? 0} onInspect={onInspect} />)}
                  {!group.items.length && <div className="quest-board-empty">Nenhum item neste filtro.</div>}
                </div>
              </div>

              <div className="quest-board-block keys-block">
                <div className="quest-board-block-title"><span>KEYS TO LOCATE</span><b>{group.keys.length}</b></div>
                <div className="quest-board-keys">
                  {group.keys.map((entry) => <QuestBoardKeyRow key={entry.info.item.id} entry={entry} onInspect={onInspect} />)}
                  {!group.keys.length && <div className="quest-board-empty">Nenhuma chave neste filtro.</div>}
                </div>
              </div>
            </article>
          ))}
          {!filtered.length && <div className="empty quest-board-no-results">Nada encontrado neste filtro.</div>}
        </div>
      </div>
    </section>
  );
}

function QuestBoardItemRow({ entry, owned, onInspect }: { entry: QuestBoardItem; owned: number; onInspect: (item: TarkovItem) => void }) {
  const title = [...entry.questNames, ...entry.questNamesEn].join(" / ");
  const covered = entry.globalMissing <= 0;
  return (
    <button type="button" className={covered ? "quest-board-item covered" : "quest-board-item missing"} title={title} onClick={() => onInspect(entry.item)}>
      <div className="quest-board-thumb"><ItemImage item={entry.item} /></div>
      <div className="quest-board-item-main">
        <strong>{dual(entry.item.shortName, entry.item.shortNameEn)}</strong>
        <span>{entry.questNames[0]}{entry.questNames.length > 1 ? ` +${entry.questNames.length - 1}` : ""}</span>
        <div className="quest-board-badges">
          {entry.foundInRaid && <em className="fir-badge">FIR</em>}
          {entry.kappa && <em>Kappa</em>}
          {entry.lightkeeper && <em>LK</em>}
          {covered ? <em className="covered-badge">✓ COBERTO</em> : <em className="owned-reference">Tenho {owned}</em>}
        </div>
      </div>
      <div className="quest-board-qty">{covered ? <><b>✓</b><small>tenho {owned} / preciso {entry.required}</small></> : <><b>×{entry.required}</b><small>faltam {entry.globalMissing} global</small></>}</div>
    </button>
  );
}

function QuestBoardKeyRow({ entry, onInspect }: { entry: QuestBoardKey; onInspect: (item: TarkovItem) => void }) {
  const best = bestSellPrice(entry.info.item);
  return (
    <div className={entry.info.owned > 0 ? "quest-board-key owned" : "quest-board-key missing"} title={[...entry.questNames, ...entry.questNamesEn].join(" / ")}>
      <div className="quest-board-key-icon"><ItemImage item={entry.info.item} onInspect={onInspect} /></div>
      <div className="quest-board-key-main">
        <strong>{dual(entry.info.item.shortName, entry.info.item.shortNameEn)}</strong>
        <span>{entry.questNames[0]}{entry.questNames.length > 1 ? ` +${entry.questNames.length - 1}` : ""}</span>
        <small>{entry.info.owned > 0 ? `✓ Tenho ${entry.info.owned}` : "Falta no stash"}{best?.price ? ` · ${money(best.price)}` : ""}</small>
      </div>
      {entry.info.keepDuplicates && <span className="quest-board-key-star">★</span>}
    </div>
  );
}

function QuestSection({
  view,
  tasks,
  progress,
  itemMap,
  traders,
  traderFilter,
  setTraderFilter,
  query,
  setQuery,
  filter,
  setFilter,
  onCompleted,
  onCurrent,
  onInspectTask,
}: {
  view: "quests" | "kappa" | "lightkeeper";
  tasks: TarkovTask[];
  progress: ProfileProgress;
  itemMap: Map<string, TarkovItem>;
  traders: TarkovTrader[];
  traderFilter: string;
  setTraderFilter: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  filter: TaskStatusFilter;
  setFilter: (value: TaskStatusFilter) => void;
  onCompleted: (id: string, completed: boolean) => void;
  onCurrent: (id: string) => void;
  onInspectTask: (task: TarkovTask) => void;
}) {
  const title = view === "kappa" ? "Caminho do Kappa" : view === "lightkeeper" ? "Caminho do Lightkeeper" : "Missões";
  const completed = tasks.filter((task) => taskIsCompleted(task, progress)).length;
  const needle = query.trim().toLocaleLowerCase();
  const taskTraderIds = new Set(tasks.map((task) => task.traderId).filter((id): id is string => Boolean(id)));
  const traderOrder = ["prapor", "therapist", "fence", "skier", "peacekeeper", "mechanic", "ragman", "jaeger", "ref", "lightkeeper"];
  const relevantTraders = traders
    .filter((trader) => taskTraderIds.has(trader.id))
    .sort((a, b) => {
      const aName = a.nameEn.toLocaleLowerCase();
      const bName = b.nameEn.toLocaleLowerCase();
      const ai = traderOrder.findIndex((name) => aName.includes(name));
      const bi = traderOrder.findIndex((name) => bName.includes(name));
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return a.name.localeCompare(b.name);
    });

  const taskPassesText = (task: TarkovTask) => {
    if (!needle) return true;
    const keyNames = task.keyRequirements.flatMap((requirement) => requirement.keyIds.flatMap((id) => {
      const item = itemMap.get(id);
      return item ? [item.name, item.nameEn, item.shortName, item.shortNameEn] : [];
    }));
    return searchText(task.name, task.nameEn, task.traderName, task.traderNameEn, ...keyNames).includes(needle);
  };

  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  // The status counters must describe the same scope the user is viewing.
  // Trader + text search narrow the scope first; the status tab is applied afterwards.
  const scopedTasks = tasks.filter((task) => {
    if (traderFilter !== "all" && task.traderId !== traderFilter) return false;
    return taskPassesText(task);
  });

  const chainCounts = scopedTasks.reduce((acc, task) => {
    const state = taskChainState(task, progress);
    if (state === "completed") acc.completed += 1;
    else if (state === "chain-ready") acc.ready += 1;
    else acc.blocked += 1;
    return acc;
  }, { ready: 0, blocked: 0, completed: 0 });

  const filtered = scopedTasks.filter((task) => {
    const chainState = taskChainState(task, progress);
    if (filter === "chain-ready" && chainState !== "chain-ready") return false;
    if (filter === "blocked" && chainState !== "blocked-by-task") return false;
    if (filter === "completed" && chainState !== "completed") return false;
    return true;
  });

  const traderStats = new Map(relevantTraders.map((trader) => {
    const traderTasks = tasks.filter((task) => task.traderId === trader.id);
    return [trader.id, {
      total: traderTasks.length,
      completed: traderTasks.filter((task) => taskIsCompleted(task, progress)).length,
    }];
  }));

  const groups = relevantTraders.flatMap((trader) => {
    const groupTasks = filtered
      .filter((task) => task.traderId === trader.id)
      .sort((a, b) => a.minPlayerLevel - b.minPlayerLevel || a.name.localeCompare(b.name));
    if (!groupTasks.length) return [];
    return [{ trader, tasks: groupTasks }];
  });
  const ungrouped = filtered.filter((task) => !task.traderId || !relevantTraders.some((trader) => trader.id === task.traderId));


  return (
    <section>
      <div className="section-heading">
        <div><div className="eyebrow">QUEST PROGRESS</div><h2>{title}</h2><p>{completed}/{tasks.length} concluídas. “Cadeia liberada” significa que não falta nenhuma quest pré-requisito conhecida; level, loyalty e outros gates do jogo ainda podem se aplicar. A busca aceita PT/EN, trader e chaves.</p></div>
        <input className="search" placeholder="Quest, trader ou chave, PT/EN…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="trader-filter-grid">
        <button type="button" className={traderFilter === "all" ? "trader-filter-card active" : "trader-filter-card"} onClick={() => setTraderFilter("all")}>
          <div className="trader-avatar trader-avatar-all">ALL</div>
          <div className="trader-filter-copy"><strong>Todos os traders</strong><span>{completed}/{tasks.length} concluídas</span></div>
        </button>
        {relevantTraders.map((trader) => {
          const stats = traderStats.get(trader.id) ?? { total: 0, completed: 0 };
          return (
            <button type="button" key={trader.id} className={traderFilter === trader.id ? "trader-filter-card active" : "trader-filter-card"} onClick={() => setTraderFilter(trader.id)}>
              <TraderAvatar trader={trader} />
              <div className="trader-filter-copy"><strong>{dual(trader.name, trader.nameEn)}</strong><span>{stats.completed}/{stats.total} concluídas</span></div>
            </button>
          );
        })}
      </div>

      <div className="subtabs quest-status-tabs">
        {([
          ["all", `Todas · ${scopedTasks.length}`],
          ["chain-ready", `Cadeia liberada · ${chainCounts.ready}`],
          ["blocked", `Bloqueadas por missão · ${chainCounts.blocked}`],
          ["completed", `Concluídas · ${chainCounts.completed}`],
        ] as Array<[TaskStatusFilter, string]>).map(([id, label]) => <button key={id} className={filter === id ? "subtab active" : "subtab"} onClick={() => setFilter(id)}>{label}</button>)}
      </div>

      <div className="quest-groups">
        {groups.map(({ trader, tasks: groupTasks }) => {
          const stats = traderStats.get(trader.id) ?? { total: groupTasks.length, completed: 0 };
          return (
            <section className="quest-trader-group" key={trader.id}>
              <div className="quest-trader-header">
                <TraderAvatar trader={trader} large />
                <div><div className="eyebrow">TRADER</div><h3>{dual(trader.name, trader.nameEn)}</h3><span>{stats.completed}/{stats.total} concluídas · {groupTasks.length} visíveis neste filtro</span></div>
                <div className="trader-progress"><i style={{ width: `${stats.total ? Math.round((stats.completed / stats.total) * 100) : 0}%` }} /></div>
              </div>
              <div className="quest-list quest-list-flat">
                {groupTasks.map((task) => (
                  <QuestRow key={task.id} task={task} progress={progress} itemMap={itemMap} taskMap={taskMap} onCompleted={onCompleted} onCurrent={onCurrent} onInspect={onInspectTask} />
                ))}
              </div>
            </section>
          );
        })}
        {ungrouped.length > 0 && (
          <section className="quest-trader-group">
            <div className="quest-trader-header"><div className="trader-avatar trader-avatar-large trader-avatar-all">?</div><div><div className="eyebrow">OUTROS</div><h3>Trader não identificado</h3><span>{ungrouped.length} missões visíveis</span></div></div>
            <div className="quest-list">{ungrouped.slice().sort((a, b) => a.minPlayerLevel - b.minPlayerLevel || a.name.localeCompare(b.name)).map((task) => <QuestRow key={task.id} task={task} progress={progress} itemMap={itemMap} taskMap={taskMap} onCompleted={onCompleted} onCurrent={onCurrent} onInspect={onInspectTask} />)}</div>
          </section>
        )}
        {!filtered.length && <div className="empty">Nenhuma missão encontrada.</div>}
      </div>
    </section>
  );
}

function TraderAvatar({ trader, large = false }: { trader: TarkovTrader; large?: boolean }) {
  const className = large ? "trader-avatar trader-avatar-large" : "trader-avatar";
  return (
    <div className={className}>
      {trader.imageLink ? <img src={trader.imageLink} alt={trader.nameEn || trader.name} /> : <span>{(trader.nameEn || trader.name).slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

function QuestRow({ task, progress, itemMap, taskMap, onCompleted, onCurrent, onInspect }: { task: TarkovTask; progress: ProfileProgress; itemMap: Map<string, TarkovItem>; taskMap: Map<string, TarkovTask>; onCompleted: (id: string, completed: boolean) => void; onCurrent: (id: string) => void; onInspect: (task: TarkovTask) => void }) {
  const chainState = taskChainState(task, progress);
  const missingIds = missingTaskRequirements(task, progress);
  const missingTasks = missingIds.map((id) => taskMap.get(id)).filter((candidate): candidate is TarkovTask => Boolean(candidate));
  const levelMet = progress.playerLevel >= task.minPlayerLevel;
  const statusLabel = chainState === "completed" ? "Concluída" : chainState === "chain-ready" ? "Cadeia liberada" : "Bloqueada por missão";
  return (
    <article className={`quest-row ${chainState} quest-row-clickable`} onClick={() => onInspect(task)}>
      <label className="quest-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={taskIsCompleted(task, progress)} onChange={(event) => onCompleted(task.id, event.target.checked)} /><span /></label>
      <div className="quest-main">
        <div className="quest-title"><strong>{dual(task.name, task.nameEn)}</strong></div>
        <div className="quest-meta">
          <span className={`status-pill ${chainState}`}>{statusLabel}</span>
          <span className={levelMet ? "level-met" : "level-missing"}>PMC Lv. {task.minPlayerLevel}+{levelMet ? " ✓" : " necessário"}</span>
          {task.kappaRequired && <span className="kappa-pill">Kappa</span>}
          {task.lightkeeperRequired && <span>Lightkeeper</span>}
        </div>
        {chainState === "blocked-by-task" && (
          <div className="quest-dependency-line">
            <b>Falta concluir:</b>
            {missingTasks.slice(0, 4).map((missing) => <span key={missing.id}>{dual(missing.name, missing.nameEn)}</span>)}
            {missingTasks.length < missingIds.length && missingIds.slice(missingTasks.length, 4).map((id) => <span key={id}>Quest {id.slice(0, 6)}</span>)}
            {missingIds.length > 4 && <em>+{missingIds.length - 4}</em>}
          </div>
        )}
        {chainState === "chain-ready" && !levelMet && <div className="quest-caveat">A cadeia de quests está liberada, mas seu level de PMC ainda não atende este requisito.</div>}
        {(task.itemRequirements.length > 0 || task.keyRequirements.length > 0) && <div className="quest-items">
          {task.itemRequirements.slice(0, 6).map((requirement, index) => {
            const names = requirement.itemIds.map((id) => itemMap.get(id)).filter((item): item is TarkovItem => Boolean(item)).map((item) => dual(item.shortName, item.shortNameEn));
            const requirementKey = ["item", task.id, requirement.objectiveId, requirement.itemIds.join("-"), requirement.count, requirement.foundInRaid ? "fir" : "any", index].join(":");
            return <span key={requirementKey}>{requirement.count}× {names.length ? names.join(" / ") : "item"}{requirement.itemIds.length > 1 ? " (alternativas)" : ""}{requirement.foundInRaid ? " · FIR" : ""}</span>;
          })}
          {task.keyRequirements.slice(0, 5).map((requirement, index) => {
            const names = requirement.keyIds.map((id) => itemMap.get(id)).filter((item): item is TarkovItem => Boolean(item)).map((item) => dual(item.shortName, item.shortNameEn));
            const requirementKey = ["key", task.id, requirement.objectiveId, requirement.keyIds.join("-"), index].join(":");
            return <span className="key-requirement-chip" key={requirementKey}>🔑 {names.length ? names.join(" / ") : "chave"}{requirement.keyIds.length > 1 ? " · 1 alternativa" : ""}</span>;
          })}
        </div>}
      </div>
      <button className="current-task" type="button" disabled={chainState === "completed"} onClick={(event) => { event.stopPropagation(); onCurrent(task.id); }}>Estou nesta</button>
    </article>
  );
}

