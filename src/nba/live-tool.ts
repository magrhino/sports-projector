import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  EspnClient,
  type EspnNormalizedGame,
  normalizeGameSummary
} from "../clients/espn.js";
import {
  KalshiClient,
  type NormalizedKalshiMarket,
  normalizeEvent,
  normalizeGameStats,
  normalizeLiveData,
  normalizeMarkets,
  normalizeMilestones
} from "../clients/kalshi.js";
import type { CacheStatus } from "../lib/cache.js";
import { HttpError } from "../lib/http.js";
import { makeResponse, nowIso } from "../lib/response.js";
import {
  EventIdSchema,
  KalshiMilestoneIdSchema,
  KalshiTickerListSchema,
  KalshiTickerSchema
} from "../lib/validation.js";
import {
  extractRecentScoringFromGameStats,
  gameTime,
  projectLiveNbaScore,
  selectLiveTotalMarket,
  type RecentScoringWindow
} from "./live-projection.js";

const LIVE_PROJECTION_CAVEATS = [
  "Informational projection only.",
  "ESPN public endpoints and Kalshi public live-data fields can change without notice.",
  "The model is a transparent heuristic and does not account for all lineup, injury, overtime, market, or game-state effects.",
  "No trading, account, balance, position, order placement, order cancellation, private key, API key, or WebSocket functionality is implemented."
];

export const LiveProjectionInputSchema = z.object({
  event_id: EventIdSchema,
  kalshi_event_ticker: KalshiTickerSchema.optional(),
  kalshi_market_tickers: KalshiTickerListSchema.optional(),
  kalshi_milestone_id: KalshiMilestoneIdSchema.optional(),
  is_playoffs: z.boolean().optional(),
  include_debug: z.boolean().default(false)
});

type LiveProjectionInput = z.infer<typeof LiveProjectionInputSchema>;

interface LiveProjectionToolData {
  event_id: string;
  teams: {
    home: LiveProjectionTeam;
    away: LiveProjectionTeam;
  };
  game_status: {
    state: string | null;
    description: string | null;
    detail: string | null;
    completed: boolean;
    period: number;
    clock: string;
  };
  live_projection: LiveProjectionPayload;
}

interface LiveProjectionTeam {
  id: string | null;
  name: string;
  abbreviation: string;
  score: number;
}

interface ProjectionSourceUrls {
  espn_summary?: string;
  kalshi_markets?: string;
  kalshi_event?: string;
  kalshi_milestones?: string;
  kalshi_live_data?: string;
  kalshi_game_stats?: string;
}

interface LiveProjectionPayload extends Record<string, unknown> {
  source_urls: ProjectionSourceUrls;
  cache_status: CacheStatus;
}

interface DataQuality {
  status: "live" | "completed" | "not_live";
  warnings: string[];
  market_line_source: "explicit_tickers" | "event_ticker" | "auto_search" | "unavailable";
  selected_market_ticker: string | null;
  kalshi_live_data_available: boolean;
  kalshi_game_stats_available: boolean;
  recent_scoring_source: RecentScoringWindow["source"] | null;
}

interface ToolContext {
  sourceUrls: ProjectionSourceUrls;
  cacheStatuses: CacheStatus[];
  warnings: string[];
}

export function registerLiveProjectionTools(
  server: McpServer,
  espnClient: EspnClient,
  kalshiClient: KalshiClient
): void {
  server.registerTool(
    "project_nba_live_score",
    {
      description:
        "Project the most likely NBA final score for an ESPN event using public ESPN state and public Kalshi total/live data when available. Informational projection only.",
      inputSchema: LiveProjectionInputSchema
    },
    async (input) => {
      try {
        const data = await projectNbaLiveScore(input, espnClient, kalshiClient);
        return makeResponse({
          source: "live_projection",
          fetched_at: nowIso(),
          source_url: data.live_projection.source_urls.espn_summary as string | null,
          cache_status: data.live_projection.cache_status as CacheStatus,
          summary: `Projected NBA live score for ESPN event ${input.event_id}.`,
          data,
          caveats: LIVE_PROJECTION_CAVEATS
        });
      } catch (error) {
        return makeResponse({
          source: "live_projection",
          fetched_at: nowIso(),
          source_url: error instanceof HttpError ? error.url : null,
          cache_status: "not_applicable",
          summary: "Unable to project NBA live score.",
          data: {
            error: error instanceof Error ? error.message : String(error)
          },
          caveats: LIVE_PROJECTION_CAVEATS
        });
      }
    }
  );
}

