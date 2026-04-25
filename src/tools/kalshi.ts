import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  KalshiClient,
  normalizeMarkets,
  normalizeOrderbook,
  normalizeSingleMarket,
  normalizeTrades
} from "../clients/kalshi.js";
import { HttpError } from "../lib/http.js";
import { makeResponse, nowIso } from "../lib/response.js";
import {
  DepthSchema,
  KalshiCursorSchema,
  KalshiLargeLimitSchema,
  KalshiStatusSchema,
  KalshiTickerSchema,
  LimitSchema,
  SafeSearchTextSchema,
  UnixTimestampSchema
} from "../lib/validation.js";

const KALSHI_CAVEATS = [
  "Kalshi public REST market data is unauthenticated, but availability and fields can change.",
  "Informational research only; this is not betting advice.",
  "No trading, account, balance, position, order placement, order cancellation, private key, API key, or WebSocket functionality is implemented."
];

const SearchMarketsInputSchema = z.object({
  query: SafeSearchTextSchema.optional(),
  series_ticker: KalshiTickerSchema.optional(),
  event_ticker: KalshiTickerSchema.optional(),
  status: KalshiStatusSchema.default("open"),
  limit: LimitSchema,
  cursor: KalshiCursorSchema.optional()
});

const MarketInputSchema = z.object({
  ticker: KalshiTickerSchema
});

const OrderbookInputSchema = z.object({
  ticker: KalshiTickerSchema,
  depth: DepthSchema
});

const TradesInputSchema = z.object({
  ticker: KalshiTickerSchema.optional(),
  limit: KalshiLargeLimitSchema,
  cursor: KalshiCursorSchema.optional(),
  min_ts: UnixTimestampSchema.optional(),
  max_ts: UnixTimestampSchema.optional()
});

export function registerKalshiTools(server: McpServer, client: KalshiClient): void {
  server.registerTool(
    "search_kalshi_markets",
    {
      description:
        "Search public Kalshi markets using unauthenticated REST market data only. Read-only, informational research only, and not betting advice.",
      inputSchema: SearchMarketsInputSchema
    },
    async (input) => {
      try {
        const result = await client.searchMarkets({
          query: input.query,
          limit: input.limit,
          cursor: input.cursor,
          status: input.status,
          seriesTicker: input.series_ticker,
          eventTicker: input.event_ticker
        });
        const data = normalizeMarkets(result.data, input.query);
        return makeResponse({
          source: "kalshi",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ${data.count} public Kalshi markets.`,
          data,
          caveats: KALSHI_CAVEATS
        });
      } catch (error) {
        return kalshiErrorResponse(error, "Unable to search public Kalshi markets.");
      }
    }
  );

  server.registerTool(
    "get_kalshi_market",
    {
      description:
        "Get one public Kalshi market by ticker using unauthenticated REST data only. Read-only, informational research only, and not betting advice.",
      inputSchema: MarketInputSchema
    },
    async (input) => {
      try {
        const result = await client.getMarket(input);
        const data = normalizeSingleMarket(result.data);
        return makeResponse({
          source: "kalshi",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched public Kalshi market ${input.ticker}.`,
          data,
          caveats: KALSHI_CAVEATS
        });
      } catch (error) {
        return kalshiErrorResponse(error, "Unable to fetch public Kalshi market.");
      }
    }
  );

  server.registerTool(
    "get_kalshi_orderbook",
    {
      description:
        "Get a public Kalshi market orderbook. Kalshi returns YES bids and NO bids, not conventional asks. Read-only and not betting advice.",
      inputSchema: OrderbookInputSchema
    },
    async (input) => {
      try {
        const result = await client.getOrderbook(input);
        const data = normalizeOrderbook(result.data);
        return makeResponse({
          source: "kalshi",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched public Kalshi orderbook for ${input.ticker}.`,
          data,
          caveats: [
            ...KALSHI_CAVEATS,
            "Kalshi orderbooks return YES bids and NO bids. A NO bid at X cents implies a YES ask at 100 - X cents."
          ]
        });
      } catch (error) {
        return kalshiErrorResponse(error, "Unable to fetch public Kalshi orderbook.");
      }
    }
  );

  server.registerTool(
    "get_kalshi_trades",
    {
      description:
        "Get public Kalshi trades using the unauthenticated REST trades endpoint only. Read-only, informational research only, and not betting advice.",
      inputSchema: TradesInputSchema
    },
    async (input) => {
      try {
        const result = await client.getTrades({
          ticker: input.ticker,
          limit: input.limit,
          cursor: input.cursor,
          minTs: input.min_ts,
          maxTs: input.max_ts
        });
        const data = normalizeTrades(result.data);
        return makeResponse({
          source: "kalshi",
          fetched_at: nowIso(),
          source_url: result.sourceUrl,
          cache_status: result.cacheStatus,
          summary: `Fetched ${data.count} public Kalshi trades.`,
          data,
          caveats: KALSHI_CAVEATS
        });
      } catch (error) {
        return kalshiErrorResponse(error, "Unable to fetch public Kalshi trades.");
      }
    }
  );
}

function kalshiErrorResponse(error: unknown, summary: string) {
  return makeResponse({
    source: "kalshi",
    fetched_at: nowIso(),
    source_url: error instanceof HttpError ? error.url : null,
    cache_status: "not_applicable",
    summary,
    data: {
      error: error instanceof Error ? error.message : String(error)
    },
    caveats: KALSHI_CAVEATS
  });
}
