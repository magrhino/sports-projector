import { existsSync } from "node:fs";
import path from "node:path";
import { EspnClient, normalizeGameSummary, type EspnNormalizedGame } from "../clients/espn.js";
import { KalshiClient } from "../clients/kalshi.js";
import type { CacheStatus } from "../lib/cache.js";
import { nowIso } from "../lib/response.js";
import { EventIdSchema } from "../lib/validation.js";
import { HistoricalProjectionClient, type HistoricalProjectionInput } from "../nba/historical-client.js";
import { projectNbaLiveScore } from "../nba/live-tool.js";

interface CachedFetch<T> {
  cacheStatus: CacheStatus;
  data: T;
  sourceUrl: string;
}

interface EspnSummaryClient {
  getGameSummary(input: { league: "nba"; eventId: string }): Promise<CachedFetch<unknown>>;
}

interface HistoricalProjectionRunner {
  project(input: HistoricalProjectionInput): Promise<Record<string, unknown>>;
}

export interface NbaProjectionClients {
  espnClient?: EspnClient;
  kalshiClient?: KalshiClient;
  historicalClient?: HistoricalProjectionRunner;
}

type ProjectionScope = "all" | "live";

type ProjectionSection =
  | {
      status: "ok";
      data: unknown;
    }
  | {
      status: "error";
      error: string;
    };

export interface NbaProjectionResult {
  status: number;
  body: {
    source?: "nba_projection";
    fetched_at?: string;
    event_id?: string;
    scope?: ProjectionScope;
    game?: EspnNormalizedGame;
    source_url?: string | null;
    cache_status?: CacheStatus;
    live_projection?: ProjectionSection;
    historical_projection?: ProjectionSection;
    error?: string;
  };
}

export async function getNbaProjections(
  searchParams: URLSearchParams,
  clients: NbaProjectionClients = {}
): Promise<NbaProjectionResult> {
  const parsed = parseProjectionInput(searchParams);
  if ("error" in parsed) {
    return {
      status: 400,
      body: {
        error: parsed.error
      }
    };
  }

  const espnClient = clients.espnClient ?? new EspnClient();
  const kalshiClient = clients.kalshiClient ?? new KalshiClient();
  const historicalClient = clients.historicalClient ?? defaultWebHistoricalClient();
  const allowHistoricalFallback = clients.historicalClient === undefined;
  let summaryResult: CachedFetch<unknown>;
  let game: EspnNormalizedGame | null;

  try {
    summaryResult = await espnClient.getGameSummary({ league: "nba", eventId: parsed.eventId });
    game = normalizeGameSummary("nba", parsed.eventId, summaryResult.data).game;
  } catch (error) {
    return {
      status: 502,
      body: {
        error: `Unable to fetch ESPN NBA game summary: ${errorMessage(error)}`
      }
    };
  }

  if (!game) {
    return {
      status: 502,
      body: {
        error: `ESPN summary for event ${parsed.eventId} did not include a game.`
      }
    };
  }

  const liveProjection = await projectLiveSection(parsed.eventId, espnClient, kalshiClient);
  const body: NbaProjectionResult["body"] = {
    source: "nba_projection",
    fetched_at: nowIso(),
    event_id: parsed.eventId,
    scope: parsed.scope,
    game,
    source_url: summaryResult.sourceUrl,
    cache_status: summaryResult.cacheStatus,
    live_projection: liveProjection
  };

  if (parsed.scope === "all") {
    body.historical_projection = await projectHistoricalSection(game, historicalClient, liveProjection, allowHistoricalFallback);
  }

  return {
    status: 200,
    body
  };
}

function parseProjectionInput(searchParams: URLSearchParams): { eventId: string; scope: ProjectionScope } | { error: string } {
  const eventId = EventIdSchema.safeParse(searchParams.get("event_id") ?? "");
  if (!eventId.success) {
    return { error: eventId.error.issues[0]?.message ?? "Invalid event_id query parameter." };
  }

  const rawScope = searchParams.get("scope") ?? "all";
  if (rawScope !== "all" && rawScope !== "live") {
    return { error: "Scope must be all or live." };
  }

  return {
    eventId: eventId.data,
    scope: rawScope
  };
}