export async function projectNbaLiveScore(
  input: LiveProjectionInput,
  espnClient: EspnClient,
  kalshiClient: KalshiClient
): Promise<LiveProjectionToolData> {
  const context: ToolContext = {
    sourceUrls: {},
    cacheStatuses: [],
    warnings: []
  };

  const espnResult = await espnClient.getGameSummary({
    league: "nba",
    eventId: input.event_id
  });
  context.sourceUrls.espn_summary = espnResult.sourceUrl;
  context.cacheStatuses.push(espnResult.cacheStatus);

  const summary = normalizeGameSummary("nba", input.event_id, espnResult.data);
  const game = summary.game;
  if (!game?.teams.home || !game.teams.away) {
    throw new Error(`ESPN summary for event ${input.event_id} did not include home and away teams.`);
  }

  const home = normalizeProjectionTeam(game.teams.home);
  const away = normalizeProjectionTeam(game.teams.away);
  if (home.score === null || away.score === null) {
    throw new Error(`ESPN summary for event ${input.event_id} did not include current scores.`);
  }

  const period = game.status.period ?? 1;
  const clock = game.status.clock ?? defaultClock(period);
  const marketContext = await resolveKalshiMarket(input, kalshiClient, game, context);
  const milestoneContext = await resolveKalshiMilestone(
    input,
    kalshiClient,
    marketContext.selectedMarket?.event_ticker ?? input.kalshi_event_ticker ?? null,
    context
  );
  const recentScoring =
    extractRecentScoringFromGameStats({
      pbp: milestoneContext.gameStats?.pbp ?? null,
      period,
      clock,
      currentHomeScore: home.score,
      currentAwayScore: away.score
    }) ?? extractRecentScoringFromEspnLinescore(game, period, clock);
  const fouls = extractFouls(milestoneContext.liveData?.details ?? {});
  const isCompleted = game.status.completed;
  const projection = isCompleted
    ? completedProjection(home.score, away.score, marketContext.marketTotalLine)
    : projectLiveNbaScore({
        currentHomeScore: home.score,
        currentAwayScore: away.score,
        period,
        clock,
        marketTotalLine: marketContext.marketTotalLine,
        recentPoints: recentScoring?.points,
        recentMinutes: recentScoring?.minutes,
        recentHomePoints: recentScoring?.home_points,
        recentAwayPoints: recentScoring?.away_points,
        homeFoulsPeriod: fouls.home,
        awayFoulsPeriod: fouls.away,
        isPlayoffs: input.is_playoffs ?? inferPlayoffs(espnResult.data)
      });
  const status = liveStatus(game);
  const dataQuality: DataQuality = {
    status,
    warnings: context.warnings,
    market_line_source: marketContext.marketLineSource,
    selected_market_ticker: marketContext.selectedMarket?.ticker ?? null,
    kalshi_live_data_available: milestoneContext.liveData !== null,
    kalshi_game_stats_available: milestoneContext.gameStats !== null,
    recent_scoring_source: recentScoring?.source ?? null
  };

  const liveProjection = {
    projected_home_score: projection.most_likely_score.home,
    projected_away_score: projection.most_likely_score.away,
    projected_total: projection.projected_total,
    projected_remaining_points: projection.projected_remaining_points,
    most_likely_score: projection.most_likely_score,
    market_total_line: projection.market_total_line,
    difference_vs_market: projection.difference_vs_market,
    p_over: projection.p_over,
    residual_sigma: projection.residual_sigma,
    projection_uncertainty: projection.projection_uncertainty,
    calibration: {
      raw_full_game_rate: projection.raw_full_game_rate,
      raw_recent_rate: projection.raw_recent_rate,
      full_game_rate: projection.full_game_rate,
      prior_rate: projection.prior_rate,
      recent_rate: projection.recent_rate,
      blended_rate: projection.blended_rate,
      rate_weights: projection.rate_weights,
      effective_minutes: projection.effective_minutes,
      recent_effective_minutes: projection.recent_effective_minutes
    },
    relationship_to_market: projection.relationship_to_market,
    model_inputs: projection.model_inputs,
    data_quality: dataQuality,
    source_urls: context.sourceUrls,
    cache_status: combineCacheStatuses(context.cacheStatuses),
    ...(input.include_debug
      ? {
          debug: {
            selected_market: marketContext.selectedMarket,
            market_candidates: marketContext.candidates,
            milestone_id: milestoneContext.milestoneId,
            fouls,
            model_details: projection
          }
        }
      : {})
  };

  return {
    event_id: input.event_id,
    teams: {
      home: {
        id: home.id,
        name: home.name,
        abbreviation: home.abbreviation,
        score: home.score
      },
      away: {
        id: away.id,
        name: away.name,
        abbreviation: away.abbreviation,
        score: away.score
      }
    },
    game_status: {
      state: game.status.state,
      description: game.status.description,
      detail: game.status.detail,
      completed: game.status.completed,
      period,
      clock
    },
    live_projection: liveProjection
  };
}

