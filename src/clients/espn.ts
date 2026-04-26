import type { CacheStatus } from "../lib/cache.js";
import { TtlCache, ttlMsFromEnv } from "../lib/cache.js";
import { ESPN_SITE_ORIGIN, buildUrl, fetchJson, type FetchJsonOptions } from "../lib/http.js";
import { type League, getLeagueConfig } from "../lib/validation.js";

interface CachedFetch<T> {
  cacheStatus: CacheStatus;
  data: T;
  sourceUrl: string;
}

interface EspnClientOptions extends FetchJsonOptions {
  env?: NodeJS.ProcessEnv;
}

export interface EspnTeam {
  id: string;
  name: string;
  abbreviation: string;
  logo?: string | null;
  location?: string;
  nickname?: string;
  short_name?: string;
}

export interface EspnNormalizedTeam {
  id: string | null;
  name: string;
  abbreviation: string;
  logo?: string | null;
  home_away: "home" | "away" | string;
  score: number | null;
  record: string | null;
  winner: boolean | null;
  linescore: Array<{
    period: number | null;
    value: number | null;
    display_value: string | null;
  }>;
}

export interface EspnNormalizedGame {
  id: string;
  name: string | null;
  short_name: string | null;
  start_time: string | null;
  status: {
    state: string | null;
    description: string | null;
    detail: string | null;
    completed: boolean;
    period: number | null;
    period_name: string;
    clock: string | null;
  };
  teams: {
    home: EspnNormalizedTeam | null;
    away: EspnNormalizedTeam | null;
  };
  venue: {
    name: string | null;
    city: string | null;
    state: string | null;
  } | null;
  broadcasts: string[];
}

export function buildEspnScoreboardUrl(league: League, date?: string, limit?: number): URL {
  const config = getLeagueConfig(league);
  return buildUrl(
    ESPN_SITE_ORIGIN,
    ["apis", "site", "v2", "sports", config.sport, config.league, "scoreboard"],
    {
      dates: date,
      limit
    }
  );
}

export function buildEspnSummaryUrl(league: League, eventId: string): URL {
  const config = getLeagueConfig(league);
  return buildUrl(
    ESPN_SITE_ORIGIN,
    ["apis", "site", "v2", "sports", config.sport, config.league, "summary"],
    { event: eventId }
  );
}

export function buildEspnTeamsUrl(league: League): URL {
  const config = getLeagueConfig(league);
  return buildUrl(ESPN_SITE_ORIGIN, ["apis", "site", "v2", "sports", config.sport, config.league, "teams"]);
}

export function buildEspnTeamScheduleUrl(league: League, teamId: string, season?: number): URL {
  const config = getLeagueConfig(league);
  return buildUrl(
    ESPN_SITE_ORIGIN,
    ["apis", "site", "v2", "sports", config.sport, config.league, "teams", teamId, "schedule"],
    { season }
  );
}

export function buildEspnStandingsUrl(league: League, season?: number): URL {
  const config = getLeagueConfig(league);
  return buildUrl(
    ESPN_SITE_ORIGIN,
    ["apis", "v2", "sports", config.sport, config.league, "standings"],
    { season }
  );
}

export class EspnClient {
  private readonly scoreboardCache: TtlCache<unknown>;
  private readonly detailCache: TtlCache<unknown>;
  private readonly fetchOptions: FetchJsonOptions;

  constructor(options: EspnClientOptions = {}) {
    const env = options.env ?? process.env;
    this.scoreboardCache = new TtlCache<unknown>(
      ttlMsFromEnv(env, "SPORTS_KALSHI_ESPN_SCOREBOARD_TTL_SECONDS", 20, 0, 30)
    );
    this.detailCache = new TtlCache<unknown>(
      ttlMsFromEnv(env, "SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS", 30, 0, 60)
    );
    this.fetchOptions = {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    };
  }

  async getScoreboard(input: { league: League; date?: string; limit?: number }): Promise<CachedFetch<unknown>> {
    const url = buildEspnScoreboardUrl(input.league, input.date, input.limit);
    return this.fetchCached(url, this.scoreboardCache);
  }

  async getGameSummary(input: { league: League; eventId: string }): Promise<CachedFetch<unknown>> {
    const url = buildEspnSummaryUrl(input.league, input.eventId);
    return this.fetchCached(url, this.detailCache);
  }

  async getTeams(input: { league: League }): Promise<CachedFetch<unknown>> {
    const url = buildEspnTeamsUrl(input.league);
    return this.fetchCached(url, this.detailCache);
  }

  async getTeamSchedule(input: { league: League; team: string; season?: number }): Promise<CachedFetch<unknown>> {
    const team = await this.resolveTeam(input.league, input.team);
    const url = buildEspnTeamScheduleUrl(input.league, team.id, input.season);
    const result = await this.fetchCached(url, this.detailCache);
    return {
      ...result,
      data: {
        resolved_team: team,
        schedule: result.data
      }
    };
  }

