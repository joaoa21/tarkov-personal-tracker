import { GAME_MODES, type GameMode } from "@/lib/types";

const MODE_META: Record<GameMode, { eyebrow: string; detail: string }> = {
  pve: { eyebrow: "PERSISTENTE", detail: "PvE" },
  regular: { eyebrow: "PERSISTENTE", detail: "PvP" },
  "pvp-season": { eyebrow: "TEMPORADA", detail: "Season" },
};

export function ModeSwitcher({ mode, onChange }: { mode: GameMode; onChange: (mode: GameMode) => void }) {
  return (
    <div className="mode-selector-shell">
      <div className="mode-selector-label">PERSONAGEM ATIVO</div>
      <div className="mode-switch" aria-label="Personagem/modo">
        {GAME_MODES.map((entry) => {
          const meta = MODE_META[entry.id];
          return (
            <button
              type="button"
              key={entry.id}
              onClick={() => onChange(entry.id)}
              className={mode === entry.id ? "mode-button active" : "mode-button"}
            >
              <span className={`mode-dot ${entry.id}`} />
              <span className="mode-copy">
                <b>{meta.detail}</b>
                <small>{meta.eyebrow}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