async function resolveKalshiMarket(
  input: LiveProjectionInput,
  client: KalshiClient,
  game: EspnNormalizedGame,
  context: ToolContext
): Promise<{
  marketTotalLine: number | null;
  selectedMarket: NormalizedKalshiMarket | null;
  candidates: unknown[];
  marketLineSource: DataQuality["market_line_source"];
}> {
  const matchup = {
    homeName: game.teams.home?.name,
    awayName: game.teams.away?.name,
    homeAbbreviation: game.teams.home?.abbreviation,
    awayAbbreviation: game.teams.away?.abbreviation,
    startTime: game.start_time
  };

  if (input.kalshi_market_tickers) {
    const result = await optionalFetch(context, "Kalshi markets by ticker", () =>
      client.searchMarkets({
        tickers: input.kalshi_market_tickers,
        status: "all",
        limit: input.kalshi_market_tickers?.length
      })
    );
    if (result) {
      context.sourceUrls.kalshi_markets = result.sourceUrl;
      const markets = normalizeMarkets(result.data).markets;
      const selected = selectLiveTotalMarket(markets, matchup, false);
      return {
        marketTotalLine: selected?.line ?? null,
        selectedMarket: selected?.market ?? null,
        candidates: selected ? [selected] : [],
        marketLineSource: selected ? "explicit_tickers" : "unavailable"
      };
    }
  }

  if (input.kalshi_event_ticker) {
    const result = await optionalFetch(context, "Kalshi event", () =>
      client.getEvent({
        eventTicker: input.kalshi_event_ticker as string,
        withNestedMarkets: true
      })
    );
    if (result) {
      context.sourceUrls.kalshi_event = result.sourceUrl;
      const event = normalizeEvent(result.data);
      const selected = selectLiveTotalMarket(event.markets, matchup, false);
      return {
        marketTotalLine: selected?.line ?? null,
        selectedMarket: selected?.market ?? null,
        candidates: selected ? [selected] : [],
        marketLineSource: selected ? "event_ticker" : "unavailable"
      };
    }
  }

  const result = await optionalFetch(context, "Kalshi NBA total-market search", () =>
    client.searchMarkets({
      seriesTicker: "KXNBATOTAL",
      status: "open",
      limit: 100
    })
  );
  if (!result) {
    return {
      marketTotalLine: null,
      selectedMarket: null,
      candidates: [],
      marketLineSource: "unavailable"
    };
  }

  context.sourceUrls.kalshi_markets = result.sourceUrl;
  const markets = normalizeMarkets(result.data).markets;
  const selected = selectLiveTotalMarket(markets, matchup, true);
  if (!selected) {
    context.warnings.push("No matching Kalshi NBA total market was found; projection uses live score pace without a market line.");
  }

  return {
    marketTotalLine: selected?.line ?? null,
    selectedMarket: selected?.market ?? null,
    candidates: selected ? [selected] : [],
    marketLineSource: selected ? "auto_search" : "unavailable"
  };
}