  async getStandings(input: { league: League; season?: number }): Promise<CachedFetch<unknown>> {
    const url = buildEspnStandingsUrl(input.league, input.season);
    return this.fetchCached(url, this.detailCache);
  }

  async resolveTeam(league: League, teamQuery: string): Promise<EspnTeam> {
    if (/^\d+$/.test(teamQuery)) {
      return {
        id: teamQuery,
        name: teamQuery,
        abbreviation: teamQuery,
        logo: null
      };
    }

    const teamsResponse = await this.getTeams({ league });
    const teams = extractTeams(teamsResponse.data);
    const normalizedQuery = normalizeForMatch(teamQuery);

    const exact = teams.find((team) =>
      [
        team.id,
        team.name,
        team.abbreviation,
        team.location,
        team.nickname,
        team.short_name
      ].some((field) => field !== undefined && normalizeForMatch(field) === normalizedQuery)
    );

    if (exact) {
      return exact;
    }

    const partial = teams.find((team) =>
      [team.name, team.location, team.nickname, team.short_name].some(
        (field) => field !== undefined && normalizeForMatch(field).includes(normalizedQuery)
      )
    );

    if (partial) {
      return partial;
    }

    throw new Error(`Could not resolve ESPN team "${teamQuery}" for ${league.toUpperCase()}`);
  }

  private async fetchCached<T>(url: URL, cache: TtlCache<unknown>): Promise<CachedFetch<T>> {
    const key = url.toString();
    const result = await cache.getOrSet(key, async () => fetchJson<T>(url, this.fetchOptions));
    return {
      cacheStatus: result.status,
      data: result.value as T,
      sourceUrl: key
    };
  }
}

export function normalizeScoreboard(league: League, raw: unknown): {
  league: League;
  date: string | null;
  count: number;
  games: EspnNormalizedGame[];
} {
  const data = asRecord(raw);
  const events = asArray(data.events);
  return {
    league,
    date: asString(asRecord(data.day).date),
    count: events.length,
    games: events.map((event) => normalizeGame(league, event)).filter((game): game is EspnNormalizedGame => game !== null)
  };
}

export function normalizeGameSummary(league: League, eventId: string, raw: unknown): {
  league: League;
  event_id: string;
  game: EspnNormalizedGame | null;
  leaders: unknown[];
  boxscore: unknown | null;
} {
  const data = asRecord(raw);
  const header = asRecord(data.header);
  const game = normalizeGame(league, {
    id: header.id ?? eventId,
    name: header.name,
    shortName: header.shortName,
    competitions: header.competitions
  });

  return {
    league,
    event_id: eventId,
    game,
    leaders: asArray(data.leaders),
    boxscore: data.boxscore ?? null
  };
}

export function normalizeTeamSchedule(league: League, raw: unknown): {
  league: League;
  team: EspnTeam | null;
  count: number;
  games: EspnNormalizedGame[];
} {
  const data = asRecord(raw);
  const resolvedTeam = asRecord(data.resolved_team);
  const schedule = asRecord(data.schedule);
  const events = asArray(schedule.events);
  return {
    league,
    team:
      typeof resolvedTeam.id === "string"
        ? {
            id: resolvedTeam.id,
            name: asString(resolvedTeam.name) ?? resolvedTeam.id,
            abbreviation: asString(resolvedTeam.abbreviation) ?? resolvedTeam.id,
            logo: asString(resolvedTeam.logo),
            location: asString(resolvedTeam.location) ?? undefined,
            nickname: asString(resolvedTeam.nickname) ?? undefined,
            short_name: asString(resolvedTeam.short_name) ?? undefined
          }
        : null,
    count: events.length,
    games: events.map((event) => normalizeGame(league, event)).filter((game): game is EspnNormalizedGame => game !== null)
  };
}

export function normalizeStandings(league: League, raw: unknown): {
  league: League;
  season: number | null;
  groups: Array<{
    name: string | null;
    abbreviation: string | null;
    teams: Array<{
      id: string | null;
      name: string | null;
      abbreviation: string | null;
      stats: Record<string, string | number | boolean | null>;
    }>;
  }>;
} {
  const data = asRecord(raw);
  const groups = asArray(data.children);
  const normalizedGroups = groups.map((group) => {
    const groupRecord = asRecord(group);
    const standings = asRecord(groupRecord.standings);
    const entries = asArray(standings.entries);
    return {
      name: asString(groupRecord.name),
      abbreviation: asString(groupRecord.abbreviation),
      teams: entries.map((entry) => {
        const entryRecord = asRecord(entry);
        const team = asRecord(entryRecord.team);
        return {
          id: asString(team.id),
          name: asString(team.displayName),
          abbreviation: asString(team.abbreviation),
          stats: normalizeStats(asArray(entryRecord.stats))
        };
      })
    };
  });

  return {
    league,
    season: findSeason(data, normalizedGroups),
    groups: normalizedGroups
  };
}