async function projectLiveSection(
  eventId: string,
  espnClient: EspnSummaryClient,
  kalshiClient: KalshiClient
): Promise<ProjectionSection> {
  try {
    return {
      status: "ok",
      data: await projectNbaLiveScore({ event_id: eventId, include_debug: false }, espnClient as EspnClient, kalshiClient)
    };
  } catch (error) {
    return {
      status: "error",
      error: errorMessage(error)
    };
  }
}

async function projectHistoricalSection(
  game: EspnNormalizedGame,
  historicalClient: HistoricalProjectionRunner,
  liveProjection: ProjectionSection,
  allowFallback: boolean
): Promise<ProjectionSection> {
  const input = historicalInputFromGame(game, liveProjection);
  if ("error" in input) {
    return {
      status: "error",
      error: input.error
    };
  }

  try {
    return {
      status: "ok",
      data: await historicalClient.project(input)
    };
  } catch (error) {
    const fallbackClient = allowFallback ? fallbackWebHistoricalClient() : null;
    if (fallbackClient) {
      try {
        return {
          status: "ok",
          data: await fallbackClient.project(input)
        };
      } catch {
        // Report the original local-artifact failure below; it is usually the actionable cause.
      }
    }

    return {
      status: "error",
      error: errorMessage(error)
    };
  }
}

function historicalInputFromGame(
  game: EspnNormalizedGame,
  liveProjection: ProjectionSection
): HistoricalProjectionInput | { error: string } {
  const homeTeam = game.teams.home?.name || game.teams.home?.abbreviation;
  const awayTeam = game.teams.away?.name || game.teams.away?.abbreviation;
  const gameDate = isoDateFromStartTime(game.start_time);

  if (!homeTeam || !awayTeam || !gameDate) {
    return {
      error: "Historical projection requires home team, away team, and game date from ESPN."
    };
  }

  const input: HistoricalProjectionInput = {
    home_team: homeTeam,
    away_team: awayTeam,
    game_date: gameDate
  };
  const marketTotal = liveMarketTotal(liveProjection);
  if (marketTotal !== null) {
    input.market_total = marketTotal;
  }

  return input;
}

function isoDateFromStartTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function liveMarketTotal(section: ProjectionSection): number | null {
  if (section.status !== "ok" || !section.data || typeof section.data !== "object") {
    return null;
  }

  const liveProjection = (section.data as { live_projection?: unknown }).live_projection;
  if (!liveProjection || typeof liveProjection !== "object") {
    return null;
  }

  const marketTotal = (liveProjection as { market_total_line?: unknown }).market_total_line;
  return typeof marketTotal === "number" && Number.isFinite(marketTotal) ? marketTotal : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWebHistoricalClient(): HistoricalProjectionClient {
  const root = process.env.SPORTS_PROJECTOR_HISTORICAL_ROOT ?? process.cwd();
  const configuredArtifactDir = process.env.SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR;
  if (configuredArtifactDir) {
    return new HistoricalProjectionClient();
  }

  const defaultArtifactDir = path.join(root, "data", "historical");
  if (existsSync(path.join(defaultArtifactDir, "manifest.json"))) {
    return new HistoricalProjectionClient();
  }

  const fixtureArtifactDir = path.join(root, "fixtures", "nba-historical-linear");
  if (!existsSync(path.join(fixtureArtifactDir, "manifest.json"))) {
    return new HistoricalProjectionClient();
  }

  return historicalClientForArtifactDir(root, fixtureArtifactDir);
}

function fallbackWebHistoricalClient(): HistoricalProjectionClient | null {
  if (process.env.SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR) {
    return null;
  }

  const root = process.env.SPORTS_PROJECTOR_HISTORICAL_ROOT ?? process.cwd();
  const fixtureArtifactDir = path.join(root, "fixtures", "nba-historical-linear");
  if (!existsSync(path.join(fixtureArtifactDir, "manifest.json"))) {
    return null;
  }

  return historicalClientForArtifactDir(root, fixtureArtifactDir);
}

function historicalClientForArtifactDir(root: string, artifactDir: string): HistoricalProjectionClient {
  return new HistoricalProjectionClient({
    env: {
      ...process.env,
      SPORTS_PROJECTOR_HISTORICAL_ROOT: root,
      SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR: artifactDir
    }
  });
}
