import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  EspnClient,
  normalizeGameSummary,
  normalizeScoreboard,
  normalizeStandings,
  normalizeTeamSchedule
} from "../clients/espn.js";
import { HttpError } from "../lib/http.js";
import { makeResponse, nowIso } from "../lib/response.js";
import {
  EventIdSchema,
  LeagueSchema,
  LimitSchema,
  OptionalEspnDateSchema,
  TeamQuerySchema
} from "../lib/validation.js";

const ESPN_CAVEATS = [
  "ESPN public endpoints are unofficial and undocumented, so fields may change without notice.",
  "Informational research only; this is not betting advice."
];

const ScoreboardInputSchema = z.object({
  league: LeagueSchema,
  date: OptionalEspnDateSchema,
  limit: LimitSchema
});

const GameSummaryInputSchema = z.object({
  league: LeagueSchema,
  event_id: EventIdSchema
});

const TeamScheduleInputSchema = z.object({
  league: LeagueSchema,
  team: TeamQuerySchema,
  season: z.number().int().min(1900).max(2200).optional()
});

const StandingsInputSchema = z.object({
  league: LeagueSchema,
  season: z.number().int().min(1900).max(2200).optional()
});

export function registerEspnTools(server: McpServer, client: EspnClient): void {
  server.registerTool(
    "get_scoreboard",
    {
      description:
        "Get public ESPN scoreboard data for NBA/NFL/MLB/NHL. Read-only, public-data-only, informational research only, and not betting advice.",
      inputSchema: ScoreboardInputSchema
    },
    async (input) => {
      try {
        const result = await client.getScoreboard(input);
        const data = normalizeScoreboard(input.league, result.data);
        return makeResponse({
          source: "espn",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ${data.count} ${input.league.toUpperCase()} games from ESPN scoreboard.`,
          data,
          caveats: ESPN_CAVEATS
        });
      } catch (error) {
        return espnErrorResponse(error, "Unable to fetch ESPN scoreboard.");
      }
    }
  );

  server.registerTool(
    "get_game_summary",
    {
      description:
        "Get a public ESPN game summary by event_id. Read-only, public-data-only, informational research only, and not betting advice.",
      inputSchema: GameSummaryInputSchema
    },
    async (input) => {
      try {
        const result = await client.getGameSummary({
          league: input.league,
          eventId: input.event_id
        });
        const data = normalizeGameSummary(input.league, input.event_id, result.data);
        return makeResponse({
          source: "espn",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ESPN ${input.league.toUpperCase()} game summary for event ${input.event_id}.`,
          data,
          caveats: ESPN_CAVEATS
        });
      } catch (error) {
        return espnErrorResponse(error, "Unable to fetch ESPN game summary.");
      }
    }
  );

  server.registerTool(
    "get_team_schedule",
    {
      description:
        "Resolve a team and fetch its public ESPN schedule. Read-only, public-data-only, informational research only, and not betting advice.",
      inputSchema: TeamScheduleInputSchema
    },
    async (input) => {
      try {
        const result = await client.getTeamSchedule(input);
        const data = normalizeTeamSchedule(input.league, result.data);
        return makeResponse({
          source: "espn",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ${input.league.toUpperCase()} schedule for ${data.team?.name ?? input.team}.`,
          data,
          caveats: ESPN_CAVEATS
        });
      } catch (error) {
        return espnErrorResponse(error, "Unable to fetch ESPN team schedule.");
      }
    }
  );

  server.registerTool(
    "get_standings",
    {
      description:
        "Get public ESPN standings when the public endpoint is available. Read-only, public-data-only, informational research only, and not betting advice.",
      inputSchema: StandingsInputSchema
    },
    async (input) => {
      try {
        const result = await client.getStandings(input);
        const data = normalizeStandings(input.league, result.data);
        return makeResponse({
          source: "espn",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ESPN ${input.league.toUpperCase()} standings.`,
          data,
          caveats: ESPN_CAVEATS
        });
      } catch (error) {
        return espnErrorResponse(error, "ESPN standings are not available from the public endpoint for this request.");
      }
    }
  );
}

function espnErrorResponse(error: unknown, summary: string) {
  return makeResponse({
    source: "espn",
    fetched_at: nowIso(),
    source_url: error instanceof HttpError ? error.url : null,
    cache_status: "not_applicable",
    summary,
    data: {
      error: error instanceof Error ? error.message : String(error)
    },
    caveats: ESPN_CAVEATS
  });
}
