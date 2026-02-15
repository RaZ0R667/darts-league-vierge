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
type MatchStatus = "PENDING" | "VALIDATED" | "CONTESTED";
type RulesProfile = "STANDARD" | "FUN" | "CUSTOM";

type RulesConfig = {
  winPoints: number;
  smallFinalPoints: number;
  checkoutBonusPoints: number;
  jackpotPerPlayerEUR: number;
  rebuyEUR: number;
  rebuyWinPointsS1S2: number;
  rebuyFirstWinPointsS3Plus: number;
  rebuyNextWinPointsS3Plus: number;
  defaultPoolFormat: 301 | 501;
  defaultFinalFormat: 301 | 501;
};

type AuditEntry = {
  id: string;
  ts: number;
  action: string;
  details?: string;
};

type SnapshotEntry = {
  id: string;
  ts: number;
  label: string;
  state: AppState;
};

type CoreMatch = {
  id: string;
  order: number;
  phase: Phase;
  status: MatchStatus;
  pool: "A" | "B" | null;
  format: 301 | 501;
  bo: "BO1" | "BO3" | "BO5" | "SEC";
  maxTurns: number;
  a: string;
  b: string;
  winner: "" | string;
  checkout100: boolean;
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

type FunModeState = {
  players: string[];
  matches: CoreMatch[];
};

type AppState = {
  version: number;
  season: Season;
  funMode: FunModeState;
  system: {
    rulesProfile: RulesProfile;
    customRules: RulesConfig;
    audit: AuditEntry[];
  };
};

const STORAGE_KEY = "darts_league_app_v1";
const VERSION = 1;

const MONEY = {
  entryFeeEUR: 3,
  podiumEUR: { first: 7, second: 3, third: 2 },
};

const STANDARD_RULES: RulesConfig = {
  winPoints: 2,
  smallFinalPoints: 1,
  checkoutBonusPoints: 1,
  jackpotPerPlayerEUR: 1,
  rebuyEUR: 0.5,
  rebuyWinPointsS1S2: 2,
  rebuyFirstWinPointsS3Plus: 2,
  rebuyNextWinPointsS3Plus: 1,
  defaultPoolFormat: 301,
  defaultFinalFormat: 501,
};

const FUN_RULES: RulesConfig = {
  ...STANDARD_RULES,
  winPoints: 1,
  smallFinalPoints: 1,
  checkoutBonusPoints: 0,
  jackpotPerPlayerEUR: 0,
  rebuyEUR: 0,
};

const SNAPSHOTS_KEY = "darts_league_snapshots_v1";
const MAX_SNAPSHOTS = 20;

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

function hashString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getRules(profile: RulesProfile, customRules: RulesConfig): RulesConfig {
  if (profile === "FUN") return FUN_RULES;
  if (profile === "CUSTOM") return customRules;
  return STANDARD_RULES;
}

function loadSnapshots(): SnapshotEntry[] {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x: any) => ({
        id: normName(x?.id) || uid("snap"),
        ts: Number(x?.ts ?? Date.now()),
        label: normName(x?.label) || "Snapshot",
        state: sanitizeState(x?.state),
      }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_SNAPSHOTS);
  } catch {
    return [];
  }
}

function saveSnapshots(snaps: SnapshotEntry[]) {
  try {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snaps.slice(0, MAX_SNAPSHOTS)));
  } catch {}
}

function runSeasonDiagnostics(season: Season) {
  const issues: string[] = [];
  const playersSet = new Set(season.players);

  if (season.players.length < 2) issues.push("Pas assez de joueurs dans la saison.");

  for (const so of season.soirees) {
    const participants = uniq([...so.pools.A, ...so.pools.B]);
    if (participants.length === 0) issues.push(`Soirée ${so.number}: aucune poule définie.`);
    for (const m of so.matches) {
      if (m.a && !playersSet.has(m.a)) issues.push(`Soirée ${so.number} Match #${m.order}: joueur A inconnu (${m.a}).`);
      if (m.b && !playersSet.has(m.b)) issues.push(`Soirée ${so.number} Match #${m.order}: joueur B inconnu (${m.b}).`);
      if (m.winner && m.winner !== m.a && m.winner !== m.b) {
        issues.push(`Soirée ${so.number} Match #${m.order}: vainqueur incohérent.`);
      }
    }
  }

  return issues;
}

function buildRoundRobinMatches(players: string[]): CoreMatch[] {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      pairs.push([players[i], players[j]]);
    }
  }
  return pairs.map(([a, b], idx) => ({
    id: uid("funm"),
    order: idx + 1,
    phase: "POULE",
    status: "PENDING",
    pool: null,
    format: 301,
    bo: "BO3",
    maxTurns: 10,
    a,
    b,
    winner: "",
    checkout100: false,
  }));
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
    status: "PENDING",
    pool,
    format: 301,
    bo: "BO3",
    maxTurns: 10,
    a,
    b,
    winner: "",
    checkout100: false,
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
  season?: Season,
  rules: RulesConfig = STANDARD_RULES
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
    if (!w) continue;

    const basePts = m.phase === "PFINAL" ? rules.smallFinalPoints : rules.winPoints;

    add(pts, w, basePts);
    add(wins, w, 1);

    if (m.checkout100) {
      add(bonus, w, 1);
      add(pts, w, rules.checkoutBonusPoints);
    }
  }

  const soN = Number(seasonSoireeNumber ?? 0);

  const priorCompleted = new Map<string, number>();
  if (soN >= 3 && season) {
    const soireesAsc = [...season.soirees].sort((a, b) => a.number - b.number);
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

  const sortedRebuys = [...rebuyMatches].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const localCompleted = new Map<string, number>();
  const doneBefore = (buyer: string) => (priorCompleted.get(buyer) ?? 0) + (localCompleted.get(buyer) ?? 0);
  const incLocalDone = (buyer: string) => localCompleted.set(buyer, (localCompleted.get(buyer) ?? 0) + 1);

  for (const r of sortedRebuys) {
    const buyer = normName(r.buyer);
    const w = normName(r.winner);
    if (!buyer || !w) continue;

    if (soN > 0 && soN <= 2) {
      if (w === buyer) {
        add(pts, buyer, rules.rebuyWinPointsS1S2);
        add(wins, buyer, 1);
      }
      incLocalDone(buyer);
      continue;
    }

    const winPts =
      soN >= 3
        ? doneBefore(buyer) === 0
          ? rules.rebuyFirstWinPointsS3Plus
          : rules.rebuyNextWinPointsS3Plus
        : rules.rebuyWinPointsS1S2;

    if (w === buyer) {
      add(pts, buyer, winPts);
      add(wins, buyer, 1);
    }

    incLocalDone(buyer);
  }

  return { pts, wins, bonus };
}

function aggregateSeasonStats(season: Season, rules: RulesConfig = STANDARD_RULES) {
  const pts = new Map<string, number>();
  const wins = new Map<string, number>();
  const bonus = new Map<string, number>();

  const add = (map: Map<string, number>, key: string, delta: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  for (const s of season.soirees) {
    const { pts: p, wins: w, bonus: b } = computePointsFromMatches(s.matches, s.rebuys, s.number, season, rules);
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

  table.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.name.localeCompare(b.name);
  });

  return { table, pts, wins, bonus };
}

