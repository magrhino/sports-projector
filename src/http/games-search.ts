import {
  EspnClient,
  normalizeScoreboard,
  normalizeTeamSchedule,
  type EspnNormalizedGame,
  type EspnTeam
} from "../clients/espn.js";
import type { CacheStatus } from "../lib/cache.js";
import { nowIso } from "../lib/response.js";
import { LeagueSchema, TeamQuerySchema, type League } from "../lib/validation.js";

interface TeamScheduleClient {
  getTeamSchedule(input: { league: League; team: string; season?: number }): Promise<{
    cacheStatus: CacheStatus;
    data: unknown;
    sourceUrl: string;
  }>;
}

interface ScoreboardClient {
  getScoreboard(input: { league: League; limit?: number }): Promise<{
    cacheStatus: CacheStatus;
    data: unknown;
    sourceUrl: string;
  }>;
}

export interface GamesSearchResult {
  status: number;
  body: {
    source?: "espn";
    fetched_at?: string;
    source_url?: string | null;
    cache_status?: CacheStatus;
    team?: EspnTeam | null;
    count?: number;
    games?: EspnNormalizedGame[];
    error?: string;
  };
}

export interface LiveGamesResult {
  status: number;
  body: {
    source?: "espn";
    fetched_at?: string;
    source_url?: string | null;
    cache_status?: CacheStatus;
    league?: League;
    count?: number;
    games?: EspnNormalizedGame[];
    error?: string;
  };
}

export async function getLiveGames(
  searchParams: URLSearchParams,
  client: ScoreboardClient = new EspnClient()
): Promise<LiveGamesResult> {
  const league = LeagueSchema.safeParse(searchParams.get("league") ?? "nba");
  if (!league.success) {
    return {
      status: 400,
      body: {
        error: league.error.issues[0]?.message ?? "Invalid league query parameter."
      }
    };
  }

  try {
    const result = await client.getScoreboard({ league: league.data, limit: 100 });
    const data = normalizeScoreboard(league.data, result.data);
    const games = data.games.filter(isLiveGame);

    return {
      status: 200,
      body: {
        source: "espn",
        fetched_at: nowIso(),
        source_url: result.sourceUrl,
        cache_status: result.cacheStatus,
        league: data.league,
        count: games.length,
        games
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      body: {
        error: `Unable to fetch ESPN scoreboard: ${message}`
      }
    };
  }
}

export async function searchGamesByTeam(
  searchParams: URLSearchParams,
  client: TeamScheduleClient = new EspnClient()
): Promise<GamesSearchResult> {
  const parsedInput = parseSearchInput(searchParams);
  if ("error" in parsedInput) {
    return {
      status: 400,
      body: {
        error: parsedInput.error
      }
    };
  }

  try {
    const result = await client.getTeamSchedule(parsedInput);
    const data = normalizeTeamSchedule(parsedInput.league, result.data);

    return {
      status: 200,
      body: {
        source: "espn",
        fetched_at: nowIso(),
        source_url: result.sourceUrl,
        cache_status: result.cacheStatus,
        team: data.team,
        count: data.count,
        games: data.games
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTeamResolutionError = message.startsWith("Could not resolve ESPN team");

    return {
      status: isTeamResolutionError ? 404 : 502,
      body: {
        error: isTeamResolutionError ? message : `Unable to fetch ESPN team schedule: ${message}`
      }
    };
  }
}

function parseSearchInput(
  searchParams: URLSearchParams
): { league: League; team: string; season?: number } | { error: string } {
  const rawTeam = searchParams.get("team");
  if (rawTeam === null || rawTeam.trim() === "") {
    return { error: "Missing required team query parameter." };
  }

  const team = TeamQuerySchema.safeParse(rawTeam);
  if (!team.success) {
    return { error: team.error.issues[0]?.message ?? "Invalid team query parameter." };
  }

  const league = LeagueSchema.safeParse(searchParams.get("league") ?? "nba");
  if (!league.success) {
    return { error: league.error.issues[0]?.message ?? "Invalid league query parameter." };
  }

  const season = parseSeason(searchParams.get("season"));
  if ("error" in season) {
    return season;
  }

  return {
    league: league.data,
    team: team.data,
    season: season.value
  };
}

function parseSeason(rawSeason: string | null): { value?: number } | { error: string } {
  if (rawSeason === null || rawSeason.trim() === "") {
    return {};
  }

  if (!/^\d+$/.test(rawSeason)) {
    return { error: "Season must be a whole year." };
  }

  const season = Number(rawSeason);
  if (!Number.isInteger(season) || season < 1900 || season > 2200) {
    return { error: "Season must be between 1900 and 2200." };
  }

  return { value: season };
}

function isLiveGame(game: EspnNormalizedGame): boolean {
  if (game.status.state === "in") {
    return true;
  }

  const detail = `${game.status.description ?? ""} ${game.status.detail ?? ""}`.toLowerCase();
  return !game.status.completed && /\b(in progress|quarter|half|period|inning)\b/.test(detail);
}
