import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Darts League (local-only, Safari)
 * - Single-file React app (Canvas)
 * - Persists to localStorage
 * - Season 1 preloaded with Soirée 1 results
 * - Pools S1+S2 random, from S3 split by ranking: (1,3,5,7) vs (2,4,6,8)
 * - Rebuy: separate tab, adds +€1 to jackpot, only rebuy winner earns +2 pts
 * - Jackpot: +€1 per player per soirée (8 players => +€8), +€1 per rebuy
 * - Podium gains per soirée: 7€ / 3€ / 2€ (displayed)
 */

type Phase = "POULE" | "DEMI" | "PFINAL" | "FINAL";

type CoreMatch = {
  id: string;
  order: number;
  phase: Phase;
  pool: "A" | "B" | null;
  format: 301 | 501;
  bo: "BO1" | "BO3" | "BO5" | "SEC";
  maxTurns: number;
  a: string;
  b: string;
  winner: "" | string;
  checkout100: boolean;
  checkoutBy: "" | "A" | "B";
};

type RebuyMatch = {
  id: string;
  buyer: string;
  a: string;
  b: string;
  winner: "" | string;
  createdAt: number;
};

type Soiree = {
  id: string;
  number: number;
  dateLabel?: string;
  createdAt: number;
  pools: { A: string[]; B: string[] };
  matches: CoreMatch[];
  rebuys: RebuyMatch[];
  qualifiersOverride?: {
    A1?: string;
    A2?: string;
    B1?: string;
    B2?: string;
  };
};

type Season = {
  id: string;
  name: string;
  players: string[];
  soirees: Soiree[];
};

type AppState = {
  version: number;
  seasons: Season[];
  activeSeasonId: string;
};

const STORAGE_KEY = "darts_league_app_v2";
const VERSION = 2;

const MONEY = {
  entryFeeEUR: 3,
  jackpotPerPlayerEUR: 1,
  rebuyEUR: 0.5,
  podiumEUR: { first: 7, second: 3, third: 2 },
};