async function resolveKalshiMilestone(
  input: LiveProjectionInput,
  client: KalshiClient,
  eventTicker: string | null,
  context: ToolContext
): Promise<{
  milestoneId: string | null;
  liveData: ReturnType<typeof normalizeLiveData> | null;
  gameStats: ReturnType<typeof normalizeGameStats> | null;
}> {
  let milestoneId = input.kalshi_milestone_id ?? null;
  if (!milestoneId && eventTicker) {
    const milestonesResult = await optionalFetch(context, "Kalshi milestones", () =>
      client.getMilestones({
        relatedEventTicker: eventTicker,
        category: "Sports",
        limit: 10
      })
    );
    if (milestonesResult) {
      context.sourceUrls.kalshi_milestones = milestonesResult.sourceUrl;
      const milestones = normalizeMilestones(milestonesResult.data).milestones;
      milestoneId = selectBasketballMilestoneId(milestones);
    }
  }

  if (!milestoneId) {
    return {
      milestoneId: null,
      liveData: null,
      gameStats: null
    };
  }

  const liveDataResult = await optionalFetch(context, "Kalshi live data", () =>
    client.getLiveData({
      milestoneId
    })
  );
  const gameStatsResult = await optionalFetch(context, "Kalshi game stats", () =>
    client.getGameStats({
      milestoneId
    })
  );

  if (liveDataResult) {
    context.sourceUrls.kalshi_live_data = liveDataResult.sourceUrl;
  }
  if (gameStatsResult) {
    context.sourceUrls.kalshi_game_stats = gameStatsResult.sourceUrl;
  }

  return {
    milestoneId,
    liveData: liveDataResult ? normalizeLiveData(liveDataResult.data) : null,
    gameStats: gameStatsResult ? normalizeGameStats(gameStatsResult.data) : null
  };
}