function normalizeGame(league: League, raw: unknown): EspnNormalizedGame | null {
  const event = asRecord(raw);
  const competition = asRecord(asArray(event.competitions)[0]);
  if (Object.keys(competition).length === 0) {
    return null;
  }

  const competitors = asArray(competition.competitors);
  const home = competitors.find((competitor) => asRecord(competitor).homeAway === "home");
  const away = competitors.find((competitor) => asRecord(competitor).homeAway === "away");
  const status = asRecord(competition.status);
  const statusType = asRecord(status.type);
  const venue = asRecord(competition.venue);
  const address = asRecord(venue.address);

  return {
    id: String(event.id ?? competition.id ?? ""),
    name: asString(event.name),
    short_name: asString(event.shortName),
    start_time: asString(event.date ?? competition.date),
    status: {
      state: asString(statusType.state),
      description: asString(statusType.description),
      detail: asString(statusType.detail ?? statusType.shortDetail),
      completed: Boolean(statusType.completed),
      period: asNumber(status.period),
      period_name: getLeagueConfig(league).periodName,
      clock: asString(status.displayClock)
    },
    teams: {
      home: home ? normalizeCompetitor(home) : null,
      away: away ? normalizeCompetitor(away) : null
    },
    venue:
      Object.keys(venue).length > 0
        ? {
            name: asString(venue.fullName),
            city: asString(address.city),
            state: asString(address.state)
          }
        : null,
    broadcasts: asArray(competition.broadcasts).flatMap((broadcast) => asArray(asRecord(broadcast).names).map(String))
  };
}

function normalizeCompetitor(raw: unknown): EspnNormalizedTeam {
  const competitor = asRecord(raw);
  const team = asRecord(competitor.team);
  return {
    id: asString(team.id),
    name: asString(team.displayName) ?? "",
    abbreviation: asString(team.abbreviation) ?? "",
    logo: extractTeamLogo(team),
    home_away: String(competitor.homeAway ?? ""),
    score: asNumber(competitor.score),
    record: asString(asRecord(asArray(competitor.records)[0]).summary),
    winner: typeof competitor.winner === "boolean" ? competitor.winner : null,
    linescore: asArray(competitor.linescores).map((line) => {
      const lineRecord = asRecord(line);
      return {
        period: asNumber(lineRecord.period),
        value: asNumber(lineRecord.value),
        display_value: asString(lineRecord.displayValue)
      };
    })
  };
}

function extractTeams(raw: unknown): EspnTeam[] {
  const data = asRecord(raw);
  const sports = asArray(data.sports);
  return sports.flatMap((sport) =>
    asArray(asRecord(sport).leagues).flatMap((league) =>
      asArray(asRecord(league).teams).map((entry) => {
        const team = asRecord(asRecord(entry).team);
        return {
          id: String(team.id ?? ""),
          name: asString(team.displayName) ?? "",
          abbreviation: asString(team.abbreviation) ?? "",
          logo: extractTeamLogo(team),
          location: asString(team.location) ?? undefined,
          nickname: asString(team.name) ?? undefined,
          short_name: asString(team.shortDisplayName) ?? undefined
        };
      })
    )
  );
}

function extractTeamLogo(team: Record<string, unknown>): string | null {
  const directLogo = asString(team.logo);
  if (directLogo !== null) {
    return directLogo;
  }

  const firstLogo = asRecord(asArray(team.logos)[0]);
  return asString(firstLogo.href);
}

function normalizeStats(rawStats: unknown[]): Record<string, string | number | boolean | null> {
  const stats: Record<string, string | number | boolean | null> = {};
  for (const rawStat of rawStats) {
    const stat = asRecord(rawStat);
    const name = asString(stat.name);
    if (!name) {
      continue;
    }
    stats[name] = asScalar(stat.displayValue) ?? asScalar(stat.value);
  }
  return stats;
}

function findSeason(data: Record<string, unknown>, groups: Array<{ teams: unknown[] }>): number | null {
  const seasonFromData = asNumber(asArray(data.seasons).map((season) => asRecord(season).year)[0]);
  if (seasonFromData !== null) {
    return seasonFromData;
  }

  for (const group of asArray(data.children)) {
    const season = asNumber(asRecord(asRecord(group).standings).season);
    if (season !== null) {
      return season;
    }
  }

  return groups.length > 0 ? new Date().getFullYear() : null;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asScalar(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}