const PALETTE = [
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#f97316",
  "#ef4444",
  "#eab308",
  "#06b6d4",
  "#f43f5e",
];

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normName(s: string) {
  return (s ?? "").toString().trim();
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function poolMatchesFor4(players: string[], pool: "A" | "B"): CoreMatch[] {
  const [p1, p2, p3, p4] = players;
  const pairs: Array<[string, string]> = [
    [p1, p2],
    [p3, p4],
    [p1, p3],
    [p2, p4],
    [p1, p4],
    [p2, p3],
  ];

  return pairs.map(([a, b], idx) => ({
    id: uid("m"),
    order: idx + 1,
    phase: "POULE",
    pool,
    format: 301,
    bo: "BO3",
    maxTurns: 10,
    a,
    b,
    winner: "",
    checkout100: false,
    checkoutBy: "",
  }));
}

function interleavePools(a: CoreMatch[], b: CoreMatch[]) {
  const out: CoreMatch[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out.map((m, idx) => ({ ...m, order: idx + 1 }));
}

function computePointsFromMatches(
  matches: CoreMatch[],
  rebuyMatches: RebuyMatch[],
  seasonSoireeNumber?: number,
  season?: Season
) {
  const pts = new Map<string, number>();
  const wins = new Map<string, number>();
  const bonus = new Map<string, number>();

  const add = (map: Map<string, number>, key: string, delta: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  for (const m of matches) {
    const w = normName(m.winner);
    if (w) {
      const basePts = m.phase === "PFINAL" ? 1 : 2;
      add(pts, w, basePts);
      add(wins, w, 1);
    }

    if (m.checkoutBy === "A" && normName(m.a)) {
      add(bonus, normName(m.a), 1);
      add(pts, normName(m.a), 1);
    } else if (m.checkoutBy === "B" && normName(m.b)) {
      add(bonus, normName(m.b), 1);
      add(pts, normName(m.b), 1);
    }
  }

  const soN = Number(seasonSoireeNumber ?? 0);

  const priorCompleted = new Map<string, number>();
  if (soN >= 3 && season) {
    const soireesAsc = [...season.soirees].sort((a: Soiree, b: Soiree) => a.number - b.number);
    for (const s of soireesAsc) {
      if (s.number >= soN) break;
      for (const rb of s.rebuys) {
        const buyer = normName(rb.buyer);
        const w = normName(rb.winner);
        if (!buyer || !w) continue;
        priorCompleted.set(buyer, (priorCompleted.get(buyer) ?? 0) + 1);
      }
    }
  }

  const sortedRebuys = [...rebuyMatches].sort((a: RebuyMatch, b: RebuyMatch) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const localCompleted = new Map<string, number>();
  const doneBefore = (buyer: string) => (priorCompleted.get(buyer) ?? 0) + (localCompleted.get(buyer) ?? 0);
  const incLocalDone = (buyer: string) => localCompleted.set(buyer, (localCompleted.get(buyer) ?? 0) + 1);

  for (const r of sortedRebuys) {
    const buyer = normName(r.buyer);
    const w = normName(r.winner);
    if (!buyer || !w) continue;

    if (soN > 0 && soN <= 2) {
      if (w === buyer) {
        add(pts, buyer, 2);
        add(wins, buyer, 1);
      }
      incLocalDone(buyer);
      continue;
    }

    const winPts = soN >= 3 ? (doneBefore(buyer) === 0 ? 2 : 1) : 2;

    if (w === buyer) {
      add(pts, buyer, winPts);
      add(wins, buyer, 1);
    }

    incLocalDone(buyer);
  }

  return { pts, wins, bonus };
}

function aggregateSeasonStats(season: Season) {
  const pts = new Map<string, number>();
  const wins = new Map<string, number>();
  const bonus = new Map<string, number>();

  const add = (map: Map<string, number>, key: string, delta: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  for (const s of season.soirees) {
    const { pts: p, wins: w, bonus: b } = computePointsFromMatches(s.matches, s.rebuys, s.number, season);
    for (const [k, v] of p.entries()) add(pts, k, v);
    for (const [k, v] of w.entries()) add(wins, k, v);
    for (const [k, v] of b.entries()) add(bonus, k, v);
  }

  for (const pl of season.players) {
    if (!pts.has(pl)) pts.set(pl, 0);
    if (!wins.has(pl)) wins.set(pl, 0);
    if (!bonus.has(pl)) bonus.set(pl, 0);
  }

  const table = season.players.map((name) => ({
    name,
    pts: pts.get(name) ?? 0,
    wins: wins.get(name) ?? 0,
    bonus: bonus.get(name) ?? 0,
  }));

  table.sort((a: { name: string; pts: number; wins: number; bonus: number }, b: { name: string; pts: number; wins: number; bonus: number }) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.name.localeCompare(b.name);
  });

  return { table, pts, wins, bonus };
}

function computeJackpotEUR(season: Season) {
  const base = season.soirees.reduce((sum, s) => sum + s.pools.A.length + s.pools.B.length, 0);
  const rebuyCount = season.soirees.reduce((sum, s) => sum + s.rebuys.length, 0);
  return base * MONEY.jackpotPerPlayerEUR + rebuyCount * MONEY.rebuyEUR;
}

function computeWinStreaks(season: Season) {
  const streak = new Map<string, number>();
  const best = new Map<string, number>();

  const setBest = (p: string) => best.set(p, Math.max(best.get(p) ?? 0, streak.get(p) ?? 0));

  const allPlayers = season.players;
  for (const p of allPlayers) {
    streak.set(p, 0);
    best.set(p, 0);
  }

  const applyResult = (a: string, b: string, winner: string) => {
    a = normName(a);
    b = normName(b);
    winner = normName(winner);
    if (!a || !b || !winner) return;
    const loser = winner === a ? b : winner === b ? a : "";
    if (!loser) return;

    streak.set(winner, (streak.get(winner) ?? 0) + 1);
    setBest(winner);

    streak.set(loser, 0);
    setBest(loser);
  };

  for (const s of season.soirees) {
    const sortedMatches = [...s.matches].sort((x, y) => x.order - y.order);
    for (const m of sortedMatches) applyResult(m.a, m.b, m.winner);

    const sortedRebuys = [...s.rebuys].sort((x, y) => x.createdAt - y.createdAt);
    for (const r of sortedRebuys) {
      if (normName(r.winner) && normName(r.winner) === normName(r.buyer)) {
        const opp = normName(r.a) === normName(r.buyer) ? r.b : r.a;
        applyResult(r.buyer, opp, r.winner);
      } else if (normName(r.winner)) {
        streak.set(normName(r.buyer), 0);
        setBest(normName(r.buyer));
      }
    }
  }

  const out = allPlayers.map((p) => ({ player: p, best: best.get(p) ?? 0 }));
  out.sort((a: { player: string; best: number }, b: { player: string; best: number }) => b.best - a.best || a.player.localeCompare(b.player));
  return out;
}

function computeHeadToHead(season: Season) {
  const players = season.players;
  const index = new Map(players.map((p, i) => [p, i] as const));
  const matrix = Array.from({ length: players.length }, () => Array(players.length).fill(0));

  for (const s of season.soirees) {
    for (const m of s.matches) {
      const w = normName(m.winner);
      if (!w) continue;
      const a = normName(m.a);
      const b = normName(m.b);
      if (!index.has(a) || !index.has(b) || !index.has(w)) continue;
      const loser = w === a ? b : w === b ? a : "";
      if (!loser) continue;
      matrix[index.get(w)!][index.get(loser)!] += 1;
    }
  }

  return { players, matrix };
}

function makeEmptySoiree(number = 1): Soiree {
  return {
    id: uid("s"),
    number,
    createdAt: Date.now(),
    pools: { A: [], B: [] },
    matches: [],
    rebuys: [],
  };
}

function makeEmptySeason(name = "Saison 1"): Season {
  return {
    id: uid("season"),
    name,
    players: [],
    soirees: [makeEmptySoiree(1)],
  };
}

function makeInitialState(): AppState {
  const season = makeEmptySeason("Saison 1");
  return {
    version: VERSION,
    seasons: [season],
    activeSeasonId: season.id,
  };
}

function sanitizeState(raw: any): AppState {
  const fallback = makeInitialState();
  try {
    if (!raw || typeof raw !== "object") return fallback;
    const v = Number(raw.version ?? 0);
    const seasonsRaw = Array.isArray(raw.seasons)
      ? raw.seasons
      : raw.season && typeof raw.season === "object"
        ? [raw.season]
        : [];

    const sanitizeSeason = (season: any, i: number): Season => {
      const players = uniq((season?.players ?? []).map(normName)).filter(isNonEmptyString);
      const soirees: Soiree[] = (season?.soirees ?? []).map((s: any, idx: number) => {
        const poolsA = (s?.pools?.A ?? []).map(normName).filter(isNonEmptyString);
        const poolsB = (s?.pools?.B ?? []).map(normName).filter(isNonEmptyString);

        const matches: CoreMatch[] = (s?.matches ?? []).map((m: any, midx: number) => {
          const phase = (["POULE", "DEMI", "PFINAL", "FINAL"].includes(m?.phase) ? m.phase : "POULE") as Phase;
          const a = normName(m?.a);
          const b = normName(m?.b);
          const winner = normName(m?.winner);
          const checkoutBy = m?.checkoutBy === "A" || m?.checkoutBy === "B" ? m.checkoutBy : "";
          const inferredCheckoutBy =
            checkoutBy ||
            (m?.checkout100 && winner && (winner === a || winner === b) ? (winner === a ? "A" : "B") : "");
          return {
            id: normName(m?.id) || uid("m"),
            order: clampInt(Number(m?.order ?? midx + 1), 1, 9999),
            phase,
            pool: m?.pool === "A" || m?.pool === "B" ? m.pool : null,
            format: Number(m?.format) === 501 ? 501 : 301,
            bo: (["BO1", "BO3", "BO5", "SEC"].includes(m?.bo) ? m.bo : "BO3") as any,
            maxTurns: clampInt(Number(m?.maxTurns ?? 10), 1, 50),
            a,
            b,
            winner,
            checkout100: Boolean(inferredCheckoutBy),
            checkoutBy: inferredCheckoutBy,
          };
        });

        const rebuys: RebuyMatch[] = (s?.rebuys ?? []).map((r: any) => ({
          id: normName(r?.id) || uid("rb"),
          buyer: normName(r?.buyer),
          a: normName(r?.a),
          b: normName(r?.b),
          winner: normName(r?.winner),
          createdAt: Number(r?.createdAt ?? Date.now()),
        }));

        return {
          id: normName(s?.id) || uid("s"),
          number: clampInt(Number(s?.number ?? idx + 1), 1, 999),
          dateLabel: normName(s?.dateLabel) || undefined,
          createdAt: Number(s?.createdAt ?? Date.now()),
          pools: { A: poolsA, B: poolsB },
        matches: matches.sort((a: CoreMatch, b: CoreMatch) => a.order - b.order),
        rebuys: rebuys.sort((a: RebuyMatch, b: RebuyMatch) => a.createdAt - b.createdAt),
          qualifiersOverride:
            s?.qualifiersOverride && typeof s.qualifiersOverride === "object"
              ? {
                  A1: normName(s.qualifiersOverride.A1),
                  A2: normName(s.qualifiersOverride.A2),
                  B1: normName(s.qualifiersOverride.B1),
                  B2: normName(s.qualifiersOverride.B2),
                }
              : undefined,
        };
      });

      const inferredPlayers = players.length
        ? players
        : uniq(
            soirees.flatMap((s) => [
              ...s.pools.A,
              ...s.pools.B,
              ...s.matches.flatMap((m) => [m.a, m.b, m.winner]),
              ...s.rebuys.flatMap((r) => [r.buyer, r.a, r.b, r.winner]),
            ])
          ).filter(isNonEmptyString);

      const seasonSan: Season = {
        id: normName(season?.id) || uid("season"),
        name: normName(season?.name) || `Saison ${i + 1}`,
        players: inferredPlayers,
        soirees,
      };

      if (!seasonSan.soirees.length) seasonSan.soirees = [makeEmptySoiree(1)];
      return seasonSan;
    };

    const seasons = seasonsRaw.length ? seasonsRaw.map(sanitizeSeason) : [makeEmptySeason("Saison 1")];
    const activeSeasonId = normName(raw.activeSeasonId) || seasons[0].id;

    return {
      version: v || VERSION,
      seasons,
      activeSeasonId,
    };
  } catch {
    return fallback;
  }
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch {}

  try {
    if (
      typeof window !== "undefined" &&
      typeof window.name === "string" &&
      window.name.startsWith("DLSTATE:")
    ) {
      const raw = window.name.slice("DLSTATE:".length);
      if (raw) return sanitizeState(JSON.parse(raw));
    }
  } catch {}

  return makeInitialState();
}

function saveState(state: AppState) {
  const raw = JSON.stringify(state);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {}
  try {
    window.name = "DLSTATE:" + raw;
  } catch {}
}

function downloadTextFile(filename: string, text: string, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatEUR(n: number) {
  const v = Math.round(n * 100) / 100;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
}

function Pill({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ background: color ? `${color}22` : "#ffffff14", color: color ?? "#e5e7eb" }}
    >
      {children}
    </span>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-sm">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const base = "rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-[0.99]";
  const styles =
    variant === "primary"
      ? "bg-white text-black hover:bg-white/90"
      : variant === "danger"
        ? "bg-red-500 text-white hover:bg-red-400"
        : "bg-white/10 text-white hover:bg-white/15";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles} ${disabled ? "opacity-50" : ""}`}>
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? "—"}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export default function App() {
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<AppState>(() => loadState());
  const [tab, setTab] = useState<"SOIREE" | "CLASSEMENT" | "HISTO" | "REBUY" | "H2H" | "PARAMS" | "SAISONS">("SOIREE");
  const [compactMode, setCompactMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("dl_compact_mode") === "1";
    } catch {
      return false;
    }
  });
  const [cardsMode, setCardsMode] = useState<boolean>(true);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [exportText, setExportText] = useState("");
  const [newPlayerName, setNewPlayerName] = useState("");
  const [bulkPlayersText, setBulkPlayersText] = useState("");
  const [editingPlayer, setEditingPlayer] = useState<string | null>(null);
  const [editingPlayerName, setEditingPlayerName] = useState("");
  const [newSeasonName, setNewSeasonName] = useState("");
  const [copyPlayersForNewSeason, setCopyPlayersForNewSeason] = useState(true);
  const currentSeasons: Season[] = state.seasons;
  const [selectedSoireeNumber, setSelectedSoireeNumber] = useState<number>(() => {
    const max = Math.max(...currentSeasons[0].soirees.map((s: Soiree) => s.number));
    return max;
  });

  const savingRef = useRef<number | null>(null);

  const currentSeason = useMemo<Season>(() => {
    return currentSeasons.find((s: Season) => s.id === state.activeSeasonId) ?? currentSeasons[0];
  }, [currentSeasons, state.activeSeasonId]);

  useEffect(() => {
    if (savingRef.current) window.clearTimeout(savingRef.current);
    savingRef.current = window.setTimeout(() => {
      saveState(state);
    }, 120);
    return () => {
      if (savingRef.current) window.clearTimeout(savingRef.current);
    };
  }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem("dl_compact_mode", compactMode ? "1" : "0");
    } catch {}
  }, [compactMode]);

  useEffect(() => {
    if (!currentSeasons.find((s: Season) => s.id === state.activeSeasonId)) {
      setState((prev) => ({ ...prev, activeSeasonId: prev.seasons[0]?.id ?? prev.activeSeasonId }));
    }
  }, [state.activeSeasonId, currentSeasons]);

  useEffect(() => {
    const exists = currentSeason.soirees.some((s: Soiree) => s.number === selectedSoireeNumber);
    if (!exists) {
      const max = Math.max(...currentSeason.soirees.map((s: Soiree) => s.number));
      setSelectedSoireeNumber(max);
    }
  }, [currentSeason.soirees, selectedSoireeNumber]);

  const seasonStats = useMemo(() => aggregateSeasonStats(currentSeason), [currentSeason]);
  const jackpotEUR = useMemo(() => computeJackpotEUR(currentSeason), [currentSeason]);
  const streaks = useMemo(() => computeWinStreaks(currentSeason), [currentSeason]);
  const h2h = useMemo(() => computeHeadToHead(currentSeason), [currentSeason]);

  const playerColors = useMemo(() => {
    const map = new Map<string, string>();
    currentSeason.players.forEach((p: string, i: number) => map.set(p, PALETTE[i % PALETTE.length]));
    return map;
  }, [currentSeason.players]);

  const currentSoiree = useMemo(() => {
    return currentSeason.soirees.find((s: Soiree) => s.number === selectedSoireeNumber) ?? currentSeason.soirees[0];
  }, [currentSeason.soirees, selectedSoireeNumber]);


  const currentPoolStandings = useMemo(() => {
    const poolMatches = currentSoiree.matches.filter((m: CoreMatch) => m.phase === "POULE");

    const calcPool = (pool: "A" | "B") => {
      const players = currentSoiree.pools[pool];
      const relevant = poolMatches.filter((m: CoreMatch) => m.pool === pool);

      const { pts, wins, bonus } = computePointsFromMatches(relevant, [], currentSoiree.number, currentSeason);

      const rows = players.map((p: string) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
        bonus: bonus.get(p) ?? 0,
      }));

      rows.sort((a: { name: string; pts: number; wins: number; bonus: number }, b: { name: string; pts: number; wins: number; bonus: number }) =>
        b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name)
      );
      return rows;
    };

    return { A: calcPool("A"), B: calcPool("B") };
  }, [currentSoiree.matches, currentSoiree.pools, currentSoiree.number, currentSeason]);

  const allSoireeNumbers = useMemo(() => {
    return [...currentSeason.soirees].map((s: Soiree) => s.number).sort((a: number, b: number) => a - b);
  }, [currentSeason.soirees]);

  function updateSeason(mutator: (season: Season) => Season) {
    setState((prev) => {
      const seasons = prev.seasons.map((s) => (s.id === prev.activeSeasonId ? mutator(s) : s));
      return { ...prev, seasons };
    });
  }

  function addPlayer(nameRaw: string) {
    const name = normName(nameRaw);
    if (!name) return;
    updateSeason((season) => {
      if (season.players.includes(name)) return season;
      return { ...season, players: [...season.players, name] };
    });
  }

  function addPlayersFromBulk(text: string) {
    const names = uniq(
      text
        .split(/[\n,;]/g)
        .map((x) => normName(x))
        .filter(isNonEmptyString)
    );
    if (!names.length) return;
    updateSeason((season) => {
      const merged = [...season.players];
      for (const n of names) if (!merged.includes(n)) merged.push(n);
      return { ...season, players: merged };
    });
  }

  function removePlayer(name: string) {
    updateSeason((season) => {
      const players = season.players.filter((p) => p !== name);
      const soirees = season.soirees.map((s) => ({
        ...s,
        pools: {
          A: s.pools.A.filter((p) => p !== name),
          B: s.pools.B.filter((p) => p !== name),
        },
        matches: s.matches.map((m) => ({
          ...m,
          a: m.a === name ? "" : m.a,
          b: m.b === name ? "" : m.b,
          winner: m.winner === name ? "" : m.winner,
        })),
        rebuys: s.rebuys.map((r) => ({
          ...r,
          buyer: r.buyer === name ? "" : r.buyer,
          a: r.a === name ? "" : r.a,
          b: r.b === name ? "" : r.b,
          winner: r.winner === name ? "" : r.winner,
        })),
      }));
      return { ...season, players, soirees };
    });
  }

  function renamePlayer(oldName: string, newNameRaw: string) {
    const newName = normName(newNameRaw);
    if (!newName || newName === oldName) return;
    updateSeason((season) => {
      if (season.players.includes(newName)) return season;
      const players = season.players.map((p) => (p === oldName ? newName : p));
      const soirees = season.soirees.map((s) => ({
        ...s,
        pools: {
          A: s.pools.A.map((p) => (p === oldName ? newName : p)),
          B: s.pools.B.map((p) => (p === oldName ? newName : p)),
        },
        matches: s.matches.map((m) => ({
          ...m,
          a: m.a === oldName ? newName : m.a,
          b: m.b === oldName ? newName : m.b,
          winner: m.winner === oldName ? newName : m.winner,
        })),
        rebuys: s.rebuys.map((r) => ({
          ...r,
          buyer: r.buyer === oldName ? newName : r.buyer,
          a: r.a === oldName ? newName : r.a,
          b: r.b === oldName ? newName : r.b,
          winner: r.winner === oldName ? newName : r.winner,
        })),
      }));
      return { ...season, players, soirees };
    });
  }

  function addSeason() {
    setState((prev) => {
      const name = normName(newSeasonName) || `Saison ${prev.seasons.length + 1}`;
      const season = makeEmptySeason(name);
      if (copyPlayersForNewSeason) season.players = [...currentSeason.players];
      return {
        ...prev,
        seasons: [...prev.seasons, season],
        activeSeasonId: season.id,
      };
    });
    setSelectedSoireeNumber(1);
    setNewSeasonName("");
    setTab("SOIREE");
  }

  function setActiveSeason(id: string) {
    setState((prev) => {
      const season = prev.seasons.find((s) => s.id === id) ?? prev.seasons[0];
      const max = Math.max(...season.soirees.map((s) => s.number));
      setSelectedSoireeNumber(max);
      return { ...prev, activeSeasonId: id };
    });
  }

  function renameSeason(id: string, nameRaw: string) {
    const name = normName(nameRaw);
    if (!name) return;
    setState((prev) => ({
      ...prev,
      seasons: prev.seasons.map((s) => (s.id === id ? { ...s, name } : s)),
    }));
  }

  function deleteSeason(id: string) {
    setState((prev) => {
      if (prev.seasons.length <= 1) return prev;
      const seasons = prev.seasons.filter((s) => s.id !== id);
      const activeSeasonId = prev.activeSeasonId === id ? seasons[0].id : prev.activeSeasonId;
      return { ...prev, seasons, activeSeasonId };
    });
  }

  function setQualifiersOverride(patch: Partial<NonNullable<Soiree["qualifiersOverride"]>>) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        return {
          ...s,
          qualifiersOverride: { ...(s.qualifiersOverride ?? {}), ...patch },
        };
      });
      return { ...season, soirees };
    });
  }

  function resetAll() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setState(makeInitialState());
    setSelectedSoireeNumber(1);
    setTab("SOIREE");
  }

  function exportSeasonFile() {
    const payload = JSON.stringify(state, null, 2);
    const safeName = (currentSeason.name || "Saison").split(" ").join("_");
    const filename = "dark-league_" + safeName + "_soirees-" + String(currentSeason.soirees.length) + ".json";

    try {
      downloadTextFile(filename, payload);
    } catch {}

    setExportText(payload);
    setShowExport(true);
  }

  async function exportSeasonClipboard() {
    try {
      const payload = JSON.stringify(state, null, 2);
      await navigator.clipboard.writeText(payload);
      alert("Export copié dans le presse-papiers ✅");
    } catch {
      const payload = JSON.stringify(state, null, 2);
      setExportText(payload);
      setShowExport(true);
      alert("Copie automatique bloquée. L’export s’affiche : copie/colle-le dans un fichier .json ✅");
    }
  }

  function importSeasonFromText(text: string) {
    try {
      const parsed = JSON.parse(text);
      const next = sanitizeState(parsed);
      setState(next);
      const active = next.seasons.find((s) => s.id === next.activeSeasonId) ?? next.seasons[0];
      const max = Math.max(...active.soirees.map((s) => s.number));
      setSelectedSoireeNumber(max);
      setTab("SOIREE");
      setShowImport(false);
      setImportText("");
    } catch {
      alert("Import impossible : JSON invalide.");
    }
  }

  function triggerImportFile() {
    importFileRef.current?.click();
  }

  function startNewSoiree() {
    if (currentSeason.players.length < 2) {
      alert("Ajoute d’abord les joueurs (au moins 2).");
      return;
    }
    updateSeason((season) => {
      const nextNumber = Math.max(...season.soirees.map((s) => s.number)) + 1;
      const players = season.players;

      let pools: { A: string[]; B: string[] };
      if (nextNumber <= 2) {
        const sh = shuffle(players);
        pools = { A: sh.slice(0, 4), B: sh.slice(4, 8) };
      } else {
        const ranked = aggregateSeasonStats(season).table.map((x) => x.name);
        pools = {
          A: [ranked[0], ranked[2], ranked[4], ranked[6]].filter(Boolean),
          B: [ranked[1], ranked[3], ranked[5], ranked[7]].filter(Boolean),
        };
      }

          const poolA = poolMatchesFor4(pools.A, "A");
          const poolB = poolMatchesFor4(pools.B, "B");
          const inter = interleavePools(poolA, poolB);

          const finals: CoreMatch[] = [
            {
              id: uid("m"),
              order: inter.length + 1,
              phase: "DEMI",
              pool: null,
              format: 301,
              bo: "BO3",
              maxTurns: 10,
              a: "",
              b: "",
              winner: "",
              checkout100: false,
              checkoutBy: "",
            },
            {
              id: uid("m"),
              order: inter.length + 2,
              phase: "DEMI",
              pool: null,
              format: 301,
              bo: "BO3",
              maxTurns: 10,
              a: "",
              b: "",
              winner: "",
              checkout100: false,
              checkoutBy: "",
            },
            {
              id: uid("m"),
              order: inter.length + 3,
              phase: "PFINAL",
              pool: null,
              format: 301,
              bo: "BO3",
              maxTurns: 10,
              a: "",
              b: "",
              winner: "",
              checkout100: false,
              checkoutBy: "",
            },
            {
              id: uid("m"),
              order: inter.length + 4,
              phase: "FINAL",
              pool: null,
              format: 501,
              bo: "BO3",
              maxTurns: 10,
              a: "",
              b: "",
              winner: "",
              checkout100: false,
              checkoutBy: "",
            },
          ];

      const newSoiree: Soiree = {
        id: uid("s"),
        number: nextNumber,
        createdAt: Date.now(),
        pools,
        matches: [...inter, ...finals],
        rebuys: [],
      };

      return { ...season, soirees: [...season.soirees, newSoiree] };
    });

    setTimeout(() => {
      const max = Math.max(...currentSeason.soirees.map((s: Soiree) => s.number)) + 1;
      setSelectedSoireeNumber(max);
      setTab("SOIREE");
    }, 0);
  }

  function setMatchWinner(matchId: string, winner: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          const w = normName(winner);
          const valid = w && (w === normName(m.a) || w === normName(m.b));
          return {
            ...m,
            winner: valid ? w : "",
            checkoutBy: !m.a || !m.b ? "" : m.checkoutBy,
            checkout100: !m.a || !m.b ? false : Boolean(m.checkoutBy),
          };
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function setMatchCheckoutBy(matchId: string, checkoutBy: "" | "A" | "B") {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          if (!m.a || !m.b) return { ...m, checkoutBy: "", checkout100: false };
          const by = checkoutBy as "" | "A" | "B";
          return { ...m, checkoutBy: by, checkout100: Boolean(by) };
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function swapMatchPlayers(matchId: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          const a = m.b;
          const b = m.a;
          const winner =
            m.winner === m.a ? m.b : m.winner === m.b ? m.a : m.winner;
          return { ...m, a, b, winner };
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function recalcFinalsFromPools() {
    const poolMatches = currentSoiree.matches.filter((m: CoreMatch) => m.phase === "POULE");

    const calcPool = (pool: "A" | "B") => {
      const players = currentSoiree.pools[pool];
      const relevant = poolMatches.filter((m: CoreMatch) => m.pool === pool);
      const { pts, wins, bonus } = computePointsFromMatches(relevant, [], currentSoiree.number, currentSeason);
      const rows = players.map((p: string) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
        bonus: bonus.get(p) ?? 0,
      }));
      rows.sort((a: { name: string; pts: number; wins: number; bonus: number }, b: { name: string; pts: number; wins: number; bonus: number }) =>
        b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name)
      );
      return rows;
    };

    const A = calcPool("A");
    const B = calcPool("B");

    const ov = currentSoiree.qualifiersOverride ?? {};
    const A1 = ov.A1 || (A[0]?.name ?? "");
    const A2 = ov.A2 || (A[1]?.name ?? "");
    const B1 = ov.B1 || (B[0]?.name ?? "");
    const B2 = ov.B2 || (B[1]?.name ?? "");

    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;

        const demisSorted = s.matches
          .filter((x: CoreMatch) => x.phase === "DEMI")
          .sort((x: CoreMatch, y: CoreMatch) => x.order - y.order);

        const matches = s.matches.map((m: CoreMatch) => {
          if (m.phase !== "DEMI") return m;
          const demiIndex = demisSorted.findIndex((x: CoreMatch) => x.id === m.id);
          if (demiIndex === 0) {
            return { ...m, a: A1, b: B2, winner: m.winner && (m.winner === A1 || m.winner === B2) ? m.winner : "" };
          }
          if (demiIndex === 1) {
            return { ...m, a: B1, b: A2, winner: m.winner && (m.winner === B1 || m.winner === A2) ? m.winner : "" };
          }
          return m;
        });

        return { ...s, matches };
      });

      return { ...season, soirees };
    });
  }

  function recalcFinalAndPFinal() {
    const demis = currentSoiree.matches
      .filter((m: CoreMatch) => m.phase === "DEMI")
      .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order);
    if (demis.length < 2) return;

    const d1 = demis[0];
    const d2 = demis[1];
    const w1 = normName(d1.winner);
    const w2 = normName(d2.winner);

    const l1 = w1 ? (w1 === d1.a ? d1.b : w1 === d1.b ? d1.a : "") : "";
    const l2 = w2 ? (w2 === d2.a ? d2.b : w2 === d2.b ? d2.a : "") : "";

    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => {
          if (m.phase === "FINAL") {
            const a = w1 && w2 ? w1 : "";
            const b = w1 && w2 ? w2 : "";
            const keepWinner = m.winner && (m.winner === a || m.winner === b) ? m.winner : "";
            return { ...m, a, b, winner: keepWinner };
          }
          if (m.phase === "PFINAL") {
            const a = l1 && l2 ? l1 : "";
            const b = l1 && l2 ? l2 : "";
            const keepWinner = m.winner && (m.winner === a || m.winner === b) ? m.winner : "";
            return { ...m, a, b, winner: keepWinner };
          }
          return m;
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function addRebuy() {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const rb: RebuyMatch = {
          id: uid("rb"),
          buyer: "",
          a: "",
          b: "",
          winner: "",
          createdAt: Date.now(),
        };
        return { ...s, rebuys: [...s.rebuys, rb] };
      });
      return { ...season, soirees };
    });
  }

  function updateRebuy(id: string, patch: Partial<RebuyMatch>) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const rebuys = s.rebuys.map((r: RebuyMatch) => (r.id === id ? { ...r, ...patch } : r));
        return { ...s, rebuys };
      });
      return { ...season, soirees };
    });
  }

  function deleteRebuy(id: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        return { ...s, rebuys: s.rebuys.filter((r: RebuyMatch) => r.id !== id) };
      });
      return { ...season, soirees };
    });
  }

  const currentPodium = useMemo(() => {
    const final = currentSoiree.matches.find((m: CoreMatch) => m.phase === "FINAL");
    const pfinal = currentSoiree.matches.find((m: CoreMatch) => m.phase === "PFINAL");

    const wFinal = normName(final?.winner ?? "");
    const aFinal = normName(final?.a ?? "");
    const bFinal = normName(final?.b ?? "");

    const second =
      wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";

    const third = normName(pfinal?.winner ?? "");

    if (!wFinal || !second || !third) {
      const { pts, wins } = computePointsFromMatches(currentSoiree.matches, [], currentSoiree.number, currentSeason);
      const rows = currentSeason.players.map((p: string) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
      }));
      rows.sort((a: { name: string; pts: number; wins: number }, b: { name: string; pts: number; wins: number }) =>
        b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name)
      );
      return {
        first: rows[0]?.name ?? "",
        second: rows[1]?.name ?? "",
        third: rows[2]?.name ?? "",
        provisional: true as const,
      };
    }

    return {
      first: wFinal,
      second,
      third,
      provisional: false as const,
    };
  }, [currentSoiree.matches, currentSoiree.number, currentSeason]);


  const totalGainsEUR = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of currentSeason.players) totals.set(p, 0);

    const podiumFromSoiree = (s: Soiree) => {
      const final = s.matches.find((m: CoreMatch) => m.phase === "FINAL");
      const pfinal = s.matches.find((m: CoreMatch) => m.phase === "PFINAL");

      const wFinal = normName(final?.winner ?? "");
      const aFinal = normName(final?.a ?? "");
      const bFinal = normName(final?.b ?? "");
      const second =
        wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
      const third = normName(pfinal?.winner ?? "");

      if (!wFinal || !second || !third) {
        const { pts, wins } = computePointsFromMatches(s.matches, [], s.number, currentSeason);
        const rows = currentSeason.players.map((p: string) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }));
        rows.sort((a: { name: string; pts: number; wins: number }, b: { name: string; pts: number; wins: number }) =>
          b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name)
        );
        return { first: rows[0]?.name ?? "", second: rows[1]?.name ?? "", third: rows[2]?.name ?? "" };
      }

      return { first: wFinal, second, third };
    };

    for (const s of currentSeason.soirees) {
      const { first, second, third } = podiumFromSoiree(s);
      if (first) totals.set(first, (totals.get(first) ?? 0) + MONEY.podiumEUR.first);
      if (second) totals.set(second, (totals.get(second) ?? 0) + MONEY.podiumEUR.second);
      if (third) totals.set(third, (totals.get(third) ?? 0) + MONEY.podiumEUR.third);
    }

    const out = currentSeason.players.map((p: string) => ({ player: p, eur: totals.get(p) ?? 0 }));
    out.sort((a: { player: string; eur: number }, b: { player: string; eur: number }) => b.eur - a.eur || a.player.localeCompare(b.player));
    return out;
  }, [currentSeason.players, currentSeason.soirees]);

  return (
    <div className="min-h-screen bg-[#0b0f17] text-white">
      <div className="mx-auto max-w-6xl px-4 pt-6 pb-24 md:pb-6">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-10 w-10 rounded-2xl bg-white/10 grid place-items-center">🎯</div>
              <div>
                <h1 className="text-lg font-bold sm:text-xl">DARTS LEAGUE — App (local)</h1>
                <div className="mt-0.5 text-xs sm:text-sm text-white/70">
                  {currentSeason.name} • Sauvegarde locale (Safari)
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Pill color="#22c55e">Jackpot: {formatEUR(jackpotEUR)}</Pill>
              <Pill>Joueurs: {currentSeason.players.length}</Pill>
              <Pill>Soirées: {currentSeason.soirees.length}</Pill>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => startNewSoiree()}>
              Générer une soirée
            </Button>
            <Button variant="danger" onClick={() => resetAll()}>
              Reset complet
            </Button>
          </div>
        </div>

        <div className="mb-6 hidden md:flex gap-2 overflow-x-auto pb-2">
          {(
            [
              ["SOIREE", "Soirée"],
              ["CLASSEMENT", "Classement"],
              ["HISTO", "Historique"],
              ["REBUY", "Re-buy"],
              ["H2H", "Confrontations"],
              ["SAISONS", "Saisons"],
              ["PARAMS", "Paramètres"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition ${
                tab === k ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/15"
              }`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-[#0b0f17]/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-2">
            {(
              [
                ["SOIREE", "Soirée"],
                ["CLASSEMENT", "Classement"],
                ["HISTO", "Historique"],
                ["REBUY", "Re-buy"],
                ["H2H", "H2H"],
                ["SAISONS", "Saisons"],
                ["PARAMS", "Params"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`flex-1 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
                  tab === k ? "bg-white text-black" : "text-white/70 hover:bg-white/10"
                }`}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab !== "PARAMS" && tab !== "SAISONS" && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-white/70">Soirée sélectionnée</div>
            <div className="w-full sm:w-56">
              <Select
                value={String(selectedSoireeNumber)}
                onChange={(v) => setSelectedSoireeNumber(Number(v))}
                options={allSoireeNumbers.map(String)}
                placeholder="Choisir…"
              />
            </div>
          </div>
        )}

        {tab === "SOIREE" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Section
                title={`Planning — Soirée ${currentSoiree.number}`}
                right={
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => recalcFinalsFromPools()}>
                      Calculer demis
                    </Button>
                    <Button variant="ghost" onClick={() => recalcFinalAndPFinal()}>
                      Calculer finales
                    </Button>
                    <Button variant="ghost" onClick={() => setCompactMode((v) => !v)}>
                      {compactMode ? "Mode détaillé" : "Mode compact"}
                    </Button>
                    <Button variant="ghost" onClick={() => setCardsMode((v) => !v)}>
                      {cardsMode ? "Vue tableau" : "Vue cartes"}
                    </Button>
                  </div>
                }
              >
                <div className={`space-y-3 ${cardsMode ? "block" : "md:hidden"}`}>
                  {currentSoiree.matches
                    .slice()
                    .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order)
                    .map((m: CoreMatch) => {
                      const winner = normName(m.winner);
                      const bonusA = m.checkoutBy === "A" ? 1 : 0;
                      const bonusB = m.checkoutBy === "B" ? 1 : 0;
                      const basePts = m.phase === "PFINAL" ? 1 : 2;
                      const ptsA = (winner && winner === m.a ? basePts : 0) + bonusA;
                      const ptsB = (winner && winner === m.b ? basePts : 0) + bonusB;
                      const pickWinner = (name: string) => {
                        setMatchWinner(m.id, name);
                        if (m.phase === "DEMI") setTimeout(() => recalcFinalAndPFinal(), 0);
                      };
                      const cardClass = winner ? "winner-anim" : "";

                      if (compactMode) {
                        return (
                          <div key={m.id} className={`rounded-2xl border border-white/10 bg-black/30 p-3 ${cardClass}`}>
                            <div className="flex items-center justify-between text-xs text-white/60">
                              <div>#{m.order}</div>
                              <div className="flex items-center gap-2">
                                <Pill>{m.phase}</Pill>
                                <span>{m.pool ?? "—"}</span>
                              </div>
                            </div>
                            <div className="mt-2 grid grid-cols-[1fr,auto,1fr] items-center gap-2 text-sm">
                              <div className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.a) ?? "#ffffff33" }} />
                                <span className="font-semibold">{m.a || "—"}</span>
                              </div>
                              <span className="text-white/50">vs</span>
                              <div className="flex items-center gap-2 justify-end">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.b) ?? "#ffffff33" }} />
                                <span className="font-semibold">{m.b || "—"}</span>
                              </div>
                            </div>
                            <div className="mt-2 grid grid-cols-1 gap-2">
                              <div className="grid grid-cols-2 gap-2">
                                <Button variant={winner === m.a ? "primary" : "ghost"} onClick={() => pickWinner(m.a)} disabled={!m.a || !m.b} >
                                  {m.a || "A"}
                                </Button>
                                <Button variant={winner === m.b ? "primary" : "ghost"} onClick={() => pickWinner(m.b)} disabled={!m.a || !m.b}>
                                  {m.b || "B"}
                                </Button>
                              </div>
                              <div className="flex items-center justify-between text-xs text-white/60">
                                <span>{m.format} • {m.bo} • {m.maxTurns}t</span>
                                <button
                                  className="text-white/70 underline"
                                  onClick={() => swapMatchPlayers(m.id)}
                                  disabled={!m.a && !m.b}
                                >
                                  Inverser A/B
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-2">
                                <Select
                                  value={m.checkoutBy}
                                  onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                                  options={["A", "B"]}
                                  placeholder="Checkout ≥100 par…"
                                  disabled={!m.a || !m.b}
                                />
                              </div>
                            </div>
                            <div className="mt-2 flex items-center justify-between text-xs text-white/60">
                              <div>Pts</div>
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-white">{ptsA}</span>
                                <span className="text-white/40">/</span>
                                <span className="font-semibold text-white">{ptsB}</span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={m.id} className={`rounded-2xl border border-white/10 bg-black/30 p-3 ${cardClass}`}>
                          <div className="flex items-center justify-between text-xs text-white/60">
                            <div>Match #{m.order}</div>
                            <div className="flex items-center gap-2">
                              <Pill>{m.phase}</Pill>
                              <span>{m.pool ?? "—"}</span>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.a) ?? "#ffffff33" }} />
                              <span className="font-semibold">{m.a || "—"}</span>
                            </div>
                            <span className="text-white/50">vs</span>
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.b) ?? "#ffffff33" }} />
                              <span className="font-semibold">{m.b || "—"}</span>
                            </div>
                          </div>
                          <div className="mt-2 text-xs text-white/60">
                            {m.format} • {m.bo} • {m.maxTurns}t
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-2">
                            <div className="grid grid-cols-2 gap-2">
                              <Button variant={winner === m.a ? "primary" : "ghost"} onClick={() => pickWinner(m.a)} disabled={!m.a || !m.b}>
                                {m.a || "A"}
                              </Button>
                              <Button variant={winner === m.b ? "primary" : "ghost"} onClick={() => pickWinner(m.b)} disabled={!m.a || !m.b}>
                                {m.b || "B"}
                              </Button>
                            </div>
                            <button
                              className="text-xs text-white/70 underline"
                              onClick={() => swapMatchPlayers(m.id)}
                              disabled={!m.a && !m.b}
                            >
                              Inverser A/B
                            </button>
                            <Select
                              value={m.checkoutBy}
                              onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                              options={["A", "B"]}
                              placeholder="Checkout ≥100 par…"
                              disabled={!m.a || !m.b}
                            />
                          </div>
                          <div className="mt-3 flex items-center justify-between text-xs">
                            <div className="text-white/60">Points</div>
                            <div className="flex items-center gap-3">
                              <span className="font-semibold">{ptsA}</span>
                              <span className="text-white/40">/</span>
                              <span className="font-semibold">{ptsB}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className={`${cardsMode ? "hidden" : "hidden md:block"} overflow-x-auto`}>
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead>
                      <tr className="text-white/70">
                        <th className="py-2 pr-2">Ordre</th>
                        <th className="py-2 pr-2">Phase</th>
                        <th className="py-2 pr-2">Poule</th>
                        <th className="py-2 pr-2">Format</th>
                        <th className="py-2 pr-2">A</th>
                        <th className="py-2 pr-2">B</th>
                        <th className="py-2 pr-2">Vainqueur</th>
                        <th className="py-2 pr-2">Checkout ≥100 par</th>
                        <th className="py-2 pr-2">Points A</th>
                        <th className="py-2 pr-2">Points B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentSoiree.matches
                        .slice()
                        .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order)
                        .map((m: CoreMatch) => {
                          const winner = normName(m.winner);
                          const bonusA = m.checkoutBy === "A" ? 1 : 0;
                          const bonusB = m.checkoutBy === "B" ? 1 : 0;
                          const basePts = m.phase === "PFINAL" ? 1 : 2;
                          const ptsA = (winner && winner === m.a ? basePts : 0) + bonusA;
                          const ptsB = (winner && winner === m.b ? basePts : 0) + bonusB;
                          const rowClass = winner ? "winner-row" : "";

                          return (
                            <tr key={m.id} className={`border-t border-white/10 ${rowClass}`}>
                              <td className="py-2 pr-2 text-white/70">{m.order}</td>
                              <td className="py-2 pr-2">
                                <Pill>{m.phase}</Pill>
                              </td>
                              <td className="py-2 pr-2 text-white/80">{m.pool ?? "—"}</td>
                              <td className="py-2 pr-2 text-white/80">
                                {m.format} • {m.bo} • {m.maxTurns}t
                              </td>
                              <td className="py-2 pr-2">
                                <div className="flex items-center gap-2">
                                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.a) ?? "#ffffff33" }} />
                                  <span className="font-semibold">{m.a || "—"}</span>
                                </div>
                              </td>
                              <td className="py-2 pr-2">
                                <div className="flex items-center gap-2">
                                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(m.b) ?? "#ffffff33" }} />
                                  <span className="font-semibold">{m.b || "—"}</span>
                                </div>
                              </td>
                              <td className="py-2 pr-2 w-[220px]">
                                <Select
                                  value={winner}
                                  onChange={(v) => {
                                    setMatchWinner(m.id, v);
                                    if (m.phase === "DEMI") setTimeout(() => recalcFinalAndPFinal(), 0);
                                  }}
                                  options={[m.a, m.b].map(normName).filter(Boolean)}
                                  placeholder="Vainqueur…"
                                  disabled={!m.a || !m.b}
                                />
                              </td>
                              <td className="py-2 pr-2">
                                <Select
                                  value={m.checkoutBy}
                                  onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                                  options={["A", "B"]}
                                  placeholder="Checkout ≥100 par…"
                                  disabled={!m.a || !m.b}
                                />
                              </td>
                              <td className="py-2 pr-2 font-semibold">{ptsA}</td>
                              <td className="py-2 pr-2 font-semibold">{ptsB}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-xs text-white/60">
                  Astuce : clique “Calculer demis” après les poules, puis “Calculer finales” dès que les demis ont un
                  vainqueur.
                </div>
              </Section>
            </div>

            <div className="space-y-4">
              <Section title="Classement des poules">
                <div className="hidden md:grid grid-cols-1 gap-3">
                  {(["A", "B"] as const).map((pool) => (
                    <div key={pool} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="mb-2 text-sm font-semibold">Poule {pool}</div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-white/60">
                            <th className="py-1 text-left">#</th>
                            <th className="py-1 text-left">Joueur</th>
                            <th className="py-1 text-right">Pts</th>
                            <th className="py-1 text-right">V</th>
                            <th className="py-1 text-right">B</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentPoolStandings[pool].map((r: { name: string; pts: number; wins: number; bonus: number }, idx: number) => (
                            <tr key={r.name} className="border-t border-white/10">
                              <td className="py-1">{idx + 1}</td>
                              <td className="py-1 font-semibold">{r.name}</td>
                              <td className="py-1 text-right">{r.pts}</td>
                              <td className="py-1 text-right">{r.wins}</td>
                              <td className="py-1 text-right">{r.bonus}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>

                <div className="md:hidden grid grid-cols-1 gap-3">
                  {(["A", "B"] as const).map((pool) => (
                    <div key={pool} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">Poule {pool}</div>
                        <Pill>Pts ➜ V ➜ Bonus</Pill>
                      </div>
                      <div className="mt-2 space-y-1">
                        {currentPoolStandings[pool].map((r: { name: string; pts: number; wins: number; bonus: number }, idx: number) => (
                          <div key={r.name} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1">
                            <div className="flex items-center gap-2">
                              <span className="text-white/60 w-5">{idx + 1}.</span>
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.name) ?? "#ffffff33" }} />
                              <span className="font-semibold">{r.name}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              <span className="text-white/70">PTS</span>
                              <span className="font-bold">{r.pts}</span>
                              <span className="text-white/70">V</span>
                              <span className="font-bold">{r.wins}</span>
                              <span className="text-white/70">B</span>
                              <span className="font-bold">{r.bonus}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs text-white/60 mb-2">Départage manuel (si égalité / match sec)</div>

                <div className="grid grid-cols-1 gap-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-white/60 mb-1">Poule A — #1</div>
                      <Select
                        value={normName(currentSoiree.qualifiersOverride?.A1 ?? "")}
                        onChange={(v) => setQualifiersOverride({ A1: normName(v) })}
                        options={currentSoiree.pools.A}
                        placeholder="Auto…"
                      />
                    </div>
                    <div>
                      <div className="text-xs text-white/60 mb-1">Poule A — #2</div>
                      <Select
                        value={normName(currentSoiree.qualifiersOverride?.A2 ?? "")}
                        onChange={(v) => setQualifiersOverride({ A2: normName(v) })}
                        options={currentSoiree.pools.A}
                        placeholder="Auto…"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-white/60 mb-1">Poule B — #1</div>
                      <Select
                        value={normName(currentSoiree.qualifiersOverride?.B1 ?? "")}
                        onChange={(v) => setQualifiersOverride({ B1: normName(v) })}
                        options={currentSoiree.pools.B}
                        placeholder="Auto…"
                      />
                    </div>
                    <div>
                      <div className="text-xs text-white/60 mb-1">Poule B — #2</div>
                      <Select
                        value={normName(currentSoiree.qualifiersOverride?.B2 ?? "")}
                        onChange={(v) => setQualifiersOverride({ B2: normName(v) })}
                        options={currentSoiree.pools.B}
                        placeholder="Auto…"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setQualifiersOverride({ A1: "", A2: "", B1: "", B2: "" })}>
                      Réinitialiser (auto)
                    </Button>
                  </div>

                  <div className="text-[11px] text-white/50">
                    Si tu fais un match sec pour départager, règle l’ordre #1/#2 ici puis clique “Calculer demis”.
                  </div>
                </div>
              </div>

              <Section title="Podium & gains (soirée)">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <div className="text-white/70">🥇 1er</div>
                    <div className="font-semibold">
                      {currentPodium.first || "—"} <span className="text-white/60">({formatEUR(MONEY.podiumEUR.first)})</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-white/70">🥈 2e</div>
                    <div className="font-semibold">
                      {currentPodium.second || "—"} <span className="text-white/60">({formatEUR(MONEY.podiumEUR.second)})</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-white/70">🥉 3e</div>
                    <div className="font-semibold">
                      {currentPodium.third || "—"} <span className="text-white/60">({formatEUR(MONEY.podiumEUR.third)})</span>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-xs text-white/60">Gains cumulés (saison)</div>
                    <div className="mt-2 space-y-1">
                      {totalGainsEUR.slice(0, 6).map((x: { player: string; eur: number }) => (
                        <div key={x.player} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(x.player) ?? "#ffffff33" }} />
                            <span className="font-semibold">{x.player}</span>
                          </div>
                          <div className="font-semibold">{formatEUR(x.eur)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Section>
            </div>
          </div>
        )}

        {tab === "CLASSEMENT" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Classement général (points ➜ victoires ➜ bonus)">
              <div className="space-y-2">
                {seasonStats.table.map((r, idx) => {
                  const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "";
                  return (
                    <div
                      key={r.name}
                      className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-white/60 w-6">{idx + 1}.</span>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.name) ?? "#ffffff33" }} />
                        <span className="font-semibold">{r.name}</span>
                        {medal && <span>{medal}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs sm:text-sm">
                        <span className="text-white/70">PTS</span>
                        <span className="font-bold">{r.pts}</span>
                        <span className="text-white/70">V</span>
                        <span className="font-bold">{r.wins}</span>
                        <span className="text-white/70">B</span>
                        <span className="font-bold">{r.bonus}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Stats rapides">
              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Jackpot actuel</div>
                  <div className="mt-1 text-2xl font-extrabold">{formatEUR(jackpotEUR)}</div>
                  <div className="mt-2 text-xs text-white/60">
                    +{formatEUR(MONEY.jackpotPerPlayerEUR)} / joueur / soirée • +{formatEUR(MONEY.rebuyEUR)} / re-buy
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Meilleure win streak</div>
                  <div className="mt-2 space-y-1">
                    {streaks.slice(0, 5).map((s) => (
                      <div key={s.player} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(s.player) ?? "#ffffff33" }} />
                          <span className="font-semibold">{s.player}</span>
                        </div>
                        <span className="font-bold">{s.best}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Gains cumulés (top 5)</div>
                  <div className="mt-2 space-y-1">
                    {totalGainsEUR.slice(0, 5).map((x: { player: string; eur: number }) => (
                      <div key={x.player} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(x.player) ?? "#ffffff33" }} />
                          <span className="font-semibold">{x.player}</span>
                        </div>
                        <span className="font-bold">{formatEUR(x.eur)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Graph (simple) — Points par soirée">
              <div className="text-xs text-white/60 mb-2">Mini-graph: barres ASCII (lisible sans librairie)</div>
              <div className="space-y-2">
                {allSoireeNumbers.map((n: number) => {
                  const so = currentSeason.soirees.find((s: Soiree) => s.number === n)!;
                  const { pts } = computePointsFromMatches(so.matches, so.rebuys, so.number, currentSeason);
                  const top = Math.max(...currentSeason.players.map((p: string) => pts.get(p) ?? 0), 1);
                  const topPlayer = currentSeason.players
                    .map((p: string) => ({ p, v: pts.get(p) ?? 0 }))
                    .sort((a: { p: string; v: number }, b: { p: string; v: number }) => b.v - a.v || a.p.localeCompare(b.p))[0];
                  const width = Math.round((topPlayer.v / top) * 24);
                  return (
                    <div key={n} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">Soirée {n}</div>
                        <div className="text-white/70">Top: {topPlayer.p} ({topPlayer.v} pts)</div>
                      </div>
                      <div className="mt-2 font-mono text-sm">
                        <span style={{ color: playerColors.get(topPlayer.p) ?? "#fff" }}>{"█".repeat(width)}</span>
                        <span className="text-white/20">{"█".repeat(24 - width)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          </div>
        )}

        {tab === "HISTO" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Historique des soirées">
              <div className="space-y-2">
                {currentSeason.soirees
                  .slice()
                  .sort((a: Soiree, b: Soiree) => b.number - a.number)
                  .map((s: Soiree) => {
                    const { pts, wins } = computePointsFromMatches(s.matches, s.rebuys, s.number, currentSeason);
                    const rows = currentSeason.players.map((p: string) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }));
                    rows.sort((a: { name: string; pts: number; wins: number }, b: { name: string; pts: number; wins: number }) =>
                      b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name)
                    );
                    const podium = rows.slice(0, 3);
                    return (
                      <button
                        key={s.id}
                        className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-left hover:bg-black/40"
                        onClick={() => {
                          setSelectedSoireeNumber(s.number);
                          setTab("SOIREE");
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-base font-semibold">Soirée {s.number}</div>
                          <div className="text-xs text-white/60">Rebuys: {s.rebuys.length}</div>
                        </div>
                        <div className="mt-2 text-sm text-white/70">
                          Podium: {(() => {
                        const final = s.matches.find((m: CoreMatch) => m.phase === "FINAL");
                        const pfinal = s.matches.find((m: CoreMatch) => m.phase === "PFINAL");
                            const wFinal = normName(final?.winner ?? "");
                            const aFinal = normName(final?.a ?? "");
                            const bFinal = normName(final?.b ?? "");
                            const second = wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
                            const third = normName(pfinal?.winner ?? "");
                            const ok = wFinal && second && third;
                            if (ok) return `1) ${wFinal} • 2) ${second} • 3) ${third}`;
                        return podium.map((p: { name: string; pts: number }, i: number) => `${i + 1}) ${p.name} (${p.pts})`).join(" • ");
                      })()}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Pill>
                            Jackpot +
                            {formatEUR((s.pools.A.length + s.pools.B.length) * MONEY.jackpotPerPlayerEUR + s.rebuys.length * MONEY.rebuyEUR)}
                          </Pill>
                          <Pill>Matchs: {s.matches.length}</Pill>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </Section>

            <Section title={`Historique des matchs — Soirée ${currentSoiree.number}`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="text-white/70">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Phase</th>
                      <th className="py-2 pr-2">A</th>
                      <th className="py-2 pr-2">B</th>
                      <th className="py-2 pr-2">Vainqueur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentSoiree.matches
                      .slice()
                      .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order)
                      .map((m: CoreMatch) => (
                        <tr key={m.id} className="border-t border-white/10">
                          <td className="py-2 pr-2 text-white/70">{m.order}</td>
                          <td className="py-2 pr-2">
                            <Pill>
                              {m.phase}
                              {m.pool ? ` ${m.pool}` : ""}
                            </Pill>
                          </td>
                          <td className="py-2 pr-2 font-semibold">{m.a}</td>
                          <td className="py-2 pr-2 font-semibold">{m.b}</td>
                          <td className="py-2 pr-2 font-bold" style={{ color: playerColors.get(m.winner) ?? "#fff" }}>
                            {m.winner || "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-xs text-white/60">Note : les rebuys ont leur onglet dédié.</div>
            </Section>
          </div>
        )}

        {tab === "REBUY" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Section
                title={`Re-buys — Soirée ${currentSoiree.number}`}
                right={
                  <Button variant="ghost" onClick={() => addRebuy()}>
                    + Ajouter un re-buy
                  </Button>
                }
              >
                {currentSoiree.rebuys.length === 0 ? (
                  <div className="text-sm text-white/70">Aucun re-buy pour cette soirée.</div>
                ) : (
                  <div className="space-y-3">
                    {currentSoiree.rebuys.map((r: RebuyMatch, idx: number) => {
                      const players = currentSeason.players;
                      const buyer = normName(r.buyer);
                      const a = normName(r.a);
                      const b = normName(r.b);
                      const winnerOptions = [a, b].filter(Boolean);

                      const info = (() => {
                        const buyerN = normName(r.buyer);
                        const winnerN = normName(r.winner);
                        if (!buyerN || !winnerN) return "";

                        if (currentSoiree.number <= 2) {
                          return winnerN === buyerN ? "✅ Le buyer gagne +2 pts" : "❌ Buyer perd → 0 pt pour tous";
                        }

                        let doneBefore = 0;
                        for (const sx of currentSeason.soirees) {
                          if (sx.number >= currentSoiree.number) continue;
                          for (const rb of sx.rebuys) {
                            if (normName(rb.buyer) === buyerN && normName(rb.winner)) doneBefore++;
                          }
                        }
                        doneBefore += currentSoiree.rebuys
                          .slice(0, idx)
                          .filter((x: RebuyMatch) => normName(x.buyer) === buyerN && normName(x.winner)).length;

                        const winPts = doneBefore === 0 ? 2 : 1;
                        return winnerN === buyerN
                          ? `✅ Le buyer gagne +${winPts} pt${winPts > 1 ? "s" : ""}`
                          : "❌ Buyer perd → 0 pt pour tous";
                      })();

                      return (
                        <div key={r.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold">Re-buy #{idx + 1}</div>
                            <Button variant="danger" onClick={() => deleteRebuy(r.id)}>
                              Supprimer
                            </Button>
                          </div>

                          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
                            <div>
                              <div className="mb-1 text-xs text-white/60">Buyer (paye le re-buy)</div>
                              <Select
                                value={buyer}
                                onChange={(v) => {
                                  const nv = normName(v);
                                  const patch: Partial<RebuyMatch> = { buyer: nv };
                                  if (!r.a) patch.a = nv;
                                  updateRebuy(r.id, patch);
                                }}
                                options={players}
                                placeholder="Choisir…"
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-xs text-white/60">Joueur A</div>
                              <Select
                                value={a}
                                onChange={(v) => {
                                  const nv = normName(v);
                                  const patch: Partial<RebuyMatch> = { a: nv };
                                  if (nv && nv === b) patch.b = "";
                                  if (r.winner && r.winner !== nv && r.winner !== b) patch.winner = "";
                                  updateRebuy(r.id, patch);
                                }}
                                options={players}
                                placeholder="A…"
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-xs text-white/60">Joueur B</div>
                              <Select
                                value={b}
                                onChange={(v) => {
                                  const nv = normName(v);
                                  const patch: Partial<RebuyMatch> = { b: nv };
                                  if (nv && nv === a) patch.a = "";
                                  if (r.winner && r.winner !== a && r.winner !== nv) patch.winner = "";
                                  updateRebuy(r.id, patch);
                                }}
                                options={players}
                                placeholder="B…"
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-xs text-white/60">Vainqueur</div>
                              <Select
                                value={normName(r.winner)}
                                onChange={(v) => updateRebuy(r.id, { winner: normName(v) })}
                                options={winnerOptions}
                                placeholder="Vainqueur…"
                                disabled={!a || !b}
                              />
                            </div>
                          </div>

                          {info && <div className="mt-3 text-sm text-white/70">{info}</div>}
                          <div className="mt-2 text-xs text-white/60">Impact cagnotte : +{formatEUR(MONEY.rebuyEUR)} (automatique)</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>
            </div>

            <div className="space-y-4">
              <Section title="Règles re-buy">
                <div className="text-sm text-white/70 space-y-2">
                  <div>• Match sec : 301 • 10 tours max</div>
                  <div>• Seul le buyer peut marquer des points :</div>
                  <div className="ml-3">— Soirées 1 & 2 : s’il gagne : +2 pts (ancien système)</div>
                  <div className="ml-3">— À partir de la soirée 3 :</div>
                  <div className="ml-6">• 1er re-buy de la saison gagné : +2 pts</div>
                  <div className="ml-6">• re-buys suivants gagnés : +1 pt</div>
                  <div className="ml-3">— s’il perd : 0 pt pour tous</div>
                  <div className="mt-2 text-xs text-white/60">⚠️ Le re-buy ne qualifie jamais pour les phases finales.</div>
                </div>
              </Section>

              <Section title="Jackpot (détail)">
                <div className="text-sm text-white/70 space-y-1">
                  <div>
                    Soirées jouées : <span className="font-semibold text-white">{currentSeason.soirees.length}</span>
                  </div>
                  <div>
                    Rebuys total : <span className="font-semibold text-white">{currentSeason.soirees.reduce((s: number, x: Soiree) => s + x.rebuys.length, 0)}</span>
                  </div>
                  <div className="mt-2">
                    Jackpot actuel : <span className="font-extrabold text-white">{formatEUR(jackpotEUR)}</span>
                  </div>
                </div>
              </Section>
            </div>
          </div>
        )}

        {tab === "H2H" && (
          <Section title="Confrontations (Head-to-Head) — victoires" right={<Pill>core matches</Pill>}>
            <div className="md:hidden space-y-3">
              {h2h.players.map((rowP, i) => (
                <div key={rowP} className="rounded-2xl border border-white/10 bg-black/30 p-3">
                  <div className="font-semibold">{rowP}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {h2h.players.map((colP, j) => {
                      if (i === j) return null;
                      const v = h2h.matrix[i][j];
                      return (
                        <div key={colP} className="flex items-center justify-between rounded-lg bg-black/30 px-2 py-1 text-xs">
                          <span className="text-white/70">{colP}</span>
                          <span className="font-semibold">{v}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead>
                  <tr className="text-white/70">
                    <th className="py-2 pr-2"> </th>
                    {h2h.players.map((p) => (
                      <th key={p} className="py-2 pr-2 font-semibold">
                        {p}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {h2h.players.map((rowP, i) => (
                    <tr key={rowP} className="border-t border-white/10">
                      <td className="py-2 pr-2 font-semibold">{rowP}</td>
                      {h2h.players.map((colP, j) => {
                        const v = h2h.matrix[i][j];
                        const isDiag = i === j;
                        return (
                          <td key={colP} className="py-2 pr-2">
                            <div
                              className={`rounded-lg px-2 py-1 text-center ${
                                isDiag ? "bg-white/5 text-white/20" : "bg-black/30"
                              }`}
                              style={!isDiag && v > 0 ? { border: `1px solid ${playerColors.get(rowP) ?? "#ffffff22"}` } : {}}
                            >
                              {isDiag ? "—" : v}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-xs text-white/60">
              Lecture : ligne = joueur, colonne = adversaire. La valeur = nombre de victoires de la ligne contre la colonne.
            </div>
          </Section>
        )}

        {tab === "SAISONS" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Saisons">
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr,auto]">
                <input
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                  placeholder="Nom de la nouvelle saison…"
                  value={newSeasonName}
                  onChange={(e) => setNewSeasonName(e.target.value)}
                />
                <Button variant="primary" onClick={() => addSeason()}>
                  Créer
                </Button>
              </div>
              <label className="mb-3 inline-flex items-center gap-2 text-xs text-white/70">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-white/20 bg-black"
                  checked={copyPlayersForNewSeason}
                  onChange={(e) => setCopyPlayersForNewSeason(e.target.checked)}
                />
                Copier les joueurs de la saison actuelle
              </label>

              <div className="space-y-2">
                {state.seasons.map((s, idx) => (
                  <div key={s.id} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-white/60 w-6">{idx + 1}.</span>
                        <input
                          className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-sm text-white outline-none focus:border-white/25"
                          defaultValue={s.name}
                          onBlur={(e) => renameSeason(s.id, e.target.value)}
                        />
                        {s.id === currentSeason.id && <Pill color="#22c55e">Active</Pill>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill>Joueurs: {s.players.length}</Pill>
                        <Pill>Soirées: {s.soirees.length}</Pill>
                        <Button variant="ghost" onClick={() => setActiveSeason(s.id)}>
                          Ouvrir
                        </Button>
                        <Button variant="danger" onClick={() => deleteSeason(s.id)} disabled={state.seasons.length <= 1}>
                          Supprimer
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Conseils">
              <div className="text-sm text-white/70 space-y-2">
                <div>• Crée une saison par année ou par ligue.</div>
                <div>• Tu peux copier les joueurs pour aller plus vite.</div>
                <div>• Les saisons restent indépendantes (stats, soirées, rebuys).</div>
              </div>
            </Section>
          </div>
        )}

        {tab === "PARAMS" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Joueurs (saison en cours)">
              <div className="text-sm text-white/70 mb-3">
                Ajoute tes joueurs ici. Les noms servent partout (matchs, menus, stats). Garde des noms stables (accents inclus).
              </div>
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr,auto]">
                <input
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                  placeholder="Nom du joueur…"
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      addPlayer(newPlayerName);
                      setNewPlayerName("");
                    }
                  }}
                />
                <Button
                  variant="primary"
                  onClick={() => {
                    addPlayer(newPlayerName);
                    setNewPlayerName("");
                  }}
                >
                  Ajouter
                </Button>
              </div>
              <div className="mb-3 grid grid-cols-1 gap-2">
                <textarea
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                  rows={3}
                  placeholder="Ajouter plusieurs joueurs (un par ligne ou séparés par virgule)…"
                  value={bulkPlayersText}
                  onChange={(e) => setBulkPlayersText(e.target.value)}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    addPlayersFromBulk(bulkPlayersText);
                    setBulkPlayersText("");
                  }}
                >
                  Ajouter la liste
                </Button>
              </div>
              <div className="space-y-2">
                {currentSeason.players.length === 0 && (
                  <div className="text-sm text-white/60">Aucun joueur pour l’instant. Ajoute-les ci-dessus.</div>
                )}
                {currentSeason.players.map((p: string, idx: number) => (
                  <div
                    key={p}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ background: playerColors.get(p) ?? "#ffffff33" }} />
                      {editingPlayer === p ? (
                        <input
                          className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-sm text-white outline-none focus:border-white/25"
                          value={editingPlayerName}
                          onChange={(e) => setEditingPlayerName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              renamePlayer(p, editingPlayerName);
                              setEditingPlayer(null);
                              setEditingPlayerName("");
                            }
                          }}
                        />
                      ) : (
                        <span className="font-semibold">{p}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/60">Couleur #{idx + 1}</span>
                      {editingPlayer === p ? (
                        <Button
                          variant="primary"
                          onClick={() => {
                            renamePlayer(p, editingPlayerName);
                            setEditingPlayer(null);
                            setEditingPlayerName("");
                          }}
                        >
                          Valider
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditingPlayer(p);
                            setEditingPlayerName(p);
                          }}
                        >
                          Renommer
                        </Button>
                      )}
                      <Button variant="danger" onClick={() => removePlayer(p)}>
                        Supprimer
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="À savoir (local Safari)">
              <input
                ref={importFileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const txt = String(reader.result ?? "");
                    importSeasonFromText(txt);
                  };
                  reader.readAsText(f);
                  e.currentTarget.value = "";
                }}
              />
              <div className="space-y-2 text-sm text-white/70">
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Sauvegarde / transfert (recommandé)</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => exportSeasonFile()}>
                      Exporter (.json)
                    </Button>
                    <Button variant="ghost" onClick={() => exportSeasonClipboard()}>
                      Copier export
                    </Button>
                    <Button variant="ghost" onClick={() => triggerImportFile()}>
                      Importer (.json)
                    </Button>
                    <Button variant="ghost" onClick={() => setShowImport(true)}>
                      Importer (coller JSON)
                    </Button>
                  </div>
                  <div className="mt-2 text-xs text-white/60">
                    Important : le lien d’aperçu Canvas change d’origine (URL) → Safari ne retrouve pas le même localStorage.
                    Donc pour garder Soirée 2 & co, exporte puis importe.
                  </div>
                </div>

                {showExport && (
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-xs text-white/60">Export saison (copier/coller si le téléchargement est bloqué)</div>
                    <textarea
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white outline-none focus:border-white/25"
                      rows={10}
                      value={exportText}
                      readOnly
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => exportSeasonClipboard()}>
                        Copier l’export
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setShowExport(false);
                          setExportText("");
                        }}
                      >
                        Fermer
                      </Button>
                    </div>
                    <div className="mt-2 text-xs text-white/60">
                      Astuce : colle ce JSON dans Notes / TextEdit, puis enregistre en <span className="font-semibold text-white">.json</span>.
                    </div>
                  </div>
                )}

                {showImport && (
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-xs text-white/60">Importer (coller le JSON)</div>
                    <textarea
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white outline-none focus:border-white/25"
                      rows={10}
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      placeholder="Colle ici le JSON exporté…"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => importSeasonFromText(importText)} disabled={!importText.trim()}>
                        Importer
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setShowImport(false);
                          setImportText("");
                        }}
                      >
                        Fermer
                      </Button>
                    </div>
                  </div>
                )}

                <div>• Tout est sauvegardé dans le navigateur (localStorage). Si tu restes sur le même appareil + navigateur, tu retrouves tout.</div>
                <div>• En navigation privée / effacement du site, ça peut disparaître.</div>
                <div>
                  • Le bouton <span className="font-semibold text-white">Reset complet</span> remet exactement l’app à l’état “Saison 1 + Soirée 1 déjà intégrée”.
                </div>
                <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Règles financières affichées</div>
                  <div className="mt-1">
                    Entrée : {formatEUR(MONEY.entryFeeEUR)} • Jackpot: +{formatEUR(MONEY.jackpotPerPlayerEUR)}/joueur/soirée • Rebuy: +{formatEUR(MONEY.rebuyEUR)}
                  </div>
                  <div className="mt-1">
                    Podium: {formatEUR(MONEY.podiumEUR.first)} / {formatEUR(MONEY.podiumEUR.second)} / {formatEUR(MONEY.podiumEUR.third)}
                  </div>
                </div>
              </div>
            </Section>
          </div>
        )}

        <div className="mt-8 text-center text-xs text-white/40">Darts League — app locale • v{VERSION}</div>
      </div>
    </div>
  );
}