async function optionalFetch<T extends { cacheStatus: CacheStatus; sourceUrl: string; data: unknown }>(
  context: ToolContext,
  label: string,
  fetcher: () => Promise<T>
): Promise<T | null> {
  try {
    const result = await fetcher();
    context.cacheStatuses.push(result.cacheStatus);
    return result;
  } catch (error) {
    context.warnings.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function normalizeProjectionTeam(team: NonNullable<EspnNormalizedGame["teams"]["home"]>): {
  id: string | null;
  name: string;
  abbreviation: string;
  score: number | null;
} {
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    score: team.score
  };
}

function extractRecentScoringFromEspnLinescore(
  game: EspnNormalizedGame,
  period: number,
  clock: string
): RecentScoringWindow | null {
  const homePeriodScore = game.teams.home?.linescore.find((line) => line.period === period)?.value;
  const awayPeriodScore = game.teams.away?.linescore.find((line) => line.period === period)?.value;
  if (homePeriodScore === null || homePeriodScore === undefined || awayPeriodScore === null || awayPeriodScore === undefined) {
    return null;
  }

  const timing = gameTime(period, clock);
  const elapsedPeriodMinutes = timing.period_length - timing.period_left;
  if (elapsedPeriodMinutes <= 0 || elapsedPeriodMinutes > 4) {
    return null;
  }

  return {
    points: homePeriodScore + awayPeriodScore,
    minutes: Math.round(elapsedPeriodMinutes * 100) / 100,
    home_points: homePeriodScore,
    away_points: awayPeriodScore,
    source: "espn_linescore"
  };
}

function extractFouls(details: Record<string, unknown>): { home: number | null; away: number | null } {
  return {
    home: findNestedNumber(details, ["home_team_fouls", "home_fouls", "homeFouls", "home_personal_fouls"]),
    away: findNestedNumber(details, ["away_team_fouls", "away_fouls", "awayFouls", "away_personal_fouls"])
  };
}

function findNestedNumber(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedNumber(item, keys);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const parsed = numberFromUnknown(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  for (const nested of Object.values(record)) {
    const found = findNestedNumber(nested, keys);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function selectBasketballMilestoneId(
  milestones: ReturnType<typeof normalizeMilestones>["milestones"]
): string | null {
  const basketball = milestones.find((milestone) => {
    const text = `${milestone.type ?? ""} ${milestone.title ?? ""}`.toLowerCase();
    return text.includes("basketball") || text.includes("nba");
  });
  return basketball?.id ?? milestones[0]?.id ?? null;
}

function inferPlayoffs(raw: unknown): boolean {
  const text = JSON.stringify(raw).toLowerCase();
  if (text.includes("playoff") || text.includes("postseason")) {
    return true;
  }
  const seasonType = findNestedNumber(raw, ["type"]);
  return seasonType === 3;
}

function liveStatus(game: EspnNormalizedGame): DataQuality["status"] {
  if (game.status.completed) {
    return "completed";
  }
  return game.status.state === "in" ? "live" : "not_live";
}

function completedProjection(homeScore: number, awayScore: number, marketTotalLine: number | null) {
  const total = homeScore + awayScore;
  const difference = marketTotalLine === null ? null : total - marketTotalLine;
  return {
    current_total: total,
    elapsed_minutes: 48,
    minutes_left: 0,
    margin: Math.abs(homeScore - awayScore),
    historical_baseline_total: total,
    raw_full_game_rate: Math.round((total / 48) * 1000) / 1000,
    raw_recent_rate: null,
    full_game_rate: Math.round((total / 48) * 1000) / 1000,
    prior_rate: Math.round((total / 48) * 1000) / 1000,
    recent_rate: Math.round((total / 48) * 1000) / 1000,
    blended_rate: Math.round((total / 48) * 1000) / 1000,
    rate_weights: {
      prior: 1,
      full_game: 0,
      recent: 0
    },
    effective_minutes: 48,
    recent_effective_minutes: null,
    trailing_fouls_to_give: null,
    foul_bonus: 0,
    overtime_probability: 0,
    overtime_bonus: 0,
    blowout_drag: 0,
    residual_sigma: 0,
    projection_uncertainty: 0,
    projected_total: total,
    projected_remaining_points: 0,
    market_total_line: marketTotalLine,
    difference_vs_market: difference === null ? null : Math.round(difference * 100) / 100,
    p_over: null,
    relationship_to_market:
      difference === null ? "unavailable" : Math.abs(difference) <= 1 ? "near_market" : difference > 0 ? "above_market" : "below_market",
    most_likely_score: {
      home: homeScore,
      away: awayScore,
      total
    },
    model_inputs: {
      current_home_score: homeScore,
      current_away_score: awayScore,
      period: 4,
      clock: "0.0",
      recent_points: null,
      recent_minutes: null,
      home_fouls_period: null,
      away_fouls_period: null,
      is_playoffs: false
    },
    formulas: ["Completed games return the final observed score."]
  };
}

function defaultClock(period: number): string {
  return period > 4 ? "5:00" : "12:00";
}

function combineCacheStatuses(statuses: CacheStatus[]): CacheStatus {
  if (statuses.includes("miss")) {
    return "miss";
  }
  if (statuses.includes("bypass")) {
    return "bypass";
  }
  if (statuses.includes("hit")) {
    return "hit";
  }
  return "not_applicable";
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
