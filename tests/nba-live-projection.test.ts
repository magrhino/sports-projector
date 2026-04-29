import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { EspnClient } from "../src/clients/espn.js";
import { KalshiClient } from "../src/clients/kalshi.js";
import { registerLiveProjectionTools } from "../src/nba/live-tool.js";
import {
  extractRecentScoringFromGameStats,
  extractTotalLineFromMarket,
  projectLiveNbaScore,
  selectLiveTotalMarket
} from "../src/nba/live-projection.js";

describe("NBA live projection model", () => {
  it("projects a late-game total and returns a score split", () => {
    const result = projectLiveNbaScore({
      currentHomeScore: 83,
      currentAwayScore: 78,
      period: 4,
      clock: "9:25",
      marketTotalLine: 203,
      pregameTotal: 203,
      isPlayoffs: true
    });

    expect(result.current_total).toBe(161);
    expect(result.minutes_left).toBe(9.42);
    expect(result.foul_bonus).toBe(1);
    expect(result.overtime_probability).toBe(0.01);
    expect(result.projected_total).toBeCloseTo(201.77, 2);
    expect(result.most_likely_score).toEqual({
      home: 104,
      away: 98,
      total: 202
    });
  });

  it("shrinks early Q1 hot starts toward the market prior", () => {
    const result = projectLiveNbaScore({
      currentHomeScore: 26,
      currentAwayScore: 17,
      period: 1,
      clock: "4:32",
      marketTotalLine: 226.5,
      recentPoints: 27,
      recentMinutes: 4,
      recentHomePoints: 26,
      recentAwayPoints: 1,
      isPlayoffs: true
    });

    expect(result.raw_full_game_rate).toBeGreaterThan(5.7);
    expect(result.raw_recent_rate).toBe(6.75);
    expect(result.projected_total).toBeLessThan(245);
    expect(result.projected_total).toBeGreaterThan(226.5);
    expect(result.most_likely_score.home).toBeLessThan(140);
    expect(result.most_likely_score.away).toBeGreaterThan(100);
    expect(result.p_over).toBeLessThan(0.9);
    expect(result.p_over).toBeGreaterThan(0.5);
    expect(result.rate_weights.prior).toBeGreaterThan(result.rate_weights.full_game);
  });

  it("shrinks early Q1 cold starts toward the market prior", () => {
    const result = projectLiveNbaScore({
      currentHomeScore: 6,
      currentAwayScore: 5,
      period: 1,
      clock: "6:00",
      marketTotalLine: 226.5,
      recentPoints: 7,
      recentMinutes: 4,
      recentHomePoints: 4,
      recentAwayPoints: 3,
      isPlayoffs: true
    });

    expect(result.raw_full_game_rate).toBeLessThan(2);
    expect(result.projected_total).toBeGreaterThan(190);
    expect(result.projected_total).toBeLessThan(226.5);
    expect(result.p_over).toBeLessThan(0.5);
  });

  it("keeps late Q4 projections responsive to close-game foul context", () => {
    const result = projectLiveNbaScore({
      currentHomeScore: 101,
      currentAwayScore: 99,
      period: 4,
      clock: "1:30",
      marketTotalLine: 214.5,
      recentPoints: 20,
      recentMinutes: 4,
      recentHomePoints: 12,
      recentAwayPoints: 8,
      homeFoulsPeriod: 4,
      awayFoulsPeriod: 4,
      isPlayoffs: true
    });

    expect(result.foul_bonus).toBeGreaterThan(0);
    expect(result.projected_total).toBeGreaterThan(205);
    expect(result.projected_remaining_points).toBeGreaterThan(5);
    expect(result.rate_weights.prior).toBeLessThan(result.rate_weights.full_game);
  });

  it("selects the total market closest to even probability", () => {
    const selected = selectLiveTotalMarket(
      [
        {
          ...marketFixture("KXNBA-CELNYK-TOTAL-199", 199),
          yes_bid_cents: 75,
          yes_ask_cents: 77
        },
        {
          ...marketFixture("KXNBA-CELNYK-TOTAL-203", 203),
          yes_bid_cents: 49,
          yes_ask_cents: 51
        }
      ],
      {
        homeName: "Boston Celtics",
        awayName: "New York Knicks",
        homeAbbreviation: "BOS",
        awayAbbreviation: "NY"
      },
      true
    );

    expect(selected?.market.ticker).toBe("KXNBA-CELNYK-TOTAL-203");
    expect(selected?.line).toBe(203);
    expect(extractTotalLineFromMarket(marketFixture("KXNBA-CELNYK-TOTAL-205", 205))).toBe(205);
  });

  it("extracts a recent scoring window from Kalshi play-by-play game stats", () => {
    const recent = extractRecentScoringFromGameStats({
      pbp: {
        periods: [
          { number: 1, events: [] },
          { number: 2, events: [] },
          { number: 3, events: [] },
          {
            number: 4,
            events: [
              { clock: "10:00", home_score: 83, away_score: 78 },
              { clock: "8:30", home_score: 86, away_score: 80 }
            ]
          }
        ]
      },
      period: 4,
      clock: "6:00",
      currentHomeScore: 92,
      currentAwayScore: 84
    });

    expect(recent).toEqual({
      points: 15,
      minutes: 4,
      home_points: 9,
      away_points: 6,
      source: "kalshi_game_stats"
    });
  });

  it("uses Kalshi period_number when play-by-play periods are reverse ordered", () => {
    const recent = extractRecentScoringFromGameStats({
      pbp: {
        periods: [
          {
            period_number: 2,
            events: [
              { clock: "5:58", home_points: 31, away_points: 41 },
              { clock: "9:59", home_points: 24, away_points: 32 },
              { clock: "12:00", home_points: 20, away_points: 27 }
            ]
          },
          {
            period_number: 1,
            events: [
              { clock: "0:00", home_points: 20, away_points: 27 },
              { clock: "12:00", home_points: 0, away_points: 0 }
            ]
          }
        ]
      },
      period: 2,
      clock: "5:58",
      currentHomeScore: 31,
      currentAwayScore: 41
    });

    expect(recent).toEqual({
      points: 16,
      minutes: 4,
      home_points: 7,
      away_points: 9,
      source: "kalshi_game_stats"
    });
  });

  it("ignores impossible recent scoring inputs instead of over-projecting totals", () => {
    const result = projectLiveNbaScore({
      currentHomeScore: 29,
      currentAwayScore: 38,
      period: 2,
      clock: "7:31",
      marketTotalLine: 208.5,
      recentPoints: 65,
      recentMinutes: 4,
      recentHomePoints: 29,
      recentAwayPoints: 36,
      isPlayoffs: true
    });

    expect(result.model_inputs.recent_points).toBeNull();
    expect(result.projected_total).toBeLessThan(210);
  });

  it("rejects implausibly hot recent play-by-play windows", () => {
    const recent = extractRecentScoringFromGameStats({
      pbp: {
        periods: [
          {
            number: 2,
            events: [{ clock: "8:00", home_score: 20, away_score: 20 }]
          }
        ]
      },
      period: 2,
      clock: "7:00",
      currentHomeScore: 30,
      currentAwayScore: 30,
      windowMinutes: 1
    });

    expect(recent).toBeNull();
  });
});

