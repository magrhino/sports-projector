import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HistoricalProjectionClient,
  HistoricalProjectionError
} from "./historical-client.js";
import { makeResponse, nowIso } from "../lib/response.js";
import { TeamQuerySchema } from "../lib/validation.js";

const HISTORICAL_CAVEATS = [
  "Informational projection only.",
  "Historical artifact quality depends on local artifact freshness and leak-free feature snapshots.",
  "Live in-game state is not included in this historical model."
];

export const HistoricalProjectionInputSchema = z.object({
  home_team: TeamQuerySchema,
  away_team: TeamQuerySchema,
  game_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "game_date must be YYYY-MM-DD"),
  season: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "season must be YYYY-YY")
    .optional(),
  market_total: z.number().positive().optional(),
  market_spread: z.number().optional(),
  days_rest_home: z.number().int().min(0).max(30).optional(),
  days_rest_away: z.number().int().min(0).max(30).optional(),
  include_debug: z.boolean().default(false)
});

export function registerHistoricalTools(server: McpServer, client: HistoricalProjectionClient): void {
  server.registerTool(
    "project_nba_historical_score",
    {
      description:
        "Project an NBA matchup score from local historical model artifacts. Projection-only output; live in-game state is not included.",
      inputSchema: HistoricalProjectionInputSchema
    },
    async (input) => {
      try {
        const data = await client.project(input);
        return makeResponse({
          source: "historical",
          fetched_at: nowIso(),
          source_url: null,
          cache_status: "not_applicable",
          summary: "Projected an NBA matchup score from local historical artifacts.",
          data,
          caveats: HISTORICAL_CAVEATS
        });
      } catch (error) {
        return makeResponse({
          source: "historical",
          fetched_at: nowIso(),
          source_url: null,
          cache_status: "not_applicable",
          summary: "Unable to project NBA historical score from local artifacts.",
          data: {
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof HistoricalProjectionError ? error.code : "unknown"
          },
          caveats: HISTORICAL_CAVEATS
        });
      }
    }
  );
}
