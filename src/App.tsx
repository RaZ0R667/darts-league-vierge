import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SOIREE_RULE_POLICIES,
  getActiveSoireeRulePolicy,
  hasKnockoutStarted,
  resolveSoireeRuleContext,
  type ResolvedRuleContext,
  type SoireeRulePolicy,
} from "./domain/soireeRules";
import {
  computeJackpotEURWithPolicies,
  computePointsFromMatchesWithPolicies,
} from "./domain/scoring";

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
type PresenceStatus = "HERE" | "LATE" | "ABSENT";
type TvScene = "INTRO" | "LINEUP" | "WARMUP" | "MATCHFOCUS" | "LIVE" | "CLUTCH" | "FINALE" | "PODIUM";
type PerformanceSort = "POWER" | "FORM" | "DYNAMIC" | "LOWS";
type TournamentFormat = "CLASSIC_POOLS" | "ROUND_ROBIN" | "SWISS_LITE" | "DOUBLE_ELIM_LITE";
type TvTab = Extract<AppTab, "SOIREE" | "CLASSEMENT" | "H2H">;
type BroadcastOverlayKind = "" | "SPONSOR" | "PAUSE" | "ANNOUNCE";
type TvDisplayMode = "STANDARD" | "BIGSCREEN";
type TvInfoDensity = "FULL" | "FOCUS";
type SfxKind = "match" | "checkout" | "scene" | "clutch" | "podium";
type SfxProfile = "SOFT" | "ARENA" | "FINAL";
type CinematicMoment = {
  id: string;
  title: string;
  lines: string[];
  tone: "cyan" | "emerald" | "amber" | "fuchsia";
};
type AppTab =
  | "SOIREE"
  | "CLASSEMENT"
  | "HISTO"
  | "REBUY"
  | "FUN"
  | "H2H"
  | "FINANCES"
  | "ARBITRAGE"
  | "REGLES"
  | "PARAMS"
  | "SAISONS";

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

type CoreMatch = {
  id: string;
  order: number;
  phase: Phase;
  status?: MatchStatus | string;
  pool: "A" | "B" | null;
  format: 301 | 501;
  bo: "BO1" | "BO3" | "BO5" | "SEC";
  maxTurns: number;
  a: string;
  b: string;
  winner: "" | string;
  checkout100: boolean;
  checkoutBy: "" | "A" | "B";
  startedAt?: number;
  endedAt?: number;
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
  tournamentFormat?: TournamentFormat;
  dateLabel?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  closedAt?: number;
  locked?: boolean;
  pools: { A: string[]; B: string[] };
  matches: CoreMatch[];
  rebuys: RebuyMatch[];
  absentPlayers?: string[];
  attendance?: Record<string, PresenceStatus>;
  arrivalEta?: Record<string, string>;
  payments?: Record<string, boolean>;
  financeNotes?: string;
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
  format: 301 | 501;
  moneyEnabled: boolean;
  moneyPerPlayer: number;
  matches: CoreMatch[];
  finals: CoreMatch[];
  positionRounds: Array<{ id: string; positions: string[] }>;
};

type AppState = {
  version: number;
  seasons: Season[];
  activeSeasonId: string;
  funMode: FunModeState;
  system: {
    rulesProfile: RulesProfile;
    customRules: RulesConfig;
    soireeRulePolicies: SoireeRulePolicy[];
    audit: AuditEntry[];
  };
};

const STORAGE_KEY = "darts_league_app_v2";
const VERSION = 2;

const MONEY = {
  entryFeeEUR: 3,
  jackpotPerPlayerEUR: 1,
  rebuyEUR: 0.5,
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
  checkoutBonusPoints: 0,
  jackpotPerPlayerEUR: 0,
  rebuyEUR: 0,
};

type SnapshotEntry = {
  id: string;
  ts: number;
  label: string;
  state: AppState;
};

type SharedPayload = {
  state: AppState;
  rulesPdfData?: string;
  rulesPdfName?: string;
};

type PersistEnvelope = {
  kind: "DL_PERSIST_V1";
  savedAt: number;
  checksum: string;
  state: AppState;
};

const SNAPSHOTS_KEY = "darts_league_snapshots_v1";
const MAX_SNAPSHOTS = 30;
const SYNC_CODE_KEY = "darts_league_sync_code_v1";
const SYNC_ENABLED_KEY = "darts_league_sync_enabled_v1";
const RULES_PDF_DATA_KEY = "darts_league_rules_pdf_data_v1";
const RULES_PDF_NAME_KEY = "darts_league_rules_pdf_name_v1";
const STORAGE_RECOVERY_KEY = "darts_league_recovery_v1";
const STORAGE_HISTORY_KEY = "darts_league_history_v1";
const MAX_STORAGE_HISTORY = 8;
const TV_ROTATION_TABS_KEY = "darts_league_tv_rotation_tabs_v1";
const TV_ROTATION_AUTO_KEY = "darts_league_tv_rotation_auto_v1";
const TV_ROTATION_SPEED_KEY = "darts_league_tv_rotation_speed_v1";
const TV_SOUND_ENABLED_KEY = "darts_league_tv_sound_enabled_v1";
const TV_SOUND_VOLUME_KEY = "darts_league_tv_sound_volume_v1";
const TV_SOUND_PROFILE_KEY = "darts_league_tv_sound_profile_v1";
const TV_DISPLAY_MODE_KEY = "darts_league_tv_display_mode_v1";
const TV_INFO_DENSITY_KEY = "darts_league_tv_info_density_v1";

const SUPABASE_URL = (import.meta as any)?.env?.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY ?? "";

let __supabaseClient: SupabaseClient | null = null;
let BOOT_RECOVERY_NOTICE = "";

function getSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!__supabaseClient) {
    __supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return __supabaseClient;
}

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

const TV_TAB_CATALOG: Array<{ tab: TvTab; label: string }> = [
  { tab: "SOIREE", label: "Soirée" },
  { tab: "CLASSEMENT", label: "Classement" },
  { tab: "H2H", label: "Confrontations" },
];

const DEFAULT_TV_ROTATION_TABS: TvTab[] = ["SOIREE", "CLASSEMENT", "H2H"];

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

function checksumOf(raw: string) {
  return String(hashString(raw));
}

function encodePersistEnvelope(state: AppState) {
  const stateRaw = JSON.stringify(state);
  const envelope: PersistEnvelope = {
    kind: "DL_PERSIST_V1",
    savedAt: Date.now(),
    checksum: checksumOf(stateRaw),
    state: sanitizeState(JSON.parse(stateRaw)),
  };
  return JSON.stringify(envelope);
}

function parsePersistedStateRaw(raw: string): { state: AppState | null; integrityOk: boolean; reason?: string } {
  try {
    const parsed = JSON.parse(raw);
    const isEnvelope =
      parsed &&
      typeof parsed === "object" &&
      parsed.kind === "DL_PERSIST_V1" &&
      typeof parsed.checksum === "string" &&
      parsed.state &&
      typeof parsed.state === "object";
    if (!isEnvelope) {
      return { state: sanitizeState(parsed), integrityOk: true };
    }

    const stateRaw = JSON.stringify(parsed.state);
    const expected = checksumOf(stateRaw);
    if (expected !== parsed.checksum) {
      return { state: null, integrityOk: false, reason: "checksum_mismatch" };
    }
    return { state: sanitizeState(parsed.state), integrityOk: true };
  } catch {
    return { state: null, integrityOk: false, reason: "json_parse_error" };
  }
}

function readRecoveryCandidates(): Array<{ key: string; state: AppState }> {
  if (typeof window === "undefined") return [];
  const out: Array<{ key: string; state: AppState }> = [];
  try {
    const recoveryRaw = localStorage.getItem(STORAGE_RECOVERY_KEY);
    if (recoveryRaw) {
      const parsed = parsePersistedStateRaw(recoveryRaw);
      if (parsed.state) out.push({ key: "recovery", state: parsed.state });
    }
  } catch {}
  try {
    const historyRaw = localStorage.getItem(STORAGE_HISTORY_KEY);
    const history = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];
    if (Array.isArray(history)) {
      for (const item of history) {
        const parsed = parsePersistedStateRaw(String(item));
        if (parsed.state) out.push({ key: "history", state: parsed.state });
      }
    }
  } catch {}
  return out;
}

function getRules(profile: RulesProfile, customRules: RulesConfig): RulesConfig {
  if (profile === "FUN") return FUN_RULES;
  if (profile === "CUSTOM") return customRules;
  return STANDARD_RULES;
}

function sanitizeSoireeRulePolicies(raw: unknown): SoireeRulePolicy[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SOIREE_RULE_POLICIES];
  const parsed = raw
    .map((item: any, idx: number) => ({
      id: normName(item?.id) || `policy_${idx + 1}`,
      label: normName(item?.label) || `Policy ${idx + 1}`,
      enabled: Boolean(item?.enabled ?? true),
      trigger: {
        soireeNumber: clampInt(Number(item?.trigger?.soireeNumber ?? 0), 0, 99) || undefined,
        lastSoireeOfSeason: Boolean(item?.trigger?.lastSoireeOfSeason ?? false),
      },
      scoring: {
        matchWinMultiplier: Math.max(1, Number(item?.scoring?.matchWinMultiplier ?? 1)),
        checkoutBonusMultiplierWithMatchMultiplier: Boolean(
          item?.scoring?.checkoutBonusMultiplierWithMatchMultiplier ?? false
        ),
        checkoutBonusOverrides: {
          POULE: Number.isFinite(Number(item?.scoring?.checkoutBonusOverrides?.POULE))
            ? Number(item.scoring.checkoutBonusOverrides.POULE)
            : undefined,
          DEMI: Number.isFinite(Number(item?.scoring?.checkoutBonusOverrides?.DEMI))
            ? Number(item.scoring.checkoutBonusOverrides.DEMI)
            : undefined,
          PFINAL: Number.isFinite(Number(item?.scoring?.checkoutBonusOverrides?.PFINAL))
            ? Number(item.scoring.checkoutBonusOverrides.PFINAL)
            : undefined,
          FINAL: Number.isFinite(Number(item?.scoring?.checkoutBonusOverrides?.FINAL))
            ? Number(item.scoring.checkoutBonusOverrides.FINAL)
            : undefined,
        },
        rebuyPointsMultiplier: Math.max(0, Number(item?.scoring?.rebuyPointsMultiplier ?? 1)),
        podiumPointsOverride:
          item?.scoring?.podiumPointsOverride && typeof item.scoring.podiumPointsOverride === "object"
            ? {
                first: clampInt(Number(item.scoring.podiumPointsOverride.first ?? 0), 0, 20),
                second: clampInt(Number(item.scoring.podiumPointsOverride.second ?? 0), 0, 20),
                third: clampInt(Number(item.scoring.podiumPointsOverride.third ?? 0), 0, 20),
              }
            : undefined,
      },
      rebuy: {
        lockAfterKnockoutStart: Boolean(item?.rebuy?.lockAfterKnockoutStart ?? false),
        jackpotContributionMultiplier: Math.max(0, Number(item?.rebuy?.jackpotContributionMultiplier ?? 1)),
      },
    }))
    .filter((p: SoireeRulePolicy) => p.id && p.label)
    .slice(0, 20);
  return parsed.length ? parsed : [...DEFAULT_SOIREE_RULE_POLICIES];
}

function getMatchStatus(m: CoreMatch): MatchStatus {
  if (m.status === "PENDING" || m.status === "VALIDATED" || m.status === "CONTESTED") return m.status;
  return normName(m.winner) ? "VALIDATED" : "PENDING";
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

function runSeasonDiagnostics(season: Season): string[] {
  const issues: string[] = [];
  const players = new Set(season.players);
  if (season.players.length < 2) issues.push("Pas assez de joueurs enregistrés.");
  for (const so of season.soirees) {
    const participants = uniq([...so.pools.A, ...so.pools.B]).filter(isNonEmptyString);
    if (participants.length === 0) issues.push(`Soirée ${so.number}: aucune poule définie.`);
    for (const m of so.matches) {
      if (m.a && !players.has(m.a)) issues.push(`Soirée ${so.number} Match #${m.order}: joueur A inconnu.`);
      if (m.b && !players.has(m.b)) issues.push(`Soirée ${so.number} Match #${m.order}: joueur B inconnu.`);
      if (m.winner && m.winner !== m.a && m.winner !== m.b) issues.push(`Soirée ${so.number} Match #${m.order}: vainqueur incohérent.`);
    }
  }
  return issues;
}

function buildRoundRobinMatches(players: string[], format: 301 | 501): CoreMatch[] {
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
    format,
    bo: "BO3",
    maxTurns: 10,
    a,
    b,
    winner: "",
    checkout100: false,
    checkoutBy: "",
  }));
}

function getTournamentFormatLabel(format: TournamentFormat) {
  if (format === "ROUND_ROBIN") return "Round Robin";
  if (format === "SWISS_LITE") return "Swiss Lite";
  if (format === "DOUBLE_ELIM_LITE") return "Double Elim Lite";
  return "Poules classiques";
}

function createPoolMatch(
  order: number,
  a: string,
  b: string,
  pool: "A" | "B" | null,
  format: 301 | 501
): CoreMatch {
  return {
    id: uid("m"),
    order,
    phase: "POULE",
    status: "PENDING",
    pool,
    format,
    bo: "BO3",
    maxTurns: 10,
    a,
    b,
    winner: "",
    checkout100: false,
    checkoutBy: "",
  };
}

function createFinalPhases(startOrder: number, poolFormat: 301 | 501, finalFormat: 301 | 501): CoreMatch[] {
  return [
    {
      id: uid("m"),
      order: startOrder,
      phase: "DEMI",
      status: "PENDING",
      pool: null,
      format: poolFormat,
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
      order: startOrder + 1,
      phase: "DEMI",
      status: "PENDING",
      pool: null,
      format: poolFormat,
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
      order: startOrder + 2,
      phase: "PFINAL",
      status: "PENDING",
      pool: null,
      format: poolFormat,
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
      order: startOrder + 3,
      phase: "FINAL",
      status: "PENDING",
      pool: null,
      format: finalFormat,
      bo: "BO3",
      maxTurns: 10,
      a: "",
      b: "",
      winner: "",
      checkout100: false,
      checkoutBy: "",
    },
  ];
}

function buildGreedyLimitedPairs(players: string[], targetMatchesPerPlayer: number) {
  const clean = players.map(normName).filter(isNonEmptyString);
  const allPairs: Array<[string, string]> = [];
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      allPairs.push([clean[i], clean[j]]);
    }
  }
  const shuffled = shuffle(allPairs);
  const counts = new Map<string, number>();
  clean.forEach((p) => counts.set(p, 0));
  const selected: Array<[string, string]> = [];

  for (const [a, b] of shuffled) {
    const ca = counts.get(a) ?? 0;
    const cb = counts.get(b) ?? 0;
    if (ca >= targetMatchesPerPlayer || cb >= targetMatchesPerPlayer) continue;
    selected.push([a, b]);
    counts.set(a, ca + 1);
    counts.set(b, cb + 1);
    const done = clean.every((p) => (counts.get(p) ?? 0) >= targetMatchesPerPlayer);
    if (done) break;
  }

  // Safety pass: if some players are still under target, add best possible remaining pairs.
  for (const p of clean) {
    while ((counts.get(p) ?? 0) < targetMatchesPerPlayer) {
      const candidate = shuffled.find(([a, b]) => {
        if (selected.some(([sa, sb]) => (sa === a && sb === b) || (sa === b && sb === a))) return false;
        if (a !== p && b !== p) return false;
        const other = a === p ? b : a;
        return (counts.get(other) ?? 0) < targetMatchesPerPlayer + 1;
      });
      if (!candidate) break;
      selected.push(candidate);
      counts.set(candidate[0], (counts.get(candidate[0]) ?? 0) + 1);
      counts.set(candidate[1], (counts.get(candidate[1]) ?? 0) + 1);
    }
  }

  return selected;
}

function poolMatchesFor4(players: string[], pool: "A" | "B"): CoreMatch[] {
  const valid = players.map(normName).filter(isNonEmptyString);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      pairs.push([valid[i], valid[j]]);
    }
  }

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

function isFairSoireeMode(soiree: Soiree) {
  return (soiree.absentPlayers?.length ?? 0) > 0;
}

function useGlobalTop4Qualification(soiree: Soiree) {
  return isFairSoireeMode(soiree) || soiree.tournamentFormat === "ROUND_ROBIN" || soiree.tournamentFormat === "SWISS_LITE" || soiree.tournamentFormat === "DOUBLE_ELIM_LITE";
}

function getMatchWinPointsForSoiree(match: CoreMatch, rules: RulesConfig, ctx: ResolvedRuleContext) {
  const base = match.phase === "PFINAL" ? rules.smallFinalPoints : rules.winPoints;
  return base * ctx.matchWinMultiplier;
}

function getCheckoutBonusForMatch(match: CoreMatch, rules: RulesConfig, ctx: ResolvedRuleContext) {
  if (!match.checkoutBy) return 0;
  const override = ctx.checkoutBonusOverrides[match.phase];
  if (typeof override === "number") return override;
  if (ctx.checkoutBonusMultiplierWithMatchMultiplier) return rules.checkoutBonusPoints * ctx.matchWinMultiplier;
  return rules.checkoutBonusPoints;
}

function computePoolRows(
  soiree: Soiree,
  pool: "A" | "B",
  season: Season,
  rules: RulesConfig,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const players = soiree.pools[pool];
  const relevant = soiree.matches.filter((m: CoreMatch) => m.phase === "POULE" && m.pool === pool);
  const { pts, wins, bonus } = computePointsFromMatches(relevant, [], soiree.number, season, rules, rulePolicies);
  const fairMode = useGlobalTop4Qualification(soiree);

  const playedMap = new Map<string, number>();
  for (const p of players) playedMap.set(p, 0);
  for (const m of relevant) {
    const done = Boolean(normName(m.winner));
    if (!done) continue;
    if (m.a) playedMap.set(m.a, (playedMap.get(m.a) ?? 0) + 1);
    if (m.b) playedMap.set(m.b, (playedMap.get(m.b) ?? 0) + 1);
  }

  const rows = players.map((p: string) => {
    const played = playedMap.get(p) ?? 0;
    const pPts = pts.get(p) ?? 0;
    return {
      name: p,
      pts: pPts,
      wins: wins.get(p) ?? 0,
      bonus: bonus.get(p) ?? 0,
      played,
      avg: played > 0 ? pPts / played : 0,
    };
  });

  rows.sort((a, b) => {
    if (fairMode && b.avg !== a.avg) return b.avg - a.avg;
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.bonus !== a.bonus) return b.bonus - a.bonus;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function computeSoireeRankingPoints(
  soiree: Soiree,
  season: Season,
  rules: RulesConfig,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const participants = uniq([...soiree.pools.A, ...soiree.pools.B]).filter(isNonEmptyString);
  if (!participants.length) return new Map<string, number>();
  const fairMode = isFairSoireeMode(soiree);

  const poolA = computePoolRows(soiree, "A", season, rules, rulePolicies);
  const poolB = computePoolRows(soiree, "B", season, rules, rulePolicies);

  const ov = soiree.qualifiersOverride ?? {};
  const A1 = normName(ov.A1 || poolA[0]?.name || "");
  const A2 = normName(ov.A2 || poolA[1]?.name || "");
  const B1 = normName(ov.B1 || poolB[0]?.name || "");
  const B2 = normName(ov.B2 || poolB[1]?.name || "");

  const final = soiree.matches.find((m: CoreMatch) => m.phase === "FINAL");
  const pfinal = soiree.matches.find((m: CoreMatch) => m.phase === "PFINAL");
  const first = normName(final?.winner ?? "");
  const second = first && first === normName(final?.a ?? "") ? normName(final?.b ?? "") : first && first === normName(final?.b ?? "") ? normName(final?.a ?? "") : "";
  const third = normName(pfinal?.winner ?? "");
  const fourth = third && third === normName(pfinal?.a ?? "") ? normName(pfinal?.b ?? "") : third && third === normName(pfinal?.b ?? "") ? normName(pfinal?.a ?? "") : "";

  const fallback = fairMode
    ? [...poolA, ...poolB]
        .slice()
        .sort((a, b) => b.avg - a.avg || b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name))
        .map((x) => x.name)
    : (() => {
        const fallbackStats = computePointsFromMatches(
          soiree.matches,
          [],
          soiree.number,
          season,
          rules,
          rulePolicies
        );
        return participants
          .map((p: string) => ({
            name: p,
            pts: fallbackStats.pts.get(p) ?? 0,
            wins: fallbackStats.wins.get(p) ?? 0,
            bonus: fallbackStats.bonus.get(p) ?? 0,
          }))
          .sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name))
          .map((x) => x.name);
      })();

  const top4Global = [...poolA, ...poolB]
    .slice()
    .sort((a, b) => b.avg - a.avg || b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map((x) => x.name);

  const manualTop = fairMode
    ? [first, second, third, fourth, ...top4Global].filter(isNonEmptyString)
    : [first, second, third, fourth, A1, B1, A2, B2].filter(isNonEmptyString);
  const ordered = uniq([...manualTop, ...fallback, ...participants]).filter((p) => participants.includes(p));

  const map = new Map<string, number>();
  const n = ordered.length;
  ordered.forEach((name, idx) => map.set(name, Math.max(1, n - idx)));
  return map;
}

function computePointsFromMatches(
  matches: CoreMatch[],
  rebuyMatches: RebuyMatch[],
  seasonSoireeNumber?: number,
  season?: Season,
  rules: RulesConfig = STANDARD_RULES,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  return computePointsFromMatchesWithPolicies(
    matches,
    rebuyMatches,
    seasonSoireeNumber,
    season,
    rules,
    rulePolicies
  );
}