describe("project_nba_live_score MCP tool", () => {
  it("uses explicit Kalshi market tickers when provided", async () => {
    const response = await callLiveProjectionTool({
      arguments: {
        event_id: "401",
        kalshi_market_tickers: ["KXNBA-CELNYK-TOTAL-203"]
      },
      responses: {
        "/trade-api/v2/markets": {
          markets: [marketFixture("KXNBA-CELNYK-TOTAL-203", 203)],
          cursor: ""
        },
        "/trade-api/v2/milestones": {
          milestones: [],
          cursor: ""
        }
      }
    });

    expect(response.source).toBe("live_projection");
    expect(response.data.live_projection.market_total_line).toBe(203);
    expect(response.data.live_projection.data_quality.market_line_source).toBe("explicit_tickers");
    expect(response.data.live_projection.projected_home_score).toBeGreaterThanOrEqual(83);
  });

  it("auto-matches a Kalshi NBA total market by teams", async () => {
    const response = await callLiveProjectionTool({
      arguments: {
        event_id: "401"
      },
      responses: {
        "/trade-api/v2/markets": {
          markets: [
            {
              ...marketFixture("KXNBA-LALGSW-TOTAL-220", 220),
              title: "Los Angeles Lakers and Golden State Warriors total points"
            },
            marketFixture("KXNBA-CELNYK-TOTAL-203", 203)
          ],
          cursor: ""
        },
        "/trade-api/v2/milestones": {
          milestones: [],
          cursor: ""
        }
      }
    });

    expect(response.data.live_projection.market_total_line).toBe(203);
    expect(response.data.live_projection.data_quality.market_line_source).toBe("auto_search");
    expect(response.data.live_projection.data_quality.selected_market_ticker).toBe("KXNBA-CELNYK-TOTAL-203");
  });

  it("degrades cleanly when Kalshi live data is unavailable", async () => {
    const response = await callLiveProjectionTool({
      arguments: {
        event_id: "401",
        kalshi_event_ticker: "KXNBA-CELNYK"
      },
      responses: {
        "/trade-api/v2/events/KXNBA-CELNYK": {
          event: {
            event_ticker: "KXNBA-CELNYK",
            markets: [marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]
          }
        },
        "/trade-api/v2/milestones": {
          milestones: [{ id: "ms-1", type: "basketball_game", title: "Celtics Knicks" }],
          cursor: ""
        },
        "/trade-api/v2/live_data/milestone/ms-1": notFoundResponse(),
        "/trade-api/v2/live_data/milestone/ms-1/game_stats": notFoundResponse()
      }
    });

    expect(response.data.live_projection.market_total_line).toBe(203);
    expect(response.data.live_projection.data_quality.kalshi_live_data_available).toBe(false);
    expect(response.data.live_projection.data_quality.kalshi_game_stats_available).toBe(false);
    expect(response.data.live_projection.data_quality.warnings.join(" ")).toContain("Kalshi live data unavailable");
  });

  it("falls back to pace when no Kalshi market line is available", async () => {
    const response = await callLiveProjectionTool({
      arguments: {
        event_id: "401"
      },
      responses: {
        "/trade-api/v2/markets": {
          markets: [],
          cursor: ""
        }
      }
    });

    expect(response.data.live_projection.market_total_line).toBeNull();
    expect(response.data.live_projection.relationship_to_market).toBe("unavailable");
    expect(response.data.live_projection.data_quality.market_line_source).toBe("unavailable");
  });

  it("returns the observed final score for completed games", async () => {
    const response = await callLiveProjectionTool({
      arguments: {
        event_id: "402"
      },
      espnSummary: espnSummaryFixture({
        eventId: "402",
        completed: true,
        state: "post",
        homeScore: "101",
        awayScore: "99",
        period: 4,
        clock: "0.0"
      }),
      responses: {
        "/trade-api/v2/markets": {
          markets: [],
          cursor: ""
        }
      }
    });

    expect(response.data.live_projection.most_likely_score).toEqual({
      home: 101,
      away: 99,
      total: 200
    });
    expect(response.data.live_projection.data_quality.status).toBe("completed");
  });
});