function computeJackpotEUR(season: Season, rules: RulesConfig = STANDARD_RULES) {
  const base = season.soirees.reduce((sum, s) => sum + s.pools.A.length + s.pools.B.length, 0);
  const rebuyCount = season.soirees.reduce((sum, s) => sum + s.rebuys.length, 0);
  return base * rules.jackpotPerPlayerEUR + rebuyCount * rules.rebuyEUR;
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
  out.sort((a, b) => b.best - a.best || a.player.localeCompare(b.player));
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

const SEASON1_PLAYERS = [
  "ANGEL",
  "SAMUEL",
  "MARVIN",
  "CLÉMENT",
  "ACHIL",
  "BAPTISTE",
  "EMERIC",
  "JOAO",
];

function seedSoiree1(): Soiree {
  const pools = {
    A: ["CLÉMENT", "ANGEL", "BAPTISTE", "EMERIC"],
    B: ["JOAO", "SAMUEL", "MARVIN", "ACHIL"],
  };

  const base: Array<{ order: number; phase: Phase; pool: "A" | "B" | null; a: string; b: string; winner: string }> = [
    { order: 1, phase: "POULE", pool: "A", a: "CLÉMENT", b: "ANGEL", winner: "ANGEL" },
    { order: 2, phase: "POULE", pool: "B", a: "JOAO", b: "SAMUEL", winner: "SAMUEL" },
    { order: 3, phase: "POULE", pool: "A", a: "EMERIC", b: "BAPTISTE", winner: "BAPTISTE" },
    { order: 4, phase: "POULE", pool: "B", a: "MARVIN", b: "ACHIL", winner: "MARVIN" },
    { order: 5, phase: "POULE", pool: "A", a: "BAPTISTE", b: "CLÉMENT", winner: "CLÉMENT" },
    { order: 6, phase: "POULE", pool: "B", a: "MARVIN", b: "JOAO", winner: "MARVIN" },
    { order: 7, phase: "POULE", pool: "A", a: "ANGEL", b: "EMERIC", winner: "EMERIC" },
    { order: 8, phase: "POULE", pool: "B", a: "SAMUEL", b: "ACHIL", winner: "SAMUEL" },
    { order: 9, phase: "POULE", pool: "A", a: "CLÉMENT", b: "EMERIC", winner: "CLÉMENT" },
    { order: 10, phase: "POULE", pool: "B", a: "JOAO", b: "ACHIL", winner: "ACHIL" },
    { order: 11, phase: "POULE", pool: "A", a: "ANGEL", b: "BAPTISTE", winner: "ANGEL" },
    { order: 12, phase: "POULE", pool: "B", a: "SAMUEL", b: "MARVIN", winner: "SAMUEL" },
    { order: 13, phase: "DEMI", pool: null, a: "ANGEL", b: "SAMUEL", winner: "ANGEL" },
    { order: 14, phase: "DEMI", pool: null, a: "CLÉMENT", b: "MARVIN", winner: "MARVIN" },
    { order: 15, phase: "PFINAL", pool: null, a: "CLÉMENT", b: "SAMUEL", winner: "SAMUEL" },
    { order: 16, phase: "FINAL", pool: null, a: "ANGEL", b: "MARVIN", winner: "ANGEL" },
  ];

  const matches: CoreMatch[] = base.map((m, idx) => ({
    id: uid("m"),
    order: idx + 1,
    phase: m.phase,
    status: m.winner ? "VALIDATED" : "PENDING",
    pool: m.pool,
    format: m.phase === "FINAL" ? 501 : 301,
    bo: "BO3",
    maxTurns: 10,
    a: m.a,
    b: m.b,
    winner: m.winner,
    checkout100: false,
  }));

  return {
    id: uid("s"),
    number: 1,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    pools,
    matches,
    rebuys: [],
  };
}

function seedSoiree2(): Soiree {
  const pools = {
    A: ["ACHIL", "JOAO", "ANGEL", "MARVIN"],
    B: ["SAMUEL", "EMERIC", "BAPTISTE", "CLÉMENT"],
  };

  const base: Array<Partial<CoreMatch> & { phase: Phase; pool: "A" | "B" | null; a: string; b: string; winner: string; format?: 301 | 501 }> = [
    { phase: "POULE", pool: "A", a: "ACHIL", b: "JOAO", winner: "JOAO", format: 301 },
    { phase: "POULE", pool: "B", a: "SAMUEL", b: "EMERIC", winner: "SAMUEL", format: 301 },
    { phase: "POULE", pool: "A", a: "ANGEL", b: "MARVIN", winner: "ANGEL", format: 301 },
    { phase: "POULE", pool: "B", a: "BAPTISTE", b: "CLÉMENT", winner: "CLÉMENT", format: 301 },
    { phase: "POULE", pool: "A", a: "ACHIL", b: "ANGEL", winner: "ACHIL", format: 301, checkout100: true },
    { phase: "POULE", pool: "B", a: "SAMUEL", b: "BAPTISTE", winner: "BAPTISTE", format: 301 },
    { phase: "POULE", pool: "A", a: "JOAO", b: "MARVIN", winner: "MARVIN", format: 301 },
    { phase: "POULE", pool: "B", a: "EMERIC", b: "CLÉMENT", winner: "EMERIC", format: 301 },
    { phase: "POULE", pool: "A", a: "ACHIL", b: "MARVIN", winner: "MARVIN", format: 301 },
    { phase: "POULE", pool: "B", a: "SAMUEL", b: "CLÉMENT", winner: "SAMUEL", format: 301 },
    { phase: "POULE", pool: "A", a: "JOAO", b: "ANGEL", winner: "JOAO", format: 301 },
    { phase: "POULE", pool: "B", a: "EMERIC", b: "BAPTISTE", winner: "BAPTISTE", format: 301 },
    { phase: "DEMI", pool: null, a: "JOAO", b: "SAMUEL", winner: "JOAO", format: 301 },
    { phase: "DEMI", pool: null, a: "BAPTISTE", b: "MARVIN", winner: "BAPTISTE", format: 301 },
    { phase: "PFINAL", pool: null, a: "SAMUEL", b: "MARVIN", winner: "MARVIN", format: 301 },
    { phase: "FINAL", pool: null, a: "JOAO", b: "BAPTISTE", winner: "JOAO", format: 501 },
  ];

  const matches: CoreMatch[] = base.map((m, idx) => ({
    id: uid("m"),
    order: idx + 1,
    phase: m.phase,
    status: m.winner ? "VALIDATED" : "PENDING",
    pool: m.pool,
    format: (m.format ?? (m.phase === "FINAL" ? 501 : 301)) as 301 | 501,
    bo: "BO3",
    maxTurns: 10,
    a: m.a,
    b: m.b,
    winner: m.winner,
    checkout100: Boolean((m as any).checkout100),
  }));

  const rebuys: RebuyMatch[] = [
    { buyer: "CLÉMENT", a: "CLÉMENT", b: "EMERIC", winner: "CLÉMENT" },
    { buyer: "ACHIL", a: "ACHIL", b: "MARVIN", winner: "ACHIL" },
    { buyer: "ANGEL", a: "ANGEL", b: "JOAO", winner: "ANGEL" },
    { buyer: "EMERIC", a: "EMERIC", b: "BAPTISTE", winner: "EMERIC" },
  ].map((r, i) => ({
    id: uid("rb"),
    buyer: r.buyer,
    a: r.a,
    b: r.b,
    winner: r.winner,
    createdAt: Date.now() - 1000 * 60 * 60 * 12 + i * 1000,
  }));

  return {
    id: uid("s"),
    number: 2,
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    pools,
    matches,
    rebuys,
  };
}

function makeInitialState(): AppState {
  return {
    version: VERSION,
    season: {
      id: uid("season"),
      name: "Saison 1",
      players: [...SEASON1_PLAYERS],
      soirees: [seedSoiree1(), seedSoiree2()],
    },
    funMode: {
      players: [],
      matches: [],
    },
    system: {
      rulesProfile: "STANDARD",
      customRules: { ...STANDARD_RULES },
      audit: [],
    },
  };
}

function sanitizeState(raw: any): AppState {
  const fallback = makeInitialState();
  try {
    if (!raw || typeof raw !== "object") return fallback;
    const v = Number(raw.version ?? 0);
    const season = raw.season;
    if (!season || typeof season !== "object") return fallback;

    const players = uniq((season.players ?? []).map(normName)).filter(isNonEmptyString);
    const soirees: Soiree[] = (season.soirees ?? []).map((s: any, i: number) => {
      const poolsA = (s?.pools?.A ?? []).map(normName).filter(Boolean);
      const poolsB = (s?.pools?.B ?? []).map(normName).filter(Boolean);

      const matches: CoreMatch[] = (s?.matches ?? []).map((m: any, idx: number) => ({
        id: normName(m?.id) || uid("m"),
        order: clampInt(Number(m?.order ?? idx + 1), 1, 9999),
        phase: (["POULE", "DEMI", "PFINAL", "FINAL"].includes(m?.phase) ? m.phase : "POULE") as Phase,
        status:
          m?.status === "PENDING" || m?.status === "VALIDATED" || m?.status === "CONTESTED"
            ? m.status
            : normName(m?.winner)
              ? "VALIDATED"
              : "PENDING",
        pool: m?.pool === "A" || m?.pool === "B" ? m.pool : null,
        format: Number(m?.format) === 501 ? 501 : 301,
        bo: (["BO1", "BO3", "BO5", "SEC"].includes(m?.bo) ? m.bo : "BO3") as any,
        maxTurns: clampInt(Number(m?.maxTurns ?? 10), 1, 50),
        a: normName(m?.a),
        b: normName(m?.b),
        winner: normName(m?.winner),
        checkout100: Boolean(m?.checkout100),
      }));

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
        number: clampInt(Number(s?.number ?? i + 1), 1, 999),
        dateLabel: normName(s?.dateLabel) || undefined,
        createdAt: Number(s?.createdAt ?? Date.now()),
        pools: { A: poolsA, B: poolsB },
        matches: matches.sort((a, b) => a.order - b.order),
        rebuys: rebuys.sort((a, b) => a.createdAt - b.createdAt),
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
      id: normName(season.id) || uid("season"),
      name: normName(season.name) || "Saison 1",
      players: inferredPlayers,
      soirees,
    };

    const funPlayers = uniq((raw.funMode?.players ?? []).map(normName)).filter(isNonEmptyString).slice(0, 8);
    const funMatchesRaw = Array.isArray(raw.funMode?.matches) ? raw.funMode.matches : [];
    const funMatches: CoreMatch[] = funMatchesRaw.map((m: any, idx: number) => ({
      id: normName(m?.id) || uid("funm"),
      order: clampInt(Number(m?.order ?? idx + 1), 1, 9999),
      phase: "POULE",
      status:
        m?.status === "PENDING" || m?.status === "VALIDATED" || m?.status === "CONTESTED"
          ? m.status
          : normName(m?.winner)
            ? "VALIDATED"
            : "PENDING",
      pool: null,
      format: Number(m?.format) === 501 ? 501 : 301,
      bo: (["BO1", "BO3", "BO5", "SEC"].includes(m?.bo) ? m.bo : "BO3") as "BO1" | "BO3" | "BO5" | "SEC",
      maxTurns: clampInt(Number(m?.maxTurns ?? 10), 1, 50),
      a: normName(m?.a),
      b: normName(m?.b),
      winner: normName(m?.winner),
      checkout100: Boolean(m?.checkout100),
    }));

    if (!seasonSan.soirees.length) seasonSan.soirees = [seedSoiree1()];

    const profileRaw = normName(raw.system?.rulesProfile);
    const rulesProfile: RulesProfile =
      profileRaw === "FUN" || profileRaw === "CUSTOM" || profileRaw === "STANDARD" ? profileRaw : "STANDARD";
    const customRulesRaw = raw.system?.customRules ?? {};
    const customRules: RulesConfig = {
      winPoints: clampInt(Number(customRulesRaw.winPoints ?? STANDARD_RULES.winPoints), 0, 20),
      smallFinalPoints: clampInt(Number(customRulesRaw.smallFinalPoints ?? STANDARD_RULES.smallFinalPoints), 0, 20),
      checkoutBonusPoints: clampInt(Number(customRulesRaw.checkoutBonusPoints ?? STANDARD_RULES.checkoutBonusPoints), 0, 10),
      jackpotPerPlayerEUR: Math.max(0, Number(customRulesRaw.jackpotPerPlayerEUR ?? STANDARD_RULES.jackpotPerPlayerEUR)),
      rebuyEUR: Math.max(0, Number(customRulesRaw.rebuyEUR ?? STANDARD_RULES.rebuyEUR)),
      rebuyWinPointsS1S2: clampInt(Number(customRulesRaw.rebuyWinPointsS1S2 ?? STANDARD_RULES.rebuyWinPointsS1S2), 0, 20),
      rebuyFirstWinPointsS3Plus: clampInt(
        Number(customRulesRaw.rebuyFirstWinPointsS3Plus ?? STANDARD_RULES.rebuyFirstWinPointsS3Plus),
        0,
        20
      ),
      rebuyNextWinPointsS3Plus: clampInt(
        Number(customRulesRaw.rebuyNextWinPointsS3Plus ?? STANDARD_RULES.rebuyNextWinPointsS3Plus),
        0,
        20
      ),
      defaultPoolFormat: Number(customRulesRaw.defaultPoolFormat) === 501 ? 501 : 301,
      defaultFinalFormat: Number(customRulesRaw.defaultFinalFormat) === 301 ? 301 : 501,
    };
    const audit: AuditEntry[] = Array.isArray(raw.system?.audit)
      ? raw.system.audit
          .map((x: any) => ({
            id: normName(x?.id) || uid("audit"),
            ts: Number(x?.ts ?? Date.now()),
            action: normName(x?.action) || "Action",
            details: normName(x?.details) || undefined,
          }))
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 300)
      : [];

    return {
      version: v || VERSION,
      season: seasonSan,
      funMode: {
        players: funPlayers,
        matches: funMatches
          .filter((m) => m.a && m.b && funPlayers.includes(m.a) && funPlayers.includes(m.b))
          .sort((a, b) => a.order - b.order),
      },
      system: {
        rulesProfile,
        customRules,
        audit,
      },
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
  const [tab, setTab] = useState<"SOIREE" | "CLASSEMENT" | "HISTO" | "REBUY" | "FUN" | "H2H" | "ARBITRAGE" | "PARAMS">(
    "SOIREE"
  );
  const [compactMode, setCompactMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("dl_compact_mode") === "1";
    } catch {
      return false;
    }
  });
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [exportText, setExportText] = useState("");
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>(() => loadSnapshots());
  const [readOnlyLink, setReadOnlyLink] = useState("");
  const [funPlayerInput, setFunPlayerInput] = useState("");
  const [selectedSoireeNumber, setSelectedSoireeNumber] = useState<number>(() => {
    const max = Math.max(...state.season.soirees.map((s) => s.number));
    return max;
  });

  const savingRef = useRef<number | null>(null);
  const undoStackRef = useRef<AppState[]>([]);
  const redoStackRef = useRef<AppState[]>([]);
  const historyNavRef = useRef(false);
  const lastSerializedRef = useRef(JSON.stringify(state));
  const lastAutoSnapRef = useRef<number>(0);

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
    const currentSerialized = JSON.stringify(state);
    if (historyNavRef.current) {
      historyNavRef.current = false;
      lastSerializedRef.current = currentSerialized;
      return;
    }
    if (currentSerialized !== lastSerializedRef.current) {
      undoStackRef.current.push(sanitizeState(JSON.parse(lastSerializedRef.current)));
      if (undoStackRef.current.length > 60) undoStackRef.current = undoStackRef.current.slice(-60);
      redoStackRef.current = [];
      lastSerializedRef.current = currentSerialized;
    }

    const now = Date.now();
    if (now - lastAutoSnapRef.current > 1000 * 60 * 5) {
      const snap: SnapshotEntry = {
        id: uid("snap"),
        ts: now,
        label: `Auto ${new Date(now).toLocaleString("fr-FR")}`,
        state: sanitizeState(JSON.parse(currentSerialized)),
      };
      const next = [snap, ...snapshots].slice(0, MAX_SNAPSHOTS);
      setSnapshots(next);
      saveSnapshots(next);
      lastAutoSnapRef.current = now;
    }
  }, [state, snapshots]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    if (!hash.startsWith("#readonly=")) return;
    try {
      const encoded = hash.slice("#readonly=".length);
      const decoded = decodeURIComponent(escape(atob(encoded)));
      const parsed = JSON.parse(decoded);
      setState(sanitizeState(parsed));
      setTab("CLASSEMENT");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("dl_compact_mode", compactMode ? "1" : "0");
    } catch {}
  }, [compactMode]);

  useEffect(() => {
    const exists = state.season.soirees.some((s) => s.number === selectedSoireeNumber);
    if (!exists) {
      const max = Math.max(...state.season.soirees.map((s) => s.number));
      setSelectedSoireeNumber(max);
    }
  }, [state.season.soirees, selectedSoireeNumber]);

  const effectiveRules = useMemo(
    () => getRules(state.system.rulesProfile, state.system.customRules),
    [state.system.rulesProfile, state.system.customRules]
  );
  const seasonStats = useMemo(() => aggregateSeasonStats(state.season, effectiveRules), [state.season, effectiveRules]);
  const jackpotEUR = useMemo(() => computeJackpotEUR(state.season, effectiveRules), [state.season, effectiveRules]);
  const streaks = useMemo(() => computeWinStreaks(state.season), [state.season]);
  const h2h = useMemo(() => computeHeadToHead(state.season), [state.season]);
  const diagnostics = useMemo(() => runSeasonDiagnostics(state.season), [state.season]);

  const playerColors = useMemo(() => {
    const map = new Map<string, string>();
    state.season.players.forEach((p, i) => map.set(p, PALETTE[i % PALETTE.length]));
    return map;
  }, [state.season.players]);

  const getPlayerColor = (name: string) => {
    const norm = normName(name);
    if (!norm) return "#ffffff33";
    return playerColors.get(norm) ?? PALETTE[hashString(norm) % PALETTE.length];
  };

  const currentSoiree = useMemo(() => {
    return state.season.soirees.find((s) => s.number === selectedSoireeNumber) ?? state.season.soirees[0];
  }, [state.season.soirees, selectedSoireeNumber]);


  const currentPoolStandings = useMemo(() => {
    const poolMatches = currentSoiree.matches.filter((m) => m.phase === "POULE");

    const calcPool = (pool: "A" | "B") => {
      const players = currentSoiree.pools[pool];
      const relevant = poolMatches.filter((m) => m.pool === pool);

      const { pts, wins, bonus } = computePointsFromMatches(relevant, [], currentSoiree.number, state.season, effectiveRules);

      const rows = players.map((p) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
        bonus: bonus.get(p) ?? 0,
      }));

      rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name));
      return rows;
    };

    return { A: calcPool("A"), B: calcPool("B") };
  }, [currentSoiree.matches, currentSoiree.pools, currentSoiree.number, state.season]);

  const allSoireeNumbers = useMemo(() => {
    return [...state.season.soirees].map((s) => s.number).sort((a, b) => a - b);
  }, [state.season.soirees]);

  const funStandings = useMemo(() => {
    const wins = new Map<string, number>();
    const played = new Map<string, number>();
    state.funMode.players.forEach((p) => {
      wins.set(p, 0);
      played.set(p, 0);
    });

    for (const m of state.funMode.matches) {
      const a = normName(m.a);
      const b = normName(m.b);
      const w = normName(m.winner);
      if (!a || !b) continue;
      played.set(a, (played.get(a) ?? 0) + 1);
      played.set(b, (played.get(b) ?? 0) + 1);
      if (w && (w === a || w === b)) wins.set(w, (wins.get(w) ?? 0) + 1);
    }

    const rows = state.funMode.players.map((p) => ({
      name: p,
      wins: wins.get(p) ?? 0,
      played: played.get(p) ?? 0,
    }));
    rows.sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
    return rows;
  }, [state.funMode.players, state.funMode.matches]);

  function updateSeason(mutator: (season: Season) => Season) {
    setState((prev) => ({ ...prev, season: mutator(prev.season) }));
  }

  function updateSystem(mutator: (system: AppState["system"]) => AppState["system"]) {
    setState((prev) => ({ ...prev, system: mutator(prev.system) }));
  }

  function logAudit(action: string, details?: string) {
    updateSystem((system) => ({
      ...system,
      audit: [{ id: uid("audit"), ts: Date.now(), action, details }, ...system.audit].slice(0, 300),
    }));
  }

  function createSnapshot(label = "Manuel") {
    const snap: SnapshotEntry = {
      id: uid("snap"),
      ts: Date.now(),
      label,
      state: sanitizeState(JSON.parse(JSON.stringify(state))),
    };
    const next = [snap, ...snapshots].slice(0, MAX_SNAPSHOTS);
    setSnapshots(next);
    saveSnapshots(next);
    logAudit("Snapshot créé", label);
  }

  function restoreSnapshot(snapshotId: string) {
    const snap = snapshots.find((x) => x.id === snapshotId);
    if (!snap) return;
    historyNavRef.current = true;
    setState(sanitizeState(snap.state));
    logAudit("Snapshot restauré", snap.label);
  }

  function undoLastAction() {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(sanitizeState(JSON.parse(JSON.stringify(state))));
    historyNavRef.current = true;
    setState(sanitizeState(prev));
    logAudit("Undo");
  }

  function redoLastAction() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(sanitizeState(JSON.parse(JSON.stringify(state))));
    historyNavRef.current = true;
    setState(sanitizeState(next));
    logAudit("Redo");
  }

  function exportSeasonSummaryText() {
    const lines: string[] = [];
    lines.push(`Résumé ${state.season.name}`);
    lines.push(`Date: ${new Date().toLocaleString("fr-FR")}`);
    lines.push("");
    lines.push("Classement général:");
    seasonStats.table.forEach((r, i) => lines.push(`${i + 1}. ${r.name} - ${r.pts} pts (${r.wins}V)`));
    lines.push("");
    lines.push(`Jackpot: ${formatEUR(jackpotEUR)}`);
    lines.push(`Soirées: ${state.season.soirees.length}`);
    const txt = lines.join("\n");
    downloadTextFile(`resume_${state.season.name.replace(/\s+/g, "_")}.txt`, txt, "text/plain;charset=utf-8");
    logAudit("Export résumé soirée");
  }

  async function generateReadOnlyLink() {
    const serialized = JSON.stringify(state);
    const encoded = btoa(unescape(encodeURIComponent(serialized)));
    const url = `${window.location.origin}${window.location.pathname}#readonly=${encoded}`;
    setReadOnlyLink(url);
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
    logAudit("Lien lecture seule généré");
  }

  function updateFunMode(mutator: (fun: FunModeState) => FunModeState) {
    setState((prev) => ({ ...prev, funMode: mutator(prev.funMode) }));
  }

  function addFunPlayer() {
    const name = normName(funPlayerInput);
    if (!name) return;
    updateFunMode((fun) => {
      if (fun.players.includes(name) || fun.players.length >= 8) return fun;
      return { ...fun, players: [...fun.players, name], matches: [] };
    });
    setFunPlayerInput("");
  }

  function removeFunPlayer(name: string) {
    updateFunMode((fun) => ({
      ...fun,
      players: fun.players.filter((p) => p !== name),
      matches: [],
    }));
  }

  function generateFunSoiree() {
    updateFunMode((fun) => {
      const players = fun.players.slice(0, 8);
      if (players.length < 2) return fun;
      const matches = buildRoundRobinMatches(players);
      return { ...fun, matches };
    });
  }

  function resetFunMode() {
    updateFunMode(() => ({ players: [], matches: [] }));
    setFunPlayerInput("");
  }

  function setFunMatchWinner(matchId: string, winner: string) {
    updateFunMode((fun) => {
      const matches = fun.matches.map((m) => {
        if (m.id !== matchId) return m;
        const w = normName(winner);
        const valid = w === m.a || w === m.b;
        return { ...m, winner: valid ? w : "", status: valid ? "VALIDATED" : "PENDING", checkout100: false };
      });
      return { ...fun, matches };
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
    logAudit("Reset complet");
  }

  function exportSeasonFile() {
    const payload = JSON.stringify(state, null, 2);
    const safeName = (state.season.name || "Saison").split(" ").join("_");
    const filename = "dark-league_" + safeName + "_soirees-" + String(state.season.soirees.length) + ".json";

    try {
      downloadTextFile(filename, payload);
    } catch {}

    setExportText(payload);
    setShowExport(true);
    logAudit("Export JSON fichier");
  }

  async function exportSeasonClipboard() {
    try {
      const payload = JSON.stringify(state, null, 2);
      await navigator.clipboard.writeText(payload);
      alert("Export copié dans le presse-papiers ✅");
      logAudit("Export JSON clipboard");
    } catch {
      const payload = JSON.stringify(state, null, 2);
      setExportText(payload);
      setShowExport(true);
      alert("Copie automatique bloquée. L’export s’affiche : copie/colle-le dans un fichier .json ✅");
      logAudit("Export JSON fallback");
    }
  }

  function importSeasonFromText(text: string) {
    try {
      const parsed = JSON.parse(text);
      const next = sanitizeState(parsed);
      setState(next);
      const max = Math.max(...next.season.soirees.map((s) => s.number));
      setSelectedSoireeNumber(max);
      setTab("SOIREE");
      setShowImport(false);
      setImportText("");
      logAudit("Import JSON");
    } catch {
      alert("Import impossible : JSON invalide.");
    }
  }

  function triggerImportFile() {
    importFileRef.current?.click();
  }

  function startNewSoiree() {
    const issues = runSeasonDiagnostics(state.season);
    if (issues.length > 0) {
      const proceed = window.confirm(
        `Diagnostics: ${issues.length} anomalie(s) détectée(s).\n\n- ${issues.slice(0, 3).join("\n- ")}\n\nContinuer quand même ?`
      );
      if (!proceed) return;
    }
    updateSeason((season) => {
      const nextNumber = Math.max(...season.soirees.map((s) => s.number)) + 1;
      const players = season.players;

      let pools: { A: string[]; B: string[] };
      if (nextNumber <= 2) {
        const sh = shuffle(players);
        pools = { A: sh.slice(0, 4), B: sh.slice(4, 8) };
      } else {
        const ranked = aggregateSeasonStats(season, effectiveRules).table.map((x) => x.name);
        pools = {
          A: [ranked[0], ranked[2], ranked[4], ranked[6]].filter(Boolean),
          B: [ranked[1], ranked[3], ranked[5], ranked[7]].filter(Boolean),
        };
      }

      const poolA = poolMatchesFor4(pools.A, "A");
      const poolB = poolMatchesFor4(pools.B, "B");
      const inter = interleavePools(poolA, poolB).map((m) => ({ ...m, format: effectiveRules.defaultPoolFormat }));

      const finals: CoreMatch[] = [
        {
          id: uid("m"),
          order: inter.length + 1,
          phase: "DEMI",
          status: "PENDING",
          pool: null,
          format: effectiveRules.defaultPoolFormat,
          bo: "BO3",
          maxTurns: 10,
          a: "",
          b: "",
          winner: "",
          checkout100: false,
        },
        {
          id: uid("m"),
          order: inter.length + 2,
          phase: "DEMI",
          status: "PENDING",
          pool: null,
          format: effectiveRules.defaultPoolFormat,
          bo: "BO3",
          maxTurns: 10,
          a: "",
          b: "",
          winner: "",
          checkout100: false,
        },
        {
          id: uid("m"),
          order: inter.length + 3,
          phase: "PFINAL",
          status: "PENDING",
          pool: null,
          format: effectiveRules.defaultPoolFormat,
          bo: "BO3",
          maxTurns: 10,
          a: "",
          b: "",
          winner: "",
          checkout100: false,
        },
        {
          id: uid("m"),
          order: inter.length + 4,
          phase: "FINAL",
          status: "PENDING",
          pool: null,
          format: effectiveRules.defaultFinalFormat,
          bo: "BO3",
          maxTurns: 10,
          a: "",
          b: "",
          winner: "",
          checkout100: false,
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
    logAudit("Nouvelle soirée générée");

    setTimeout(() => {
      const max = Math.max(...state.season.soirees.map((s) => s.number)) + 1;
      setSelectedSoireeNumber(max);
      setTab("SOIREE");
    }, 0);
  }

  function setMatchWinner(matchId: string, winner: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m) => {
          if (m.id !== matchId) return m;
          const w = normName(winner);
          const valid = w && (w === normName(m.a) || w === normName(m.b));
          return {
            ...m,
            winner: valid ? w : "",
            status: valid ? "VALIDATED" : "PENDING",
            checkout100: valid ? m.checkout100 : false,
          };
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function setMatchStatus(matchId: string, status: MatchStatus) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        return {
          ...s,
          matches: s.matches.map((m) => (m.id === matchId ? { ...m, status } : m)),
        };
      });
      return { ...season, soirees };
    });
    logAudit("Statut match modifié", `${matchId} -> ${status}`);
  }

  function setMatchCheckout100(matchId: string, val: boolean) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m) => {
          if (m.id !== matchId) return m;
          if (!normName(m.winner)) return { ...m, checkout100: false };
          return { ...m, checkout100: Boolean(val) };
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function recalcFinalsFromPools() {
    const poolMatches = currentSoiree.matches.filter((m) => m.phase === "POULE");

    const calcPool = (pool: "A" | "B") => {
      const players = currentSoiree.pools[pool];
      const relevant = poolMatches.filter((m) => m.pool === pool);
      const { pts, wins, bonus } = computePointsFromMatches(relevant, [], currentSoiree.number, state.season, effectiveRules);
      const rows = players.map((p) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
        bonus: bonus.get(p) ?? 0,
      }));
      rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name));
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
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;

        const demisSorted = s.matches.filter((x) => x.phase === "DEMI").sort((x, y) => x.order - y.order);

        const matches = s.matches.map((m) => {
          if (m.phase !== "DEMI") return m;
          const demiIndex = demisSorted.findIndex((x) => x.id === m.id);
          if (demiIndex === 0) {
            const winner = m.winner && (m.winner === A1 || m.winner === B2) ? m.winner : "";
            return { ...m, a: A1, b: B2, winner, status: winner ? "VALIDATED" : "PENDING" };
          }
          if (demiIndex === 1) {
            const winner = m.winner && (m.winner === B1 || m.winner === A2) ? m.winner : "";
            return { ...m, a: B1, b: A2, winner, status: winner ? "VALIDATED" : "PENDING" };
          }
          return m;
        });

        return { ...s, matches };
      });

      return { ...season, soirees };
    });
  }

  function recalcFinalAndPFinal() {
    const demis = currentSoiree.matches.filter((m) => m.phase === "DEMI").sort((a, b) => a.order - b.order);
    if (demis.length < 2) return;

    const d1 = demis[0];
    const d2 = demis[1];
    const w1 = normName(d1.winner);
    const w2 = normName(d2.winner);

    const l1 = w1 ? (w1 === d1.a ? d1.b : w1 === d1.b ? d1.a : "") : "";
    const l2 = w2 ? (w2 === d2.a ? d2.b : w2 === d2.b ? d2.a : "") : "";

    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m) => {
          if (m.phase === "FINAL") {
            const a = w1 && w2 ? w1 : "";
            const b = w1 && w2 ? w2 : "";
            const keepWinner = m.winner && (m.winner === a || m.winner === b) ? m.winner : "";
            return { ...m, a, b, winner: keepWinner, status: keepWinner ? "VALIDATED" : "PENDING" };
          }
          if (m.phase === "PFINAL") {
            const a = l1 && l2 ? l1 : "";
            const b = l1 && l2 ? l2 : "";
            const keepWinner = m.winner && (m.winner === a || m.winner === b) ? m.winner : "";
            return { ...m, a, b, winner: keepWinner, status: keepWinner ? "VALIDATED" : "PENDING" };
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
      const soirees = season.soirees.map((s) => {
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
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const rebuys = s.rebuys.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { ...s, rebuys };
      });
      return { ...season, soirees };
    });
  }

  function deleteRebuy(id: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        return { ...s, rebuys: s.rebuys.filter((r) => r.id !== id) };
      });
      return { ...season, soirees };
    });
  }

  const currentPodium = useMemo(() => {
    const final = currentSoiree.matches.find((m) => m.phase === "FINAL");
    const pfinal = currentSoiree.matches.find((m) => m.phase === "PFINAL");

    const wFinal = normName(final?.winner ?? "");
    const aFinal = normName(final?.a ?? "");
    const bFinal = normName(final?.b ?? "");

    const second =
      wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";

    const third = normName(pfinal?.winner ?? "");

    if (!wFinal || !second || !third) {
      const { pts, wins } = computePointsFromMatches(currentSoiree.matches, [], currentSoiree.number, state.season, effectiveRules);
      const rows = state.season.players.map((p) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
      }));
      rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name));
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
  }, [currentSoiree.matches, currentSoiree.number, state.season]);


  const totalGainsEUR = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of state.season.players) totals.set(p, 0);

    const podiumFromSoiree = (s: Soiree) => {
      const final = s.matches.find((m) => m.phase === "FINAL");
      const pfinal = s.matches.find((m) => m.phase === "PFINAL");

      const wFinal = normName(final?.winner ?? "");
      const aFinal = normName(final?.a ?? "");
      const bFinal = normName(final?.b ?? "");
      const second =
        wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
      const third = normName(pfinal?.winner ?? "");

      if (!wFinal || !second || !third) {
        const { pts, wins } = computePointsFromMatches(s.matches, [], s.number, state.season, effectiveRules);
        const rows = state.season.players.map((p) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }));
        rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name));
        return { first: rows[0]?.name ?? "", second: rows[1]?.name ?? "", third: rows[2]?.name ?? "" };
      }

      return { first: wFinal, second, third };
    };

    for (const s of state.season.soirees) {
      const { first, second, third } = podiumFromSoiree(s);
      if (first) totals.set(first, (totals.get(first) ?? 0) + MONEY.podiumEUR.first);
      if (second) totals.set(second, (totals.get(second) ?? 0) + MONEY.podiumEUR.second);
      if (third) totals.set(third, (totals.get(third) ?? 0) + MONEY.podiumEUR.third);
    }

    const out = state.season.players.map((p) => ({ player: p, eur: totals.get(p) ?? 0 }));
    out.sort((a, b) => b.eur - a.eur || a.player.localeCompare(b.player));
    return out;
  }, [state.season.players, state.season.soirees]);

  const rankingTimeline = useMemo(() => {
    const players = state.season.players;
    const soirees = [...state.season.soirees].sort((a, b) => a.number - b.number);
    const totals = new Map<string, { pts: number; wins: number; bonus: number }>();
    players.forEach((p) => totals.set(p, { pts: 0, wins: 0, bonus: 0 }));

    const series = new Map<string, number[]>();
    players.forEach((p) => series.set(p, []));

    for (const s of soirees) {
      const { pts, wins, bonus } = computePointsFromMatches(s.matches, s.rebuys, s.number, state.season, effectiveRules);
      for (const p of players) {
        const t = totals.get(p)!;
        totals.set(p, {
          pts: t.pts + (pts.get(p) ?? 0),
          wins: t.wins + (wins.get(p) ?? 0),
          bonus: t.bonus + (bonus.get(p) ?? 0),
        });
      }

      const table = players
        .map((p) => ({ name: p, ...(totals.get(p) ?? { pts: 0, wins: 0, bonus: 0 }) }))
        .sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name));

      table.forEach((row, idx) => {
        series.get(row.name)!.push(idx + 1);
      });
    }

    return {
      labels: soirees.map((s) => s.number),
      series: players.map((p) => ({ player: p, ranks: series.get(p) ?? [] })),
    };
  }, [state.season.players, state.season.soirees]);

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
                  {state.season.name} • Sauvegarde locale (Safari)
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Pill color="#22c55e">Jackpot: {formatEUR(jackpotEUR)}</Pill>
              <Pill>Joueurs: {state.season.players.length}</Pill>
              <Pill>Soirées: {state.season.soirees.length}</Pill>
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
              ["FUN", "Mode Fun"],
              ["H2H", "Confrontations"],
              ["ARBITRAGE", "Arbitrage"],
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
                ["FUN", "Fun"],
                ["H2H", "H2H"],
                ["ARBITRAGE", "Arbitre"],
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

        {tab !== "PARAMS" && tab !== "FUN" && (
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
                  </div>
                }
              >
                <div className="md:hidden space-y-3">
                  {currentSoiree.matches
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((m) => {
                      const options = [m.a, m.b].map(normName).filter(Boolean);
                      const winner = normName(m.winner);
                      const bonus = m.checkout100 ? effectiveRules.checkoutBonusPoints : 0;
                      const basePts = m.phase === "PFINAL" ? effectiveRules.smallFinalPoints : effectiveRules.winPoints;
                      const ptsA = winner && winner === m.a ? basePts + bonus : 0;
                      const ptsB = winner && winner === m.b ? basePts + bonus : 0;

                      if (compactMode) {
                        return (
                          <div key={m.id} className="rounded-2xl border border-white/10 bg-black/30 p-3">
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
                              <Select
                                value={winner}
                                onChange={(v) => {
                                  setMatchWinner(m.id, v);
                                  if (m.phase === "DEMI") setTimeout(() => recalcFinalAndPFinal(), 0);
                                }}
                                options={options}
                                placeholder="Vainqueur…"
                                disabled={!m.a || !m.b}
                              />
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
                        <div key={m.id} className="rounded-2xl border border-white/10 bg-black/30 p-3">
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
                            <Select
                              value={winner}
                              onChange={(v) => {
                                setMatchWinner(m.id, v);
                                if (m.phase === "DEMI") setTimeout(() => recalcFinalAndPFinal(), 0);
                              }}
                              options={options}
                              placeholder="Vainqueur…"
                              disabled={!m.a || !m.b}
                            />
                            <label className="inline-flex items-center gap-2 text-xs text-white/80">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-white/20 bg-black"
                                checked={!!m.checkout100}
                                disabled={!normName(m.winner)}
                                onChange={(e) => setMatchCheckout100(m.id, e.target.checked)}
                              />
                              Checkout ≥100
                            </label>
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

                <div className="hidden md:block overflow-x-auto">
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
                        <th className="py-2 pr-2">Checkout ≥100</th>
                        <th className="py-2 pr-2">Points A</th>
                        <th className="py-2 pr-2">Points B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentSoiree.matches
                        .slice()
                        .sort((a, b) => a.order - b.order)
                        .map((m) => {
                          const options = [m.a, m.b].map(normName).filter(Boolean);
                          const winner = normName(m.winner);
                          const bonus = m.checkout100 ? effectiveRules.checkoutBonusPoints : 0;
                          const basePts = m.phase === "PFINAL" ? effectiveRules.smallFinalPoints : effectiveRules.winPoints;
                          const ptsA = winner && winner === m.a ? basePts + bonus : 0;
                          const ptsB = winner && winner === m.b ? basePts + bonus : 0;

                          return (
                            <tr key={m.id} className="border-t border-white/10">
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
                                  options={options}
                                  placeholder="Vainqueur…"
                                  disabled={!m.a || !m.b}
                                />
                              </td>
                              <td className="py-2 pr-2">
                                <label className="inline-flex items-center gap-2 text-sm text-white/80">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-white/20 bg-black"
                                    checked={!!m.checkout100}
                                    disabled={!normName(m.winner)}
                                    onChange={(e) => setMatchCheckout100(m.id, e.target.checked)}
                                  />
                                  Oui
                                </label>
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
                          {currentPoolStandings[pool].map((r, idx) => (
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
                        {currentPoolStandings[pool].map((r, idx) => (
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
                      {totalGainsEUR.slice(0, 6).map((x) => (
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
                    +{formatEUR(effectiveRules.jackpotPerPlayerEUR)} / joueur / soirée • +{formatEUR(effectiveRules.rebuyEUR)} / re-buy
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
                    {totalGainsEUR.slice(0, 5).map((x) => (
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

            <Section title="Évolution du classement (global)">
              <div className="text-xs text-white/60 mb-2">Une seule courbe par joueur, rang 1 en haut.</div>
              {rankingTimeline.labels.length === 0 ? (
                <div className="text-sm text-white/70">Pas encore de soirées.</div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="w-full overflow-x-auto">
                    <div className="min-w-[640px]">
                      <svg viewBox="0 0 700 260" className="w-full h-[260px]">
                        {(() => {
                          const w = 700;
                          const h = 260;
                          const padL = 40;
                          const padR = 20;
                          const padT = 20;
                          const padB = 30;
                          const playersCount = Math.max(state.season.players.length, 1);
                          const pointsCount = Math.max(rankingTimeline.labels.length, 1);
                          const xScale = (i: number) => {
                            if (pointsCount === 1) return (w - padL - padR) / 2 + padL;
                            return padL + (i / (pointsCount - 1)) * (w - padL - padR);
                          };
                          const yScale = (rank: number) => {
                            if (playersCount === 1) return (h - padT - padB) / 2 + padT;
                            return padT + ((rank - 1) / (playersCount - 1)) * (h - padT - padB);
                          };

                          return (
                            <>
                              {Array.from({ length: playersCount }).map((_, i) => {
                                const y = yScale(i + 1);
                                return (
                                  <g key={`grid-${i}`}>
                                    <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#ffffff1a" />
                                    <text x={10} y={y + 4} fontSize="10" fill="#ffffff80">
                                      {i + 1}
                                    </text>
                                  </g>
                                );
                              })}

                              {rankingTimeline.labels.map((label, i) => {
                                const x = xScale(i);
                                return (
                                  <text key={`x-${label}`} x={x} y={h - 8} fontSize="10" fill="#ffffff80" textAnchor="middle">
                                    S{label}
                                  </text>
                                );
                              })}

                              {rankingTimeline.series.map((ser) => {
                                if (ser.ranks.length === 0) return null;
                                const d = ser.ranks
                                  .map((rank, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(rank)}`)
                                  .join(" ");
                                return (
                                  <path
                                    key={ser.player}
                                    d={d}
                                    fill="none"
                                    stroke={playerColors.get(ser.player) ?? "#fff"}
                                    strokeWidth="2"
                                  />
                                );
                              })}
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {rankingTimeline.series.map((ser) => (
                      <div key={ser.player} className="inline-flex items-center gap-2 rounded-full bg-black/40 px-2 py-1">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(ser.player) ?? "#ffffff33" }} />
                        <span className="font-semibold">{ser.player}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          </div>
        )}

        {tab === "HISTO" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Historique des soirées">
              <div className="space-y-2">
                {state.season.soirees
                  .slice()
                  .sort((a, b) => b.number - a.number)
                  .map((s) => {
                    const { pts, wins } = computePointsFromMatches(s.matches, s.rebuys, s.number, state.season, effectiveRules);
                    const rows = state.season.players.map((p) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }));
                    rows.sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name));
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
                            const final = s.matches.find((m) => m.phase === "FINAL");
                            const pfinal = s.matches.find((m) => m.phase === "PFINAL");
                            const wFinal = normName(final?.winner ?? "");
                            const aFinal = normName(final?.a ?? "");
                            const bFinal = normName(final?.b ?? "");
                            const second = wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
                            const third = normName(pfinal?.winner ?? "");
                            const ok = wFinal && second && third;
                            if (ok) return `1) ${wFinal} • 2) ${second} • 3) ${third}`;
                            return podium.map((p, i) => `${i + 1}) ${p.name} (${p.pts})`).join(" • ");
                          })()}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Pill>
                            Jackpot +
                            {formatEUR((s.pools.A.length + s.pools.B.length) * effectiveRules.jackpotPerPlayerEUR + s.rebuys.length * effectiveRules.rebuyEUR)}
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
                      .sort((a, b) => a.order - b.order)
                      .map((m) => (
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
                    {currentSoiree.rebuys.map((r, idx) => {
                      const players = state.season.players;
                      const buyer = normName(r.buyer);
                      const a = normName(r.a);
                      const b = normName(r.b);
                      const winnerOptions = [a, b].filter(Boolean);

                      const info = (() => {
                        const buyerN = normName(r.buyer);
                        const winnerN = normName(r.winner);
                        if (!buyerN || !winnerN) return "";

                        if (currentSoiree.number <= 2) {
                          return winnerN === buyerN
                            ? `✅ Le buyer gagne +${effectiveRules.rebuyWinPointsS1S2} pts`
                            : "❌ Buyer perd → 0 pt pour tous";
                        }

                        let doneBefore = 0;
                        for (const sx of state.season.soirees) {
                          if (sx.number >= currentSoiree.number) continue;
                          for (const rb of sx.rebuys) {
                            if (normName(rb.buyer) === buyerN && normName(rb.winner)) doneBefore++;
                          }
                        }
                        doneBefore += currentSoiree.rebuys
                          .slice(0, idx)
                          .filter((x) => normName(x.buyer) === buyerN && normName(x.winner)).length;

                        const winPts =
                          doneBefore === 0
                            ? effectiveRules.rebuyFirstWinPointsS3Plus
                            : effectiveRules.rebuyNextWinPointsS3Plus;
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
                          <div className="mt-2 text-xs text-white/60">Impact cagnotte : +{formatEUR(effectiveRules.rebuyEUR)} (automatique)</div>
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
                  <div className="ml-3">— Soirées 1 & 2 : s’il gagne : +{effectiveRules.rebuyWinPointsS1S2} pts</div>
                  <div className="ml-3">— À partir de la soirée 3 :</div>
                  <div className="ml-6">• 1er re-buy de la saison gagné : +{effectiveRules.rebuyFirstWinPointsS3Plus} pts</div>
                  <div className="ml-6">• re-buys suivants gagnés : +{effectiveRules.rebuyNextWinPointsS3Plus} pt</div>
                  <div className="ml-3">— s’il perd : 0 pt pour tous</div>
                  <div className="mt-2 text-xs text-white/60">⚠️ Le re-buy ne qualifie jamais pour les phases finales.</div>
                </div>
              </Section>

              <Section title="Jackpot (détail)">
                <div className="text-sm text-white/70 space-y-1">
                  <div>
                    Soirées jouées : <span className="font-semibold text-white">{state.season.soirees.length}</span>
                  </div>
                  <div>
                    Rebuys total : <span className="font-semibold text-white">{state.season.soirees.reduce((s, x) => s + x.rebuys.length, 0)}</span>
                  </div>
                  <div className="mt-2">
                    Jackpot actuel : <span className="font-extrabold text-white">{formatEUR(jackpotEUR)}</span>
                  </div>
                </div>
              </Section>
            </div>
          </div>
        )}

        {tab === "FUN" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-4">
              <Section
                title="Mode Fun — Soirée unique"
                right={
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => generateFunSoiree()} disabled={state.funMode.players.length < 2}>
                      Générer les matchs
                    </Button>
                    <Button variant="danger" onClick={() => resetFunMode()}>
                      Réinitialiser
                    </Button>
                  </div>
                }
              >
                <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60 mb-2">Joueurs (2 à 8)</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={funPlayerInput}
                      onChange={(e) => setFunPlayerInput(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                      placeholder="Ajouter un joueur..."
                    />
                    <Button onClick={() => addFunPlayer()} disabled={!funPlayerInput.trim() || state.funMode.players.length >= 8}>
                      Ajouter
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {state.funMode.players.map((p) => (
                      <button
                        key={p}
                        onClick={() => removeFunPlayer(p)}
                        className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs hover:bg-white/15"
                        title="Retirer ce joueur"
                      >
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: getPlayerColor(p) }} />
                        <span>{p}</span>
                        <span className="text-white/60">✕</span>
                      </button>
                    ))}
                  </div>
                </div>

                {state.funMode.matches.length === 0 ? (
                  <div className="text-sm text-white/70">Ajoute au moins 2 joueurs puis clique “Générer les matchs”.</div>
                ) : (
                  <div className="space-y-2">
                    {state.funMode.matches
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((m) => (
                        <div key={m.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-white/60">#{m.order}</span>
                              <span className="font-semibold">{m.a}</span>
                              <span className="text-white/50">vs</span>
                              <span className="font-semibold">{m.b}</span>
                            </div>
                            <div className="w-full md:w-56">
                              <Select
                                value={normName(m.winner)}
                                onChange={(v) => setFunMatchWinner(m.id, v)}
                                options={[m.a, m.b]}
                                placeholder="Vainqueur..."
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </Section>
            </div>

            <div className="space-y-4">
              <Section title="Classement Fun">
                <div className="space-y-2">
                  {funStandings.map((r, idx) => (
                    <div key={r.name} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-white/60 w-6">{idx + 1}.</span>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: getPlayerColor(r.name) }} />
                        <span className="font-semibold">{r.name}</span>
                      </div>
                      <div className="text-xs text-white/70">
                        <span className="font-bold text-white">{r.wins}</span> V / {r.played} M
                      </div>
                    </div>
                  ))}
                  {funStandings.length === 0 && <div className="text-sm text-white/70">Aucun joueur.</div>}
                </div>
              </Section>

              <Section title="Règles Fun">
                <div className="text-sm text-white/70 space-y-2">
                  <div>• Mode indépendant de la saison.</div>
                  <div>• Maximum 8 joueurs.</div>
                  <div>• Matchs en round-robin (tout le monde se rencontre).</div>
                  <div>• 1 victoire = 1 point dans le classement Fun.</div>
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

        {tab === "ARBITRAGE" && (
          <Section title={`Mode Arbitrage — Soirée ${currentSoiree.number}`} right={<Pill>Officiel</Pill>}>
            <div className="space-y-3">
              {currentSoiree.matches
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((m) => (
                  <div key={m.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Pill>{m.phase}</Pill>
                        <span className="text-xs text-white/60">Match #{m.order}</span>
                        <Pill
                          color={
                            m.status === "VALIDATED" ? "#22c55e" : m.status === "CONTESTED" ? "#ef4444" : "#eab308"
                          }
                        >
                          {m.status}
                        </Pill>
                      </div>
                      <div className="text-sm font-semibold">
                        {m.a || "—"} vs {m.b || "—"}
                        <span className="ml-2 text-white/60">{m.winner ? `→ ${m.winner}` : ""}</span>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="ghost" onClick={() => setMatchStatus(m.id, "PENDING")}>
                        En attente
                      </Button>
                      <Button variant="ghost" onClick={() => setMatchStatus(m.id, "VALIDATED")}>
                        Valider
                      </Button>
                      <Button variant="danger" onClick={() => setMatchStatus(m.id, "CONTESTED")}>
                        Contester
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          </Section>
        )}

        {tab === "PARAMS" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Joueurs (Saison 1)">
              <div className="text-sm text-white/70 mb-3">
                Les noms servent partout (matchs, menus, stats). Garde des noms stables (accents inclus).
              </div>
              <div className="space-y-2">
                {state.season.players.map((p, idx) => (
                  <div
                    key={p}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ background: playerColors.get(p) ?? "#ffffff33" }} />
                      <span className="font-semibold">{p}</span>
                    </div>
                    <span className="text-xs text-white/60">Couleur #{idx + 1}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Système">
              <div className="space-y-3 text-sm text-white/70">
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Sauvegardes intelligentes</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => createSnapshot("Manuel")}>
                      Snapshot manuel
                    </Button>
                    <Button variant="ghost" onClick={() => undoLastAction()}>
                      Undo
                    </Button>
                    <Button variant="ghost" onClick={() => redoLastAction()}>
                      Redo
                    </Button>
                  </div>
                  <div className="mt-2 space-y-1">
                    {snapshots.slice(0, 4).map((s) => (
                      <div key={s.id} className="flex items-center justify-between rounded-lg bg-black/30 px-2 py-1">
                        <span className="text-xs">{s.label}</span>
                        <Button variant="ghost" onClick={() => restoreSnapshot(s.id)}>
                          Restaurer
                        </Button>
                      </div>
                    ))}
                    {snapshots.length === 0 && <div className="text-xs text-white/50">Aucun snapshot.</div>}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Règles personnalisables</div>
                  <div className="mt-2">
                    <Select
                      value={state.system.rulesProfile}
                      onChange={(v) =>
                        updateSystem((system) => ({
                          ...system,
                          rulesProfile: (v === "STANDARD" || v === "FUN" || v === "CUSTOM" ? v : "STANDARD") as RulesProfile,
                        }))
                      }
                      options={["STANDARD", "FUN", "CUSTOM"]}
                    />
                  </div>
                  {state.system.rulesProfile === "CUSTOM" && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="text-xs">
                        Points victoire
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          value={state.system.customRules.winPoints}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, winPoints: clampInt(Number(e.target.value), 0, 20) },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        Bonus checkout
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          value={state.system.customRules.checkoutBonusPoints}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: {
                                ...system.customRules,
                                checkoutBonusPoints: clampInt(Number(e.target.value), 0, 10),
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        Jackpot / joueur (€)
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          step="0.1"
                          min={0}
                          value={state.system.customRules.jackpotPerPlayerEUR}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: {
                                ...system.customRules,
                                jackpotPerPlayerEUR: Math.max(0, Number(e.target.value)),
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        Rebuy (€)
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          step="0.1"
                          min={0}
                          value={state.system.customRules.rebuyEUR}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, rebuyEUR: Math.max(0, Number(e.target.value)) },
                            }))
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Qualité des données (diagnostics)</div>
                  <div className="mt-2 space-y-1">
                    {diagnostics.slice(0, 8).map((issue, i) => (
                      <div key={`${issue}-${i}`} className="text-xs text-orange-300">
                        • {issue}
                      </div>
                    ))}
                    {diagnostics.length === 0 && <div className="text-xs text-emerald-300">Aucune incohérence détectée.</div>}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Partage simplifié</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => exportSeasonSummaryText()}>
                      Export résumé (.txt)
                    </Button>
                    <Button variant="ghost" onClick={() => generateReadOnlyLink()}>
                      Générer lien lecture seule
                    </Button>
                  </div>
                  {readOnlyLink && (
                    <textarea
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 p-2 text-xs text-white"
                      rows={3}
                      value={readOnlyLink}
                      readOnly
                    />
                  )}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Audit (qui/quoi/quand)</div>
                  <div className="mt-2 space-y-1">
                    {state.system.audit.slice(0, 8).map((a) => (
                      <div key={a.id} className="text-xs">
                        <span className="text-white/50">{new Date(a.ts).toLocaleString("fr-FR")} • </span>
                        <span>{a.action}</span>
                        {a.details ? <span className="text-white/60"> ({a.details})</span> : null}
                      </div>
                    ))}
                    {state.system.audit.length === 0 && <div className="text-xs text-white/50">Aucun événement.</div>}
                  </div>
                </div>
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
                    Entrée : {formatEUR(MONEY.entryFeeEUR)} • Jackpot: +{formatEUR(effectiveRules.jackpotPerPlayerEUR)}/joueur/soirée • Rebuy: +{formatEUR(effectiveRules.rebuyEUR)}
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