function aggregateSeasonStats(
  season: Season,
  rules: RulesConfig = STANDARD_RULES,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const pts = new Map<string, number>();
  const wins = new Map<string, number>();
  const bonus = new Map<string, number>();

  const add = (map: Map<string, number>, key: string, delta: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  for (const s of season.soirees) {
    const { pts: p, wins: w, bonus: b } = computePointsFromMatches(
      s.matches,
      s.rebuys,
      s.number,
      season,
      rules,
      rulePolicies
    );
    if (isFairSoireeMode(s)) {
      const soireePoints = computeSoireeRankingPoints(s, season, rules, rulePolicies);
      for (const [k, v] of soireePoints.entries()) add(pts, k, v);
    } else {
      for (const [k, v] of p.entries()) add(pts, k, v);
    }
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

function computeJackpotEUR(
  season: Season,
  rules: RulesConfig = STANDARD_RULES,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  return computeJackpotEURWithPolicies(season, rules, rulePolicies);
}

function computeSoireeJackpotEUR(
  soiree: Soiree,
  season: Season,
  rules: RulesConfig = STANDARD_RULES,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const ctx = resolveSoireeRuleContext(soiree, season, rulePolicies);
  return (
    (soiree.pools.A.length + soiree.pools.B.length) * rules.jackpotPerPlayerEUR +
    soiree.rebuys.length * rules.rebuyEUR * ctx.rebuyJackpotContributionMultiplier
  );
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

function computeAdvancedStats(season: Season) {
  const players = season.players;
  const matches = season.soirees.flatMap((s) => s.matches);

  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  const played = new Map<string, number>();
  const finals = new Map<string, { finals: number; wins: number }>();
  const semis = new Map<string, number>();

  players.forEach((p) => {
    wins.set(p, 0);
    losses.set(p, 0);
    played.set(p, 0);
    finals.set(p, { finals: 0, wins: 0 });
    semis.set(p, 0);
  });

  for (const m of matches) {
    const a = normName(m.a);
    const b = normName(m.b);
    const w = normName(m.winner);
    if (!a || !b) continue;
    if (!players.includes(a) || !players.includes(b)) continue;

    played.set(a, (played.get(a) ?? 0) + 1);
    played.set(b, (played.get(b) ?? 0) + 1);

    if (w === a || w === b) {
      const loser = w === a ? b : a;
      wins.set(w, (wins.get(w) ?? 0) + 1);
      losses.set(loser, (losses.get(loser) ?? 0) + 1);
    }

    if (m.phase === "DEMI") {
      semis.set(a, (semis.get(a) ?? 0) + 1);
      semis.set(b, (semis.get(b) ?? 0) + 1);
    }

    if (m.phase === "FINAL") {
      const fa = finals.get(a) ?? { finals: 0, wins: 0 };
      const fb = finals.get(b) ?? { finals: 0, wins: 0 };
      finals.set(a, { finals: fa.finals + 1, wins: fa.wins + (w === a ? 1 : 0) });
      finals.set(b, { finals: fb.finals + 1, wins: fb.wins + (w === b ? 1 : 0) });
    }
  }

  const winRates = players.map((p) => {
    const w = wins.get(p) ?? 0;
    const l = losses.get(p) ?? 0;
    const pl = played.get(p) ?? 0;
    const rate = pl > 0 ? Math.round((w / pl) * 1000) / 10 : 0;
    return { player: p, wins: w, losses: l, played: pl, rate };
  });

  const clutch = players.map((p) => {
    const f = finals.get(p) ?? { finals: 0, wins: 0 };
    const rate = f.finals > 0 ? Math.round((f.wins / f.finals) * 1000) / 10 : 0;
    return { player: p, finals: f.finals, wins: f.wins, rate };
  });

  const semiRuns = players.map((p) => ({ player: p, semis: semis.get(p) ?? 0 }));

  return { winRates, clutch, semiRuns };
}

function computeSoireeRankingRows(
  soiree: Soiree,
  season: Season,
  rules: RulesConfig,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const participants = uniq([...soiree.pools.A, ...soiree.pools.B].map(normName)).filter(isNonEmptyString);
  const { pts, wins, bonus } = computePointsFromMatches(
    soiree.matches,
    soiree.rebuys,
    soiree.number,
    season,
    rules,
    rulePolicies
  );
  const rows = participants.map((p: string) => ({
    name: p,
    pts: pts.get(p) ?? 0,
    wins: wins.get(p) ?? 0,
    bonus: bonus.get(p) ?? 0,
  }));
  rows.sort((a: { name: string; pts: number; wins: number; bonus: number }, b: { name: string; pts: number; wins: number; bonus: number }) =>
    b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name)
  );
  return rows;
}

function computeSoireePodium(
  soiree: Soiree,
  season: Season,
  rules: RulesConfig,
  rulePolicies: SoireeRulePolicy[] = DEFAULT_SOIREE_RULE_POLICIES
) {
  const final = soiree.matches.find((m: CoreMatch) => m.phase === "FINAL");
  const pfinal = soiree.matches.find((m: CoreMatch) => m.phase === "PFINAL");
  const wFinal = normName(final?.winner ?? "");
  const aFinal = normName(final?.a ?? "");
  const bFinal = normName(final?.b ?? "");
  const second =
    wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
  const third = normName(pfinal?.winner ?? "");
  if (wFinal && second && third) return { first: wFinal, second, third, provisional: false as const };

  const rows = computeSoireeRankingRows(soiree, season, rules, rulePolicies);
  return {
    first: rows[0]?.name ?? "",
    second: rows[1]?.name ?? "",
    third: rows[2]?.name ?? "",
    provisional: true as const,
  };
}

function makeEmptySoiree(number = 1): Soiree {
  return {
    id: uid("s"),
    number,
    tournamentFormat: "CLASSIC_POOLS",
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

function makeEmptyFunMode(): FunModeState {
  return {
    players: [],
    format: 301,
    moneyEnabled: false,
    moneyPerPlayer: 0,
    matches: [],
    finals: [],
    positionRounds: [],
  };
}

function makeInitialState(): AppState {
  const season = makeEmptySeason("Saison 1");
  return {
    version: VERSION,
    seasons: [season],
    activeSeasonId: season.id,
    funMode: makeEmptyFunMode(),
    system: {
      rulesProfile: "STANDARD",
      customRules: { ...STANDARD_RULES },
      soireeRulePolicies: [...DEFAULT_SOIREE_RULE_POLICIES],
      audit: [],
    },
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
            status:
              m?.status === "PENDING" || m?.status === "VALIDATED" || m?.status === "CONTESTED"
                ? m.status
                : winner
                  ? "VALIDATED"
                  : "PENDING",
            pool: m?.pool === "A" || m?.pool === "B" ? m.pool : null,
            format: Number(m?.format) === 501 ? 501 : 301,
            bo: (["BO1", "BO3", "BO5", "SEC"].includes(m?.bo) ? m.bo : "BO3") as any,
            maxTurns: clampInt(Number(m?.maxTurns ?? 10), 1, 50),
            a,
            b,
            winner,
            checkout100: Boolean(inferredCheckoutBy),
            checkoutBy: inferredCheckoutBy,
            startedAt: Number.isFinite(Number(m?.startedAt)) ? Number(m.startedAt) : undefined,
            endedAt: Number.isFinite(Number(m?.endedAt)) ? Number(m.endedAt) : undefined,
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

        const paymentsRaw = s?.payments && typeof s.payments === "object" ? s.payments : {};
        const payments: Record<string, boolean> = {};
        for (const p of poolsA.concat(poolsB)) {
          payments[p] = Boolean(paymentsRaw[p]);
        }
        const attendanceRaw = s?.attendance && typeof s.attendance === "object" ? s.attendance : {};
        const arrivalEtaRaw = s?.arrivalEta && typeof s.arrivalEta === "object" ? s.arrivalEta : {};
        const absentsSet = new Set(
          (Array.isArray(s?.absentPlayers) ? s.absentPlayers : []).map(normName).filter(isNonEmptyString)
        );
        const attendance: Record<string, PresenceStatus> = {};
        const arrivalEta: Record<string, string> = {};
        for (const p of poolsA.concat(poolsB)) {
          const rawStatus = attendanceRaw[p];
          if (rawStatus === "LATE" || rawStatus === "ABSENT" || rawStatus === "HERE") {
            attendance[p] = rawStatus;
          } else {
            attendance[p] = absentsSet.has(p) ? "ABSENT" : "HERE";
          }
          const eta = normName(arrivalEtaRaw[p]);
          if (attendance[p] === "LATE" && eta) arrivalEta[p] = eta;
        }
        const absentPlayers = Object.keys(attendance).filter((p) => attendance[p] === "ABSENT");

        return {
          id: normName(s?.id) || uid("s"),
          number: clampInt(Number(s?.number ?? idx + 1), 1, 999),
          tournamentFormat:
            s?.tournamentFormat === "ROUND_ROBIN" ||
            s?.tournamentFormat === "SWISS_LITE" ||
            s?.tournamentFormat === "DOUBLE_ELIM_LITE"
              ? s.tournamentFormat
              : "CLASSIC_POOLS",
          dateLabel: normName(s?.dateLabel) || undefined,
          createdAt: Number(s?.createdAt ?? Date.now()),
          startedAt: Number.isFinite(Number(s?.startedAt)) ? Number(s.startedAt) : undefined,
          endedAt: Number.isFinite(Number(s?.endedAt)) ? Number(s.endedAt) : undefined,
          closedAt: Number.isFinite(Number(s?.closedAt)) ? Number(s.closedAt) : undefined,
          locked: Boolean(s?.locked),
          pools: { A: poolsA, B: poolsB },
          matches: matches.sort((a: CoreMatch, b: CoreMatch) => a.order - b.order),
          rebuys: rebuys.sort((a: RebuyMatch, b: RebuyMatch) => a.createdAt - b.createdAt),
          absentPlayers,
          attendance,
          arrivalEta,
          payments,
          financeNotes: normName(s?.financeNotes) || "",
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

    const rawFunPlayers = uniq((raw.funMode?.players ?? []).map(normName)).filter(isNonEmptyString).slice(0, 8);
    const rawFunMatches = Array.isArray(raw.funMode?.matches) ? raw.funMode.matches : [];
    const rawFunFinals = Array.isArray(raw.funMode?.finals) ? raw.funMode.finals : [];
    const rawPositionRounds = Array.isArray(raw.funMode?.positionRounds) ? raw.funMode.positionRounds : [];
    const sanitizeFunMatch = (m: any, idx: number): CoreMatch => ({
      id: normName(m?.id) || uid("funm"),
      order: clampInt(Number(m?.order ?? idx + 1), 1, 9999),
      phase: (["POULE", "DEMI", "PFINAL", "FINAL"].includes(m?.phase) ? m.phase : "POULE") as Phase,
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
      checkoutBy: m?.checkoutBy === "A" || m?.checkoutBy === "B" ? m.checkoutBy : "",
      startedAt: Number.isFinite(Number(m?.startedAt)) ? Number(m.startedAt) : undefined,
      endedAt: Number.isFinite(Number(m?.endedAt)) ? Number(m.endedAt) : undefined,
    });
    const funMatches: CoreMatch[] = rawFunMatches.map(sanitizeFunMatch);
    const funFinals: CoreMatch[] = rawFunFinals.map(sanitizeFunMatch);
    const funPositionRounds: Array<{ id: string; positions: string[] }> = rawPositionRounds.map((r: any, idx: number) => ({
      id: normName(r?.id) || uid(`fpr_${idx + 1}`),
      positions: Array.isArray(r?.positions) ? r.positions.map(normName).filter(isNonEmptyString) : [],
    }));

    const profileRaw = normName(raw.system?.rulesProfile);
    const rulesProfile: RulesProfile =
      profileRaw === "STANDARD" || profileRaw === "FUN" || profileRaw === "CUSTOM" ? profileRaw : "STANDARD";
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
          .slice(0, 300)
      : [];
    const soireeRulePolicies = sanitizeSoireeRulePolicies(raw.system?.soireeRulePolicies);

    return {
      version: v || VERSION,
      seasons,
      activeSeasonId,
      funMode: {
        players: rawFunPlayers,
        format: Number(raw.funMode?.format) === 501 ? 501 : 301,
        moneyEnabled: Boolean(raw.funMode?.moneyEnabled),
        moneyPerPlayer: Math.max(0, Number(raw.funMode?.moneyPerPlayer ?? 0)),
        matches: funMatches
          .filter((m) => m.phase === "POULE" && m.a && m.b && rawFunPlayers.includes(m.a) && rawFunPlayers.includes(m.b))
          .sort((a, b) => a.order - b.order),
        finals: funFinals
          .filter((m) => m.phase !== "POULE")
          .sort((a, b) => a.order - b.order),
        positionRounds: funPositionRounds,
      },
      system: {
        rulesProfile,
        customRules,
        soireeRulePolicies,
        audit,
      },
    };
  } catch {
    return fallback;
  }
}

function loadState(): AppState {
  BOOT_RECOVERY_NOTICE = "";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parsePersistedStateRaw(raw);
      if (parsed.state) return parsed.state;

      const recovery = readRecoveryCandidates()[0];
      if (recovery?.state) {
        BOOT_RECOVERY_NOTICE =
          "Intégrité locale détectée comme invalide. Une sauvegarde de récupération a été restaurée automatiquement.";
        return recovery.state;
      }
      BOOT_RECOVERY_NOTICE =
        "Intégrité locale invalide et aucune récupération trouvée. État initial chargé.";
    }
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
  const envelopeRaw = encodePersistEnvelope(state);
  try {
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous && previous !== envelopeRaw) {
      localStorage.setItem(STORAGE_RECOVERY_KEY, previous);
      const historyRaw = localStorage.getItem(STORAGE_HISTORY_KEY);
      const history = historyRaw ? (JSON.parse(historyRaw) as string[]) : [];
      const nextHistory = [previous, ...(Array.isArray(history) ? history : [])].slice(0, MAX_STORAGE_HISTORY);
      localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(nextHistory));
    }
    localStorage.setItem(STORAGE_KEY, envelopeRaw);
  } catch {}
  try {
    window.name = "DLSTATE:" + JSON.stringify(state);
  } catch {}
}

function parseSharedPayload(raw: any): SharedPayload {
  const wrapped = raw && typeof raw === "object" && raw.state && typeof raw.state === "object";
  const statePayload = wrapped ? raw.state : raw;
  const parsedState = sanitizeState(statePayload);
  const rulesPdfData = wrapped && typeof raw.rulesPdfData === "string" ? raw.rulesPdfData : undefined;
  const rulesPdfName = wrapped && typeof raw.rulesPdfName === "string" ? raw.rulesPdfName : undefined;
  return { state: parsedState, rulesPdfData, rulesPdfName };
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

function AnimatedMetric({
  value,
  kind = "int",
  durationMs = 650,
  className,
}: {
  value: number;
  kind?: "int" | "eur";
  durationMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState<number>(Number.isFinite(value) ? value : 0);
  const previousRef = useRef<number>(Number.isFinite(value) ? value : 0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const to = Number.isFinite(value) ? value : 0;
    const from = Number.isFinite(previousRef.current) ? previousRef.current : 0;
    if (Math.abs(to - from) < 0.0001) {
      setDisplay(to);
      previousRef.current = to;
      return;
    }
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || durationMs <= 0) {
      setDisplay(to);
      previousRef.current = to;
      return;
    }

    const start = performance.now();
    const delta = to - from;
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + delta * eased;
      setDisplay(next);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        previousRef.current = to;
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [value, durationMs]);

  const rendered =
    kind === "eur"
      ? formatEUR(display)
      : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(display));

  return <span className={`tabular-nums ${className ?? ""}`}>{rendered}</span>;
}

function formatDuration(ms: number) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getMatchDurationMs(match: CoreMatch, now: number) {
  if (!match.startedAt) return 0;
  const end = match.endedAt ?? now;
  return Math.max(0, end - match.startedAt);
}

function getSoireeDurationMs(soiree: Soiree, now: number) {
  const startedAt =
    soiree.startedAt ??
    soiree.matches
      .map((m: CoreMatch) => m.startedAt)
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      .sort((a: number, b: number) => a - b)[0];
  if (!startedAt) return 0;
  const end = soiree.endedAt ?? now;
  return Math.max(0, end - startedAt);
}

function parseEtaTodayMs(hhmm: string, nowMs: number) {
  const v = normName(hhmm);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return null;
  const now = new Date(nowMs);
  const eta = new Date(nowMs);
  eta.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (eta.getTime() < now.getTime() - 5 * 60 * 1000) return nowMs;
  return eta.getTime();
}

function formatTimeHM(ms: number) {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
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
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur">
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
  title,
  className,
  size = "default",
}: {
  children: React.ReactNode;
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  className?: string;
  size?: "default" | "touch";
}) {
  const base =
    "rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-[0.99] min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/90 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f17]";
  const styles =
    variant === "primary"
      ? "bg-white text-black hover:bg-white/90"
      : variant === "danger"
        ? "bg-red-500 text-white hover:bg-red-400"
        : "bg-white/10 text-white hover:bg-white/15";
  const sizeStyles = size === "touch" ? "min-h-12 px-4 py-3 text-base" : "";
  return (
    <button
      title={title}
      onClick={(e) => onClick?.(e)}
      disabled={disabled}
      className={`${base} ${styles} ${sizeStyles} ${disabled ? "opacity-50" : ""} ${className ?? ""}`}
    >
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
  const rulesPdfFileRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<AppState>(() => loadState());
  const [clockNow, setClockNow] = useState<number>(() => Date.now());
  const [tab, setTab] = useState<AppTab>("SOIREE");
  const [tvMode, setTvMode] = useState(false);
  const [, setTvIndex] = useState(0);
  const [tvRotationTabs, setTvRotationTabs] = useState<TvTab[]>(() => {
    try {
      const raw = localStorage.getItem(TV_ROTATION_TABS_KEY);
      if (!raw) return [...DEFAULT_TV_ROTATION_TABS];
      const parsed = JSON.parse(raw) as string[];
      const safe = Array.isArray(parsed)
        ? parsed.filter((x): x is TvTab => x === "SOIREE" || x === "CLASSEMENT" || x === "H2H")
        : [];
      return safe.length ? safe : [...DEFAULT_TV_ROTATION_TABS];
    } catch {
      return [...DEFAULT_TV_ROTATION_TABS];
    }
  });
  const [tvAutoRotateEnabled, setTvAutoRotateEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(TV_ROTATION_AUTO_KEY);
      return raw !== "0";
    } catch {
      return true;
    }
  });
  const [tvRotateEveryMs, setTvRotateEveryMs] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(TV_ROTATION_SPEED_KEY) ?? 12000);
      return [8000, 12000, 20000].includes(raw) ? raw : 12000;
    } catch {
      return 12000;
    }
  });
  const [tvBroadcastOverlayKind, setTvBroadcastOverlayKind] = useState<BroadcastOverlayKind>("");
  const [tvBroadcastAnnouncement, setTvBroadcastAnnouncement] = useState("Annonce officielle");
  const [tvSceneOverride, setTvSceneOverride] = useState<"" | TvScene>("");
  const [tvDisplayMode, setTvDisplayMode] = useState<TvDisplayMode>(() => {
    try {
      const raw = localStorage.getItem(TV_DISPLAY_MODE_KEY);
      return raw === "BIGSCREEN" ? "BIGSCREEN" : "STANDARD";
    } catch {
      return "STANDARD";
    }
  });
  const [tvInfoDensity, setTvInfoDensity] = useState<TvInfoDensity>(() => {
    try {
      const raw = localStorage.getItem(TV_INFO_DENSITY_KEY);
      return raw === "FULL" ? "FULL" : "FOCUS";
    } catch {
      return "FOCUS";
    }
  });
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TV_SOUND_ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [soundVolume, setSoundVolume] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(TV_SOUND_VOLUME_KEY) ?? 65);
      return Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 65));
    } catch {
      return 65;
    }
  });
  const [soundProfile, setSoundProfile] = useState<SfxProfile>(() => {
    try {
      const raw = localStorage.getItem(TV_SOUND_PROFILE_KEY);
      return raw === "SOFT" || raw === "ARENA" || raw === "FINAL" ? raw : "ARENA";
    } catch {
      return "ARENA";
    }
  });
  const [operatorFullscreen, setOperatorFullscreen] = useState(false);
  const [timelinePlay, setTimelinePlay] = useState(false);
  const [timelineStep, setTimelineStep] = useState(0);
  const [timelineSpeedMs, setTimelineSpeedMs] = useState(1200);
  const [performanceSort, setPerformanceSort] = useState<PerformanceSort>("POWER");
  const [dataIntegrityNotice, setDataIntegrityNotice] = useState<string>(() => BOOT_RECOVERY_NOTICE);
  const [quickRecoveryStatus, setQuickRecoveryStatus] = useState("");
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
  const [logoLoadError, setLogoLoadError] = useState(false);
  const [rulesPdfData, setRulesPdfData] = useState<string>(() => {
    try {
      return localStorage.getItem(RULES_PDF_DATA_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [rulesPdfName, setRulesPdfName] = useState<string>(() => {
    try {
      return localStorage.getItem(RULES_PDF_NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);
  const [absentPlayersSelection, setAbsentPlayersSelection] = useState<string[]>([]);
  const [newSoireeFormat, setNewSoireeFormat] = useState<TournamentFormat>("CLASSIC_POOLS");
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>(() => loadSnapshots());
  const [readOnlyLink, setReadOnlyLink] = useState("");
  const [syncCode, setSyncCode] = useState<string>(() => {
    try {
      return localStorage.getItem(SYNC_CODE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [syncEnabled, setSyncEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SYNC_ENABLED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [readOnlyMode, setReadOnlyMode] = useState(false);
  const [readOnlyRoomCode, setReadOnlyRoomCode] = useState("");
  const [showSoireeClosureModal, setShowSoireeClosureModal] = useState(false);
  const [closureSoireeId, setClosureSoireeId] = useState("");
  const [closureAutoExportStatus, setClosureAutoExportStatus] = useState("");
  const [showFinalNightBurst, setShowFinalNightBurst] = useState(false);
  const [flowAutoAdvance, setFlowAutoAdvance] = useState(true);
  const [flowMatchId, setFlowMatchId] = useState("");
  const [queuedAutoAdvanceFromMatchId, setQueuedAutoAdvanceFromMatchId] = useState("");
  const [newPlayerName, setNewPlayerName] = useState("");
  const [bulkPlayersText, setBulkPlayersText] = useState("");
  const [editingPlayer, setEditingPlayer] = useState<string | null>(null);
  const [editingPlayerName, setEditingPlayerName] = useState("");
  const [newSeasonName, setNewSeasonName] = useState("");
  const [copyPlayersForNewSeason, setCopyPlayersForNewSeason] = useState(true);
  const [funPlayerInput, setFunPlayerInput] = useState("");
  const [funLiveEnabled, setFunLiveEnabled] = useState(false);
  const [funLiveIndex, setFunLiveIndex] = useState(0);
  const [tvOverlayIndex, setTvOverlayIndex] = useState(0);
  const [tvSceneFlash, setTvSceneFlash] = useState<TvScene | "">("");
  const [cinematicMoment, setCinematicMoment] = useState<CinematicMoment | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [showFinalNightIntro, setShowFinalNightIntro] = useState(false);
  const [winnerFxMatchId, setWinnerFxMatchId] = useState("");
  const currentSeasons: Season[] = state.seasons;
  const [selectedSoireeNumber, setSelectedSoireeNumber] = useState<number>(() => {
    const max = Math.max(...currentSeasons[0].soirees.map((s: Soiree) => s.number));
    return max;
  });

  const savingRef = useRef<number | null>(null);
  const undoStackRef = useRef<AppState[]>([]);
  const redoStackRef = useRef<AppState[]>([]);
  const historyNavRef = useRef(false);
  const lastSerializedRef = useRef(JSON.stringify(state));
  const lastAutoSnapshotAtRef = useRef(0);
  const skipNextCloudPushRef = useRef(false);
  const closureAutoExportDoneRef = useRef<string>("");
  const finalNightBurstKeyRef = useRef("");
  const smartConfirmMemoryRef = useRef<Record<string, number>>({});
  const previousTvSceneRef = useRef<TvScene | null>(null);
  const winnerFxTimerRef = useRef<number | null>(null);
  const cinematicTimerRef = useRef<number | null>(null);
  const finalNightIntroKeyRef = useRef("");
  const audioCtxRef = useRef<AudioContext | null>(null);

  const currentSeason = useMemo<Season>(() => {
    return currentSeasons.find((s: Season) => s.id === state.activeSeasonId) ?? currentSeasons[0];
  }, [currentSeasons, state.activeSeasonId]);

  useEffect(() => {
    const t = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    return () => {
      if (winnerFxTimerRef.current) window.clearTimeout(winnerFxTimerRef.current);
      if (cinematicTimerRef.current) window.clearTimeout(cinematicTimerRef.current);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TV_SOUND_ENABLED_KEY, soundEnabled ? "1" : "0");
      localStorage.setItem(TV_SOUND_VOLUME_KEY, String(soundVolume));
      localStorage.setItem(TV_SOUND_PROFILE_KEY, soundProfile);
    } catch {}
  }, [soundEnabled, soundVolume, soundProfile]);

  useEffect(() => {
    try {
      localStorage.setItem(TV_DISPLAY_MODE_KEY, tvDisplayMode);
      localStorage.setItem(TV_INFO_DENSITY_KEY, tvInfoDensity);
    } catch {}
  }, [tvDisplayMode, tvInfoDensity]);

  useEffect(() => {
    if (readOnlyMode) return;
    if (savingRef.current) window.clearTimeout(savingRef.current);
    savingRef.current = window.setTimeout(() => {
      saveState(state);
    }, 120);
    return () => {
      if (savingRef.current) window.clearTimeout(savingRef.current);
    };
  }, [state, readOnlyMode]);

  useEffect(() => {
    const serialized = JSON.stringify(state);
    if (readOnlyMode) {
      lastSerializedRef.current = serialized;
      return;
    }
    if (historyNavRef.current) {
      historyNavRef.current = false;
      lastSerializedRef.current = serialized;
      return;
    }
    if (serialized !== lastSerializedRef.current) {
      undoStackRef.current.push(sanitizeState(JSON.parse(lastSerializedRef.current)));
      if (undoStackRef.current.length > 80) undoStackRef.current = undoStackRef.current.slice(-80);
      redoStackRef.current = [];
      lastSerializedRef.current = serialized;
    }

    const now = Date.now();
    if (now - lastAutoSnapshotAtRef.current > 1000 * 60 * 5) {
      const snap: SnapshotEntry = {
        id: uid("snap"),
        ts: now,
        label: `Auto ${new Date(now).toLocaleString("fr-FR")}`,
        state: sanitizeState(JSON.parse(serialized)),
      };
      const next = [snap, ...snapshots].slice(0, MAX_SNAPSHOTS);
      setSnapshots(next);
      saveSnapshots(next);
      lastAutoSnapshotAtRef.current = now;
    }
  }, [state, snapshots, readOnlyMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    if (hash.startsWith("#public=")) {
      const code = normName(decodeURIComponent(hash.slice("#public=".length))).toUpperCase();
      if (!code) return;
      setReadOnlyMode(true);
      setReadOnlyRoomCode(code);
      setTab("CLASSEMENT");
      return;
    }
    if (!hash.startsWith("#readonly=")) return;
    try {
      const payload = hash.slice("#readonly=".length);
      const decoded = decodeURIComponent(escape(window.atob(payload)));
      const parsed = JSON.parse(decoded);
      const shared = parseSharedPayload(parsed);
      setState(shared.state);
      if (typeof shared.rulesPdfData === "string") setRulesPdfData(shared.rulesPdfData);
      if (typeof shared.rulesPdfName === "string") setRulesPdfName(shared.rulesPdfName);
      setTab("CLASSEMENT");
      setReadOnlyMode(true);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("dl_compact_mode", compactMode ? "1" : "0");
    } catch {}
  }, [compactMode]);

  useEffect(() => {
    try {
      localStorage.setItem(TV_ROTATION_TABS_KEY, JSON.stringify(tvRotationTabs));
      localStorage.setItem(TV_ROTATION_AUTO_KEY, tvAutoRotateEnabled ? "1" : "0");
      localStorage.setItem(TV_ROTATION_SPEED_KEY, String(tvRotateEveryMs));
    } catch {}
  }, [tvRotationTabs, tvAutoRotateEnabled, tvRotateEveryMs]);

  useEffect(() => {
    try {
      localStorage.setItem(SYNC_CODE_KEY, syncCode);
      localStorage.setItem(SYNC_ENABLED_KEY, syncEnabled ? "1" : "0");
    } catch {}
  }, [syncCode, syncEnabled]);

  useEffect(() => {
    if (readOnlyMode) return;
    try {
      localStorage.setItem(RULES_PDF_DATA_KEY, rulesPdfData);
      localStorage.setItem(RULES_PDF_NAME_KEY, rulesPdfName);
    } catch {}
  }, [rulesPdfData, rulesPdfName, readOnlyMode]);

  useEffect(() => {
    if (!currentSeasons.find((s: Season) => s.id === state.activeSeasonId)) {
      setState((prev) => ({ ...prev, activeSeasonId: prev.seasons[0]?.id ?? prev.activeSeasonId }));
    }
  }, [state.activeSeasonId, currentSeasons]);

  useEffect(() => {
    if (!readOnlyMode) return;
    const allowed: AppTab[] = ["CLASSEMENT", "HISTO", "H2H", "REGLES"];
    if (!allowed.includes(tab)) setTab("CLASSEMENT");
  }, [readOnlyMode, tab]);

  useEffect(() => {
    if (readOnlyMode) return;
    if (!syncEnabled || !normName(syncCode)) return;
    pullCloudState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncEnabled, syncCode, readOnlyMode]);

  useEffect(() => {
    if (!readOnlyMode || !normName(readOnlyRoomCode)) return;
    pullCloudState({ codeOverride: readOnlyRoomCode, silent: true });
    const t = window.setInterval(() => {
      pullCloudState({ codeOverride: readOnlyRoomCode, silent: true });
    }, 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnlyMode, readOnlyRoomCode]);

  useEffect(() => {
    if (!syncEnabled || !normName(syncCode) || readOnlyMode) return;
    if (skipNextCloudPushRef.current) {
      skipNextCloudPushRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      pushCloudState();
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, syncEnabled, syncCode, readOnlyMode]);

  useEffect(() => {
    const exists = currentSeason.soirees.some((s: Soiree) => s.number === selectedSoireeNumber);
    if (!exists) {
      const max = Math.max(...currentSeason.soirees.map((s: Soiree) => s.number));
      setSelectedSoireeNumber(max);
    }
  }, [currentSeason.soirees, selectedSoireeNumber]);

  const effectiveRules = useMemo(
    () => getRules(state.system.rulesProfile, state.system.customRules),
    [state.system.rulesProfile, state.system.customRules]
  );
  const activeSoireeRulePolicies = useMemo(
    () => sanitizeSoireeRulePolicies(state.system.soireeRulePolicies),
    [state.system.soireeRulePolicies]
  );
  const seasonStats = useMemo(
    () => aggregateSeasonStats(currentSeason, effectiveRules, activeSoireeRulePolicies),
    [currentSeason, effectiveRules, activeSoireeRulePolicies]
  );
  const jackpotEUR = useMemo(
    () => computeJackpotEUR(currentSeason, effectiveRules, activeSoireeRulePolicies),
    [currentSeason, effectiveRules, activeSoireeRulePolicies]
  );
  const streaks = useMemo(() => computeWinStreaks(currentSeason), [currentSeason]);
  const h2h = useMemo(() => computeHeadToHead(currentSeason), [currentSeason]);
  const advancedStats = useMemo(() => computeAdvancedStats(currentSeason), [currentSeason]);
  const diagnostics = useMemo(() => runSeasonDiagnostics(currentSeason), [currentSeason]);

  const playerColors = useMemo(() => {
    const map = new Map<string, string>();
    currentSeason.players.forEach((p: string, i: number) => map.set(p, PALETTE[i % PALETTE.length]));
    return map;
  }, [currentSeason.players]);

  const getPlayerColor = (name: string) => {
    const norm = normName(name);
    if (!norm) return "#ffffff33";
    return playerColors.get(norm) ?? PALETTE[hashString(norm) % PALETTE.length];
  };

  const currentSoiree = useMemo(() => {
    return currentSeason.soirees.find((s: Soiree) => s.number === selectedSoireeNumber) ?? currentSeason.soirees[0];
  }, [currentSeason.soirees, selectedSoireeNumber]);
  const closureContext = useMemo(() => {
    if (!closureSoireeId) return null;
    for (const season of state.seasons) {
      const found = season.soirees.find((s: Soiree) => s.id === closureSoireeId);
      if (found) return { season, soiree: found };
    }
    return null;
  }, [state.seasons, closureSoireeId]);
  const closureSoiree = closureContext?.soiree ?? null;
  const closureSeason = closureContext?.season ?? currentSeason;
  const currentSoireeLocked = Boolean(currentSoiree?.locked);
  const fairSoireeMode = useMemo(() => isFairSoireeMode(currentSoiree), [currentSoiree]);
  const globalTop4Mode = useMemo(() => useGlobalTop4Qualification(currentSoiree), [currentSoiree]);
  const currentSoireeRuleContext = useMemo(
    () => resolveSoireeRuleContext(currentSoiree, currentSeason, activeSoireeRulePolicies),
    [currentSoiree, currentSeason, activeSoireeRulePolicies]
  );
  const activeSoireeRulePolicy = useMemo(
    () => getActiveSoireeRulePolicy(currentSoiree, currentSeason, activeSoireeRulePolicies),
    [currentSoiree, currentSeason, activeSoireeRulePolicies]
  );
  const finalNightMode = Boolean(activeSoireeRulePolicy);
  const activePolicySoireeNumber = activeSoireeRulePolicy?.trigger.soireeNumber ?? currentSoiree.number;
  const activePolicyPodiumPoints = currentSoireeRuleContext.podiumPointsOverride;
  const rebuyLockedByPhase = useMemo(
    () => currentSoireeRuleContext.rebuyLockAfterKnockoutStart && hasKnockoutStarted(currentSoiree),
    [currentSoireeRuleContext.rebuyLockAfterKnockoutStart, currentSoiree]
  );

  useEffect(() => {
    if (readOnlyMode) return;
    if (!currentSoiree || currentSoiree.matches.length === 0) return;
    const latestNumber = Math.max(...currentSeason.soirees.map((s: Soiree) => s.number));
    if (currentSoiree.number !== latestNumber) return;
    const allDone = currentSoiree.matches.every((m: CoreMatch) => Boolean(normName(m.winner)));
    if (!allDone || currentSoiree.closedAt) return;

    const now = Date.now();
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.id !== currentSoiree.id) return s;
        if (s.closedAt) return s;
        return { ...s, closedAt: now, endedAt: s.endedAt ?? now };
      });
      return { ...season, soirees };
    });
    createSnapshot(`Fin Soirée ${currentSoiree.number}`);
    setClosureSoireeId(currentSoiree.id);
    setClosureAutoExportStatus("");
    setShowSoireeClosureModal(true);
    logAudit("Fin de soirée détectée", `Soirée ${currentSoiree.number}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSoiree.id, currentSoiree.matches, currentSoiree.closedAt, currentSoiree.number, currentSeason.soirees, readOnlyMode]);

  useEffect(() => {
    setFlowMatchId("");
    setQueuedAutoAdvanceFromMatchId("");
  }, [currentSoiree.id]);

  useEffect(() => {
    if (tab !== "SOIREE" || !finalNightMode) return;
    const key = `${currentSeason.id}:${currentSoiree.id}:${tab}`;
    if (finalNightBurstKeyRef.current === key) return;
    finalNightBurstKeyRef.current = key;
    setShowFinalNightBurst(true);
    const t = window.setTimeout(() => setShowFinalNightBurst(false), 2400);
    return () => window.clearTimeout(t);
  }, [tab, finalNightMode, currentSeason.id, currentSoiree.id]);

  useEffect(() => {
    if (tab === "SOIREE" && finalNightMode) return;
    setShowFinalNightBurst(false);
  }, [tab, finalNightMode]);

  useEffect(() => {
    if (!tvMode || tab !== "SOIREE" || !finalNightMode) {
      setShowFinalNightIntro(false);
      return;
    }
    const key = `${currentSeason.id}:${currentSoiree.id}:tv-intro`;
    if (finalNightIntroKeyRef.current === key) return;
    finalNightIntroKeyRef.current = key;
    setShowFinalNightIntro(true);
    playSfx("scene");
    const t = window.setTimeout(() => setShowFinalNightIntro(false), 4200);
    return () => window.clearTimeout(t);
  }, [tvMode, tab, finalNightMode, currentSeason.id, currentSoiree.id]);

  const soireePlayers = useMemo(() => {
    return uniq([...currentSoiree.pools.A, ...currentSoiree.pools.B].map(normName)).filter(isNonEmptyString);
  }, [currentSoiree.pools.A, currentSoiree.pools.B]);

  const soireeAttendance = useMemo(() => {
    const map = new Map<string, PresenceStatus>();
    const absentsSet = new Set((currentSoiree.absentPlayers ?? []).map(normName).filter(isNonEmptyString));
    const attendanceRaw = currentSoiree.attendance ?? {};
    for (const p of soireePlayers) {
      const raw = attendanceRaw[p];
      if (raw === "HERE" || raw === "LATE" || raw === "ABSENT") {
        map.set(p, raw);
      } else {
        map.set(p, absentsSet.has(p) ? "ABSENT" : "HERE");
      }
    }
    return map;
  }, [currentSoiree.absentPlayers, currentSoiree.attendance, soireePlayers]);

  const liveSchedule = useMemo(() => {
    const matches = currentSoiree.matches.slice().sort((a: CoreMatch, b: CoreMatch) => a.order - b.order);
    const completed = matches.filter((m: CoreMatch) => Boolean(normName(m.winner)));
    const remaining = matches.filter((m: CoreMatch) => !normName(m.winner) && normName(m.a) && normName(m.b));
    const playable = remaining.filter(
      (m: CoreMatch) => soireeAttendance.get(m.a) === "HERE" && soireeAttendance.get(m.b) === "HERE"
    );

    const playedCount = new Map<string, number>();
    const lastPlayedIndex = new Map<string, number>();
    for (const p of soireePlayers) {
      playedCount.set(p, 0);
      lastPlayedIndex.set(p, -1);
    }
    completed.forEach((m: CoreMatch, idx: number) => {
      if (m.a) {
        playedCount.set(m.a, (playedCount.get(m.a) ?? 0) + 1);
        lastPlayedIndex.set(m.a, idx);
      }
      if (m.b) {
        playedCount.set(m.b, (playedCount.get(m.b) ?? 0) + 1);
        lastPlayedIndex.set(m.b, idx);
      }
    });

    const streakAtEnd = (player: string) => {
      let streak = 0;
      for (let i = completed.length - 1; i >= 0; i--) {
        const m = completed[i];
        if (m.a === player || m.b === player) streak += 1;
        else break;
      }
      return streak;
    };

    const lastMatch = completed.length > 0 ? completed[completed.length - 1] : null;
    const lastPlayers = new Set<string>();
    if (lastMatch?.a) lastPlayers.add(lastMatch.a);
    if (lastMatch?.b) lastPlayers.add(lastMatch.b);
    const hasAlternativeWithoutLastPlayers = playable.some(
      (m: CoreMatch) => !lastPlayers.has(m.a) && !lastPlayers.has(m.b)
    );
    const lastPool = lastMatch?.pool ?? null;

    const candidates = playable
      .map((m: CoreMatch) => {
        const waitA = completed.length - (lastPlayedIndex.get(m.a) ?? -1);
        const waitB = completed.length - (lastPlayedIndex.get(m.b) ?? -1);
        const playedA = playedCount.get(m.a) ?? 0;
        const playedB = playedCount.get(m.b) ?? 0;
        const streakA = streakAtEnd(m.a);
        const streakB = streakAtEnd(m.b);
        const reasons: string[] = [];
        let score = waitA * 110 + waitB * 110;

        if (hasAlternativeWithoutLastPlayers && (lastPlayers.has(m.a) || lastPlayers.has(m.b))) {
          score -= 2000;
        } else if (lastPlayers.has(m.a) || lastPlayers.has(m.b)) {
          reasons.push("peu d'alternatives: enchaînement partiel inévitable");
        }

        const maxStreak = Math.max(streakA, streakB);
        const hasAlternativeWithoutStreak = playable.some((x: CoreMatch) => {
          if (streakA >= 2 && (x.a === m.a || x.b === m.a)) return false;
          if (streakB >= 2 && (x.a === m.b || x.b === m.b)) return false;
          return true;
        });
        if (maxStreak >= 2 && hasAlternativeWithoutStreak) {
          score -= 2500;
        } else if (maxStreak >= 2) {
          reasons.push("enchaînement toléré faute d'autre match possible");
        }

        if (lastPool && m.pool && m.pool !== lastPool) {
          score += 80;
          reasons.push("alternance des poules");
        }

        score -= Math.max(playedA, playedB) * 18;
        score -= Math.abs(playedA - playedB) * 25;
        score -= m.order * 0.1;

        const maxWait = Math.max(waitA, waitB);
        if (maxWait >= 3) reasons.push("priorité aux joueurs qui attendent le plus");
        if (reasons.length === 0) reasons.push("équilibre global des rotations");

        return { match: m, score, reasons };
      })
      .sort((x, y) => y.score - x.score);

    const next = candidates[0];
    const latePlayers = soireePlayers.filter((p) => soireeAttendance.get(p) === "LATE");
    const absentPlayers = soireePlayers.filter((p) => soireeAttendance.get(p) === "ABSENT");
    return {
      candidates,
      nextMatch: next?.match,
      nextReason: next?.reasons?.join(" • ") ?? "",
      remainingCount: remaining.length,
      playableCount: playable.length,
      latePlayers,
      absentPlayers,
    };
  }, [currentSoiree.matches, soireeAttendance, soireePlayers]);

  useEffect(() => {
    if (!queuedAutoAdvanceFromMatchId) return;
    if (readOnlyMode || currentSoireeLocked || !flowAutoAdvance) {
      setQueuedAutoAdvanceFromMatchId("");
      return;
    }
    const next = liveSchedule.nextMatch;
    if (next && next.id !== queuedAutoAdvanceFromMatchId) {
      launchFlowMatch(next.id);
    }
    setQueuedAutoAdvanceFromMatchId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedAutoAdvanceFromMatchId, liveSchedule.nextMatch, readOnlyMode, currentSoireeLocked, flowAutoAdvance]);

  const soireeTiming = useMemo(() => {
    const startedAt =
      currentSoiree.startedAt ??
      currentSoiree.matches
        .map((m: CoreMatch) => m.startedAt)
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        .sort((a: number, b: number) => a - b)[0];
    const endedAt = currentSoiree.endedAt;
    const elapsedMs = startedAt ? Math.max(0, (endedAt ?? clockNow) - startedAt) : 0;
    const completedDurations = currentSoiree.matches
      .map((m: CoreMatch) => (m.startedAt && m.endedAt ? Math.max(0, m.endedAt - m.startedAt) : 0))
      .filter((x: number) => x > 0);
    const avgMatchMs = completedDurations.length
      ? Math.round(completedDurations.reduce((a: number, b: number) => a + b, 0) / completedDurations.length)
      : 0;
    const longestMatchMs = completedDurations.length ? Math.max(...completedDurations) : 0;
    return {
      startedAt,
      endedAt,
      elapsedMs,
      completedCount: completedDurations.length,
      avgMatchMs,
      longestMatchMs,
    };
  }, [currentSoiree.startedAt, currentSoiree.endedAt, currentSoiree.matches, clockNow]);

  const soireeEta = useMemo(() => {
    const fallbackAvgMs = 8 * 60 * 1000;
    const avgMatchMs = soireeTiming.avgMatchMs > 0 ? soireeTiming.avgMatchMs : fallbackAvgMs;
    const remaining = currentSoiree.matches.filter((m: CoreMatch) => !normName(m.winner));
    const knownRemaining = remaining.filter((m: CoreMatch) => normName(m.a) && normName(m.b));
    const unknownRemaining = remaining.length - knownRemaining.length;

    const isAbsent = (p: string) => soireeAttendance.get(p) === "ABSENT";
    const isLate = (p: string) => soireeAttendance.get(p) === "LATE";

    const blockedKnown = knownRemaining.filter((m: CoreMatch) => isAbsent(m.a) || isAbsent(m.b));
    const knownPlayable = knownRemaining.filter((m: CoreMatch) => !isAbsent(m.a) && !isAbsent(m.b));
    const delayedKnown = knownPlayable.filter((m: CoreMatch) => isLate(m.a) || isLate(m.b));
    const immediateKnown = knownPlayable.length - delayedKnown.length;

    const delayedPlayers = uniq(
      delayedKnown.flatMap((m: CoreMatch) => [m.a, m.b]).filter((p: string) => isLate(p))
    );
    const delayedArrivals = delayedPlayers
      .map((p: string) => parseEtaTodayMs(currentSoiree.arrivalEta?.[p] ?? "", clockNow))
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));

    const expectedPlayableCount = Math.max(0, knownPlayable.length + unknownRemaining);
    const immediateCount = Math.max(0, immediateKnown + unknownRemaining);
    const delayedCount = Math.max(0, delayedKnown.length);
    const immediateMs = immediateCount * avgMatchMs;
    const delayedMs = delayedCount * avgMatchMs;
    const earliestDelayedTs = delayedArrivals.length ? Math.min(...delayedArrivals) : null;
    const waitGapMs =
      delayedCount > 0 && earliestDelayedTs
        ? Math.max(0, earliestDelayedTs - (clockNow + immediateMs))
        : 0;
    const etaMs = clockNow + immediateMs + waitGapMs + delayedMs;
    const remainingMs = Math.max(0, etaMs - clockNow);

    return {
      avgMatchMs,
      remainingCount: remaining.length,
      expectedPlayableCount,
      blockedCount: blockedKnown.length,
      delayedCount,
      delayedPlayers,
      waitGapMs,
      etaMs,
      remainingMs,
    };
  }, [clockNow, currentSoiree.matches, currentSoiree.arrivalEta, soireeAttendance, soireeTiming.avgMatchMs]);

  const liveSoireeRanking = useMemo(() => {
    return computeSoireeRankingRows(currentSoiree, currentSeason, effectiveRules, activeSoireeRulePolicies);
  }, [
    currentSoiree,
    currentSeason,
    effectiveRules,
    activeSoireeRulePolicies,
  ]);

  const premiumAnalytics = useMemo(() => {
    const participants = uniq([...currentSoiree.pools.A, ...currentSoiree.pools.B].map(normName)).filter(isNonEmptyString);
    const matches = currentSoiree.matches;
    const unresolved = matches.filter((m: CoreMatch) => !normName(m.winner) && normName(m.a) && normName(m.b));

    const byPlayerCounts = new Map<string, { p1: number; p2: number; p3: number }>();
    participants.forEach((p) => byPlayerCounts.set(p, { p1: 0, p2: 0, p3: 0 }));

    const rankFromRows = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
    const baseRows = computeSoireeRankingRows(currentSoiree, currentSeason, effectiveRules, activeSoireeRulePolicies);
    const baseTop3 = rankFromRows(baseRows).slice(0, 3);

    if (unresolved.length === 0) {
      if (baseTop3[0]) byPlayerCounts.get(baseTop3[0])!.p1 += 1;
      if (baseTop3[1]) byPlayerCounts.get(baseTop3[1])!.p2 += 1;
      if (baseTop3[2]) byPlayerCounts.get(baseTop3[2])!.p3 += 1;
    } else {
      const runs = 300;
      for (let run = 0; run < runs; run++) {
        const simulatedMatches = matches.map((m: CoreMatch) => {
          if (normName(m.winner) || !m.a || !m.b) return m;
          const winner = Math.random() < 0.5 ? m.a : m.b;
          return { ...m, winner, status: "VALIDATED" as MatchStatus };
        });
        const simulatedRows = computeSoireeRankingRows(
          { ...currentSoiree, matches: simulatedMatches },
          currentSeason,
          effectiveRules,
          activeSoireeRulePolicies
        );
        const top3 = rankFromRows(simulatedRows).slice(0, 3);
        if (top3[0]) byPlayerCounts.get(top3[0])!.p1 += 1;
        if (top3[1]) byPlayerCounts.get(top3[1])!.p2 += 1;
        if (top3[2]) byPlayerCounts.get(top3[2])!.p3 += 1;
      }

      for (const p of participants) {
        const c = byPlayerCounts.get(p)!;
        c.p1 = Math.round((c.p1 / runs) * 1000) / 10;
        c.p2 = Math.round((c.p2 / runs) * 1000) / 10;
        c.p3 = Math.round((c.p3 / runs) * 1000) / 10;
      }
    }

    const phaseStats = new Map<string, Record<Phase, { played: number; wins: number }>>();
    participants.forEach((p) =>
      phaseStats.set(p, {
        POULE: { played: 0, wins: 0 },
        DEMI: { played: 0, wins: 0 },
        PFINAL: { played: 0, wins: 0 },
        FINAL: { played: 0, wins: 0 },
      })
    );

    const rankMap = new Map(seasonStats.table.map((r, idx: number) => [r.name, idx + 1] as const));
    const difficultyMap = new Map<string, { total: number; count: number }>();
    participants.forEach((p) => difficultyMap.set(p, { total: 0, count: 0 }));

    for (const m of matches) {
      const a = normName(m.a);
      const b = normName(m.b);
      if (!a || !b) continue;
      const w = normName(m.winner);
      const byA = phaseStats.get(a);
      const byB = phaseStats.get(b);
      if (byA) byA[m.phase].played += 1;
      if (byB) byB[m.phase].played += 1;
      if (w && (w === a || w === b)) {
        const loser = w === a ? b : a;
        const bucket = phaseStats.get(w);
        if (bucket) bucket[m.phase].wins += 1;
        const oppRank = rankMap.get(loser) ?? participants.length;
        const strength = participants.length + 1 - oppRank;
        const d = difficultyMap.get(w);
        if (d) {
          d.total += strength;
          d.count += 1;
        }
      }
    }

    const mvpRows = participants.map((p) => {
      const row = liveSoireeRanking.find((x) => x.name === p);
      const phases = phaseStats.get(p)!;
      const clutchWins = phases.FINAL.wins * 4 + phases.DEMI.wins * 2 + phases.PFINAL.wins;
      const score = Math.round(((row?.pts ?? 0) * 4 + (row?.wins ?? 0) * 3 + clutchWins + (row?.bonus ?? 0) * 2) * 10) / 10;
      return { player: p, score, pts: row?.pts ?? 0, wins: row?.wins ?? 0, bonus: row?.bonus ?? 0 };
    });
    mvpRows.sort((a, b) => b.score - a.score || b.pts - a.pts || a.player.localeCompare(b.player));

    const difficulty = participants
      .map((p) => {
        const d = difficultyMap.get(p)!;
        const avg = d.count > 0 ? Math.round((d.total / d.count) * 100) / 100 : 0;
        return { player: p, avgStrength: avg, wins: d.count };
      })
      .sort((a, b) => b.avgStrength - a.avgStrength || b.wins - a.wins || a.player.localeCompare(b.player));

    const phasePerformance = participants.map((p) => {
      const phases = phaseStats.get(p)!;
      const view = (phase: Phase) => {
        const played = phases[phase].played;
        const wins = phases[phase].wins;
        return {
          played,
          wins,
          rate: played > 0 ? Math.round((wins / played) * 1000) / 10 : 0,
        };
      };
      return { player: p, POULE: view("POULE"), DEMI: view("DEMI"), PFINAL: view("PFINAL"), FINAL: view("FINAL") };
    });

    const podiumProbabilities = participants
      .map((p) => {
        const c = byPlayerCounts.get(p)!;
        const top3 = Math.round(((c.p1 + c.p2 + c.p3) * 10)) / 10;
        return { player: p, p1: c.p1, p2: c.p2, p3: c.p3, top3 };
      })
      .sort((a, b) => b.top3 - a.top3 || b.p1 - a.p1 || a.player.localeCompare(b.player));

    return {
      podiumProbabilities,
      mvp: mvpRows,
      difficulty,
      phasePerformance,
    };
  }, [
    currentSoiree,
    currentSeason,
    effectiveRules,
    activeSoireeRulePolicies,
    seasonStats.table,
    liveSoireeRanking,
  ]);

  const tvLiveFocus = useMemo(() => {
    const running = currentSoiree.matches
      .filter((m: CoreMatch) => Boolean(m.startedAt) && !normName(m.winner))
      .sort((a: CoreMatch, b: CoreMatch) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    return running ?? liveSchedule.nextMatch ?? null;
  }, [currentSoiree.matches, liveSchedule.nextMatch]);

  const flowCurrentMatch = useMemo(() => {
    if (!flowMatchId) return null;
    return currentSoiree.matches.find((m: CoreMatch) => m.id === flowMatchId) ?? null;
  }, [flowMatchId, currentSoiree.matches]);
  const operatorFocusMatch = flowCurrentMatch ?? liveSchedule.nextMatch ?? null;
  const liveSoireeRankingMap = useMemo(
    () => new Map(liveSoireeRanking.map((row) => [row.name, row] as const)),
    [liveSoireeRanking]
  );
  const tvNextMatch = useMemo(
    () => liveSchedule.candidates.find((c) => c.match.id !== tvLiveFocus?.id)?.match ?? null,
    [liveSchedule.candidates, tvLiveFocus?.id]
  );
  const tvPlayerCards = useMemo(() => {
    if (!tvLiveFocus) return [];
    const players = [normName(tvLiveFocus.a), normName(tvLiveFocus.b)].filter(isNonEmptyString);
    const recentMatches = [...currentSoiree.matches]
      .filter((m: CoreMatch) => Boolean(normName(m.winner)))
      .sort((a: CoreMatch, b: CoreMatch) => b.order - a.order);
    return players.map((name) => {
      const seasonRow = seasonStats.table.find((r) => r.name === name);
      const soireeRow = liveSoireeRankingMap.get(name);
      const form = recentMatches
        .filter((m: CoreMatch) => normName(m.a) === name || normName(m.b) === name)
        .slice(0, 5)
        .map((m: CoreMatch) => (normName(m.winner) === name ? "W" : "L"));
      return {
        name,
        seasonRank: seasonRow ? seasonStats.table.findIndex((r) => r.name === name) + 1 : 0,
        seasonPts: seasonRow?.pts ?? 0,
        seasonWins: seasonRow?.wins ?? 0,
        soireePts: soireeRow?.pts ?? 0,
        soireeWins: soireeRow?.wins ?? 0,
        form: form.join(" - ") || "N/A",
      };
    });
  }, [tvLiveFocus, currentSoiree.matches, seasonStats.table, liveSoireeRankingMap]);

  const buildSoireeHighlights = (
    soiree: Soiree,
    season: Season,
    rankingRows: Array<{ name: string; pts: number; wins: number; bonus: number }>
  ) => {
    const highlights: Array<{ id: string; title: string; detail: string; tone: "cyan" | "emerald" | "amber" | "fuchsia" }> = [];
    const completed = soiree.matches
      .filter((m: CoreMatch) => Boolean(normName(m.winner)))
      .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order);
    if (!completed.length) return highlights;

    const mvp = rankingRows[0];
    if (mvp) {
      highlights.push({
        id: "mvp",
        title: `MVP: ${mvp.name}`,
        detail: `${mvp.pts} pts • ${mvp.wins} victoires`,
        tone: "emerald",
      });
    }

    const checkout = [...completed]
      .filter((m: CoreMatch) => Boolean(m.checkoutBy))
      .sort((a: CoreMatch, b: CoreMatch) => b.order - a.order)[0];
    if (checkout) {
      highlights.push({
        id: "checkout",
        title: "Clutch Checkout",
        detail: `${checkout.winner} • Match #${checkout.order} ${checkout.phase}`,
        tone: "amber",
      });
    }

    const seasonRanks = new Map(
      aggregateSeasonStats(season, effectiveRules, activeSoireeRulePolicies).table.map((r, idx: number) => [r.name, idx + 1] as const)
    );
    let bestUpset: { winner: string; loser: string; diff: number } | null = null;
    for (const m of completed) {
      const w = normName(m.winner);
      if (!w) continue;
      const loser = w === normName(m.a) ? normName(m.b) : normName(m.a);
      if (!loser) continue;
      const wRank = seasonRanks.get(w) ?? 999;
      const lRank = seasonRanks.get(loser) ?? 999;
      const diff = wRank - lRank;
      if (diff >= 3 && (!bestUpset || diff > bestUpset.diff)) {
        bestUpset = { winner: w, loser, diff };
      }
    }
    if (bestUpset) {
      highlights.push({
        id: "upset",
        title: "Upset majeur",
        detail: `${bestUpset.winner} bat ${bestUpset.loser} (+${bestUpset.diff} places)`,
        tone: "fuchsia",
      });
    }

    const streak = new Map<string, number>();
    let bestStreak = { player: "", value: 0 };
    for (const m of completed) {
      const w = normName(m.winner);
      const loser = w === normName(m.a) ? normName(m.b) : normName(m.a);
      if (w) {
        streak.set(w, (streak.get(w) ?? 0) + 1);
        if ((streak.get(w) ?? 0) > bestStreak.value) bestStreak = { player: w, value: streak.get(w) ?? 0 };
      }
      if (loser) streak.set(loser, 0);
    }
    if (bestStreak.player && bestStreak.value >= 2) {
      highlights.push({
        id: "streak",
        title: "Série du soir",
        detail: `${bestStreak.player} enchaîne ${bestStreak.value} victoires`,
        tone: "cyan",
      });
    }

    const fastest = completed
      .filter((m: CoreMatch) => Boolean(m.startedAt && m.endedAt))
      .map((m: CoreMatch) => ({ m, d: (m.endedAt ?? 0) - (m.startedAt ?? 0) }))
      .filter((x) => x.d > 0)
      .sort((a, b) => a.d - b.d)[0];
    if (fastest) {
      highlights.push({
        id: "fast",
        title: "Match le plus rapide",
        detail: `#${fastest.m.order} • ${formatDuration(fastest.d)}`,
        tone: "amber",
      });
    }

    return highlights.slice(0, 5);
  };

  const currentSoireeHighlights = useMemo(
    () => buildSoireeHighlights(currentSoiree, currentSeason, liveSoireeRanking),
    [currentSoiree, currentSeason, liveSoireeRanking, effectiveRules, activeSoireeRulePolicies]
  );


  const currentPoolStandings = useMemo(() => {
    return {
      A: computePoolRows(currentSoiree, "A", currentSeason, effectiveRules, activeSoireeRulePolicies),
      B: computePoolRows(currentSoiree, "B", currentSeason, effectiveRules, activeSoireeRulePolicies),
    };
  }, [currentSoiree.matches, currentSoiree.pools, currentSoiree.number, currentSeason, effectiveRules, activeSoireeRulePolicies]);

  const allSoireeNumbers = useMemo(() => {
    return [...currentSeason.soirees].map((s: Soiree) => s.number).sort((a: number, b: number) => a - b);
  }, [currentSeason.soirees]);

  const funStandings = useMemo(() => {
    const wins = new Map<string, number>();
    const played = new Map<string, number>();
    const posPts = new Map<string, number>();
    state.funMode.players.forEach((p) => {
      wins.set(p, 0);
      played.set(p, 0);
      posPts.set(p, 0);
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

    for (const round of state.funMode.positionRounds) {
      const seen = new Set<string>();
      round.positions.forEach((p, idx) => {
        const name = normName(p);
        if (!name || seen.has(name) || !state.funMode.players.includes(name)) return;
        seen.add(name);
        const points = Math.max(0, state.funMode.players.length - idx);
        posPts.set(name, (posPts.get(name) ?? 0) + points);
      });
    }

    const rows = state.funMode.players.map((p) => ({
      name: p,
      wins: wins.get(p) ?? 0,
      played: played.get(p) ?? 0,
      posPts: posPts.get(p) ?? 0,
      total: (wins.get(p) ?? 0) * 3 + (posPts.get(p) ?? 0),
    }));
    rows.sort((a, b) => b.total - a.total || b.wins - a.wins || a.name.localeCompare(b.name));
    return rows;
  }, [state.funMode.players, state.funMode.matches, state.funMode.positionRounds]);

  const funPodium = useMemo(() => {
    const final = state.funMode.finals.find((m) => m.phase === "FINAL");
    const pfinal = state.funMode.finals.find((m) => m.phase === "PFINAL");
    const wFinal = normName(final?.winner ?? "");
    const aFinal = normName(final?.a ?? "");
    const bFinal = normName(final?.b ?? "");
    const second = wFinal && (wFinal === aFinal || wFinal === bFinal) ? (wFinal === aFinal ? bFinal : aFinal) : "";
    const third = normName(pfinal?.winner ?? "");
    if (wFinal && second && third) return { first: wFinal, second, third, provisional: false as const };
    return {
      first: funStandings[0]?.name ?? "",
      second: funStandings[1]?.name ?? "",
      third: funStandings[2]?.name ?? "",
      provisional: true as const,
    };
  }, [state.funMode.finals, funStandings]);

  const funPotEUR = useMemo(() => {
    if (!state.funMode.moneyEnabled) return 0;
    return state.funMode.players.length * state.funMode.moneyPerPlayer;
  }, [state.funMode.moneyEnabled, state.funMode.players.length, state.funMode.moneyPerPlayer]);

  const funLiveMatches = useMemo(() => {
    const pool = state.funMode.matches
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((m) => ({ ...m, _src: "POOL" as const }));
    const finals = state.funMode.finals
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((m) => ({ ...m, _src: "FINAL" as const }));
    return [...pool, ...finals];
  }, [state.funMode.matches, state.funMode.finals]);

  const currentLiveMatch = funLiveMatches[funLiveIndex];

  useEffect(() => {
    if (funLiveIndex > Math.max(0, funLiveMatches.length - 1)) {
      setFunLiveIndex(Math.max(0, funLiveMatches.length - 1));
    }
  }, [funLiveIndex, funLiveMatches.length]);

  const tvTabs = useMemo<TvTab[]>(
    () => (tvRotationTabs.length ? tvRotationTabs : [...DEFAULT_TV_ROTATION_TABS]),
    [tvRotationTabs]
  );
  const tvLabels: Record<TvTab, string> = {
    SOIREE: "Soirée",
    CLASSEMENT: "Classement",
    H2H: "Confrontations",
  };
  const autoTvScene = useMemo<TvScene>(() => {
    if (!tvMode || tab !== "SOIREE") return "LIVE";
    const matches = currentSoiree.matches;
    const playedCount = matches.filter((m: CoreMatch) => Boolean(normName(m.winner))).length;
    const running = matches.find((m: CoreMatch) => Boolean(m.startedAt) && !normName(m.winner));
    const final = matches.find((m: CoreMatch) => m.phase === "FINAL");
    const pfinal = matches.find((m: CoreMatch) => m.phase === "PFINAL");
    const finalReady = Boolean(final && normName(final.a) && normName(final.b));
    const finalDone = Boolean(final && normName(final.winner));
    const podiumDone = finalDone && Boolean(pfinal && normName(pfinal.winner));
    const semisPlayed = matches.filter((m: CoreMatch) => m.phase === "DEMI" && Boolean(normName(m.winner))).length;
    if (playedCount === 0) return "INTRO";
    if (playedCount <= 2) return "LINEUP";
    if (podiumDone) return "PODIUM";
    if (running && (running.phase === "FINAL" || running.phase === "DEMI")) return "CLUTCH";
    if (finalReady) return "FINALE";
    if (running) return "MATCHFOCUS";
    if (playedCount < 4 || semisPlayed === 0) return "WARMUP";
    return "LIVE";
  }, [tvMode, tab, currentSoiree.matches]);
  const tvScene: TvScene = tvSceneOverride || autoTvScene;
  const tvSceneMeta = useMemo(() => {
    if (tvScene === "INTRO") {
      return { label: "Intro", subtitle: "Ouverture broadcast • présentation de la soirée" };
    }
    if (tvScene === "LINEUP") {
      return { label: "Lineup", subtitle: "Entrée des joueurs • début des affrontements" };
    }
    if (tvScene === "WARMUP") {
      return { label: "Warmup", subtitle: "Ouverture de la soirée • mise en route des poules" };
    }
    if (tvScene === "MATCHFOCUS") {
      return { label: "Match Focus", subtitle: "Caméra sur le match en cours • suivi détaillé" };
    }
    if (tvScene === "CLUTCH") {
      return { label: "Clutch Time", subtitle: "Moment décisif • pression maximale" };
    }
    if (tvScene === "FINALE") {
      return { label: "Finale", subtitle: "Phases finales actives • tension maximale" };
    }
    if (tvScene === "PODIUM") {
      return { label: "Podium", subtitle: "Résultats validés • cérémonie finale" };
    }
    return { label: "Live", subtitle: "Rotation en cours • suivi des matchs en direct" };
  }, [tvScene]);
  const tvSceneColor = useMemo(() => {
    if (tvScene === "PODIUM") return "#eab308";
    if (tvScene === "FINALE" || tvScene === "CLUTCH") return "#f97316";
    if (tvScene === "INTRO" || tvScene === "LINEUP") return "#f43f5e";
    if (tvScene === "WARMUP") return "#06b6d4";
    return "#22c55e";
  }, [tvScene]);
  const tvFocusMode = tvMode && tvInfoDensity === "FOCUS";

  const tvMomentLines = useMemo(() => {
    if (cinematicMoment) {
      return [cinematicMoment.title, ...cinematicMoment.lines].slice(0, 3);
    }

    const auditMoments = state.system.audit
      .filter((a) =>
        ["Flow soirée", "Statut match", "Fin de soirée détectée", "Récupération rapide", "Suppression soirée"].includes(
          a.action
        )
      )
      .slice(0, 3)
      .map((a) => `${new Date(a.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} • ${a.action}${a.details ? ` (${a.details})` : ""}`);

    if (auditMoments.length > 0) return auditMoments;

    const recentCompleted = [...currentSoiree.matches]
      .filter((m: CoreMatch) => Boolean(normName(m.winner)))
      .sort((a: CoreMatch, b: CoreMatch) => b.order - a.order)
      .slice(0, 3)
      .map((m: CoreMatch) => `Match #${m.order} • ${m.winner} bat ${m.winner === m.a ? m.b : m.a}`);

    return recentCompleted.length > 0 ? recentCompleted : ["Aucun moment clé pour l'instant."];
  }, [state.system.audit, currentSoiree.matches, cinematicMoment]);

  const tvOverlayCards = useMemo(() => {
    const next = liveSchedule.nextMatch;
    const top3Season = seasonStats.table.slice(0, 3).map((r, idx: number) => `${idx + 1}. ${r.name} (${r.pts} pts)`);
    const top3Soiree = liveSoireeRanking.slice(0, 3).map((r, idx: number) => `${idx + 1}. ${r.name} (${r.pts} pts)`);
    const runningMatches = currentSoiree.matches
      .filter((m: CoreMatch) => Boolean(m.startedAt) && !normName(m.winner))
      .sort((a: CoreMatch, b: CoreMatch) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 2);
    const lastWinners = [...currentSoiree.matches]
      .filter((m: CoreMatch) => Boolean(normName(m.winner)))
      .sort((a: CoreMatch, b: CoreMatch) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 8)
      .map((m: CoreMatch) => normName(m.winner))
      .filter(isNonEmptyString);
    const formMap = new Map<string, number>();
    lastWinners.forEach((p) => formMap.set(p, (formMap.get(p) ?? 0) + 1));
    const formLines = [...formMap.entries()]
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([p, v], idx) => `${idx + 1}. ${p} • ${v}W / 8 derniers matchs`);
    return [
      {
        id: "next",
        tone: "cyan",
        title: "Prochain match",
        lines: next
          ? [`#${next.order} • ${next.a} vs ${next.b}`, next.pool ? `Poule ${next.pool}` : next.phase, liveSchedule.nextReason || "Prêt à lancer"]
          : ["Aucun match jouable immédiat", "Vérifie présences / retardataires", liveSchedule.remainingCount === 0 ? "Soirée complétée" : "En attente"],
      },
      {
        id: "score",
        tone: "emerald",
        title: "Score live soirée",
        lines: top3Soiree.length > 0 ? top3Soiree : ["Aucun score disponible", "Lance un match", "Le top 3 apparaîtra ici"],
      },
      {
        id: "top",
        tone: "amber",
        title: "Top 3 saison",
        lines: top3Season.length > 0 ? top3Season : ["Aucun classement saison", "Ajoute des joueurs", "Puis génère une soirée"],
      },
      {
        id: "tables",
        tone: "cyan",
        title: "Table en cours",
        lines:
          runningMatches.length > 0
            ? runningMatches.map((m: CoreMatch) => `#${m.order} • ${m.a} vs ${m.b}`)
            : [tvLiveFocus ? `${tvLiveFocus.a} vs ${tvLiveFocus.b}` : "Aucune table active", "Lance le prochain match", "Mode live prêt"],
      },
      {
        id: "form",
        tone: "emerald",
        title: "Forme récente",
        lines:
          formLines.length > 0
            ? formLines
            : ["Pas assez d'historique", "Joue quelques matchs", "La forme apparaîtra ici"],
      },
      {
        id: "moments",
        tone: "fuchsia",
        title: "Moments clés",
        lines: tvMomentLines,
      },
    ] as const;
  }, [liveSchedule.nextMatch, liveSchedule.nextReason, liveSchedule.remainingCount, liveSoireeRanking, seasonStats.table, tvMomentLines, currentSoiree.matches, tvLiveFocus]);

  const tvOverlayCard = tvOverlayCards[tvOverlayIndex % Math.max(tvOverlayCards.length, 1)];

  const allNavTabs: Array<[AppTab, string]> = [
    ["SOIREE", "Soirée"],
    ["CLASSEMENT", "Classement"],
    ["HISTO", "Historique"],
    ["REBUY", "Re-buy"],
    ["H2H", "Confrontations"],
    ["SAISONS", "Saisons"],
    ["FINANCES", "Finances"],
    ["ARBITRAGE", "Arbitrage"],
    ["REGLES", "Règles"],
    ["PARAMS", "Paramètres"],
  ];
  const readOnlyNavTabs: Array<[AppTab, string]> = [
    ["CLASSEMENT", "Classement"],
    ["HISTO", "Historique"],
    ["H2H", "Confrontations"],
    ["REGLES", "Règles"],
  ];
  const navTabs = readOnlyMode ? readOnlyNavTabs : allNavTabs;
  const navTabIcons: Record<AppTab, string> = {
    SOIREE: "🎯",
    CLASSEMENT: "🏆",
    HISTO: "🕘",
    REBUY: "🔁",
    FUN: "🎉",
    H2H: "⚔️",
    FINANCES: "💶",
    ARBITRAGE: "🧾",
    REGLES: "📘",
    PARAMS: "⚙️",
    SAISONS: "🗂️",
  };

  useEffect(() => {
    if (!tvMode) return;
    const idx = tvTabs.indexOf(tab as (typeof tvTabs)[number]);
    setTvIndex(idx >= 0 ? idx : 0);
  }, [tvMode, tab]);

  useEffect(() => {
    if (!tvMode || !tvAutoRotateEnabled || tvTabs.length <= 1) return;
    const handle = window.setInterval(() => {
      setTab((prevTab) => {
        const current = tvTabs.indexOf(prevTab as TvTab);
        const next = ((current >= 0 ? current : 0) + 1) % tvTabs.length;
        setTvIndex(next);
        return tvTabs[next];
      });
    }, tvRotateEveryMs);
    return () => window.clearInterval(handle);
  }, [tvMode, tvAutoRotateEnabled, tvRotateEveryMs, tvTabs]);

  useEffect(() => {
    if (!tvMode || tab !== "SOIREE") return;
    setTvOverlayIndex(0);
    const handle = window.setInterval(() => {
      setTvOverlayIndex((prev) => (prev + 1) % Math.max(tvOverlayCards.length, 1));
    }, 5200);
    return () => window.clearInterval(handle);
  }, [tvMode, tab, tvOverlayCards.length]);

  useEffect(() => {
    if (!tvMode || tab !== "SOIREE" || tvScene !== "PODIUM" || currentSoireeHighlights.length <= 1) {
      setHighlightIndex(0);
      return;
    }
    const handle = window.setInterval(() => {
      setHighlightIndex((prev) => (prev + 1) % currentSoireeHighlights.length);
    }, 4200);
    return () => window.clearInterval(handle);
  }, [tvMode, tab, tvScene, currentSoireeHighlights.length]);

  useEffect(() => {
    if (!tvMode || tab !== "SOIREE") {
      previousTvSceneRef.current = tvScene;
      setTvSceneFlash("");
      return;
    }
    const previous = previousTvSceneRef.current;
    if (previous && previous !== tvScene) {
      setTvSceneFlash(tvScene);
      playSfx("scene");
      const t = window.setTimeout(() => setTvSceneFlash(""), 1300);
      previousTvSceneRef.current = tvScene;
      return () => window.clearTimeout(t);
    }
    previousTvSceneRef.current = tvScene;
  }, [tvMode, tab, tvScene]);

  useEffect(() => {
    if (!tvMode) return;
    setOperatorFullscreen(false);
  }, [tvMode]);

  useEffect(() => {
    if (!tvMode || tab !== "SOIREE") {
      setTvSceneOverride("");
    }
  }, [tvMode, tab]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase?.() ?? "";
      if (tag === "textarea" || tag === "select") return true;
      if (tag === "input") {
        const input = el as HTMLInputElement;
        const inputType = (input.type || "").toLowerCase();
        return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(inputType);
      }
      return Boolean(el.closest("[contenteditable='true']"));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const typingTarget = isTypingTarget(e.target);
      const isRight = e.key === "ArrowRight" || e.key === "Right" || e.keyCode === 39;
      const isLeft = e.key === "ArrowLeft" || e.key === "Left" || e.keyCode === 37;

      if (tvMode && !typingTarget && (isRight || isLeft)) {
        e.preventDefault();
        goToTvTab(isRight ? 1 : -1);
        return;
      }

      if (tvMode && !typingTarget && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        setTvAutoRotateEnabled((v) => !v);
        return;
      }

      if (tvMode && !typingTarget) {
        const k = e.key.toLowerCase();
        if (k === "s") {
          e.preventDefault();
          setBroadcastOverlay("SPONSOR");
          return;
        }
        if (k === "p") {
          e.preventDefault();
          setBroadcastOverlay("PAUSE");
          return;
        }
        if (k === "a") {
          e.preventDefault();
          setBroadcastOverlay("ANNOUNCE");
          return;
        }
        if (k === "escape") {
          e.preventDefault();
          setTvBroadcastOverlayKind("");
          return;
        }
      }

      if (!typingTarget) {
        const k = e.key.toLowerCase();
        if (!tvMode && !readOnlyMode && k === "o") {
          e.preventDefault();
          setOperatorFullscreen((v) => !v);
          return;
        }
        if (k === "escape" && operatorFullscreen) {
          e.preventDefault();
          setOperatorFullscreen(false);
          return;
        }
      }

      if (tvMode && !typingTarget && (e.key === "PageDown" || e.key === "]")) {
        e.preventDefault();
        goToTvTab(1);
        return;
      }
      if (tvMode && !typingTarget && (e.key === "PageUp" || e.key === "[")) {
        e.preventDefault();
        goToTvTab(-1);
        return;
      }

      if (typingTarget) return;

      if (readOnlyMode) return;

      if (e.altKey) {
        const nextTab = (() => {
          if (e.key === "1") return "SOIREE";
          if (e.key === "2") return "CLASSEMENT";
          if (e.key === "3") return "HISTO";
          if (e.key === "4") return "REBUY";
          if (e.key === "5") return "H2H";
          if (e.key === "6") return "PARAMS";
          return null;
        })();
        if (nextTab) {
          e.preventDefault();
          setTab(nextTab);
          return;
        }
      }

      if (tab !== "SOIREE") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        if (liveSchedule.nextMatch && !currentSoireeLocked) launchNextRecommendedMatch();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        if (currentSoireeLocked) return;
        if (!soireeTiming.startedAt || soireeTiming.endedAt) startSoireeTimer();
        else stopSoireeTimer();
        return;
      }
      if (key === "l") {
        e.preventDefault();
        if (confirmSmart("toggle-lock", currentSoireeLocked ? "Déverrouiller la soirée ?" : "Verrouiller la soirée ?")) {
          setCurrentSoireeLocked(!currentSoireeLocked);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnlyMode, tvMode, liveSchedule.nextMatch, currentSoireeLocked, soireeTiming.startedAt, soireeTiming.endedAt, tvTabs, tab, operatorFullscreen]);

  function goToTvTab(delta: -1 | 1) {
    if (tvTabs.length === 0) return;
    const current = tvTabs.indexOf(tab as TvTab);
    const next = ((current >= 0 ? current : 0) + delta + tvTabs.length) % tvTabs.length;
    setTvIndex(next);
    setTab(tvTabs[next]);
  }

  function toggleTvRotationTab(tabId: TvTab) {
    setTvRotationTabs((prev) => {
      if (prev.includes(tabId)) {
        const next = prev.filter((x) => x !== tabId);
        return next.length ? next : prev;
      }
      return [...prev, tabId];
    });
  }

  function moveTvRotationTab(index: number, delta: -1 | 1) {
    setTvRotationTabs((prev) => {
      const target = index + delta;
      if (index < 0 || index >= prev.length || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  function applyTv190Preset() {
    setTvDisplayMode("BIGSCREEN");
    setTvInfoDensity("FOCUS");
    setTvSceneOverride("");
    setTvAutoRotateEnabled(true);
    setTvRotateEveryMs(12000);
    setTvRotationTabs(["SOIREE", "CLASSEMENT"]);
    if (tab !== "SOIREE" && tab !== "CLASSEMENT") setTab("SOIREE");
  }

  async function requestTvFullscreen() {
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch {}
  }

  function setBroadcastOverlay(kind: BroadcastOverlayKind) {
    setTvBroadcastOverlayKind((prev) => {
      const next = prev === kind ? "" : kind;
      if (next) playSfx("scene");
      return next;
    });
  }

  function getAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return null;
    const ctx = new Ctx();
    audioCtxRef.current = ctx;
    return ctx;
  }

  function playSfx(kind: SfxKind) {
    if (!soundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") void ctx.resume();
      const profileGain = soundProfile === "SOFT" ? 0.7 : soundProfile === "FINAL" ? 1.2 : 1;
      const profileWave: OscillatorType =
        soundProfile === "SOFT" ? "sine" : soundProfile === "FINAL" ? "square" : "triangle";
      const baseGain = Math.max(0, Math.min(1, soundVolume / 100)) * 0.12 * profileGain;
      const now = ctx.currentTime + 0.01;
      const tones: Array<{ hz: number; duration: number; gain?: number; type?: OscillatorType; offset?: number }> =
        kind === "checkout"
          ? [
              { hz: 880, duration: 0.06, type: "triangle" },
              { hz: 1320, duration: 0.08, type: "triangle", offset: 0.065 },
            ]
          : kind === "clutch"
            ? [
                { hz: 440, duration: 0.06, type: "square" },
                { hz: 660, duration: 0.07, type: "square", offset: 0.055 },
                { hz: 990, duration: 0.08, type: "square", offset: 0.12 },
              ]
            : kind === "podium"
              ? [
                  { hz: 523, duration: 0.08, type: "triangle" },
                  { hz: 659, duration: 0.08, type: "triangle", offset: 0.09 },
                  { hz: 784, duration: 0.12, type: "triangle", offset: 0.18 },
                ]
              : kind === "scene"
                ? [
                    { hz: 370, duration: 0.05, type: "sine" },
                    { hz: 554, duration: 0.06, type: "sine", offset: 0.05 },
                  ]
                : [
                    { hz: 660, duration: 0.07, type: "sine" },
                    { hz: 880, duration: 0.09, type: "sine", offset: 0.07 },
                  ];

      if (soundProfile === "FINAL" && (kind === "clutch" || kind === "podium")) {
        tones.push({ hz: 1318, duration: 0.14, type: "sawtooth", offset: 0.24, gain: 0.75 });
      }

      tones.forEach((t) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const startAt = now + (t.offset ?? 0);
        const peak = Math.max(0.001, baseGain * (t.gain ?? 1));
        osc.type = t.type ?? profileWave;
        osc.frequency.setValueAtTime(t.hz, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + t.duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + t.duration + 0.02);
      });
    } catch {}
  }

  function pushCinematicMoment(
    title: string,
    lines: string[],
    tone: CinematicMoment["tone"] = "cyan",
    sound: SfxKind | "" = ""
  ) {
    const moment: CinematicMoment = {
      id: uid("cm"),
      title,
      lines: lines.filter(isNonEmptyString).slice(0, 3),
      tone,
    };
    setCinematicMoment(moment);
    if (cinematicTimerRef.current) window.clearTimeout(cinematicTimerRef.current);
    cinematicTimerRef.current = window.setTimeout(() => setCinematicMoment((prev) => (prev?.id === moment.id ? null : prev)), 3600);
    if (sound) playSfx(sound);
  }

  function updateSeason(mutator: (season: Season) => Season) {
    setState((prev) => {
      if (readOnlyMode) return prev;
      const seasons = prev.seasons.map((s) => (s.id === prev.activeSeasonId ? mutator(s) : s));
      return { ...prev, seasons };
    });
  }

  function updateSystem(mutator: (system: AppState["system"]) => AppState["system"]) {
    setState((prev) => (readOnlyMode ? prev : { ...prev, system: mutator(prev.system) }));
  }

  function logAudit(action: string, details?: string) {
    updateSystem((system) => ({
      ...system,
      audit: [{ id: uid("audit"), ts: Date.now(), action, details }, ...system.audit].slice(0, 300),
    }));
  }

  function confirmSmart(key: string, message: string, e?: React.MouseEvent<HTMLButtonElement>) {
    if (e?.shiftKey) return true;
    const now = Date.now();
    const validUntil = smartConfirmMemoryRef.current[key] ?? 0;
    if (validUntil > now) return true;
    const ok = window.confirm(`${message}\n\nAstuce: maintiens Shift en cliquant pour confirmer directement.`);
    if (ok) smartConfirmMemoryRef.current[key] = now + 12000;
    return ok;
  }

  function runQuickRecovery() {
    if (readOnlyMode) return;
    const candidates = readRecoveryCandidates();
    const candidate = candidates[0];
    if (!candidate?.state) {
      setQuickRecoveryStatus("Aucune sauvegarde de récupération disponible.");
      return;
    }
    historyNavRef.current = true;
    setState(sanitizeState(candidate.state));
    setQuickRecoveryStatus("Récupération locale appliquée.");
    setDataIntegrityNotice("Récupération rapide appliquée depuis la sauvegarde locale versionnée.");
    logAudit("Récupération rapide", candidate.key);
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
    logAudit("Snapshot", label);
  }

  function restoreSnapshot(snapshotId: string) {
    const snap = snapshots.find((x) => x.id === snapshotId);
    if (!snap) return;
    historyNavRef.current = true;
    setState(sanitizeState(snap.state));
    logAudit("Restauration snapshot", snap.label);
  }

  function undoLastAction() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(sanitizeState(JSON.parse(JSON.stringify(state))));
    historyNavRef.current = true;
    setState(sanitizeState(previous));
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
    lines.push(`Résumé ${currentSeason.name}`);
    lines.push(`Date: ${new Date().toLocaleString("fr-FR")}`);
    lines.push("");
    lines.push("Classement:");
    seasonStats.table.forEach((r, i) => lines.push(`${i + 1}. ${r.name} - ${r.pts} pts (${r.wins} V)`));
    lines.push("");
    lines.push(`Jackpot: ${formatEUR(jackpotEUR)}`);
    lines.push(`Soirées: ${currentSeason.soirees.length}`);
    const text = lines.join("\n");
    downloadTextFile(`resume_${currentSeason.name.replace(/\s+/g, "_")}.txt`, text, "text/plain;charset=utf-8");
    logAudit("Export résumé");
  }

  function exportSeasonSummaryPDF() {
    const rows = seasonStats.table.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.pts}</td><td>${r.wins}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Résumé ${currentSeason.name}</title>
    <style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}</style>
    </head><body><h1>Résumé ${currentSeason.name}</h1><p>Date: ${new Date().toLocaleString("fr-FR")}</p><p>Jackpot: ${formatEUR(jackpotEUR)}</p>
    <table><thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Victoires</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    logAudit("Export résumé PDF");
  }

  function buildSoireeSummaryText(soiree: Soiree) {
    const { pts, wins } = computePointsFromMatches(
      soiree.matches,
      soiree.rebuys,
      soiree.number,
      currentSeason,
      effectiveRules,
      activeSoireeRulePolicies
    );
    const ranking = uniq([...soiree.pools.A, ...soiree.pools.B].map(normName))
      .filter(isNonEmptyString)
      .map((p: string) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name));
    const durationMs = getSoireeDurationMs(soiree, Date.now());
    const lines: string[] = [];
    lines.push(`Résumé Soirée ${soiree.number} - ${currentSeason.name}`);
    lines.push(`Date: ${new Date().toLocaleString("fr-FR")}`);
    lines.push(`Durée: ${durationMs > 0 ? formatDuration(durationMs) : "n/a"}`);
    lines.push(`Matchs joués: ${soiree.matches.filter((m: CoreMatch) => Boolean(normName(m.winner))).length}/${soiree.matches.length}`);
    lines.push(`Re-buys: ${soiree.rebuys.length}`);
    lines.push("");
    lines.push("Classement soirée:");
    ranking.forEach((r, i) => lines.push(`${i + 1}. ${r.name} - ${r.pts} pts (${r.wins} V)`));
    return lines.join("\n");
  }

  function exportSoireeSummaryText(soiree: Soiree) {
    const text = buildSoireeSummaryText(soiree);
    downloadTextFile(`resume_soiree_${soiree.number}.txt`, text, "text/plain;charset=utf-8");
    logAudit("Export résumé soirée", `S${soiree.number}`);
  }

  function exportSoireeSummaryPDF(soiree: Soiree) {
    const { pts, wins } = computePointsFromMatches(
      soiree.matches,
      soiree.rebuys,
      soiree.number,
      currentSeason,
      effectiveRules,
      activeSoireeRulePolicies
    );
    const ranking = uniq([...soiree.pools.A, ...soiree.pools.B].map(normName))
      .filter(isNonEmptyString)
      .map((p: string) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name));
    const rows = ranking
      .map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.pts}</td><td>${r.wins}</td></tr>`)
      .join("");
    const durationMs = getSoireeDurationMs(soiree, Date.now());
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Résumé Soirée ${soiree.number}</title>
    <style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}</style>
    </head><body><h1>Résumé Soirée ${soiree.number}</h1><p>Saison: ${currentSeason.name}</p><p>Date: ${new Date().toLocaleString("fr-FR")}</p>
    <p>Durée: ${durationMs > 0 ? formatDuration(durationMs) : "n/a"} • Re-buys: ${soiree.rebuys.length}</p>
    <table><thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Victoires</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    logAudit("Export résumé soirée PDF", `S${soiree.number}`);
  }

  function buildRankingTimelineSvg(
    labels: number[],
    series: Array<{ player: string; ranks: number[] }>,
    colorByPlayer: Map<string, string>
  ) {
    const width = 720;
    const height = 280;
    const pad = 34;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    const allRanks = series.flatMap((s) => s.ranks);
    const maxRank = Math.max(1, ...allRanks, series.length);
    const steps = Math.max(1, labels.length - 1);

    const xAt = (i: number) => pad + (i / steps) * innerW;
    const yAt = (rank: number) => {
      if (maxRank <= 1) return pad + innerH / 2;
      return pad + ((rank - 1) / (maxRank - 1)) * innerH;
    };

    const grid = Array.from({ length: maxRank }, (_, i) => {
      const y = yAt(i + 1).toFixed(1);
      return `<line x1="${pad}" x2="${pad + innerW}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    }).join("");

    const xLabels = labels
      .map((label, i) => {
        const x = xAt(i).toFixed(1);
        return `<text x="${x}" y="${height - 8}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="10">S${label}</text>`;
      })
      .join("");

    const paths = series
      .map((s) => {
        if (!s.ranks.length) return "";
        const d = s.ranks
          .map((r, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(r).toFixed(1)}`)
          .join(" ");
        const color = colorByPlayer.get(s.player) ?? "#93c5fd";
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join("");

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(8,12,20,0.9)" rx="18" />
      ${grid}
      ${paths}
      ${xLabels}
    </svg>`;
  }

  function buildSoireeHighlightsText(soiree: Soiree) {
    const rankingRows = computeSoireeRankingRows(
      soiree,
      currentSeason,
      effectiveRules,
      activeSoireeRulePolicies
    );
    const highlights = buildSoireeHighlights(soiree, currentSeason, rankingRows);
    const durationMs = getSoireeDurationMs(soiree, Date.now());
    const lines: string[] = [];
    lines.push(`Highlights Soirée ${soiree.number} - ${currentSeason.name}`);
    lines.push(`Date: ${new Date().toLocaleString("fr-FR")}`);
    lines.push(`Durée: ${durationMs > 0 ? formatDuration(durationMs) : "n/a"}`);
    lines.push("");
    if (!highlights.length) {
      lines.push("Aucun highlight détecté.");
    } else {
      highlights.forEach((h, idx) => lines.push(`${idx + 1}. ${h.title} — ${h.detail}`));
    }
    return lines.join("\n");
  }

  function exportSoireeHighlightsText(soiree: Soiree) {
    const text = buildSoireeHighlightsText(soiree);
    downloadTextFile(`highlights_soiree_${soiree.number}.txt`, text, "text/plain;charset=utf-8");
    logAudit("Export highlights", `S${soiree.number}`);
  }

  function exportSoireeHighlightsPDF(soiree: Soiree) {
    const rankingRows = computeSoireeRankingRows(
      soiree,
      currentSeason,
      effectiveRules,
      activeSoireeRulePolicies
    );
    const highlights = buildSoireeHighlights(soiree, currentSeason, rankingRows);
    const durationMs = getSoireeDurationMs(soiree, Date.now());
    const list = highlights.length
      ? `<ol>${highlights.map((h) => `<li><strong>${h.title}</strong> — ${h.detail}</li>`).join("")}</ol>`
      : `<p>Aucun highlight détecté.</p>`;
    const chart = buildRankingTimelineSvg(rankingTimeline.labels, rankingTimeline.series, playerColors);
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Highlights Soirée ${soiree.number}</title>
    <style>
      body{font-family:"Space Grotesk",Arial,sans-serif;background:#0b0f17;color:#e5e7eb;padding:28px}
      h1,h2{font-family:"Syne",Arial,sans-serif;margin:0 0 8px}
      .card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:16px;margin:16px 0}
      ol{padding-left:20px}li{margin:8px 0}
      .meta{color:#94a3b8;font-size:12px}
    </style>
    </head><body>
    <h1>Highlights Soirée ${soiree.number}</h1>
    <div class="meta">Saison: ${currentSeason.name} • ${new Date().toLocaleString("fr-FR")} • Durée: ${durationMs > 0 ? formatDuration(durationMs) : "n/a"}</div>
    <div class="card">${list}</div>
    <h2>Évolution du classement</h2>
    <div class="card">${chart}</div>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    logAudit("Export highlights PDF", `S${soiree.number}`);
  }

  function exportSoireeStatsPDF(soiree: Soiree) {
    const { pts, wins, bonus } = computePointsFromMatches(
      soiree.matches,
      soiree.rebuys,
      soiree.number,
      currentSeason,
      effectiveRules,
      activeSoireeRulePolicies
    );
    const ranking = uniq([...soiree.pools.A, ...soiree.pools.B].map(normName))
      .filter(isNonEmptyString)
      .map((p: string) => ({
        name: p,
        pts: pts.get(p) ?? 0,
        wins: wins.get(p) ?? 0,
        bonus: bonus.get(p) ?? 0,
      }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name));
    const rows = ranking
      .map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.pts}</td><td>${r.wins}</td><td>${r.bonus}</td></tr>`)
      .join("");
    const durationMs = getSoireeDurationMs(soiree, Date.now());
    const highlights = buildSoireeHighlights(soiree, currentSeason, ranking);
    const highlightsHtml = highlights.length
      ? `<ol>${highlights.map((h) => `<li><strong>${h.title}</strong> — ${h.detail}</li>`).join("")}</ol>`
      : `<p>Aucun highlight détecté.</p>`;
    const chart = buildRankingTimelineSvg(rankingTimeline.labels, rankingTimeline.series, playerColors);
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Stats Soirée ${soiree.number}</title>
    <style>
      body{font-family:"Space Grotesk",Arial,sans-serif;background:#0b0f17;color:#e5e7eb;padding:28px}
      h1,h2{font-family:"Syne",Arial,sans-serif;margin:0 0 8px}
      .meta{color:#94a3b8;font-size:12px}
      .card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:16px;margin:16px 0}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th,td{border:1px solid rgba(255,255,255,0.12);padding:8px;text-align:left}
      th{background:rgba(255,255,255,0.06)}
      ol{padding-left:20px}
    </style>
    </head><body>
    <h1>Stats Soirée ${soiree.number}</h1>
    <div class="meta">Saison: ${currentSeason.name} • ${new Date().toLocaleString("fr-FR")}</div>
    <div class="card">Durée: ${durationMs > 0 ? formatDuration(durationMs) : "n/a"} • Re-buys: ${soiree.rebuys.length} • Jackpot: ${formatEUR(computeSoireeJackpotEUR(soiree, currentSeason, effectiveRules, activeSoireeRulePolicies))}</div>
    <h2>Classement</h2>
    <div class="card"><table><thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Victoires</th><th>Bonus</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2>Évolution du classement</h2>
    <div class="card">${chart}</div>
    <h2>Highlights</h2><div class="card">${highlightsHtml}</div>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    logAudit("Export stats soirée PDF", `S${soiree.number}`);
  }

  function setSoireeLockedById(soireeId: string, locked: boolean) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => (s.id === soireeId ? { ...s, locked } : s));
      return { ...season, soirees };
    });
    const so = currentSeason.soirees.find((s: Soiree) => s.id === soireeId);
    logAudit(locked ? "Soirée verrouillée" : "Soirée déverrouillée", so ? `S${so.number}` : soireeId);
  }

  function setCurrentSoireeLocked(locked: boolean) {
    setSoireeLockedById(currentSoiree.id, locked);
  }

  async function generateReadOnlyLink() {
    const code = normName(syncCode).toUpperCase();
    let url = "";
    if (syncEnabled && code) {
      url = `${window.location.origin}${window.location.pathname}#public=${encodeURIComponent(code)}`;
    } else {
      const serialized = JSON.stringify({
        state,
        rulesPdfData,
        rulesPdfName,
      });
      const payload = window.btoa(unescape(encodeURIComponent(serialized)));
      url = `${window.location.origin}${window.location.pathname}#readonly=${payload}`;
    }
    setReadOnlyLink(url);
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
    logAudit("Lien lecture seule");
  }

  async function pullCloudState(options?: { codeOverride?: string; silent?: boolean }) {
    const code = normName(options?.codeOverride ?? syncCode).toUpperCase();
    const silent = Boolean(options?.silent);
    if (!code) {
      if (!silent) setSyncStatus("Code de synchronisation manquant.");
      return;
    }
    const sb = getSupabaseClient();
    if (!sb) {
      if (!silent) setSyncStatus("Supabase non configuré (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
      return;
    }
    if (!silent) setSyncStatus("Chargement cloud…");
    const { data, error } = await sb
      .from("darts_states")
      .select("payload, updated_at")
      .eq("room_code", code)
      .maybeSingle();

    if (error) {
      if (!silent) setSyncStatus(`Erreur cloud: ${error.message}`);
      return;
    }
    if (!data?.payload) {
      if (!silent) setSyncStatus("Aucune sauvegarde cloud trouvée pour ce code.");
      return;
    }
    skipNextCloudPushRef.current = true;
    const shared = parseSharedPayload(data.payload);
    setState(shared.state);
    if (typeof shared.rulesPdfData === "string") setRulesPdfData(shared.rulesPdfData);
    if (typeof shared.rulesPdfName === "string") setRulesPdfName(shared.rulesPdfName);
    if (!silent) setSyncStatus(`Cloud chargé (${new Date(data.updated_at ?? Date.now()).toLocaleString("fr-FR")}).`);
    logAudit("Sync pull cloud", code);
  }

  async function pushCloudState() {
    const code = normName(syncCode).toUpperCase();
    if (!code) return;
    const sb = getSupabaseClient();
    if (!sb) return;
    const payload: SharedPayload = {
      state,
      rulesPdfData,
      rulesPdfName,
    };
    const { error } = await sb.from("darts_states").upsert(
      {
        room_code: code,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "room_code" }
    );
    if (error) {
      setSyncStatus(`Erreur cloud: ${error.message}`);
      return;
    }
    setSyncStatus(`Cloud sauvegardé (${new Date().toLocaleTimeString("fr-FR")}).`);
  }

  function updateFunMode(mutator: (funMode: FunModeState) => FunModeState) {
    setState((prev) => (readOnlyMode ? prev : { ...prev, funMode: mutator(prev.funMode) }));
  }

  function addFunPlayer() {
    const name = normName(funPlayerInput);
    if (!name) return;
    updateFunMode((fun) => {
      if (fun.players.includes(name) || fun.players.length >= 8) return fun;
      return { ...fun, players: [...fun.players, name], matches: [], finals: [], positionRounds: [] };
    });
    setFunPlayerInput("");
  }

  function removeFunPlayer(name: string) {
    updateFunMode((fun) => ({
      ...fun,
      players: fun.players.filter((p) => p !== name),
      matches: [],
      finals: [],
      positionRounds: [],
    }));
  }

  function generateFunSoiree() {
    updateFunMode((fun) => {
      const players = fun.players.slice(0, 8);
      if (players.length < 2) return fun;
      return {
        ...fun,
        matches: buildRoundRobinMatches(players, fun.format),
        finals: [],
        positionRounds: [],
      };
    });
  }

  function setFunMatchWinner(matchId: string, winner: string) {
    updateFunMode((fun) => {
      const matches: CoreMatch[] = fun.matches.map((m): CoreMatch => {
        if (m.id !== matchId) return m;
        const w = normName(winner);
        const valid = w === m.a || w === m.b;
        return { ...m, winner: valid ? w : "", status: valid ? "VALIDATED" : "PENDING", checkout100: false, checkoutBy: "" as const };
      });
      return { ...fun, matches };
    });
  }

  function resetFunMode() {
    updateFunMode(() => makeEmptyFunMode());
    setFunPlayerInput("");
  }

  function setFunFormat(format: 301 | 501) {
    updateFunMode((fun) => ({
      ...fun,
      format,
      matches: fun.matches.map((m) => ({ ...m, format })),
      finals: fun.finals.map((m) => ({ ...m, format })),
    }));
  }

  function generateFunFinals() {
    updateFunMode((fun) => {
      if (funStandings.length < 4) return fun;
      const top4 = funStandings.slice(0, 4).map((r) => r.name);
      const finals: CoreMatch[] = [
        { id: uid("ff"), order: 1, phase: "DEMI", status: "PENDING", pool: null, format: fun.format, bo: "BO3", maxTurns: 10, a: top4[0], b: top4[3], winner: "", checkout100: false, checkoutBy: "" },
        { id: uid("ff"), order: 2, phase: "DEMI", status: "PENDING", pool: null, format: fun.format, bo: "BO3", maxTurns: 10, a: top4[1], b: top4[2], winner: "", checkout100: false, checkoutBy: "" },
        { id: uid("ff"), order: 3, phase: "PFINAL", status: "PENDING", pool: null, format: fun.format, bo: "BO3", maxTurns: 10, a: "", b: "", winner: "", checkout100: false, checkoutBy: "" },
        { id: uid("ff"), order: 4, phase: "FINAL", status: "PENDING", pool: null, format: fun.format, bo: "BO3", maxTurns: 10, a: "", b: "", winner: "", checkout100: false, checkoutBy: "" },
      ];
      return { ...fun, finals };
    });
  }

  function setFunFinalWinner(matchId: string, winner: string) {
    updateFunMode((fun) => {
      const finals = fun.finals.map((m) => {
        if (m.id !== matchId) return m;
        const w = normName(winner);
        const valid = w === m.a || w === m.b;
        return { ...m, winner: valid ? w : "", status: valid ? "VALIDATED" : "PENDING", checkout100: false, checkoutBy: "" as const };
      });

      const demis = finals.filter((m) => m.phase === "DEMI").sort((a, b) => a.order - b.order);
      const final = finals.find((m) => m.phase === "FINAL");
      const pfinal = finals.find((m) => m.phase === "PFINAL");
      if (demis.length === 2 && final && pfinal) {
        const d1 = demis[0];
        const d2 = demis[1];
        const w1 = normName(d1.winner);
        const w2 = normName(d2.winner);
        const l1 = w1 === d1.a ? d1.b : w1 === d1.b ? d1.a : "";
        const l2 = w2 === d2.a ? d2.b : w2 === d2.b ? d2.a : "";
        final.a = w1 && w2 ? w1 : "";
        final.b = w1 && w2 ? w2 : "";
        if (final.winner && final.winner !== final.a && final.winner !== final.b) final.winner = "";
        final.status = final.winner ? "VALIDATED" : "PENDING";
        pfinal.a = l1 && l2 ? l1 : "";
        pfinal.b = l1 && l2 ? l2 : "";
        if (pfinal.winner && pfinal.winner !== pfinal.a && pfinal.winner !== pfinal.b) pfinal.winner = "";
        pfinal.status = pfinal.winner ? "VALIDATED" : "PENDING";
      }
      return { ...fun, finals: [...finals] };
    });
  }

  function addFunPositionRound() {
    updateFunMode((fun) => ({
      ...fun,
      positionRounds: [...fun.positionRounds, { id: uid("fpr"), positions: Array(fun.players.length).fill("") }],
    }));
  }

  function deleteFunPositionRound(id: string) {
    updateFunMode((fun) => ({
      ...fun,
      positionRounds: fun.positionRounds.filter((r) => r.id !== id),
    }));
  }

  function setFunRoundPosition(roundId: string, index: number, player: string) {
    updateFunMode((fun) => {
      const selected = normName(player);
      const positionRounds = fun.positionRounds.map((r) => {
        if (r.id !== roundId) return r;
        const positions = [...r.positions];
        if (selected) {
          for (let i = 0; i < positions.length; i++) {
            if (i !== index && positions[i] === selected) positions[i] = "";
          }
        }
        positions[index] = selected;
        return { ...r, positions };
      });
      return { ...fun, positionRounds };
    });
  }

  function setLiveWinner(matchId: string, source: "POOL" | "FINAL", winner: string) {
    if (source === "POOL") {
      setFunMatchWinner(matchId, winner);
    } else {
      setFunFinalWinner(matchId, winner);
    }
  }

  function goToNextPendingLiveMatch() {
    if (!funLiveMatches.length) return;
    const idx = funLiveMatches.findIndex((m) => !normName(m.winner) && m.a && m.b);
    if (idx >= 0) setFunLiveIndex(idx);
  }

  function updateFinancePayment(player: string, paid: boolean) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const payments = { ...(s.payments ?? {}) };
        payments[player] = paid;
        return { ...s, payments };
      });
      return { ...season, soirees };
    });
  }

  function updateFinanceNotes(notes: string) {
    updateSeason((season) => {
      const soirees = season.soirees.map((s) =>
        s.number === currentSoiree.number ? { ...s, financeNotes: notes } : s
      );
      return { ...season, soirees };
    });
  }

  function updateFinanceAll(paid: boolean) {
    const players = uniq([...currentSoiree.pools.A, ...currentSoiree.pools.B]).filter(isNonEmptyString);
    updateSeason((season) => {
      const soirees = season.soirees.map((s) => {
        if (s.number !== currentSoiree.number) return s;
        const payments = { ...(s.payments ?? {}) };
        players.forEach((p) => {
          payments[p] = paid;
        });
        return { ...s, payments };
      });
      return { ...season, soirees };
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
    if (readOnlyMode) return;
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
    if (readOnlyMode) return;
    setState((prev) => {
      const season = prev.seasons.find((s) => s.id === id) ?? prev.seasons[0];
      const max = Math.max(...season.soirees.map((s) => s.number));
      setSelectedSoireeNumber(max);
      return { ...prev, activeSeasonId: id };
    });
  }

  function renameSeason(id: string, nameRaw: string) {
    if (readOnlyMode) return;
    const name = normName(nameRaw);
    if (!name) return;
    setState((prev) => ({
      ...prev,
      seasons: prev.seasons.map((s) => (s.id === id ? { ...s, name } : s)),
    }));
  }

  function deleteSeason(id: string) {
    if (readOnlyMode) return;
    setState((prev) => {
      if (prev.seasons.length <= 1) return prev;
      const seasons = prev.seasons.filter((s) => s.id !== id);
      const activeSeasonId = prev.activeSeasonId === id ? seasons[0].id : prev.activeSeasonId;
      return { ...prev, seasons, activeSeasonId };
    });
  }

  function deleteSoiree(soireeNumber: number) {
    if (currentSeason.soirees.length <= 1) {
      alert("Tu dois garder au moins une soirée dans la saison.");
      return;
    }
    const ok = confirmSmart("delete-soiree", `Supprimer définitivement la soirée ${soireeNumber} ?`);
    if (!ok) return;

    const remaining = currentSeason.soirees.filter((s) => s.number !== soireeNumber);
    updateSeason((season) => ({
      ...season,
      soirees: season.soirees.filter((s) => s.number !== soireeNumber),
    }));

    if (selectedSoireeNumber === soireeNumber) {
      const next = remaining.length ? Math.max(...remaining.map((s) => s.number)) : 1;
      setSelectedSoireeNumber(next);
    }
    logAudit("Suppression soirée", `Soirée ${soireeNumber}`);
  }

  function setQualifiersOverride(patch: Partial<NonNullable<Soiree["qualifiersOverride"]>>) {
    if (currentSoireeLocked) return;
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
    if (readOnlyMode) return;
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
    const safeName = (currentSeason.name || "Saison").split(" ").join("_");
    const filename = "dark-league_" + safeName + "_soirees-" + String(currentSeason.soirees.length) + ".json";

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
    if (readOnlyMode) return;
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
      logAudit("Import JSON");
    } catch {
      alert("Import impossible : JSON invalide.");
    }
  }

  function triggerImportFile() {
    importFileRef.current?.click();
  }

  function triggerRulesPdfFile() {
    if (readOnlyMode) return;
    rulesPdfFileRef.current?.click();
  }

  function onRulesPdfSelected(e: React.ChangeEvent<HTMLInputElement>) {
    if (readOnlyMode) return;
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      alert("Merci de sélectionner un fichier PDF.");
      e.currentTarget.value = "";
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      alert("PDF trop lourd (> 4 Mo). Utilise une version plus légère.");
      e.currentTarget.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      setRulesPdfData(data);
      setRulesPdfName(file.name);
      logAudit("Règlement PDF importé", file.name);
    };
    reader.readAsDataURL(file);
    e.currentTarget.value = "";
  }

  function clearRulesPdf() {
    if (readOnlyMode) return;
    setRulesPdfData("");
    setRulesPdfName("");
    logAudit("Règlement PDF supprimé");
  }

  function openAttendanceModal() {
    if (readOnlyMode) return;
    if (currentSeason.players.length < 4) {
      alert("Ajoute d’abord les joueurs (au moins 4 pour jouer poules + demis + finales).");
      return;
    }
    setAbsentPlayersSelection([]);
    setNewSoireeFormat("CLASSIC_POOLS");
    setShowAttendanceModal(true);
  }

  function toggleAbsentPlayer(name: string) {
    setAbsentPlayersSelection((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  }

  function setSoireePlayerPresence(player: string, status: PresenceStatus) {
    if (currentSoireeLocked) return;
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const attendance: Record<string, PresenceStatus> = { ...(s.attendance ?? {}) };
        const arrivalEta: Record<string, string> = { ...(s.arrivalEta ?? {}) };
        attendance[player] = status;
        if (status !== "LATE") delete arrivalEta[player];
        const absentSet = new Set((s.absentPlayers ?? []).map(normName).filter(isNonEmptyString));
        if (status === "ABSENT") absentSet.add(player);
        else absentSet.delete(player);
        return {
          ...s,
          attendance,
          arrivalEta,
          absentPlayers: [...absentSet].sort((a: string, b: string) => a.localeCompare(b)),
        };
      });
      return { ...season, soirees };
    });
  }

  function setSoireePlayerEta(player: string, eta: string) {
    if (currentSoireeLocked) return;
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const attendance: Record<string, PresenceStatus> = { ...(s.attendance ?? {}) };
        const arrivalEta: Record<string, string> = { ...(s.arrivalEta ?? {}) };
        attendance[player] = "LATE";
        arrivalEta[player] = eta;
        const absentSet = new Set((s.absentPlayers ?? []).map(normName).filter(isNonEmptyString));
        absentSet.delete(player);
        return { ...s, attendance, arrivalEta, absentPlayers: [...absentSet] };
      });
      return { ...season, soirees };
    });
  }

  function setAllSoireePlayersPresent() {
    if (currentSoireeLocked) return;
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const players = uniq([...s.pools.A, ...s.pools.B].map(normName)).filter(isNonEmptyString);
        const attendance = players.reduce((acc, p) => {
          acc[p] = "HERE";
          return acc;
        }, {} as Record<string, PresenceStatus>);
        return { ...s, attendance, arrivalEta: {}, absentPlayers: [] };
      });
      return { ...season, soirees };
    });
  }

  function focusMatchInPlanning(matchId: string) {
    window.setTimeout(() => {
      const el = document.querySelector(`[data-match-id="${matchId}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }

  function launchFlowMatch(matchId: string) {
    if (readOnlyMode || currentSoireeLocked) return;
    startMatchTimer(matchId);
    setFlowMatchId(matchId);
    focusMatchInPlanning(matchId);
  }

  function launchNextRecommendedMatch() {
    if (readOnlyMode || currentSoireeLocked) return;
    const next = liveSchedule.nextMatch;
    if (!next) return;
    launchFlowMatch(next.id);
    logAudit("Flow soirée", `Lancement match #${next.order}`);
  }

  function startSoireeTimer() {
    if (currentSoireeLocked) return;
    const now = Date.now();
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        return { ...s, startedAt: s.startedAt ?? now, endedAt: undefined };
      });
      return { ...season, soirees };
    });
  }

  function stopSoireeTimer() {
    if (currentSoireeLocked) return;
    const now = Date.now();
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        if (!s.startedAt) return s;
        return { ...s, endedAt: now };
      });
      return { ...season, soirees };
    });
  }

  function startMatchTimer(matchId: string) {
    if (currentSoireeLocked) return;
    const now = Date.now();
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          return { ...m, startedAt: now, endedAt: undefined };
        });
        return { ...s, startedAt: s.startedAt ?? now, endedAt: undefined, matches };
      });
      return { ...season, soirees };
    });
  }

  function startNewSoiree(absentPlayers: string[] = [], requestedFormat: TournamentFormat = newSoireeFormat) {
    const absents = absentPlayers.map(normName).filter(isNonEmptyString);
    const presentPlayers = currentSeason.players.filter((p) => !absents.includes(p));

    if (presentPlayers.length < 4) {
      alert("Pas assez de joueurs présents (minimum 4).");
      return;
    }
    if (presentPlayers.length > 8) {
      alert("Maximum 8 joueurs présents. Marque des absents pour descendre à 8.");
      return;
    }

    const issues = runSeasonDiagnostics(currentSeason);
    if (issues.length > 0) {
      const proceed = window.confirm(
        `Diagnostics: ${issues.length} incohérence(s) détectée(s).\n- ${issues.slice(0, 3).join("\n- ")}\n\nContinuer ?`
      );
      if (!proceed) return;
    }

    updateSeason((season) => {
      const nextNumber = Math.max(...season.soirees.map((s) => s.number)) + 1;
      const players = season.players.filter((p) => presentPlayers.includes(p));
      const chosenFormat: TournamentFormat = requestedFormat;

      let pools: { A: string[]; B: string[] } = { A: [], B: [] };
      let inter: CoreMatch[] = [];

      if (chosenFormat === "CLASSIC_POOLS") {
        if (nextNumber <= 2) {
          const sh = shuffle(players);
          const split = Math.ceil(sh.length / 2);
          pools = { A: sh.slice(0, split), B: sh.slice(split) };
        } else {
          const ranked = aggregateSeasonStats(season, effectiveRules, activeSoireeRulePolicies)
            .table
            .map((x) => x.name)
            .filter((name) => players.includes(name));
          const A: string[] = [];
          const B: string[] = [];
          ranked.forEach((name, idx) => {
            if (idx % 2 === 0) A.push(name);
            else B.push(name);
          });
          pools = { A, B };
        }

        const poolA = poolMatchesFor4(pools.A, "A").map((m) => ({ ...m, format: effectiveRules.defaultPoolFormat }));
        const poolB = poolMatchesFor4(pools.B, "B").map((m) => ({ ...m, format: effectiveRules.defaultPoolFormat }));
        inter = interleavePools(poolA, poolB);
      } else if (chosenFormat === "ROUND_ROBIN") {
        pools = { A: [...players], B: [] };
        const rrPairs = buildRoundRobinMatches(players, effectiveRules.defaultPoolFormat);
        inter = rrPairs.map((m, idx) => ({ ...m, order: idx + 1, pool: "A", status: "PENDING" }));
      } else if (chosenFormat === "SWISS_LITE") {
        pools = { A: [...players], B: [] };
        const pairs = buildGreedyLimitedPairs(players, 3);
        inter = pairs.map(([a, b], idx) => createPoolMatch(idx + 1, a, b, "A", effectiveRules.defaultPoolFormat));
      } else {
        pools = { A: [...players], B: [] };
        const pairs = buildGreedyLimitedPairs(players, 2);
        inter = pairs.map(([a, b], idx) => createPoolMatch(idx + 1, a, b, "A", effectiveRules.defaultPoolFormat));
      }

      const finals = createFinalPhases(inter.length + 1, effectiveRules.defaultPoolFormat, effectiveRules.defaultFinalFormat);

      const newSoiree: Soiree = {
        id: uid("s"),
        number: nextNumber,
        tournamentFormat: chosenFormat,
        createdAt: Date.now(),
        absentPlayers: absents,
        attendance: players.concat(absents).reduce((acc, p) => {
          acc[p] = absents.includes(p) ? "ABSENT" : "HERE";
          return acc;
        }, {} as Record<string, PresenceStatus>),
        arrivalEta: {},
        pools,
        matches: [...inter, ...finals],
        rebuys: [],
        payments: players.reduce((acc, p) => {
          acc[p] = false;
          return acc;
        }, {} as Record<string, boolean>),
        financeNotes: "",
      };

      return { ...season, soirees: [...season.soirees, newSoiree] };
    });

    setShowAttendanceModal(false);
    logAudit("Nouvelle soirée générée", `${presentPlayers.length} joueurs présents • ${getTournamentFormatLabel(requestedFormat)}`);

    setTimeout(() => {
      const max = Math.max(...currentSeason.soirees.map((s: Soiree) => s.number)) + 1;
      setSelectedSoireeNumber(max);
      setTab("SOIREE");
    }, 0);
  }

  function setMatchWinner(matchId: string, winner: string) {
    if (currentSoireeLocked) return;
    const now = Date.now();
    const chosen = normName(winner);
    const target = currentSoiree.matches.find((m: CoreMatch) => m.id === matchId);
    const isValidChoice = Boolean(target && chosen && (chosen === normName(target.a) || chosen === normName(target.b)));
    const shouldTriggerWinnerFx = Boolean(isValidChoice && target && normName(target.winner) !== chosen);
    const loser = isValidChoice && target ? (chosen === target.a ? target.b : target.a) : "";
    const rankMap = new Map(seasonStats.table.map((r, idx: number) => [r.name, idx + 1] as const));
    const winnerRank = rankMap.get(chosen) ?? seasonStats.table.length + 1;
    const loserRank = rankMap.get(loser) ?? seasonStats.table.length + 1;
    const isUpset = Boolean(isValidChoice && loser && winnerRank >= loserRank + 3);
    const isCheckoutClutch = Boolean(
      isValidChoice &&
        target &&
        target.checkoutBy &&
        ((target.checkoutBy === "A" && chosen === target.a) || (target.checkoutBy === "B" && chosen === target.b))
    );
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches: CoreMatch[] = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          const w = normName(winner);
          const valid = w && (w === normName(m.a) || w === normName(m.b));
          return {
            ...m,
            winner: valid ? w : "",
            status: valid ? "VALIDATED" : "PENDING",
            checkoutBy: !m.a || !m.b ? "" : m.checkoutBy,
            checkout100: !m.a || !m.b ? false : Boolean(m.checkoutBy),
            startedAt: valid ? m.startedAt ?? now : m.startedAt,
            endedAt: valid ? now : undefined,
          } as CoreMatch;
        });
        const hasPending = matches.some((m: CoreMatch) => !normName(m.winner));
        return {
          ...s,
          startedAt: s.startedAt ?? now,
          endedAt: hasPending ? undefined : s.endedAt ?? now,
          matches,
        };
      });
      return { ...season, soirees };
    });
    if (isValidChoice && flowAutoAdvance) {
      setQueuedAutoAdvanceFromMatchId(matchId);
    } else if (!isValidChoice && flowMatchId === matchId) {
      setFlowMatchId("");
    }
    if (isValidChoice) {
      if (isCheckoutClutch) {
        pushCinematicMoment("Checkout Clutch", [`${chosen} conclut sur checkout`, target?.phase ?? ""], "amber", "checkout");
      } else if (target?.phase === "FINAL") {
        pushCinematicMoment("Finale en feu", [`${chosen} prend la finale`, loser ? `contre ${loser}` : ""], "fuchsia", "clutch");
      } else if (isUpset) {
        pushCinematicMoment("Upset!", [`${chosen} surprend ${loser}`, "Renversement de tendance"], "emerald", "clutch");
      } else if (target?.phase === "DEMI") {
        pushCinematicMoment("Demi validée", [`${chosen} gagne sa demi-finale`], "cyan", "match");
      } else {
        playSfx("match");
      }
    }
    if (shouldTriggerWinnerFx) {
      setWinnerFxMatchId(matchId);
      if (winnerFxTimerRef.current) window.clearTimeout(winnerFxTimerRef.current);
      winnerFxTimerRef.current = window.setTimeout(() => {
        setWinnerFxMatchId((prev) => (prev === matchId ? "" : prev));
      }, 1300);
    }
  }

  function setMatchStatus(matchId: string, status: MatchStatus) {
    if (currentSoireeLocked) return;
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches = s.matches.map((m: CoreMatch) => (m.id === matchId ? { ...m, status } : m));
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
    logAudit("Statut match", `${matchId} -> ${status}`);
  }

  function setMatchCheckoutBy(matchId: string, checkoutBy: "" | "A" | "B") {
    if (currentSoireeLocked) return;
    const target = currentSoiree.matches.find((m: CoreMatch) => m.id === matchId);
    const previousBy = target?.checkoutBy ?? "";
    updateSeason((season) => {
      const soirees = season.soirees.map((s: Soiree) => {
        if (s.number !== currentSoiree.number) return s;
        const matches: CoreMatch[] = s.matches.map((m: CoreMatch) => {
          if (m.id !== matchId) return m;
          if (!m.a || !m.b) return { ...m, checkoutBy: "", checkout100: false };
          const by: "" | "A" | "B" = checkoutBy;
          return { ...m, checkoutBy: by, checkout100: Boolean(by) } as CoreMatch;
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
    if (checkoutBy && checkoutBy !== previousBy) {
      const player = checkoutBy === "A" ? target?.a : target?.b;
      pushCinematicMoment("Bonus Checkout", [player ? `${player} active le bonus` : "Bonus checkout activé"], "amber", "checkout");
    }
  }

  function swapMatchPlayers(matchId: string) {
    if (currentSoireeLocked) return;
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
    if (currentSoireeLocked) return;
    const A = computePoolRows(currentSoiree, "A", currentSeason, effectiveRules, activeSoireeRulePolicies);
    const B = computePoolRows(currentSoiree, "B", currentSeason, effectiveRules, activeSoireeRulePolicies);
    const fairMode = useGlobalTop4Qualification(currentSoiree);

    const ov = currentSoiree.qualifiersOverride ?? {};
    const A1 = ov.A1 || (A[0]?.name ?? "");
    const A2 = ov.A2 || (A[1]?.name ?? "");
    const B1 = ov.B1 || (B[0]?.name ?? "");
    const B2 = ov.B2 || (B[1]?.name ?? "");

    const globalTop4 = [...A, ...B]
      .slice()
      .sort((a, b) => b.avg - a.avg || b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name))
      .slice(0, 4)
      .map((x) => x.name);

    const D1A = fairMode ? globalTop4[0] ?? "" : A1;
    const D1B = fairMode ? globalTop4[3] ?? "" : B2;
    const D2A = fairMode ? globalTop4[1] ?? "" : B1;
    const D2B = fairMode ? globalTop4[2] ?? "" : A2;

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
            const winner = m.winner && (m.winner === D1A || m.winner === D1B) ? m.winner : "";
            return { ...m, a: D1A, b: D1B, winner, status: winner ? "VALIDATED" : "PENDING", endedAt: winner ? m.endedAt : undefined };
          }
          if (demiIndex === 1) {
            const winner = m.winner && (m.winner === D2A || m.winner === D2B) ? m.winner : "";
            return { ...m, a: D2A, b: D2B, winner, status: winner ? "VALIDATED" : "PENDING", endedAt: winner ? m.endedAt : undefined };
          }
          return m;
        });

        return { ...s, matches };
      });

      return { ...season, soirees };
    });
  }

  function recalcFinalAndPFinal() {
    if (currentSoireeLocked) return;
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
            return {
              ...m,
              a,
              b,
              winner: keepWinner,
              status: keepWinner ? "VALIDATED" : "PENDING",
              endedAt: keepWinner ? m.endedAt : undefined,
            };
          }
          if (m.phase === "PFINAL") {
            const a = l1 && l2 ? l1 : "";
            const b = l1 && l2 ? l2 : "";
            const keepWinner = m.winner && (m.winner === a || m.winner === b) ? m.winner : "";
            return {
              ...m,
              a,
              b,
              winner: keepWinner,
              status: keepWinner ? "VALIDATED" : "PENDING",
              endedAt: keepWinner ? m.endedAt : undefined,
            };
          }
          return m;
        });
        return { ...s, matches };
      });
      return { ...season, soirees };
    });
  }

  function addRebuy() {
    if (currentSoireeLocked) return;
    if (finalNightMode && rebuyLockedByPhase) {
      alert("Mode Final: les re-buys sont fermés dès le début des phases finales.");
      return;
    }
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
    if (currentSoireeLocked) return;
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
    if (currentSoireeLocked) return;
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
      const { pts, wins } = computePointsFromMatches(
        currentSoiree.matches,
        [],
        currentSoiree.number,
        currentSeason,
        effectiveRules,
        activeSoireeRulePolicies
      );
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
  }, [currentSoiree.matches, currentSoiree.number, currentSeason, effectiveRules, activeSoireeRulePolicies]);


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
        const { pts, wins } = computePointsFromMatches(
          s.matches,
          [],
          s.number,
          currentSeason,
          effectiveRules,
          activeSoireeRulePolicies
        );
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
  }, [currentSeason.players, currentSeason.soirees, effectiveRules, activeSoireeRulePolicies]);

  const closureSoireePodium = useMemo(() => {
    if (!closureSoiree) return null;
    return computeSoireePodium(closureSoiree, closureSeason, effectiveRules, activeSoireeRulePolicies);
  }, [closureSoiree, closureSeason, effectiveRules, activeSoireeRulePolicies]);

  const closureSoireeRankingRows = useMemo(() => {
    if (!closureSoiree) return [];
    return computeSoireeRankingRows(closureSoiree, closureSeason, effectiveRules, activeSoireeRulePolicies);
  }, [closureSoiree, closureSeason, effectiveRules, activeSoireeRulePolicies]);
  const closureSoireeHighlights = useMemo(() => {
    if (!closureSoiree) return [];
    return buildSoireeHighlights(closureSoiree, closureSeason, closureSoireeRankingRows);
  }, [closureSoiree, closureSeason, closureSoireeRankingRows, effectiveRules, activeSoireeRulePolicies]);

  useEffect(() => {
    if (readOnlyMode) return;
    if (!showSoireeClosureModal || !closureSoiree) return;
    if (closureAutoExportDoneRef.current === closureSoiree.id) return;

    const text = buildSoireeSummaryText(closureSoiree);
    const filename = `resume_soiree_${closureSoiree.number}_auto.txt`;
    try {
      downloadTextFile(filename, text, "text/plain;charset=utf-8");
      setClosureAutoExportStatus(`Auto-export effectué: ${filename}`);
      logAudit("Auto-export fin de soirée", `S${closureSoiree.number}`);
    } catch {
      setClosureAutoExportStatus("Auto-export bloqué par le navigateur. Utilise les boutons d'export ci-dessous.");
    }
    closureAutoExportDoneRef.current = closureSoiree.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSoireeClosureModal, closureSoiree, readOnlyMode]);

  useEffect(() => {
    if (!showSoireeClosureModal || !closureSoiree) return;
    playSfx("podium");
    if (closureSoireePodium?.first) {
      pushCinematicMoment(
        `Podium validé • ${closureSeason.name}`,
        [
          `1. ${closureSoireePodium.first}`,
          `2. ${closureSoireePodium.second || "—"} • 3. ${closureSoireePodium.third || "—"}`,
        ],
        "fuchsia"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSoireeClosureModal, closureSoiree?.id]);

  const rankingTimeline = useMemo(() => {
    const players = currentSeason.players;
    const soirees = [...currentSeason.soirees].sort((a: Soiree, b: Soiree) => a.number - b.number);
    const totals = new Map<string, { pts: number; wins: number; bonus: number }>();
    players.forEach((p: string) => totals.set(p, { pts: 0, wins: 0, bonus: 0 }));

    const series = new Map<string, number[]>();
    players.forEach((p: string) => series.set(p, []));

    for (const s of soirees) {
      const { pts, wins, bonus } = computePointsFromMatches(
        s.matches,
        s.rebuys,
        s.number,
        currentSeason,
        effectiveRules,
        activeSoireeRulePolicies
      );
      for (const p of players) {
        const t = totals.get(p)!;
        totals.set(p, {
          pts: t.pts + (pts.get(p) ?? 0),
          wins: t.wins + (wins.get(p) ?? 0),
          bonus: t.bonus + (bonus.get(p) ?? 0),
        });
      }

      const table = players
        .map((p: string) => ({ name: p, ...(totals.get(p) ?? { pts: 0, wins: 0, bonus: 0 }) }))
        .sort(
          (
            a: { name: string; pts: number; wins: number; bonus: number },
            b: { name: string; pts: number; wins: number; bonus: number }
          ) => b.pts - a.pts || b.wins - a.wins || b.bonus - a.bonus || a.name.localeCompare(b.name)
        );

      table.forEach((row: { name: string }, idx: number) => {
        series.get(row.name)!.push(idx + 1);
      });
    }

    return {
      labels: soirees.map((s: Soiree) => s.number),
      series: players.map((p: string) => ({ player: p, ranks: series.get(p) ?? [] })),
    };
  }, [currentSeason.players, currentSeason.soirees, effectiveRules, activeSoireeRulePolicies]);

  const dynamicPerformanceRows = useMemo(() => {
    const players = currentSeason.players;
    const soirees = [...currentSeason.soirees].sort((a: Soiree, b: Soiree) => a.number - b.number);
    const results = new Map<string, Array<"W" | "L">>();
    players.forEach((p: string) => results.set(p, []));

    for (const s of soirees) {
      const core = [...s.matches].sort((a: CoreMatch, b: CoreMatch) => a.order - b.order);
      for (const m of core) {
        const a = normName(m.a);
        const b = normName(m.b);
        const w = normName(m.winner);
        if (!a || !b || !w) continue;
        if (!players.includes(a) || !players.includes(b)) continue;
        if (w !== a && w !== b) continue;
        results.get(a)?.push(w === a ? "W" : "L");
        results.get(b)?.push(w === b ? "W" : "L");
      }

      const rebuys = [...s.rebuys].sort((a: RebuyMatch, b: RebuyMatch) => a.createdAt - b.createdAt);
      for (const r of rebuys) {
        const a = normName(r.a);
        const b = normName(r.b);
        const w = normName(r.winner);
        if (!a || !b || !w) continue;
        if (!players.includes(a) || !players.includes(b)) continue;
        if (w !== a && w !== b) continue;
        results.get(a)?.push(w === a ? "W" : "L");
        results.get(b)?.push(w === b ? "W" : "L");
      }
    }

    const winRateMap = new Map(advancedStats.winRates.map((r) => [r.player, r.rate] as const));
    const clutchMap = new Map(advancedStats.clutch.map((r) => [r.player, r.rate] as const));
    const currentRankMap = new Map(seasonStats.table.map((r, idx: number) => [r.name, idx + 1] as const));
    const prevRankMap = new Map<string, number>();
    if (rankingTimeline.labels.length >= 2) {
      rankingTimeline.series.forEach((ser: { player: string; ranks: number[] }) => {
        const prev = ser.ranks[ser.ranks.length - 2];
        if (typeof prev === "number") prevRankMap.set(ser.player, prev);
      });
    }

    const rows = players.map((player: string) => {
      const seq = results.get(player) ?? [];
      const recent = seq.slice(-5);
      const recentWins = recent.filter((x) => x === "W").length;
      const recentPlayed = recent.length;
      const recentRate = recentPlayed > 0 ? recentWins / recentPlayed : 0;

      let maxLow = 0;
      let run = 0;
      for (const x of seq) {
        if (x === "L") {
          run += 1;
          if (run > maxLow) maxLow = run;
        } else {
          run = 0;
        }
      }

      let currentLow = 0;
      for (let i = seq.length - 1; i >= 0 && seq[i] === "L"; i--) currentLow += 1;

      const rank = currentRankMap.get(player) ?? players.length;
      const prevRank = prevRankMap.get(player);
      const rankDelta = typeof prevRank === "number" ? prevRank - rank : 0;
      const winRate = winRateMap.get(player) ?? 0;
      const clutch = clutchMap.get(player) ?? 0;
      const momentumFactor = (Math.max(-3, Math.min(3, rankDelta)) + 3) / 6; // 0..1

      const power = Math.round(
        winRate * 0.42 +
          recentRate * 100 * 0.33 +
          clutch * 0.15 +
          momentumFactor * 10
      );

      return {
        player,
        rank,
        prevRank: prevRank ?? null,
        rankDelta,
        recent,
        recentWins,
        recentPlayed,
        recentRate: Math.round(recentRate * 1000) / 10,
        lowStreak: maxLow,
        currentLow,
        winRate,
        clutch,
        power,
      };
    });

    rows.sort((a, b) => {
      if (performanceSort === "FORM") {
        if (b.recentRate !== a.recentRate) return b.recentRate - a.recentRate;
        if (b.recentWins !== a.recentWins) return b.recentWins - a.recentWins;
      } else if (performanceSort === "DYNAMIC") {
        if (b.rankDelta !== a.rankDelta) return b.rankDelta - a.rankDelta;
      } else if (performanceSort === "LOWS") {
        if (a.lowStreak !== b.lowStreak) return a.lowStreak - b.lowStreak;
        if (a.currentLow !== b.currentLow) return a.currentLow - b.currentLow;
      } else {
        if (b.power !== a.power) return b.power - a.power;
      }
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.player.localeCompare(b.player);
    });

    return rows;
  }, [
    currentSeason.players,
    currentSeason.soirees,
    advancedStats.winRates,
    advancedStats.clutch,
    seasonStats.table,
    rankingTimeline.labels.length,
    rankingTimeline.series,
    performanceSort,
  ]);

  useEffect(() => {
    const maxStep = Math.max(0, rankingTimeline.labels.length - 1);
    if (timelineStep > maxStep) setTimelineStep(maxStep);
  }, [rankingTimeline.labels.length, timelineStep]);

  useEffect(() => {
    if (!timelinePlay || rankingTimeline.labels.length === 0) return;
    const handle = window.setInterval(() => {
      setTimelineStep((prev) => {
        const maxStep = Math.max(0, rankingTimeline.labels.length - 1);
        return prev >= maxStep ? 0 : prev + 1;
      });
    }, timelineSpeedMs);
    return () => window.clearInterval(handle);
  }, [timelinePlay, timelineSpeedMs, rankingTimeline.labels.length]);


  return (
    <div
      className={`min-h-screen text-white app-shell ${tvMode ? `tv-mode tv-scene-${tvScene.toLowerCase()} tv-display-${tvDisplayMode.toLowerCase()} tv-density-${tvInfoDensity.toLowerCase()}` : ""} ${
        tab === "SOIREE" && finalNightMode ? "final-night-shell" : ""
      }`}
    >
      {showFinalNightBurst && tab === "SOIREE" && finalNightMode && (
        <div className="final-night-burst" aria-hidden="true">
          <div className="final-night-burst-title">FINAL NIGHT</div>
        </div>
      )}
      {showFinalNightIntro && tvMode && tab === "SOIREE" && finalNightMode && (
        <div className="final-night-intro" aria-hidden="true">
          <div className="final-night-intro-title">DARTS LEAGUE • FINAL NIGHT</div>
          <div className="final-night-intro-subtitle">{currentSeason.name} • Soirée {currentSoiree.number}</div>
        </div>
      )}
      <div className="mx-auto max-w-6xl px-4 pt-6 pb-24 md:pb-6">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <div className={`dl-logo-3d ${tvMode ? "is-tv" : ""} ${logoLoadError ? "is-fallback" : "has-image"}`}>
                {!logoLoadError && (
                  <img
                    src="/dl-logo.png"
                    alt="Darts League logo"
                    className="dl-logo-3d-img"
                    onError={() => setLogoLoadError(true)}
                  />
                )}
                <div className="dl-logo-3d-fallback">DL</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.3em] text-white/50">Darts League</div>
                <h1 className="text-2xl font-extrabold">Quartier Général 🎯</h1>
                <div className="mt-1 text-sm text-white/70">{currentSeason.name} • Sauvegarde locale</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Pill color="#22c55e">
                Jackpot: <AnimatedMetric value={jackpotEUR} kind="eur" durationMs={900} />
              </Pill>
              <Pill>Joueurs: {currentSeason.players.length}</Pill>
              <Pill>Soirées: {currentSeason.soirees.length}</Pill>
              {readOnlyMode && <Pill color="#eab308">Lecture seule</Pill>}
              {tvMode && <Pill color="#38bdf8">MODE TV</Pill>}
              {tvMode && <Pill>Écran: {tvTabs.includes(tab as TvTab) ? tvLabels[tab as TvTab] : tab}</Pill>}
              {tab === "SOIREE" && finalNightMode && (
                <Pill color="#f97316">
                  {activeSoireeRulePolicy?.label || "Règles spéciales"} • Soirée {activePolicySoireeNumber}
                </Pill>
              )}
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2 md:items-end dl-top-actions">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setTvMode((v) => !v)}
                className={`dl-mode-pill dl-mode-pill-tv rounded-2xl border px-4 py-2 text-sm font-semibold transition ${tvMode ? "is-active" : ""} ${
                  tvMode
                    ? "border-cyan-300/80 bg-gradient-to-r from-cyan-300 to-blue-400 text-black shadow-[0_0_24px_rgba(34,211,238,0.45)]"
                    : "border-cyan-300/40 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20"
                }`}
              >
                {tvMode ? "Mode TV • ON" : "Mode TV"}
              </button>
              {!readOnlyMode && (
                <button
                  onClick={() => setTab(tab === "FUN" ? "SOIREE" : "FUN")}
                  className={`dl-mode-pill dl-mode-pill-fun rounded-2xl border px-4 py-2 text-sm font-semibold transition ${tab === "FUN" ? "is-active" : ""} ${
                    tab === "FUN"
                      ? "border-fuchsia-300/80 bg-gradient-to-r from-fuchsia-300 to-orange-300 text-black shadow-[0_0_24px_rgba(244,114,182,0.4)]"
                      : "border-fuchsia-300/40 bg-fuchsia-400/10 text-fuchsia-100 hover:bg-fuchsia-400/20"
                  }`}
                >
                  {tab === "FUN" ? "Mode Fun • ACTIF" : "Mode Fun"}
                </button>
              )}
              {!tvMode && !readOnlyMode && (
                <Button variant={operatorFullscreen ? "primary" : "ghost"} onClick={() => setOperatorFullscreen((v) => !v)}>
                  {operatorFullscreen ? "Quitter Opérateur" : "Mode Opérateur"}
                </Button>
              )}
            </div>
            {!tvMode && !readOnlyMode && (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => openAttendanceModal()}>
                  Générer une soirée
                </Button>
                <Button variant="danger" onClick={(e) => confirmSmart("reset-all", "Confirmer le reset complet ? Cette action supprime la saison en cours.", e) && resetAll()}>
                  Reset complet
                </Button>
              </div>
            )}
          </div>
        </div>

        {dataIntegrityNotice && !readOnlyMode && (
          <div className="mb-4 rounded-2xl border border-amber-300/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>{dataIntegrityNotice}</div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => runQuickRecovery()} title="Restaurer la sauvegarde de récupération locale" size="touch">
                  Récupération rapide
                </Button>
                <Button variant="ghost" onClick={() => setDataIntegrityNotice("")}>
                  Fermer
                </Button>
              </div>
            </div>
          </div>
        )}

        {tvMode && tab !== "CLASSEMENT" && !tvFocusMode && (
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {seasonStats.table.slice(0, 3).map((r, idx) => {
              const label = idx === 0 ? "Champion" : idx === 1 ? "Challenger" : "Contender";
              const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
              return (
                <div
                  key={r.name}
                  className={`relative rounded-2xl border border-white/10 bg-black/40 p-5 shadow-[0_30px_80px_rgba(0,0,0,0.35)] ${
                    idx === 0 ? "ring-2 ring-emerald-400/40 tv-spotlight" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-[0.3em] text-white/50">{label}</div>
                    <div className="text-2xl">{medal}</div>
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full" style={{ background: playerColors.get(r.name) ?? "#ffffff33" }} />
                    <div className="text-xl font-extrabold">{r.name}</div>
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-sm text-white/70">
                    <span className="font-semibold text-white"><AnimatedMetric value={r.pts} kind="int" durationMs={450} /> pts</span>
                    <span>• <AnimatedMetric value={r.wins} kind="int" durationMs={450} /> V</span>
                    <span>• <AnimatedMetric value={r.bonus} kind="int" durationMs={450} /> B</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tvMode && tab === "SOIREE" && (
          <div className="mb-4 tv-scene-banner rounded-2xl border border-white/10 bg-black/35 p-4 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-white/60">Arena Scene</div>
                <div className="mt-1 text-xl font-extrabold">{tvSceneMeta.label}</div>
                <div className="text-xs text-white/70">{tvSceneMeta.subtitle}</div>
              </div>
              <Pill color={tvSceneColor}>
                {tvScene}
              </Pill>
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && tvLiveFocus && (
          <div className="mb-4 tv-lower-third rounded-2xl border border-white/10 bg-black/45 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[11px] uppercase tracking-[0.22em] text-white/60">
                Match Focus • Table Live
              </div>
              <div className="text-xs text-white/60">
                #{tvLiveFocus.order} • {tvLiveFocus.phase}
                {tvLiveFocus.pool ? ` ${tvLiveFocus.pool}` : ""}
              </div>
            </div>
            <div className="mt-1 text-xl font-extrabold">
              {tvLiveFocus.a || "—"} <span className="text-white/40">VS</span> {tvLiveFocus.b || "—"}
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && (
          <div className="mb-4 tv-scoreboard-strip rounded-2xl border border-white/10 bg-black/45 px-4 py-3">
            <div className={`grid grid-cols-1 gap-3 ${tvFocusMode ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/60">Scoreboard Live</div>
                {tvLiveFocus ? (
                  <div className="mt-1 text-sm font-semibold">
                    {tvLiveFocus.a} <span className="text-white/40">vs</span> {tvLiveFocus.b}
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-white/70">Aucun match en focus</div>
                )}
                {tvLiveFocus && (
                  <div className="mt-1 text-xs text-white/70">
                    PTS soirée: {tvLiveFocus.a}{" "}
                    <AnimatedMetric value={liveSoireeRankingMap.get(tvLiveFocus.a)?.pts ?? 0} kind="int" durationMs={420} /> •{" "}
                    {tvLiveFocus.b} <AnimatedMetric value={liveSoireeRankingMap.get(tvLiveFocus.b)?.pts ?? 0} kind="int" durationMs={420} />
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/60">Prochain Match</div>
                {tvNextMatch ? (
                  <>
                    <div className="mt-1 text-sm font-semibold">
                      #{tvNextMatch.order} • {tvNextMatch.a} vs {tvNextMatch.b}
                    </div>
                    <div className="mt-1 text-xs text-white/70">{tvNextMatch.phase}{tvNextMatch.pool ? ` • Poule ${tvNextMatch.pool}` : ""}</div>
                  </>
                ) : (
                  <div className="mt-1 text-sm text-white/70">En attente / soirée terminée</div>
                )}
              </div>
              {!tvFocusMode && (
                <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-white/60">ETA Soirée</div>
                  <div className="mt-1 text-sm font-semibold">
                    {soireeEta.expectedPlayableCount > 0 ? formatTimeHM(soireeEta.etaMs) : "—"}
                  </div>
                  <div className="mt-1 text-xs text-white/70">
                    Restants: <AnimatedMetric value={soireeEta.expectedPlayableCount} kind="int" durationMs={420} /> matchs • {formatDuration(soireeEta.remainingMs)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && tvPlayerCards.length > 0 && !tvFocusMode && (
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {tvPlayerCards.map((p) => (
              <div key={p.name} className="tv-player-card rounded-2xl border border-white/10 bg-black/45 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ background: getPlayerColor(p.name) }} />
                    <div className="text-lg font-extrabold">{p.name}</div>
                  </div>
                  <Pill color="#38bdf8">Rank #{p.seasonRank || "—"}</Pill>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1">
                    Saison: <span className="font-semibold"><AnimatedMetric value={p.seasonPts} kind="int" durationMs={380} /></span> pts •{" "}
                    <span className="font-semibold"><AnimatedMetric value={p.seasonWins} kind="int" durationMs={380} /></span> V
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1">
                    Soirée: <span className="font-semibold"><AnimatedMetric value={p.soireePts} kind="int" durationMs={380} /></span> pts •{" "}
                    <span className="font-semibold"><AnimatedMetric value={p.soireeWins} kind="int" durationMs={380} /></span> V
                  </div>
                </div>
                <div className="mt-2 text-xs text-white/70">
                  Forme récente: <span className="font-semibold text-white">{p.form}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tvMode && tvBroadcastOverlayKind && (
          <div className={`mb-4 rounded-2xl border px-4 py-3 tv-broadcast-overlay tv-broadcast-${tvBroadcastOverlayKind.toLowerCase()}`}>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/70">
              {tvBroadcastOverlayKind === "SPONSOR" ? "Sponsor" : tvBroadcastOverlayKind === "PAUSE" ? "Pause Technique" : "Annonce Officielle"}
            </div>
            <div className="mt-1 text-lg font-extrabold">
              {tvBroadcastOverlayKind === "SPONSOR"
                ? "Merci à nos sponsors"
                : tvBroadcastOverlayKind === "PAUSE"
                  ? "Pause en cours • reprise imminente"
                  : normName(tvBroadcastAnnouncement) || "Annonce officielle"}
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && cinematicMoment && (
          <div className={`mb-4 rounded-2xl border px-4 py-3 tv-cinematic-overlay tv-overlay-${cinematicMoment.tone}`}>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/70">Moment Cinématique</div>
            <div className="mt-1 text-lg font-extrabold">{cinematicMoment.title}</div>
            <div className="mt-1 space-y-0.5 text-sm text-white/80">
              {cinematicMoment.lines.map((line, idx: number) => (
                <div key={`${cinematicMoment.id}-line-${idx}`}>{line}</div>
              ))}
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && tvScene === "PODIUM" && currentSoireeHighlights.length > 0 && (
          <div className="mb-4 tv-highlights-carousel rounded-2xl border border-white/10 bg-black/45 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.24em] text-white/60">Highlights Auto</div>
              <Pill>
                {Math.min(highlightIndex + 1, currentSoireeHighlights.length)}/{currentSoireeHighlights.length}
              </Pill>
            </div>
            <div className="mt-1 text-lg font-extrabold">{currentSoireeHighlights[highlightIndex]?.title}</div>
            <div className="text-sm text-white/80">{currentSoireeHighlights[highlightIndex]?.detail}</div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && tvSceneFlash && (
          <div className="mb-4 rounded-2xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-3 tv-scene-transition">
            <div className="text-[11px] uppercase tracking-[0.28em] text-cyan-100/80">Transition scène</div>
            <div className="mt-1 text-lg font-extrabold">Mode {tvSceneFlash}</div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && tvOverlayCard && !tvFocusMode && (
          <div className={`mb-4 rounded-2xl border px-4 py-3 tv-overlay-card tv-overlay-${tvOverlayCard.tone}`} key={`${tvOverlayCard.id}-${tvOverlayIndex}`}>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/70">{tvOverlayCard.title}</div>
            <div className="mt-2 space-y-1 text-sm">
              {tvOverlayCard.lines.slice(0, 3).map((line, idx: number) => (
                <div key={`${tvOverlayCard.id}-line-${idx}`} className="tv-overlay-line">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && (
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="tv-main-stage lg:col-span-2 rounded-2xl border border-cyan-300/25 bg-gradient-to-br from-cyan-500/15 via-black/40 to-emerald-500/10 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-[0.28em] text-cyan-200/90">Live Match</div>
                {tvLiveFocus ? (
                  <Pill color={tvLiveFocus.startedAt && !normName(tvLiveFocus.winner) ? "#06b6d4" : "#22c55e"}>
                    {tvLiveFocus.startedAt && !normName(tvLiveFocus.winner) ? "En cours" : "À jouer"}
                  </Pill>
                ) : (
                  <Pill>Aucun match</Pill>
                )}
              </div>

              {tvLiveFocus ? (
                <>
                  <div className="mt-4 grid grid-cols-[1fr,auto,1fr] items-center gap-4">
                    <div className="tv-main-player text-3xl font-extrabold tracking-tight">{tvLiveFocus.a || "—"}</div>
                    <div className="tv-main-versus text-white/50 text-xl">VS</div>
                    <div className="tv-main-player text-right text-3xl font-extrabold tracking-tight">{tvLiveFocus.b || "—"}</div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="text-[11px] text-white/60">Chrono match</div>
                      <div className="tv-main-chrono mt-1 text-3xl font-black">
                        {tvLiveFocus.startedAt ? formatDuration(getMatchDurationMs(tvLiveFocus, clockNow)) : "00:00"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="text-[11px] text-white/60">Phase</div>
                      <div className="tv-main-meta mt-1 text-xl font-extrabold">
                        {tvLiveFocus.phase}
                        {tvLiveFocus.pool ? ` ${tvLiveFocus.pool}` : ""}
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="text-[11px] text-white/60">Format</div>
                      <div className="tv-main-meta mt-1 text-xl font-extrabold">{tvLiveFocus.format}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-4 text-sm text-white/70">Aucun match à afficher pour le moment.</div>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-white/50">Prochains matchs</div>
                <div className="mt-2 space-y-2 text-sm">
                  {liveSchedule.candidates
                    .filter((c) => c.match.id !== tvLiveFocus?.id)
                    .slice(0, 3)
                    .map((c, idx: number) => (
                      <div key={c.match.id} className="rounded-lg bg-black/25 px-2 py-2">
                        <div className="text-white/70 text-xs">{idx + 1}. recommandé</div>
                        <div className="font-semibold">#{c.match.order} {c.match.a} vs {c.match.b}</div>
                      </div>
                    ))}
                  {liveSchedule.candidates.filter((c) => c.match.id !== tvLiveFocus?.id).length === 0 && (
                    <div className="text-xs text-white/60">Pas d’autre match jouable actuellement.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-white/50">Fin estimée soirée</div>
                <div className="mt-1 text-2xl font-extrabold">{soireeEta.expectedPlayableCount > 0 ? formatTimeHM(soireeEta.etaMs) : "—"}</div>
                <div className="text-xs text-white/60 mt-1">
                  Restant: {soireeEta.expectedPlayableCount} matchs • {formatDuration(soireeEta.remainingMs)}
                </div>
                {soireeEta.waitGapMs > 0 && (
                  <div className="mt-1 text-xs text-yellow-300">Attente retards estimée: {formatDuration(soireeEta.waitGapMs)}</div>
                )}
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-white/50">Classement live (soirée)</div>
                <div className="mt-2 space-y-1 text-sm">
                  {liveSoireeRanking.slice(0, 5).map((r, idx: number) => (
                    <div key={r.name} className="flex items-center justify-between rounded-lg bg-black/25 px-2 py-1">
                      <span className="text-white/70">{idx + 1}. {r.name}</span>
                      <span className="font-bold">
                        <AnimatedMetric value={r.pts} kind="int" durationMs={450} /> pts
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {tvMode && tab === "SOIREE" && finalNightMode && !currentPodium.provisional && (
          <div className="mb-6 final-night-credits rounded-2xl border border-fuchsia-300/30 bg-black/50 p-4">
            <div className="text-[11px] uppercase tracking-[0.28em] text-fuchsia-200/80">Final Night Credits</div>
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
              <div className="rounded-xl border border-yellow-300/30 bg-yellow-500/10 px-3 py-2 text-sm">
                <div className="text-xs text-yellow-100/80">Champion</div>
                <div className="font-extrabold">{currentPodium.first || "—"}</div>
              </div>
              <div className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm">
                <div className="text-xs text-white/70">Runner-up</div>
                <div className="font-bold">{currentPodium.second || "—"}</div>
              </div>
              <div className="rounded-xl border border-orange-300/25 bg-orange-500/10 px-3 py-2 text-sm">
                <div className="text-xs text-orange-100/80">Third Place</div>
                <div className="font-bold">{currentPodium.third || "—"}</div>
              </div>
            </div>
          </div>
        )}

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 rounded-2xl border border-white/10 bg-black/30 p-5">
            <div className="text-xs text-white/60">Jackpot actuel</div>
            <div className="mt-2 text-4xl font-extrabold">
              <AnimatedMetric value={jackpotEUR} kind="eur" durationMs={1000} />
            </div>
            <div className="mt-2 text-xs text-white/60">
              +{formatEUR(effectiveRules.jackpotPerPlayerEUR)} / joueur / soirée • +{formatEUR(effectiveRules.rebuyEUR)} / re-buy
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
            <div className="text-xs text-white/60">Saison active</div>
            <div className="mt-2 text-lg font-semibold">{currentSeason.name}</div>
            <div className="mt-2 text-xs text-white/60">
              {currentSeason.players.length} joueurs • {currentSeason.soirees.length} soirées
            </div>
          </div>
        </div>

        <div className="mb-6 hidden md:grid grid-cols-2 gap-2 lg:grid-cols-5 tv-hide">
          {navTabs.map(([k, label]) => (
            <button
              key={k}
              className={`dl-nav-card rounded-2xl border px-3 py-2 text-left transition ${tab === k ? "is-active" : ""} ${
                tab === k
                  ? "border-white/40 bg-white text-black shadow-[0_8px_28px_rgba(255,255,255,0.15)]"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              }`}
              onClick={() => setTab(k)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg leading-none dl-nav-icon">{navTabIcons[k]}</span>
                <span className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${tab === k ? "text-black/70" : "text-white/40"}`}>
                  {tab === k ? "Ouvert" : "Menu"}
                </span>
              </div>
              <div className="mt-1 text-sm font-semibold">{label}</div>
            </button>
          ))}
        </div>

        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-[#0b0f17]/95 backdrop-blur tv-hide">
          <div className="mx-auto max-w-6xl overflow-x-auto px-2 py-2">
            <div className="flex min-w-max gap-2">
              {navTabs.map(([k, label]) => (
                <button
                  key={k}
                  className={`dl-nav-chip rounded-xl border px-3 py-2 text-[11px] font-semibold transition ${tab === k ? "is-active" : ""} ${
                    tab === k
                      ? "border-white/40 bg-white text-black"
                      : "border-white/10 bg-white/5 text-white/80 hover:bg-white/10"
                  }`}
                  onClick={() => setTab(k)}
                >
                  <span className="mr-1">{navTabIcons[k]}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {tab !== "PARAMS" && tab !== "SAISONS" && tab !== "FUN" && tab !== "REGLES" && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between tv-hide">
            <div className="flex items-center gap-2 text-sm text-white/70">
              <span>Soirée sélectionnée</span>
              <Pill>{getTournamentFormatLabel(currentSoiree.tournamentFormat ?? "CLASSIC_POOLS")}</Pill>
            </div>
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

        <div className={`tv-stage ${tvMode ? "tv-animate" : "app-tab-animate"}`} key={`${tvMode ? "tv" : "app"}-${tab}`}>
        {tab === "SOIREE" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {currentSoireeLocked && (
              <div className="lg:col-span-3 rounded-2xl border border-yellow-400/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
                Soirée verrouillée: les résultats/matchs sont figés. Tu peux la déverrouiller depuis la popup de fin de soirée.
              </div>
            )}
            {finalNightMode && (
              <div className="lg:col-span-3 final-night-banner rounded-2xl border border-fuchsia-300/30 bg-black/40 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.28em] text-fuchsia-200/80">Mode Final</div>
                    <div className="text-lg font-extrabold">
                      Soirée {activePolicySoireeNumber} — règles spéciales activées
                    </div>
                    <div className="text-xs text-white/70">
                      Multiplicateur matchs x{currentSoireeRuleContext.matchWinMultiplier} •
                      Bonus finale: +
                      {currentSoireeRuleContext.checkoutBonusOverrides.FINAL ?? effectiveRules.checkoutBonusPoints}
                      {activePolicyPodiumPoints
                        ? ` • Podium: ${activePolicyPodiumPoints.first}/${activePolicyPodiumPoints.second}/${activePolicyPodiumPoints.third}`
                        : ""}
                      {currentSoireeRuleContext.rebuyLockAfterKnockoutStart ? " • Re-buys fermés dès les phases finales" : ""}
                    </div>
                  </div>
                  <Pill color="#f97316">Jackpot final boost</Pill>
                </div>
              </div>
            )}
            <div className="lg:col-span-2">
              <Section
                title={`Planning — Soirée ${currentSoiree.number}`}
                right={
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => recalcFinalsFromPools()} disabled={currentSoireeLocked || readOnlyMode}>
                      Calculer demis
                    </Button>
                    <Button variant="ghost" onClick={() => recalcFinalAndPFinal()} disabled={currentSoireeLocked || readOnlyMode}>
                      Calculer finales
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setClosureSoireeId(currentSoiree.id);
                        setClosureAutoExportStatus("");
                        setShowSoireeClosureModal(true);
                        logAudit("Ouverture export soirée", `S${currentSoiree.number}`);
                      }}
                      disabled={readOnlyMode}
                    >
                      Export soirée
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
                      const checkoutPts = getCheckoutBonusForMatch(m, effectiveRules, currentSoireeRuleContext);
                      const bonusA = m.checkoutBy === "A" ? checkoutPts : 0;
                      const bonusB = m.checkoutBy === "B" ? checkoutPts : 0;
                      const basePts = getMatchWinPointsForSoiree(m, effectiveRules, currentSoireeRuleContext);
                      const ptsA = (winner && winner === m.a ? basePts : 0) + bonusA;
                      const ptsB = (winner && winner === m.b ? basePts : 0) + bonusB;
                      const matchDurationMs = getMatchDurationMs(m, clockNow);
                      const matchDurationLabel = m.startedAt ? formatDuration(matchDurationMs) : "—";
                      const pickWinner = (name: string) => {
                        setMatchWinner(m.id, name);
                        if (m.phase === "DEMI") setTimeout(() => recalcFinalAndPFinal(), 0);
                      };
                      const cardClass = `${winner ? "winner-anim" : ""} ${winnerFxMatchId === m.id ? "winner-fx" : ""} ${
                        liveSchedule.nextMatch?.id === m.id ? "ring-1 ring-emerald-400/60" : ""
                      } ${flowMatchId === m.id ? "ring-2 ring-cyan-300/80 shadow-[0_0_24px_rgba(34,211,238,0.35)]" : ""}`;

                      if (compactMode) {
                        return (
                          <div key={m.id} data-match-id={m.id} className={`rounded-2xl border border-white/10 bg-black/30 p-3 ${cardClass}`}>
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
                                <Button variant={winner === m.a ? "primary" : "ghost"} onClick={() => pickWinner(m.a)} disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked} >
                                  {m.a || "A"}
                                </Button>
                                <Button variant={winner === m.b ? "primary" : "ghost"} onClick={() => pickWinner(m.b)} disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}>
                                  {m.b || "B"}
                                </Button>
                              </div>
                              <div className="flex items-center justify-between text-xs text-white/60">
                                <span>{m.format} • {m.bo} • {m.maxTurns}t</span>
                                <button
                                  className="text-white/70 underline"
                                  onClick={() => swapMatchPlayers(m.id)}
                                  disabled={!m.a && !m.b || readOnlyMode || currentSoireeLocked}
                                >
                                  Inverser A/B
                                </button>
                              </div>
                              <div className="flex items-center justify-between text-xs text-white/70">
                                <span>Durée: {matchDurationLabel}</span>
                                <button
                                  className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] hover:bg-white/10"
                                  onClick={() => startMatchTimer(m.id)}
                                  disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
                                >
                                  {m.startedAt && !m.endedAt ? "Relancer" : m.startedAt ? "Reprendre" : "Démarrer"}
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-2">
                                <Select
                                  value={m.checkoutBy}
                                  onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                                  options={["A", "B"]}
                                  placeholder="Checkout bonus (100+/Cricket) par…"
                                  disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
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
                        <div key={m.id} data-match-id={m.id} className={`rounded-2xl border border-white/10 bg-black/30 p-3 ${cardClass}`}>
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
                          <div className="mt-1 flex items-center justify-between text-xs text-white/70">
                            <span>Durée: {matchDurationLabel}</span>
                            <button
                              className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] hover:bg-white/10"
                              onClick={() => startMatchTimer(m.id)}
                              disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
                            >
                              {m.startedAt && !m.endedAt ? "Relancer" : m.startedAt ? "Reprendre" : "Démarrer"}
                            </button>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-2">
                            <div className="grid grid-cols-2 gap-2">
                              <Button variant={winner === m.a ? "primary" : "ghost"} onClick={() => pickWinner(m.a)} disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}>
                                {m.a || "A"}
                              </Button>
                              <Button variant={winner === m.b ? "primary" : "ghost"} onClick={() => pickWinner(m.b)} disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}>
                                {m.b || "B"}
                              </Button>
                            </div>
                            <button
                              className="text-xs text-white/70 underline"
                              onClick={() => swapMatchPlayers(m.id)}
                              disabled={!m.a && !m.b || readOnlyMode || currentSoireeLocked}
                            >
                              Inverser A/B
                            </button>
                            <Select
                              value={m.checkoutBy}
                              onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                              options={["A", "B"]}
                              placeholder="Checkout bonus (100+/Cricket) par…"
                              disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
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
                        <th className="py-2 pr-2">Chrono</th>
                        <th className="py-2 pr-2">Checkout bonus (100+/Cricket)</th>
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
                          const checkoutPts = getCheckoutBonusForMatch(m, effectiveRules, currentSoireeRuleContext);
                          const bonusA = m.checkoutBy === "A" ? checkoutPts : 0;
                          const bonusB = m.checkoutBy === "B" ? checkoutPts : 0;
                          const basePts = getMatchWinPointsForSoiree(m, effectiveRules, currentSoireeRuleContext);
                          const ptsA = (winner && winner === m.a ? basePts : 0) + bonusA;
                          const ptsB = (winner && winner === m.b ? basePts : 0) + bonusB;
                          const matchDurationMs = getMatchDurationMs(m, clockNow);
                          const matchDurationLabel = m.startedAt ? formatDuration(matchDurationMs) : "—";
                          const rowClass = `${winner ? "winner-row" : ""} ${winnerFxMatchId === m.id ? "winner-fx-row" : ""} ${
                            liveSchedule.nextMatch?.id === m.id ? "bg-emerald-500/10" : ""
                          } ${flowMatchId === m.id ? "bg-cyan-500/10 ring-1 ring-cyan-300/50" : ""}`;

                          return (
                            <tr key={m.id} data-match-id={m.id} className={`border-t border-white/10 ${rowClass}`}>
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
                                  disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
                                />
                              </td>
                              <td className="py-2 pr-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-white/70 min-w-[52px]">{matchDurationLabel}</span>
                                  <button
                                    className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] hover:bg-white/10"
                                    onClick={() => startMatchTimer(m.id)}
                                    disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
                                  >
                                    {m.startedAt && !m.endedAt ? "Relancer" : m.startedAt ? "Reprendre" : "Start"}
                                  </button>
                                </div>
                              </td>
                              <td className="py-2 pr-2">
                                <Select
                                  value={m.checkoutBy}
                                  onChange={(v) => setMatchCheckoutBy(m.id, (v as "" | "A" | "B"))}
                                  options={["A", "B"]}
                                  placeholder="Checkout bonus (100+/Cricket) par…"
                                  disabled={!m.a || !m.b || readOnlyMode || currentSoireeLocked}
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
              <Section title="Chrono soirée">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Durée en cours</span>
                    <span className="font-bold text-lg">{soireeTiming.startedAt ? formatDuration(soireeTiming.elapsedMs) : "00:00"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Matchs chronométrés terminés</span>
                    <span>{soireeTiming.completedCount}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Durée moyenne / match</span>
                    <span>{soireeTiming.avgMatchMs > 0 ? formatDuration(soireeTiming.avgMatchMs) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Match le plus long</span>
                    <span>{soireeTiming.longestMatchMs > 0 ? formatDuration(soireeTiming.longestMatchMs) : "—"}</span>
                  </div>
                  <div className="h-px bg-white/10 my-2" />
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Fin estimée</span>
                    <span>{soireeEta.expectedPlayableCount > 0 ? formatTimeHM(soireeEta.etaMs) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Temps restant estimé</span>
                    <span>{soireeEta.expectedPlayableCount > 0 ? formatDuration(soireeEta.remainingMs) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Matchs restants (estimés)</span>
                    <span>{soireeEta.expectedPlayableCount}</span>
                  </div>
                  {soireeEta.waitGapMs > 0 && (
                    <div className="text-xs text-yellow-300">Temps mort probable (retards): {formatDuration(soireeEta.waitGapMs)}</div>
                  )}
                  {soireeEta.blockedCount > 0 && (
                    <div className="text-xs text-orange-300">
                      {soireeEta.blockedCount} match(s) bloqué(s) par statut absent (non inclus dans ETA).
                    </div>
                  )}
                  <div className="pt-1 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => startSoireeTimer()} disabled={readOnlyMode || currentSoireeLocked}>
                      {soireeTiming.startedAt ? "Reprendre" : "Démarrer soirée"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => stopSoireeTimer()}
                      disabled={readOnlyMode || currentSoireeLocked || !soireeTiming.startedAt || Boolean(soireeTiming.endedAt)}
                    >
                      Stop soirée
                    </Button>
                    <Button variant={currentSoireeLocked ? "danger" : "ghost"} onClick={() => setCurrentSoireeLocked(!currentSoireeLocked)} disabled={readOnlyMode}>
                      {currentSoireeLocked ? "Déverrouiller" : "Verrouiller"}
                    </Button>
                  </div>
                </div>
              </Section>

              <Section
                title="Classement des poules"
                right={globalTop4Mode ? <Pill color="#eab308">Mode Top 4 global: moyenne / match</Pill> : undefined}
              >
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
                            {globalTop4Mode && <th className="py-1 text-right">Avg</th>}
                            <th className="py-1 text-right">V</th>
                            <th className="py-1 text-right">B</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentPoolStandings[pool].map((r, idx: number) => (
                            <tr key={r.name} className="border-t border-white/10">
                              <td className="py-1">{idx + 1}</td>
                              <td className="py-1 font-semibold">{r.name}</td>
                              <td className="py-1 text-right">{r.pts}</td>
                              {globalTop4Mode && <td className="py-1 text-right">{r.avg.toFixed(2)}</td>}
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
                        <Pill>{globalTop4Mode ? "Avg ➜ Pts ➜ V ➜ Bonus" : "Pts ➜ V ➜ Bonus"}</Pill>
                      </div>
                      <div className="mt-2 space-y-1">
                        {currentPoolStandings[pool].map((r, idx: number) => (
                          <div key={r.name} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1">
                            <div className="flex items-center gap-2">
                              <span className="text-white/60 w-5">{idx + 1}.</span>
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.name) ?? "#ffffff33" }} />
                              <span className="font-semibold">{r.name}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              {globalTop4Mode && (
                                <>
                                  <span className="text-white/70">AVG</span>
                                  <span className="font-bold">{r.avg.toFixed(2)}</span>
                                </>
                              )}
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
                {globalTop4Mode ? (
                  <div className="text-sm text-white/70">
                    {fairSoireeMode
                      ? "Mode absents actif"
                      : `Format ${getTournamentFormatLabel(currentSoiree.tournamentFormat ?? "CLASSIC_POOLS")} actif`}
                    : qualification en demis par <span className="font-semibold text-white">Top 4 global</span> (moyenne points/match), avec affiches 1v4 et 2v3.
                  </div>
                ) : (
                  <>
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
                            disabled={readOnlyMode || currentSoireeLocked}
                          />
                        </div>
                        <div>
                          <div className="text-xs text-white/60 mb-1">Poule A — #2</div>
                          <Select
                            value={normName(currentSoiree.qualifiersOverride?.A2 ?? "")}
                            onChange={(v) => setQualifiersOverride({ A2: normName(v) })}
                            options={currentSoiree.pools.A}
                            placeholder="Auto…"
                            disabled={readOnlyMode || currentSoireeLocked}
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
                            disabled={readOnlyMode || currentSoireeLocked}
                          />
                        </div>
                        <div>
                          <div className="text-xs text-white/60 mb-1">Poule B — #2</div>
                          <Select
                            value={normName(currentSoiree.qualifiersOverride?.B2 ?? "")}
                            onChange={(v) => setQualifiersOverride({ B2: normName(v) })}
                            options={currentSoiree.pools.B}
                            placeholder="Auto…"
                            disabled={readOnlyMode || currentSoireeLocked}
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => setQualifiersOverride({ A1: "", A2: "", B1: "", B2: "" })} disabled={readOnlyMode || currentSoireeLocked}>
                          Réinitialiser (auto)
                        </Button>
                      </div>

                      <div className="text-[11px] text-white/50">
                        Si tu fais un match sec pour départager, règle l’ordre #1/#2 ici puis clique “Calculer demis”.
                      </div>
                    </div>
                  </>
                )}
              </div>

              <Section title="Podium & gains (soirée)">
                <div className="space-y-2 text-sm">
                  {finalNightMode && activePolicyPodiumPoints && (
                    <div className="rounded-xl border border-fuchsia-400/25 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-100">
                      Bonus classement: podium = +{activePolicyPodiumPoints?.first ?? 0} / +{activePolicyPodiumPoints?.second ?? 0} / +{activePolicyPodiumPoints?.third ?? 0} points.
                    </div>
                  )}
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
                          <div className="font-semibold"><AnimatedMetric value={x.eur} kind="eur" durationMs={700} /></div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="Présences & ordre live">
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <Pill color="#22c55e">Présents: {soireePlayers.filter((p) => soireeAttendance.get(p) === "HERE").length}</Pill>
                  <Pill color="#f59e0b">Retard: {liveSchedule.latePlayers.length}</Pill>
                  <Pill color="#ef4444">Absents: {liveSchedule.absentPlayers.length}</Pill>
                </div>

                <div className="mb-3 rounded-xl border border-cyan-400/25 bg-cyan-500/10 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-cyan-200">Flow soirée</div>
                    <label className="inline-flex items-center gap-2 text-xs text-cyan-100">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-white/20 bg-black"
                        checked={flowAutoAdvance}
                        disabled={readOnlyMode || currentSoireeLocked}
                        onChange={(e) => setFlowAutoAdvance(e.target.checked)}
                      />
                      Auto-match suivant
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="touch"
                      title="Raccourci clavier: N"
                      onClick={() => launchNextRecommendedMatch()}
                      disabled={!liveSchedule.nextMatch || readOnlyMode || currentSoireeLocked}
                    >
                      Lancer prochain match
                    </Button>
                    <Button
                      variant="ghost"
                      size="touch"
                      title="Raccourci clavier: T"
                      onClick={() => (!soireeTiming.startedAt || soireeTiming.endedAt ? startSoireeTimer() : stopSoireeTimer())}
                      disabled={readOnlyMode || currentSoireeLocked}
                    >
                      {!soireeTiming.startedAt || soireeTiming.endedAt ? "Démarrer chrono" : "Stop chrono"}
                    </Button>
                    <Button
                      variant={currentSoireeLocked ? "danger" : "ghost"}
                      size="touch"
                      title="Raccourci clavier: L"
                      onClick={(e) =>
                        confirmSmart(
                          "toggle-lock",
                          currentSoireeLocked ? "Déverrouiller la soirée ?" : "Verrouiller la soirée ?",
                          e
                        ) && setCurrentSoireeLocked(!currentSoireeLocked)
                      }
                      disabled={readOnlyMode}
                    >
                      {currentSoireeLocked ? "Déverrouiller" : "Verrouiller"}
                    </Button>
                    {flowCurrentMatch && (
                      <Button variant="ghost" onClick={() => focusMatchInPlanning(flowCurrentMatch.id)}>
                        Recentrer match en cours
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-cyan-100/90">
                    {flowCurrentMatch
                      ? `En cours: #${flowCurrentMatch.order} — ${flowCurrentMatch.a} vs ${flowCurrentMatch.b}`
                      : "Aucun match flow actif. Lance le prochain match recommandé."}
                  </div>
                  <div className="mt-2 text-[11px] text-cyan-100/70">
                    Raccourcis opérateur: <span className="font-semibold">Alt+1..6</span> navigation, <span className="font-semibold">N</span> prochain match, <span className="font-semibold">T</span> chrono, <span className="font-semibold">L</span> verrouillage.
                  </div>
                </div>

                <div className="space-y-2">
                  {soireePlayers.map((p) => {
                    const status = soireeAttendance.get(p) ?? "HERE";
                    const eta = currentSoiree.arrivalEta?.[p] ?? "";
                    return (
                      <div key={p} className="rounded-xl border border-white/10 bg-black/25 p-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: getPlayerColor(p) }} />
                            <span className="font-semibold text-sm">{p}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
                              value={status}
                              disabled={readOnlyMode || currentSoireeLocked}
                              onChange={(e) => setSoireePlayerPresence(p, e.target.value as PresenceStatus)}
                            >
                              <option value="HERE">Présent</option>
                              <option value="LATE">Arrive plus tard</option>
                              <option value="ABSENT">Absent</option>
                            </select>
                            {status === "LATE" && (
                              <input
                                type="time"
                                className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
                                value={eta}
                                disabled={readOnlyMode || currentSoireeLocked}
                                onChange={(e) => setSoireePlayerEta(p, e.target.value)}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => setAllSoireePlayersPresent()} disabled={readOnlyMode || currentSoireeLocked}>
                    Tout le monde présent
                  </Button>
                </div>

                <div className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3 text-sm">
                  <div className="font-semibold text-emerald-200">Prochain match recommandé</div>
                  {liveSchedule.nextMatch ? (
                    <>
                      <div className="mt-1">
                        #{liveSchedule.nextMatch.order} — {liveSchedule.nextMatch.a} vs {liveSchedule.nextMatch.b}
                        {liveSchedule.nextMatch.pool ? ` (Poule ${liveSchedule.nextMatch.pool})` : ""}
                      </div>
                      <div className="mt-1 text-xs text-emerald-100/90">{liveSchedule.nextReason}</div>
                    </>
                  ) : (
                    <div className="mt-1 text-xs text-emerald-100/90">
                      {liveSchedule.remainingCount === 0
                        ? "Tous les matchs sont déjà joués."
                        : liveSchedule.playableCount === 0
                          ? "Aucun match jouable pour l’instant (attente d’arrivées)."
                          : "Aucune recommandation disponible."}
                    </div>
                  )}
                </div>

                {liveSchedule.candidates.length > 1 && (
                  <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-xs text-white/60">Ordre conseillé (top 5)</div>
                    <div className="mt-2 space-y-1 text-xs">
                      {liveSchedule.candidates.slice(0, 5).map((c, idx: number) => (
                        <div key={c.match.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1">
                          <span className="text-white/70">{idx + 1}.</span>
                          <span className="flex-1">
                            #{c.match.order} {c.match.a} vs {c.match.b}
                          </span>
                          <span className="text-white/50">{c.match.pool ? `Poule ${c.match.pool}` : c.match.phase}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
                        <span className="font-bold"><AnimatedMetric value={r.pts} kind="int" durationMs={420} /></span>
                        <span className="text-white/70">V</span>
                        <span className="font-bold"><AnimatedMetric value={r.wins} kind="int" durationMs={420} /></span>
                        <span className="text-white/70">B</span>
                        <span className="font-bold"><AnimatedMetric value={r.bonus} kind="int" durationMs={420} /></span>
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
                  <div className="mt-1 text-2xl font-extrabold">
                    <AnimatedMetric value={jackpotEUR} kind="eur" durationMs={900} />
                  </div>
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
                        <span className="font-bold"><AnimatedMetric value={s.best} kind="int" durationMs={400} /></span>
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
                        <span className="font-bold"><AnimatedMetric value={x.eur} kind="eur" durationMs={700} /></span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section
              title="Timeline animée — Évolution du classement"
              right={
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" onClick={() => setTimelinePlay((v) => !v)}>
                    {timelinePlay ? "Pause" : "Lecture"}
                  </Button>
                  <Button variant="ghost" onClick={() => setTimelineStep(0)} disabled={rankingTimeline.labels.length === 0}>
                    Début
                  </Button>
                </div>
              }
            >
              <div className="text-xs text-white/60 mb-2">Un seul graphique, toutes les soirées et tous les joueurs.</div>
              {rankingTimeline.labels.length === 0 ? (
                <div className="text-sm text-white/70">Pas encore de soirées.</div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs text-white/60">
                      Soirée affichée : <span className="font-semibold text-white">S{rankingTimeline.labels[timelineStep] ?? rankingTimeline.labels[0]}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-white/70">
                      <span>Vitesse</span>
                      <select
                        className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
                        value={timelineSpeedMs}
                        onChange={(e) => setTimelineSpeedMs(Number(e.target.value))}
                      >
                        <option value={2000}>Lente</option>
                        <option value={1200}>Normale</option>
                        <option value={700}>Rapide</option>
                      </select>
                    </div>
                  </div>
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
                          const playersCount = Math.max(currentSeason.players.length, 1);
                          const pointsCount = Math.max(timelineStep + 1, 1);
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

                              {rankingTimeline.labels.slice(0, timelineStep + 1).map((label: number, i: number) => {
                                const x = xScale(i);
                                return (
                                  <text key={`x-${label}`} x={x} y={h - 8} fontSize="10" fill="#ffffff80" textAnchor="middle">
                                    S{label}
                                  </text>
                                );
                              })}

                              {rankingTimeline.series.map((ser: { player: string; ranks: number[] }) => {
                                const sliced = ser.ranks.slice(0, timelineStep + 1);
                                if (sliced.length === 0) return null;
                                const d = sliced
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

                  <div className="mt-3">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, rankingTimeline.labels.length - 1)}
                      value={timelineStep}
                      onChange={(e) => setTimelineStep(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {rankingTimeline.series.map((ser: { player: string }) => (
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

        {tab === "CLASSEMENT" && (
          <div className="mt-4">
            <Section
              title="Classement dynamique • Forme récente • Lows • Puissance"
              right={
                <div className="flex flex-wrap gap-2">
                  <Button variant={performanceSort === "POWER" ? "primary" : "ghost"} onClick={() => setPerformanceSort("POWER")}>
                    Puissance
                  </Button>
                  <Button variant={performanceSort === "FORM" ? "primary" : "ghost"} onClick={() => setPerformanceSort("FORM")}>
                    Forme
                  </Button>
                  <Button variant={performanceSort === "DYNAMIC" ? "primary" : "ghost"} onClick={() => setPerformanceSort("DYNAMIC")}>
                    Dynamique
                  </Button>
                  <Button variant={performanceSort === "LOWS" ? "primary" : "ghost"} onClick={() => setPerformanceSort("LOWS")}>
                    Lows
                  </Button>
                </div>
              }
            >
              <div className="space-y-2">
                {dynamicPerformanceRows.map((r) => (
                  <div key={r.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-white/60 w-6">#{r.rank}</span>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                        <span className="font-semibold">{r.player}</span>
                        <Pill color={r.rankDelta > 0 ? "#22c55e" : r.rankDelta < 0 ? "#ef4444" : undefined}>
                          {r.rankDelta > 0 ? `▲ +${r.rankDelta}` : r.rankDelta < 0 ? `▼ ${r.rankDelta}` : "— 0"}
                        </Pill>
                      </div>
                      <div className="text-xs sm:text-sm font-semibold">Puissance: {r.power}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-white/60">Forme (5):</span>
                      {Array.from({ length: 5 }).map((_, i: number) => {
                        const v = r.recent[i];
                        const cls =
                          v === "W"
                            ? "bg-emerald-500/70 text-emerald-100"
                            : v === "L"
                              ? "bg-rose-500/70 text-rose-100"
                              : "bg-white/10 text-white/40";
                        return (
                          <span key={`${r.player}-form-${i}`} className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold ${cls}`}>
                            {v ?? "·"}
                          </span>
                        );
                      })}
                      <span className="text-white/70">{r.recentWins}/{Math.max(r.recentPlayed, 1)} • {r.recentRate}%</span>
                      <span className="text-white/50">|</span>
                      <span className="text-white/70">Win rate: {r.winRate}%</span>
                      <span className="text-white/50">|</span>
                      <span className="text-white/70">Lows: max {r.lowStreak} • actuel {r.currentLow}</span>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-white/10">
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{
                          width: `${Math.max(0, Math.min(100, r.power))}%`,
                          background: playerColors.get(r.player) ?? "#22c55e",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}

        {tab === "CLASSEMENT" && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Win rate (taux de victoire)">
              <div className="space-y-2">
                {advancedStats.winRates
                  .slice()
                  .sort((a, b) => b.rate - a.rate || b.wins - a.wins || a.player.localeCompare(b.player))
                  .map((r) => (
                    <div key={r.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                          <span className="font-semibold">{r.player}</span>
                        </div>
                        <span className="font-bold">{r.rate}%</span>
                      </div>
                      <div className="mt-2 h-2 w-full rounded-full bg-white/10">
                        <div
                          className="h-2 rounded-full"
                          style={{ width: `${r.rate}%`, background: playerColors.get(r.player) ?? "#22c55e" }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-white/60">
                        {r.wins} V • {r.losses} D • {r.played} matchs
                      </div>
                    </div>
                  ))}
              </div>
            </Section>

            <Section title="Clutch (finales gagnées)">
              <div className="space-y-2">
                {advancedStats.clutch
                  .slice()
                  .sort((a, b) => b.rate - a.rate || b.finals - a.finals || a.player.localeCompare(b.player))
                  .map((r) => (
                    <div key={r.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                          <span className="font-semibold">{r.player}</span>
                        </div>
                        <span className="font-bold">{r.rate}%</span>
                      </div>
                      <div className="mt-1 text-xs text-white/60">
                        {r.wins} / {r.finals} finales gagnées
                      </div>
                    </div>
                  ))}
              </div>
            </Section>

            <Section title="Présence en demi-finales">
              <div className="space-y-2">
                {advancedStats.semiRuns
                  .slice()
                  .sort((a, b) => b.semis - a.semis || a.player.localeCompare(b.player))
                  .map((r) => (
                    <div key={r.player} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                        <span className="font-semibold">{r.player}</span>
                      </div>
                      <span className="font-bold">{r.semis}</span>
                    </div>
                  ))}
              </div>
            </Section>
          </div>
        )}

        {tab === "CLASSEMENT" && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Probabilité Podium Live">
              <div className="space-y-2">
                {premiumAnalytics.podiumProbabilities.slice(0, 6).map((r) => (
                  <div key={r.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                        <span className="font-semibold">{r.player}</span>
                      </div>
                      <span className="text-sm font-bold">{r.top3}% Top 3</span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded bg-black/25 px-2 py-1 text-center">🥇 {r.p1}%</div>
                      <div className="rounded bg-black/25 px-2 py-1 text-center">🥈 {r.p2}%</div>
                      <div className="rounded bg-black/25 px-2 py-1 text-center">🥉 {r.p3}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="MVP Soirée + Difficulté">
              <div className="space-y-2">
                {premiumAnalytics.mvp.slice(0, 5).map((r, idx: number) => (
                  <div key={r.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-white/60 w-5">{idx + 1}.</span>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(r.player) ?? "#ffffff33" }} />
                        <span className="font-semibold">{r.player}</span>
                      </div>
                      <span className="font-bold">{r.score}</span>
                    </div>
                    <div className="mt-1 text-xs text-white/60">
                      {r.pts} pts • {r.wins} V • {r.bonus} bonus
                    </div>
                  </div>
                ))}
                <div className="mt-3 text-xs text-white/60">Parcours difficiles (victoires vs joueurs forts)</div>
                {premiumAnalytics.difficulty.slice(0, 3).map((d) => (
                  <div key={d.player} className="flex items-center justify-between rounded-lg bg-black/25 px-2 py-1 text-xs">
                    <span>{d.player}</span>
                    <span className="font-semibold">indice {d.avgStrength}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Perf Par Phase">
              <div className="space-y-2">
                {premiumAnalytics.phasePerformance.map((row) => (
                  <div key={row.player} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: playerColors.get(row.player) ?? "#ffffff33" }} />
                      <span className="font-semibold">{row.player}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1 text-[11px] text-white/70">
                      <span>Poule: {row.POULE.wins}/{row.POULE.played} ({row.POULE.rate}%)</span>
                      <span>Demi: {row.DEMI.wins}/{row.DEMI.played} ({row.DEMI.rate}%)</span>
                      <span>Petite F: {row.PFINAL.wins}/{row.PFINAL.played} ({row.PFINAL.rate}%)</span>
                      <span>Finale: {row.FINAL.wins}/{row.FINAL.played} ({row.FINAL.rate}%)</span>
                    </div>
                  </div>
                ))}
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
                    const { pts, wins } = computePointsFromMatches(
                      s.matches,
                      s.rebuys,
                      s.number,
                      currentSeason,
                      effectiveRules,
                      activeSoireeRulePolicies
                    );
                    const rows = currentSeason.players.map((p: string) => ({ name: p, pts: pts.get(p) ?? 0, wins: wins.get(p) ?? 0 }));
                    rows.sort((a: { name: string; pts: number; wins: number }, b: { name: string; pts: number; wins: number }) =>
                      b.pts - a.pts || b.wins - a.wins || a.name.localeCompare(b.name)
                    );
                    const podium = rows.slice(0, 3);
                    return (
                      <div
                        key={s.id}
                        className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-left hover:bg-black/40 cursor-pointer"
                        onClick={() => {
                          setSelectedSoireeNumber(s.number);
                          setTab("SOIREE");
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-base font-semibold">Soirée {s.number}</div>
                          <div className="flex items-center gap-2">
                            <div className="text-xs text-white/60">Rebuys: {s.rebuys.length}</div>
                            {(s.absentPlayers?.length ?? 0) > 0 && (
                              <div className="text-xs text-yellow-300">Absents: {s.absentPlayers?.length ?? 0}</div>
                            )}
                            <Button
                              variant="danger"
                              disabled={readOnlyMode}
                              onClick={(e) => {
                                e?.stopPropagation();
                                deleteSoiree(s.number);
                              }}
                            >
                              Supprimer
                            </Button>
                          </div>
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
                            {formatEUR(computeSoireeJackpotEUR(s, currentSeason, effectiveRules, activeSoireeRulePolicies))}
                          </Pill>
                          <Pill>Matchs: {s.matches.length}</Pill>
                        </div>
                      </div>
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
                  <Button
                    variant="ghost"
                    onClick={() => addRebuy()}
                    disabled={readOnlyMode || currentSoireeLocked || (finalNightMode && rebuyLockedByPhase)}
                  >
                    + Ajouter un re-buy
                  </Button>
                }
              >
                {finalNightMode && (
                  <div className="mb-3 rounded-xl border border-fuchsia-400/25 bg-fuchsia-500/10 p-3 text-xs text-fuchsia-100">
                    {activeSoireeRulePolicy?.label || "Règles spéciales"} Soirée {activePolicySoireeNumber}: re-buys illimités pendant les poules, puis verrouillés dès que les phases finales démarrent.
                  </div>
                )}
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
                          return winnerN === buyerN
                            ? `✅ Le buyer gagne +${effectiveRules.rebuyWinPointsS1S2 * currentSoireeRuleContext.rebuyPointsMultiplier} pts`
                            : "❌ Buyer perd → 0 pt pour tous";
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

                        const baseWinPts = doneBefore === 0 ? effectiveRules.rebuyFirstWinPointsS3Plus : effectiveRules.rebuyNextWinPointsS3Plus;
                        const winPts = baseWinPts * currentSoireeRuleContext.rebuyPointsMultiplier;
                        return winnerN === buyerN
                          ? `✅ Le buyer gagne +${winPts} pt${winPts > 1 ? "s" : ""}`
                          : "❌ Buyer perd → 0 pt pour tous";
                      })();

                      return (
                        <div key={r.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold">Re-buy #{idx + 1}</div>
                            <Button variant="danger" onClick={() => deleteRebuy(r.id)} disabled={readOnlyMode || currentSoireeLocked}>
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
                                disabled={readOnlyMode || currentSoireeLocked}
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
                                disabled={readOnlyMode || currentSoireeLocked}
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
                                disabled={readOnlyMode || currentSoireeLocked}
                              />
                            </div>
                            <div>
                              <div className="mb-1 text-xs text-white/60">Vainqueur</div>
                              <Select
                                value={normName(r.winner)}
                                onChange={(v) => updateRebuy(r.id, { winner: normName(v) })}
                                options={winnerOptions}
                                placeholder="Vainqueur…"
                                disabled={!a || !b || readOnlyMode || currentSoireeLocked}
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
                  {finalNightMode && (
                    <>
                      <div className="mt-2">• Spécial finale (S{activePolicySoireeNumber}) :</div>
                      <div className="ml-3">— Re-buys illimités en poules, fermés en phases finales</div>
                      <div className="ml-3">— Points re-buy non doublés</div>
                      <div className="ml-3">— 100% des re-buys vont dans le jackpot final</div>
                    </>
                  )}
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
                    Jackpot actuel : <span className="font-extrabold text-white"><AnimatedMetric value={jackpotEUR} kind="eur" durationMs={900} /></span>
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
                title="Mode Live Operateur"
                right={
                  <div className="flex flex-wrap gap-2">
                    <Button variant={funLiveEnabled ? "primary" : "ghost"} onClick={() => setFunLiveEnabled((v) => !v)}>
                      {funLiveEnabled ? "Quitter Live" : "Entrer Live"}
                    </Button>
                    <Button variant="ghost" onClick={() => goToNextPendingLiveMatch()} disabled={!funLiveMatches.length}>
                      Prochain non joue
                    </Button>
                  </div>
                }
              >
                {!funLiveEnabled ? (
                  <div className="text-sm text-white/70">
                    Active ce mode pour piloter les matchs en direct (mobile first) avec validation rapide.
                  </div>
                ) : !currentLiveMatch ? (
                  <div className="text-sm text-white/70">Aucun match disponible.</div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                      <div className="flex items-center justify-between text-xs text-white/60">
                        <span>
                          Match {funLiveIndex + 1} / {funLiveMatches.length}
                        </span>
                        <Pill>{currentLiveMatch.phase}</Pill>
                      </div>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          className={`rounded-xl border px-3 py-3 text-left ${
                            normName(currentLiveMatch.winner) === currentLiveMatch.a
                              ? "border-emerald-400 bg-emerald-500/15"
                              : "border-white/10 bg-black/20 hover:bg-black/35"
                          }`}
                          onClick={() => setLiveWinner(currentLiveMatch.id, currentLiveMatch._src, currentLiveMatch.a)}
                          disabled={!currentLiveMatch.a}
                        >
                          <div className="text-xs text-white/60">Vainqueur A</div>
                          <div className="font-semibold">{currentLiveMatch.a || "-"}</div>
                        </button>
                        <button
                          className={`rounded-xl border px-3 py-3 text-left ${
                            normName(currentLiveMatch.winner) === currentLiveMatch.b
                              ? "border-emerald-400 bg-emerald-500/15"
                              : "border-white/10 bg-black/20 hover:bg-black/35"
                          }`}
                          onClick={() => setLiveWinner(currentLiveMatch.id, currentLiveMatch._src, currentLiveMatch.b)}
                          disabled={!currentLiveMatch.b}
                        >
                          <div className="text-xs text-white/60">Vainqueur B</div>
                          <div className="font-semibold">{currentLiveMatch.b || "-"}</div>
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="ghost" onClick={() => setLiveWinner(currentLiveMatch.id, currentLiveMatch._src, "")}>
                          Effacer resultat
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" onClick={() => setFunLiveIndex((i) => Math.max(0, i - 1))} disabled={funLiveIndex <= 0}>
                        Match precedent
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setFunLiveIndex((i) => Math.min(funLiveMatches.length - 1, i + 1))}
                        disabled={funLiveIndex >= funLiveMatches.length - 1}
                      >
                        Match suivant
                      </Button>
                    </div>
                  </div>
                )}
              </Section>

              <Section
                title="Mode Fun — Tournoi Soiree Unique"
                right={
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => generateFunSoiree()} disabled={state.funMode.players.length < 2}>
                      Generer ligue
                    </Button>
                    <Button variant="ghost" onClick={() => generateFunFinals()} disabled={funStandings.length < 4}>
                      Generer top 4
                    </Button>
                    <Button variant="danger" onClick={() => resetFunMode()}>
                      Reinitialiser
                    </Button>
                  </div>
                }
              >
                <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3 space-y-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    <div>
                      <div className="text-xs text-white/60 mb-1">Format</div>
                      <Select
                        value={String(state.funMode.format)}
                        onChange={(v) => setFunFormat(Number(v) === 501 ? 501 : 301)}
                        options={["301", "501"]}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-white/60 mb-1">Mode argent</div>
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={state.funMode.moneyEnabled}
                          onChange={(e) => updateFunMode((fun) => ({ ...fun, moneyEnabled: e.target.checked }))}
                        />
                        Activer
                      </label>
                    </div>
                    <div>
                      <div className="text-xs text-white/60 mb-1">Mise par joueur</div>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={state.funMode.moneyPerPlayer}
                        onChange={(e) =>
                          updateFunMode((fun) => ({ ...fun, moneyPerPlayer: Math.max(0, Number(e.target.value) || 0) }))
                        }
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                        disabled={!state.funMode.moneyEnabled}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-white/60 mb-2">Joueurs (2 a 8)</div>
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
                        <span className="text-white/60">x</span>
                      </button>
                    ))}
                  </div>
                  {state.funMode.players.length % 2 === 1 && state.funMode.players.length >= 3 && (
                    <div className="text-xs text-amber-300">
                      Nombre impair detecte: un joueur sera en repos a chaque tour de ligue.
                    </div>
                  )}
                </div>

                {state.funMode.matches.length === 0 ? (
                  <div className="text-sm text-white/70">Ajoute au moins 2 joueurs puis clique sur "Generer ligue".</div>
                ) : (
                  <div className="space-y-2">
                    <div className="text-xs text-white/60 mb-1">Ligue (round-robin)</div>
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

              <Section
                title="Parties Simultanees (Classement Par Position)"
                right={
                  <Button variant="ghost" onClick={() => addFunPositionRound()} disabled={state.funMode.players.length < 2}>
                    + Ajouter une manche
                  </Button>
                }
              >
                {state.funMode.positionRounds.length === 0 ? (
                  <div className="text-sm text-white/70">Ajoute une manche pour saisir les positions (1er, 2e, etc.).</div>
                ) : (
                  <div className="space-y-3">
                    {state.funMode.positionRounds.map((round, idx) => (
                      <div key={round.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="font-semibold text-sm">Manche {idx + 1}</div>
                          <Button variant="danger" onClick={() => deleteFunPositionRound(round.id)}>
                            Supprimer
                          </Button>
                        </div>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          {Array.from({ length: state.funMode.players.length }).map((_, posIdx) => (
                            <div key={`${round.id}_${posIdx}`}>
                              <div className="mb-1 text-xs text-white/60">Position {posIdx + 1}</div>
                              <Select
                                value={round.positions[posIdx] ?? ""}
                                onChange={(v) => setFunRoundPosition(round.id, posIdx, v)}
                                options={state.funMode.players}
                                placeholder="Joueur..."
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Top 4 — Demi / Petite Finale / Finale">
                {state.funMode.finals.length === 0 ? (
                  <div className="text-sm text-white/70">Genere le top 4 apres la ligue pour creer les finales.</div>
                ) : (
                  <div className="space-y-2">
                    {state.funMode.finals
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((m) => (
                        <div key={m.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div className="text-sm">
                              <Pill>{m.phase}</Pill>
                              <span className="ml-2 font-semibold">{m.a || "?"}</span>
                              <span className="mx-2 text-white/50">vs</span>
                              <span className="font-semibold">{m.b || "?"}</span>
                            </div>
                            <div className="w-full md:w-56">
                              <Select
                                value={normName(m.winner)}
                                onChange={(v) => setFunFinalWinner(m.id, v)}
                                options={[m.a, m.b].filter(isNonEmptyString)}
                                placeholder="Vainqueur..."
                                disabled={!m.a || !m.b}
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
                      <div className="text-xs text-white/70 text-right">
                        <div>
                          <span className="font-bold text-white">{r.total}</span> pts
                        </div>
                        <div>{r.wins} V / {r.played} M / {r.posPts} pos</div>
                      </div>
                    </div>
                  ))}
                  {funStandings.length === 0 && <div className="text-sm text-white/70">Aucun joueur.</div>}
                </div>
              </Section>

              <Section title="Podium Fun">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">1er</span>
                    <span className="font-semibold">{funPodium.first || "-"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">2e</span>
                    <span className="font-semibold">{funPodium.second || "-"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">3e</span>
                    <span className="font-semibold">{funPodium.third || "-"}</span>
                  </div>
                  {funPodium.provisional && <div className="text-xs text-white/60">Podium provisoire (avant resultat final complet).</div>}
                </div>
              </Section>

              <Section title="Cagnotte Fun">
                <div className="text-sm text-white/70 space-y-1">
                  <div>Mode argent: <span className="font-semibold text-white">{state.funMode.moneyEnabled ? "Active" : "Desactive"}</span></div>
                  <div>Mise par joueur: <span className="font-semibold text-white">{formatEUR(state.funMode.moneyPerPlayer)}</span></div>
                  <div>Total: <span className="font-semibold text-white">{formatEUR(funPotEUR)}</span></div>
                </div>
              </Section>

              <Section title="Regles Fun">
                <div className="text-sm text-white/70 space-y-2">
                  <div>• Mode independant des saisons.</div>
                  <div>• Maximum 8 joueurs.</div>
                  <div>• Ligue round-robin + top 4 automatique.</div>
                  <div>• Classement = (victoires x3) + points de position par manche.</div>
                </div>
              </Section>
            </div>
          </div>
        )}

        {tab === "FINANCES" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Section title={`Finances — Soirée ${currentSoiree.number}`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Button variant="ghost" onClick={() => updateFinanceAll(true)}>
                    Tout cocher
                  </Button>
                  <Button variant="ghost" onClick={() => updateFinanceAll(false)}>
                    Tout décocher
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="text-white/70">
                        <th className="py-2 pr-2">Payé</th>
                        <th className="py-2 pr-2">Joueur</th>
                        <th className="py-2 pr-2">Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uniq([...currentSoiree.pools.A, ...currentSoiree.pools.B])
                        .filter(isNonEmptyString)
                        .map((p) => {
                          const paid = Boolean(currentSoiree.payments?.[p]);
                          return (
                            <tr key={p} className="border-t border-white/10">
                              <td className="py-2 pr-2">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-white/20 bg-black"
                                  checked={paid}
                                  onChange={(e) => updateFinancePayment(p, e.target.checked)}
                                />
                              </td>
                              <td className="py-2 pr-2 font-semibold">{p}</td>
                              <td className="py-2 pr-2">{formatEUR(MONEY.entryFeeEUR)}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Notes (règlements, remarques)</div>
                  <textarea
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-white outline-none focus:border-white/25"
                    rows={4}
                    placeholder="Ex: Marvin a payé en espèces, Angel paie la prochaine soirée…"
                    value={currentSoiree.financeNotes ?? ""}
                    onChange={(e) => updateFinanceNotes(e.target.value)}
                  />
                </div>
              </Section>
            </div>

            <div className="space-y-4">
              <Section title="Récap soirée">
                {(() => {
                  const players = uniq([...currentSoiree.pools.A, ...currentSoiree.pools.B]).filter(isNonEmptyString);
                  const paidCount = players.filter((p) => Boolean(currentSoiree.payments?.[p])).length;
                  const total = players.length * MONEY.entryFeeEUR;
                  return (
                    <div className="text-sm text-white/70 space-y-2">
                      <div>
                        Joueurs: <span className="font-semibold text-white">{players.length}</span>
                      </div>
                      <div>
                        Payés: <span className="font-semibold text-white">{paidCount}</span> / {players.length}
                      </div>
                      <div>
                        Total dû: <span className="font-semibold text-white">{formatEUR(total)}</span>
                      </div>
                    </div>
                  );
                })()}
              </Section>

              <Section title="Infos">
                <div className="text-sm text-white/70 space-y-2">
                  <div>• Suis les paiements par soirée.</div>
                  <div>• Les notes sont privées (onglet finances).</div>
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
                .sort((a: CoreMatch, b: CoreMatch) => a.order - b.order)
                .map((m: CoreMatch) => {
                  const status = getMatchStatus(m);
                  return (
                    <div key={m.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Pill>{m.phase}</Pill>
                          <span className="text-xs text-white/60">Match #{m.order}</span>
                          <Pill color={status === "VALIDATED" ? "#22c55e" : status === "CONTESTED" ? "#ef4444" : "#eab308"}>
                            {status}
                          </Pill>
                        </div>
                        <div className="text-sm font-semibold">
                          {m.a || "—"} vs {m.b || "—"} {m.winner ? <span className="text-white/60">→ {m.winner}</span> : null}
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
                  );
                })}
            </div>
          </Section>
        )}

        {tab === "REGLES" && (
          <div className="grid grid-cols-1 gap-4">
            <Section
              title="Règlement (PDF)"
              right={
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => triggerRulesPdfFile()} disabled={readOnlyMode}>
                    Importer PDF
                  </Button>
                  <Button variant="ghost" onClick={() => window.open(rulesPdfData, "_blank")} disabled={!rulesPdfData}>
                    Ouvrir
                  </Button>
                  <Button variant="danger" onClick={() => clearRulesPdf()} disabled={!rulesPdfData || readOnlyMode}>
                    Supprimer
                  </Button>
                </div>
              }
            >
              <input ref={rulesPdfFileRef} type="file" accept="application/pdf" className="hidden" onChange={onRulesPdfSelected} />
              <div className="mb-3 text-sm text-white/70">
                Ajoute ici le règlement officiel pour qu’il soit lisible directement dans l’application.
                {rulesPdfName ? <span className="ml-2 text-white">Fichier: {rulesPdfName}</span> : null}
              </div>
              {rulesPdfData ? (
                <div className="rounded-xl overflow-hidden border border-white/10 bg-black/40">
                  <iframe title="Règlement PDF" src={rulesPdfData} className="w-full h-[70vh]" />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/20 bg-black/30 p-8 text-sm text-white/60">
                  Aucun PDF importé.
                </div>
              )}
            </Section>
          </div>
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
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
                    <Button variant="ghost" onClick={() => runQuickRecovery()}>
                      Récupération rapide
                    </Button>
                  </div>
                  <div className="mt-2 space-y-1">
                    {snapshots.slice(0, 4).map((snap) => (
                      <div key={snap.id} className="flex items-center justify-between rounded-lg bg-black/30 px-2 py-1">
                        <span className="text-xs">
                          {snap.label} • {new Date(snap.ts).toLocaleString("fr-FR")}
                        </span>
                        <Button variant="ghost" onClick={() => restoreSnapshot(snap.id)}>
                          Restaurer
                        </Button>
                      </div>
                    ))}
                    {snapshots.length === 0 && <div className="text-xs text-white/50">Aucun snapshot.</div>}
                  </div>
                  {quickRecoveryStatus && <div className="mt-2 text-xs text-cyan-200">{quickRecoveryStatus}</div>}
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
                        Pts victoire
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
                        Pts petite finale
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          value={state.system.customRules.smallFinalPoints}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, smallFinalPoints: clampInt(Number(e.target.value), 0, 20) },
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
                        Rebuy (€)
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          step="0.1"
                          value={state.system.customRules.rebuyEUR}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, rebuyEUR: Math.max(0, Number(e.target.value)) },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        Rebuy S1-S2 (pts)
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          value={state.system.customRules.rebuyWinPointsS1S2}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: {
                                ...system.customRules,
                                rebuyWinPointsS1S2: clampInt(Number(e.target.value), 0, 20),
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        1er rebuy S3+ (pts)
                        <input
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                          type="number"
                          min={0}
                          value={state.system.customRules.rebuyFirstWinPointsS3Plus}
                          onChange={(e) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: {
                                ...system.customRules,
                                rebuyFirstWinPointsS3Plus: clampInt(Number(e.target.value), 0, 20),
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="text-xs">
                        Formats poules
                        <Select
                          value={String(state.system.customRules.defaultPoolFormat)}
                          onChange={(v) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, defaultPoolFormat: Number(v) === 501 ? 501 : 301 },
                            }))
                          }
                          options={["301", "501"]}
                        />
                      </label>
                      <label className="text-xs">
                        Format finale
                        <Select
                          value={String(state.system.customRules.defaultFinalFormat)}
                          onChange={(v) =>
                            updateSystem((system) => ({
                              ...system,
                              customRules: { ...system.customRules, defaultFinalFormat: Number(v) === 301 ? 301 : 501 },
                            }))
                          }
                          options={["301", "501"]}
                        />
                      </label>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Moteur de règles déclaratif (par soirée)</div>
                  <div className="mt-2 space-y-3">
                    {state.system.soireeRulePolicies.map((policy, idx) => (
                      <div key={policy.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-sm">{policy.label}</div>
                          <label className="inline-flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-white/20 bg-black"
                              checked={policy.enabled}
                              onChange={(e) =>
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx ? { ...p, enabled: e.target.checked } : p
                                  ),
                                }))
                              }
                            />
                            Activée
                          </label>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                          <label>
                            Soirée cible
                            <input
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                              type="number"
                              min={1}
                              max={99}
                              value={policy.trigger.soireeNumber ?? 6}
                              onChange={(e) =>
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx
                                      ? {
                                          ...p,
                                          trigger: { ...p.trigger, soireeNumber: clampInt(Number(e.target.value), 1, 99) },
                                        }
                                      : p
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label>
                            Multiplicateur points match
                            <input
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                              type="number"
                              min={1}
                              max={5}
                              value={policy.scoring.matchWinMultiplier}
                              onChange={(e) =>
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx
                                      ? {
                                          ...p,
                                          scoring: {
                                            ...p.scoring,
                                            matchWinMultiplier: Math.max(1, Number(e.target.value)),
                                          },
                                        }
                                      : p
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label>
                            Bonus checkout finale
                            <input
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                              type="number"
                              min={0}
                              max={20}
                              value={policy.scoring.checkoutBonusOverrides?.FINAL ?? 0}
                              onChange={(e) =>
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx
                                      ? {
                                          ...p,
                                          scoring: {
                                            ...p.scoring,
                                            checkoutBonusOverrides: {
                                              ...p.scoring.checkoutBonusOverrides,
                                              FINAL: clampInt(Number(e.target.value), 0, 20),
                                            },
                                          },
                                        }
                                      : p
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label>
                            Podium points (1/2/3)
                            <input
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-white"
                              type="text"
                              value={`${policy.scoring.podiumPointsOverride?.first ?? 0}/${policy.scoring.podiumPointsOverride?.second ?? 0}/${policy.scoring.podiumPointsOverride?.third ?? 0}`}
                              onChange={(e) => {
                                const [first, second, third] = e.target.value.split("/").map((v) => clampInt(Number(v), 0, 20));
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx
                                      ? {
                                          ...p,
                                          scoring: {
                                            ...p.scoring,
                                            podiumPointsOverride: {
                                              first: Number.isFinite(first) ? first : 0,
                                              second: Number.isFinite(second) ? second : 0,
                                              third: Number.isFinite(third) ? third : 0,
                                            },
                                          },
                                        }
                                      : p
                                  ),
                                }));
                              }}
                            />
                          </label>
                        </div>

                        <div className="mt-2 grid grid-cols-1 gap-2 text-xs">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-white/20 bg-black"
                              checked={policy.rebuy.lockAfterKnockoutStart}
                              onChange={(e) =>
                                updateSystem((system) => ({
                                  ...system,
                                  soireeRulePolicies: system.soireeRulePolicies.map((p, i) =>
                                    i === idx
                                      ? { ...p, rebuy: { ...p.rebuy, lockAfterKnockoutStart: e.target.checked } }
                                      : p
                                  ),
                                }))
                              }
                            />
                            Bloquer les re-buys dès le début des phases finales
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Qualité des données</div>
                  <div className="mt-2 space-y-1">
                    {diagnostics.length === 0 && <div className="text-xs text-emerald-300">Aucune incohérence détectée.</div>}
                    {diagnostics.slice(0, 8).map((issue, idx) => (
                      <div key={`${idx}-${issue}`} className="text-xs text-orange-300">
                        • {issue}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Sync multi-appareils (beta)</div>
                  <label className="mt-2 inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-white/20 bg-black"
                      checked={syncEnabled}
                      onChange={(e) => setSyncEnabled(e.target.checked)}
                    />
                    Activer la synchronisation cloud
                  </label>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr,auto,auto]">
                    <input
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                      placeholder="Code ligue (ex: RAZOR-2026)"
                      value={syncCode}
                      onChange={(e) => setSyncCode(e.target.value.toUpperCase())}
                    />
                    <Button variant="ghost" onClick={() => pullCloudState()} disabled={!syncEnabled || !normName(syncCode)}>
                      Pull cloud
                    </Button>
                    <Button variant="ghost" onClick={() => pushCloudState()} disabled={!syncEnabled || !normName(syncCode)}>
                      Push cloud
                    </Button>
                  </div>
                  <div className="mt-2 text-xs text-white/60">
                    {syncStatus || "Configure Supabase puis utilise le même code sur iPhone et ordinateur."}
                  </div>
                  <div className="mt-1 text-[11px] text-white/50">
                    SQL minimal: table `darts_states(room_code text primary key, payload jsonb not null, updated_at timestamptz not null default now())`.
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Partage simplifié</div>
                  <div className="mt-1 text-[11px] text-white/50">
                    {syncEnabled && normName(syncCode)
                      ? "Avec sync cloud active: lien live permanent (toujours à jour)."
                      : "Sans sync cloud: lien snapshot figé au moment de la génération."}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => exportSeasonSummaryText()}>
                      Export résumé (.txt)
                    </Button>
                    <Button variant="ghost" onClick={() => exportSeasonSummaryPDF()}>
                      Export résumé (PDF)
                    </Button>
                    <Button variant="ghost" onClick={() => generateReadOnlyLink()}>
                      Lien lecture seule
                    </Button>
                  </div>
                  {readOnlyLink && (
                    <textarea
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 p-2 text-xs text-white outline-none"
                      rows={3}
                      value={readOnlyLink}
                      readOnly
                    />
                  )}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Audit & journal</div>
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

        {tvMode && !readOnlyMode && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="mb-2 text-xs uppercase tracking-[0.24em] text-white/60">Régie TV</div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={tvAutoRotateEnabled ? "primary" : "ghost"} onClick={() => setTvAutoRotateEnabled((v) => !v)}>
                {tvAutoRotateEnabled ? "Auto ON" : "Auto OFF"} (Espace)
              </Button>
              <div className="w-44">
                <Select
                  value={String(tvRotateEveryMs)}
                  onChange={(v) => setTvRotateEveryMs([8000, 12000, 20000].includes(Number(v)) ? Number(v) : 12000)}
                  options={["8000", "12000", "20000"]}
                />
              </div>
              <Button variant="ghost" onClick={() => goToTvTab(-1)}>
                Précédent (←)
              </Button>
              <Button variant="ghost" onClick={() => goToTvTab(1)}>
                Suivant (→)
              </Button>
            </div>
            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="mb-2 text-xs text-white/60">Scènes broadcast</div>
              <div className="flex flex-wrap gap-2">
                <Button variant={tvSceneOverride === "" ? "primary" : "ghost"} onClick={() => setTvSceneOverride("")}>
                  Auto ({autoTvScene})
                </Button>
                {(["INTRO", "LINEUP", "MATCHFOCUS", "CLUTCH", "LIVE", "FINALE", "PODIUM"] as TvScene[]).map((scene) => (
                  <Button
                    key={scene}
                    variant={tvSceneOverride === scene ? "primary" : "ghost"}
                    onClick={() => {
                      setTvSceneOverride((prev) => (prev === scene ? "" : scene));
                      playSfx("scene");
                    }}
                  >
                    {scene}
                  </Button>
                ))}
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="mb-2 text-xs text-white/60">Affichage TV</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={tvDisplayMode === "BIGSCREEN" && tvInfoDensity === "FOCUS" ? "primary" : "ghost"}
                  onClick={() => applyTv190Preset()}
                >
                  Preset TV 190cm
                </Button>
                <Button variant="ghost" onClick={() => requestTvFullscreen()}>
                  Plein écran
                </Button>
                <Button variant={tvDisplayMode === "BIGSCREEN" ? "primary" : "ghost"} onClick={() => setTvDisplayMode("BIGSCREEN")}>
                  Big Screen
                </Button>
                <Button variant={tvDisplayMode === "STANDARD" ? "primary" : "ghost"} onClick={() => setTvDisplayMode("STANDARD")}>
                  Standard
                </Button>
                <Button variant={tvInfoDensity === "FOCUS" ? "primary" : "ghost"} onClick={() => setTvInfoDensity("FOCUS")}>
                  Mode Focus
                </Button>
                <Button variant={tvInfoDensity === "FULL" ? "primary" : "ghost"} onClick={() => setTvInfoDensity("FULL")}>
                  Mode Full
                </Button>
              </div>
              <div className="mt-2 text-[11px] text-white/60">
                Focus = moins d’infos à l’écran. Big Screen = éléments et typo plus grands pour TV.
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
              {TV_TAB_CATALOG.map((item) => {
                const enabled = tvRotationTabs.includes(item.tab);
                const idx = tvRotationTabs.indexOf(item.tab);
                return (
                  <div key={item.tab} className="rounded-xl border border-white/10 bg-black/20 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-white/20 bg-black"
                          checked={enabled}
                          onChange={() => toggleTvRotationTab(item.tab)}
                        />
                        {item.label}
                      </label>
                      {enabled && (
                        <div className="flex gap-1">
                          <Button variant="ghost" onClick={() => moveTvRotationTab(idx, -1)} disabled={idx <= 0}>
                            ↑
                          </Button>
                          <Button variant="ghost" onClick={() => moveTvRotationTab(idx, 1)} disabled={idx < 0 || idx >= tvRotationTabs.length - 1}>
                            ↓
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant={tvBroadcastOverlayKind === "SPONSOR" ? "primary" : "ghost"} onClick={() => setBroadcastOverlay("SPONSOR")}>
                Sponsor (S)
              </Button>
              <Button variant={tvBroadcastOverlayKind === "PAUSE" ? "primary" : "ghost"} onClick={() => setBroadcastOverlay("PAUSE")}>
                Pause (P)
              </Button>
              <Button variant={tvBroadcastOverlayKind === "ANNOUNCE" ? "primary" : "ghost"} onClick={() => setBroadcastOverlay("ANNOUNCE")}>
                Annonce (A)
              </Button>
              <Button variant="ghost" onClick={() => setTvBroadcastOverlayKind("")}>
                Effacer (Esc)
              </Button>
              <input
                className="min-w-[220px] flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                value={tvBroadcastAnnouncement}
                onChange={(e) => setTvBroadcastAnnouncement(e.target.value)}
                placeholder="Texte annonce"
              />
            </div>
            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="mb-2 text-xs text-white/60">Sound design</div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant={soundEnabled ? "primary" : "ghost"} onClick={() => setSoundEnabled((v) => !v)}>
                  {soundEnabled ? "Son ON" : "Son OFF"}
                </Button>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/60">Pack</span>
                  <div className="w-32">
                    <Select
                      value={soundProfile}
                      onChange={(v) => setSoundProfile(v === "SOFT" || v === "FINAL" ? v : "ARENA")}
                      options={["SOFT", "ARENA", "FINAL"]}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/60">Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={soundVolume}
                    onChange={(e) => setSoundVolume(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  />
                  <span className="text-xs text-white/70 w-8">{soundVolume}</span>
                </div>
                <Button variant="ghost" onClick={() => playSfx("scene")}>
                  Test son
                </Button>
              </div>
            </div>
          </div>
        )}

        {operatorFullscreen && !readOnlyMode && (
          <div className="fixed inset-0 z-50 bg-[#060a12] p-4 md:p-8">
            <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 rounded-2xl border border-cyan-300/25 bg-black/40 p-4 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.28em] text-cyan-200/80">Mode Opérateur</div>
                  <div className="text-xl font-extrabold">
                    Soirée {currentSoiree.number} • {getTournamentFormatLabel(currentSoiree.tournamentFormat ?? "CLASSIC_POOLS")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant={currentSoireeLocked ? "danger" : "ghost"} onClick={() => setCurrentSoireeLocked(!currentSoireeLocked)}>
                    {currentSoireeLocked ? "Déverrouiller" : "Verrouiller"}
                  </Button>
                  <Button variant="ghost" onClick={() => setOperatorFullscreen(false)}>
                    Fermer (Esc)
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-white/60">Match focus</div>
                  {operatorFocusMatch ? (
                    <>
                      <div className="mt-3 grid grid-cols-[1fr,auto,1fr] items-center gap-3">
                        <div className="text-3xl font-black">{operatorFocusMatch.a || "—"}</div>
                        <div className="text-white/40">VS</div>
                        <div className="text-right text-3xl font-black">{operatorFocusMatch.b || "—"}</div>
                      </div>
                      <div className="mt-2 text-xs text-white/60">
                        Match #{operatorFocusMatch.order} • {operatorFocusMatch.phase}
                        {operatorFocusMatch.pool ? ` • Poule ${operatorFocusMatch.pool}` : ""}
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Button
                          variant={normName(operatorFocusMatch.winner) === normName(operatorFocusMatch.a) ? "primary" : "ghost"}
                          size="touch"
                          onClick={() => setMatchWinner(operatorFocusMatch.id, operatorFocusMatch.a)}
                          disabled={!operatorFocusMatch.a || !operatorFocusMatch.b || currentSoireeLocked}
                        >
                          Valider {operatorFocusMatch.a || "A"}
                        </Button>
                        <Button
                          variant={normName(operatorFocusMatch.winner) === normName(operatorFocusMatch.b) ? "primary" : "ghost"}
                          size="touch"
                          onClick={() => setMatchWinner(operatorFocusMatch.id, operatorFocusMatch.b)}
                          disabled={!operatorFocusMatch.a || !operatorFocusMatch.b || currentSoireeLocked}
                        >
                          Valider {operatorFocusMatch.b || "B"}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="mt-3 text-sm text-white/70">Aucun match disponible.</div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-white/60">Chrono</div>
                    <div className="mt-2 text-3xl font-black">{formatDuration(soireeTiming.elapsedMs)}</div>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      <Button onClick={() => startSoireeTimer()} disabled={currentSoireeLocked}>
                        Démarrer
                      </Button>
                      <Button variant="ghost" onClick={() => stopSoireeTimer()} disabled={currentSoireeLocked || !soireeTiming.startedAt || Boolean(soireeTiming.endedAt)}>
                        Stop
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-white/60">Pilotage</div>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      <Button onClick={() => launchNextRecommendedMatch()} disabled={!liveSchedule.nextMatch || currentSoireeLocked}>
                        Lancer prochain match
                      </Button>
                      <Button variant="ghost" onClick={() => recalcFinalsFromPools()} disabled={currentSoireeLocked}>
                        Calculer demis
                      </Button>
                      <Button variant="ghost" onClick={() => recalcFinalAndPFinal()} disabled={currentSoireeLocked}>
                        Calculer finales
                      </Button>
                    </div>
                    <div className="mt-2 text-xs text-white/60">
                      Raccourcis: <span className="font-semibold">N</span> prochain match • <span className="font-semibold">T</span> chrono • <span className="font-semibold">L</span> verrou • <span className="font-semibold">O</span> ouvrir/fermer.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {showAttendanceModal && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm p-4 grid place-items-center">
            <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0f172a] p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold">Présence joueurs — nouvelle soirée</h3>
                  <div className="text-xs text-white/60">Clique sur un nom pour le marquer absent.</div>
                </div>
                <Pill>Présents: {currentSeason.players.length - absentPlayersSelection.length}</Pill>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {currentSeason.players.map((p) => {
                  const isAbsent = absentPlayersSelection.includes(p);
                  return (
                    <button
                      key={p}
                      className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                        isAbsent ? "border-red-400 bg-red-500/20 text-red-100" : "border-white/10 bg-white/5 text-white hover:bg-white/10"
                      }`}
                      onClick={() => toggleAbsentPlayer(p)}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4">
                <div className="text-xs text-white/60 mb-1">Format soirée</div>
                <Select
                  value={newSoireeFormat}
                  onChange={(v) =>
                    setNewSoireeFormat(
                      v === "ROUND_ROBIN" || v === "SWISS_LITE" || v === "DOUBLE_ELIM_LITE" ? v : "CLASSIC_POOLS"
                    )
                  }
                  options={["CLASSIC_POOLS", "ROUND_ROBIN", "SWISS_LITE", "DOUBLE_ELIM_LITE"]}
                />
                <div className="mt-1 text-[11px] text-white/50">
                  {newSoireeFormat === "CLASSIC_POOLS" && "Format ligue classique: poules A/B puis demis/finales."}
                  {newSoireeFormat === "ROUND_ROBIN" && "Tous contre tous (5-8 joueurs), puis Top 4 en demis."}
                  {newSoireeFormat === "SWISS_LITE" && "Swiss Lite: ~3 matchs/joueur, puis Top 4 en demis."}
                  {newSoireeFormat === "DOUBLE_ELIM_LITE" && "Double Elim Lite: ~2 matchs/joueur (2 vies), puis Top 4 en demis."}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowAttendanceModal(false);
                    setAbsentPlayersSelection([]);
                  }}
                >
                  Annuler
                </Button>
                <Button
                  variant="primary"
                  disabled={readOnlyMode || currentSeason.players.length - absentPlayersSelection.length < 4}
                  onClick={() => startNewSoiree(absentPlayersSelection, newSoireeFormat)}
                >
                  Générer la soirée
                </Button>
              </div>
              {currentSeason.players.length - absentPlayersSelection.length < 4 && (
                <div className="mt-2 text-xs text-orange-300">Il faut au moins 4 joueurs présents.</div>
              )}
            </div>
          </div>
        )}

        {showSoireeClosureModal && closureSoiree && (
          <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm p-4 grid place-items-center">
            <div className="w-full max-w-2xl rounded-2xl border border-emerald-400/25 bg-[#0f172a] p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold">Soirée {closureSoiree.number} terminée</h3>
                  <div className="text-xs text-white/60">Clôture automatique détectée ({closureSeason.name}).</div>
                </div>
                <Pill color="#22c55e">Fin détectée</Pill>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Durée totale</div>
                  <div className="mt-1 text-xl font-extrabold">{formatDuration(getSoireeDurationMs(closureSoiree, clockNow))}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Matchs joués</div>
                  <div className="mt-1 text-xl font-extrabold">
                    {closureSoiree.matches.filter((m: CoreMatch) => Boolean(normName(m.winner))).length}/{closureSoiree.matches.length}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Re-buys</div>
                  <div className="mt-1 text-xl font-extrabold">{closureSoiree.rebuys.length}</div>
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs text-white/60">Podium de la soirée</div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    { rank: 2, label: "2e", player: closureSoireePodium?.second ?? "", gain: MONEY.podiumEUR.second },
                    { rank: 1, label: "1er", player: closureSoireePodium?.first ?? "", gain: MONEY.podiumEUR.first },
                    { rank: 3, label: "3e", player: closureSoireePodium?.third ?? "", gain: MONEY.podiumEUR.third },
                  ].map((slot) => (
                    <div
                      key={slot.rank}
                      className={`rounded-xl border px-3 py-3 ${slot.rank === 1 ? "border-emerald-300/40 bg-emerald-500/15" : "border-white/10 bg-black/20"}`}
                    >
                      <div className="text-xs text-white/70">
                        #{slot.rank} • {slot.label}
                      </div>
                      <div className="mt-1 text-base font-semibold">{slot.player || "—"}</div>
                      <div className="mt-1 text-xs text-white/60">{formatEUR(slot.gain)}</div>
                    </div>
                  ))}
                </div>
                {closureSoireePodium?.provisional && (
                  <div className="mt-2 text-[11px] text-white/50">
                    Podium provisoire (finale / petite finale incomplètes).
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs text-white/60">Récap classement soirée</div>
                <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1 text-sm">
                  {closureSoireeRankingRows.map((row, idx) => (
                    <div key={row.name} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white/50 w-5">{idx + 1}.</span>
                        <span className="font-semibold">{row.name}</span>
                      </div>
                      <div className="text-xs text-white/70">{row.pts} pts • {row.wins} V • {row.bonus} bonus</div>
                    </div>
                  ))}
                </div>
              </div>

              {closureSoireeHighlights.length > 0 && (
                <div className="mt-3 rounded-xl border border-fuchsia-300/25 bg-fuchsia-500/10 p-3">
                  <div className="text-xs text-fuchsia-100/80">Top Moments Auto</div>
                  <div className="mt-2 space-y-1 text-sm">
                    {closureSoireeHighlights.map((h, idx) => (
                      <div key={h.id} className="rounded-lg bg-black/25 px-2 py-1">
                        <div className="text-white/90 font-semibold">{idx + 1}. {h.title}</div>
                        <div className="text-white/70 text-xs">{h.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {closureAutoExportStatus && (
                <div className="mt-3 rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                  {closureAutoExportStatus}
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => exportSoireeSummaryText(closureSoiree)}>
                  Export résumé (.txt)
                </Button>
                <Button variant="ghost" onClick={() => exportSoireeSummaryPDF(closureSoiree)}>
                  Export résumé (PDF)
                </Button>
                <Button variant="ghost" onClick={() => exportSoireeHighlightsText(closureSoiree)}>
                  Export highlights (.txt)
                </Button>
                <Button variant="ghost" onClick={() => exportSoireeHighlightsPDF(closureSoiree)}>
                  Export highlights (PDF)
                </Button>
                <Button variant="ghost" onClick={() => exportSoireeStatsPDF(closureSoiree)}>
                  Export stats (PDF)
                </Button>
                <Button
                  variant={closureSoiree.locked ? "danger" : "primary"}
                  onClick={() => {
                    if (selectedSoireeNumber !== closureSoiree.number) setSelectedSoireeNumber(closureSoiree.number);
                    setSoireeLockedById(closureSoiree.id, !Boolean(closureSoiree.locked));
                  }}
                >
                  {closureSoiree.locked ? "Déverrouiller la soirée" : "Verrouiller la soirée"}
                </Button>
              </div>

              <div className="mt-4 flex justify-end">
                <Button variant="primary" onClick={() => setShowSoireeClosureModal(false)}>
                  Fermer
                </Button>
              </div>
            </div>
          </div>
        )}

        </div>

        <div className="mt-8 text-center text-xs text-white/40">Darts League — app locale • v{VERSION}</div>
      </div>
    </div>
  );
}