function marketFixture(ticker: string, line: number) {
  return {
    ticker,
    title: "Boston Celtics and New York Knicks total points",
    subtitle: `Total points ${line}`,
    yes_sub_title: `At least ${line} points`,
    no_sub_title: `Fewer than ${line} points`,
    event_ticker: "KXNBA-CELNYK",
    series_ticker: "KXNBATOTAL",
    status: "open",
    open_time: "2026-04-25T23:00:00Z",
    close_time: "2026-04-26T03:00:00Z",
    expiration_time: "2026-04-26T03:00:00Z",
    occurrence_datetime: "2026-04-25T23:00:00Z",
    strike_type: "greater",
    floor_strike: line,
    cap_strike: null,
    functional_strike: `>= ${line}`,
    yes_bid_cents: 49,
    yes_ask_cents: 51,
    no_bid_cents: 49,
    no_ask_cents: 51,
    last_price_cents: 50,
    volume: 100,
    liquidity: 1000,
    implied_probabilities: {
      yes_bid: 0.49,
      yes_ask: 0.51,
      no_bid: 0.49,
      no_ask: 0.51,
      last_price: 0.5
    }
  };
}

async function callLiveProjectionTool(input: {
  arguments: Record<string, unknown>;
  responses: Record<string, unknown | Response>;
  espnSummary?: unknown;
}): Promise<{
  source: string;
  data: {
    live_projection: Record<string, any>;
  };
}> {
  const fetchImpl: typeof fetch = async (request) => {
    const url = new URL(request.toString());
    if (url.pathname === "/apis/site/v2/sports/basketball/nba/summary") {
      return jsonResponse(input.espnSummary ?? espnSummaryFixture({ eventId: "401" }));
    }
    const response = input.responses[url.pathname];
    if (response instanceof Response) {
      return response;
    }
    if (response !== undefined) {
      return jsonResponse(response);
    }
    return jsonResponse({});
  };
  const server = new McpServer({
    name: "sports-projector-live-test",
    version: "0.0.0"
  });
  registerLiveProjectionTools(
    server,
    new EspnClient({
      fetchImpl,
      env: {
        SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS: "0"
      }
    }),
    new KalshiClient({
      fetchImpl,
      env: {
        SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0"
      }
    })
  );
  const client = new Client({
    name: "sports-projector-live-test",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "project_nba_live_score",
      arguments: input.arguments
    });
    return result.structuredContent as {
      source: string;
      data: {
        live_projection: Record<string, any>;
      };
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function espnSummaryFixture(input: {
  eventId: string;
  completed?: boolean;
  state?: string;
  homeScore?: string;
  awayScore?: string;
  period?: number;
  clock?: string;
}) {
  return {
    header: {
      id: input.eventId,
      name: "New York Knicks at Boston Celtics",
      shortName: "NY @ BOS",
      competitions: [
        {
          date: "2026-04-25T23:00:00Z",
          status: {
            displayClock: input.clock ?? "9:25",
            period: input.period ?? 4,
            type: {
              state: input.state ?? "in",
              description: input.completed ? "Final" : "In Progress",
              completed: input.completed ?? false
            }
          },
          competitors: [
            {
              homeAway: "home",
              score: input.homeScore ?? "83",
              team: { id: "2", displayName: "Boston Celtics", abbreviation: "BOS" },
              linescores: [
                { period: 1, value: 25, displayValue: "25" },
                { period: 2, value: 28, displayValue: "28" },
                { period: 3, value: 30, displayValue: "30" }
              ]
            },
            {
              homeAway: "away",
              score: input.awayScore ?? "78",
              team: { id: "18", displayName: "New York Knicks", abbreviation: "NY" },
              linescores: [
                { period: 1, value: 24, displayValue: "24" },
                { period: 2, value: 24, displayValue: "24" },
                { period: 3, value: 30, displayValue: "30" }
              ]
            }
          ]
        }
      ]
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    statusText: "Not Found",
    headers: {
      "content-type": "application/json"
    }
  });
}
