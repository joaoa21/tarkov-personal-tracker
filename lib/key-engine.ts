import { taskIsCompleted } from "./hideout-engine";
import type { KeyInfo, KeyQuestUse, ProfileProgress, TarkovItem, TarkovMap, TarkovTask } from "./types";

function lower(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function isKeyItem(item: TarkovItem) {
  const types = item.types.map(lower);
  return types.includes("keys");
}

export function isMarkedKey(item: TarkovItem) {
  if (item.types.some((type) => lower(type) === "markedonly")) return true;
  const names = `${item.name} ${item.nameEn} ${item.shortName} ${item.shortNameEn}`.toLocaleLowerCase();
  return names.includes("marked") || names.includes("marcada") || names.includes("marcado");
}

export function buildKeyInfos(
  items: TarkovItem[],
  maps: TarkovMap[],
  tasks: TarkovTask[],
  progress: ProfileProgress,
): KeyInfo[] {
  const mapUses = new Map<string, TarkovMap[]>();
  for (const map of maps) {
    for (const keyId of new Set([...map.lockKeyIds, ...map.accessKeyIds])) {
      const list = mapUses.get(keyId) ?? [];
      list.push(map);
      mapUses.set(keyId, list);
    }
  }

  const questUses = new Map<string, KeyQuestUse[]>();
  const pendingUses = new Map<string, KeyQuestUse[]>();

  for (const task of tasks) {
    for (const requirement of task.keyRequirements) {
      const use: KeyQuestUse = {
        taskId: task.id,
        taskName: task.name,
        taskNameEn: task.nameEn,
        kappaRequired: task.kappaRequired,
        lightkeeperRequired: task.lightkeeperRequired,
        alternativeKeyIds: requirement.keyIds,
        optional: requirement.optional,
      };

      const groupAlreadyOwned = requirement.keyIds.some((keyId) => (progress.inventory[keyId] ?? 0) > 0);
      for (const keyId of requirement.keyIds) {
        const all = questUses.get(keyId) ?? [];
        all.push(use);
        questUses.set(keyId, all);

        if (!taskIsCompleted(task, progress) && !groupAlreadyOwned && !requirement.optional) {
          const pending = pendingUses.get(keyId) ?? [];
          pending.push(use);
          pendingUses.set(keyId, pending);
        }
      }
    }
  }

  return items
    .filter(isKeyItem)
    .map((item): KeyInfo => ({
      item,
      owned: Math.max(0, progress.inventory[item.id] ?? 0),
      maps: (mapUses.get(item.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      questUses: questUses.get(item.id) ?? [],
      pendingQuestUses: pendingUses.get(item.id) ?? [],
      marked: isMarkedKey(item),
      keepDuplicates: Boolean(progress.preferredDuplicateKeys[item.id]),
    }))
    .sort((a, b) => {
      if (a.owned === 0 && b.owned > 0) return -1;
      if (a.owned > 0 && b.owned === 0) return 1;
      return a.item.name.localeCompare(b.item.name);
    });
}

export type KeyRaidDecision = {
  tone: "keep" | "new" | "duplicate" | "owned";
  label: string;
};

export function keyRaidDecision(info: KeyInfo): KeyRaidDecision {
  const ownedLabel = info.owned > 0 ? `tenho ${info.owned}` : "não tenho";

  if (info.pendingQuestUses.length > 0) {
    const duplicateLabel = info.keepDuplicates ? " · ⭐ manter repetidas" : "";
    return { tone: "keep", label: `GUARDE · ${ownedLabel} · necessária em missão${duplicateLabel}` };
  }
  if (info.owned <= 0) {
    return { tone: "new", label: "PEGUE · você ainda não tem esta chave" };
  }
  if (info.keepDuplicates) {
    return { tone: "duplicate", label: `PEGUE · tenho ${info.owned} · ⭐ marcada para repetir` };
  }
  if (info.marked) {
    return { tone: "duplicate", label: `PEGUE · tenho ${info.owned} · Marked Key` };
  }
  return { tone: "owned", label: `JÁ TENHO · ${info.owned} no inventário` };
}
