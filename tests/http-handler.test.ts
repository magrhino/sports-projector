import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EspnClient } from "../src/clients/espn.js";
import type { KalshiClient } from "../src/clients/kalshi.js";
import { createHttpHandler } from "../src/http/index.js";
import type { LiveTrackingHttpContext } from "../src/http/live-tracking.js";
import { HistoricalProjectionClient } from "../src/nba/historical-client.js";
import { LiveTrackingStore } from "../src/nba/live-tracking-store.js";

describe("createHttpHandler", () => {
  it("does not parse request URLs against the user-controlled Host header", async () => {
    const response = createResponseDouble();
    await createHttpHandler()(
      {
        method: "GET",
        url: "/api/unknown",
        headers: { host: "localhost:bad" }
      } as IncomingMessage,
      response
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"API route not found."}');
  });

  it("returns NBA live and historical projections for an ESPN event", async () => {
    const historicalInputs: Record<string, unknown>[] = [];
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
        historicalClient: historicalClient((input) => {
          historicalInputs.push(input);
          return {
            teams: {
              home: input.home_team,
              away: input.away_team
            },
            game_date: input.game_date,
            projected_home_score: 114,
            projected_away_score: 109,
            projected_total: 223,
            projected_home_margin: 5,
            market_comparison: {
              market_total: input.market_total
            }
          };
        })
      }),
      "/api/nba/projections?event_id=401"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.game.short_name).toBe("NY @ BOS");
    expect(payload.live_projection.status).toBe("ok");
    expect(payload.live_projection.data?.live_projection.market_total_line).toBe(203);
    expect(payload.historical_projection?.status).toBe("ok");
    expect(historicalInputs[0]).toMatchObject({
      home_team: "Boston Celtics",
      away_team: "New York Knicks",
      game_date: "2026-04-25"
    });
    expect(historicalInputs[0]).not.toHaveProperty("market_total");
  });

  it("skips historical projection for live-only refreshes", async () => {
    let historicalCalls = 0;
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([]),
        historicalClient: historicalClient(() => {
          historicalCalls += 1;
          return {};
        })
      }),
      "/api/nba/projections?event_id=401&scope=live"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.live_projection.status).toBe("ok");
    expect(payload.historical_projection).toBeUndefined();
    expect(historicalCalls).toBe(0);
  });

  it("returns 400 for invalid NBA projection event ids", async () => {
    const response = await callHandler(createHttpHandler(), "/api/nba/projections?event_id=bad");

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/event_id/i);
  });

  it("keeps historical output when live projection fails", async () => {
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(
          espnSummaryFixture({
            eventId: "401",
            homeScore: null,
            awayScore: null
          })
        ),
        kalshiClient: kalshiClientWithMarkets([]),
        historicalClient: historicalClient((input) => ({
          teams: {
            home: input.home_team,
            away: input.away_team
          },
          game_date: input.game_date,
          projected_home_score: 114,
          projected_away_score: 109,
          projected_total: 223
        }))
      }),
      "/api/nba/projections?event_id=401"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.live_projection.status).toBe("error");
    expect(payload.live_projection.error).toMatch(/current scores/i);
    expect(payload.historical_projection?.status).toBe("ok");
  });

  it("returns live tracking status", async () => {
    const response = await callHandler(createHttpHandler(), "/api/nba/live-tracking/status");

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).tracker.enabled).toBe(false);
    expect(JSON.parse(response.body).tracker.training.snapshots).toBe(0);
  });

  it("returns a training error when there are not enough finalized snapshots", async () => {
    const context = createLiveTrackingContext();
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context
        }),
        "/api/nba/live-model/train",
        "POST"
      );

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body);
      expect(payload.error).toMatch(/Need at least/i);
      expect(payload.tracker.training.snapshots).toBe(0);
    } finally {
      context.store.close();
      context.cleanup();
    }
  });

  it("keeps projections successful when live tracking snapshot persistence fails", async () => {
    const context = createLiveTrackingContext();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    context.store.recordProjectionSnapshot = () => {
      throw new Error("database is locked");
    };
    try {
      const response = await callHandler(
        createHttpHandler({
          espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
          kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
          liveTrackingContext: context
        }),
        "/api/nba/projections?event_id=401&scope=live"
      );

      const payload = JSON.parse(response.body) as ProjectionResponse;
      expect(response.statusCode).toBe(200);
      expect(payload.live_projection.status).toBe("ok");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/database is locked/));
    } finally {
      errorSpy.mockRestore();
      context.store.close();
      context.cleanup();
    }
  });

  it("does not attach learned live corrections to completed projections", async () => {
    const context = createLiveTrackingContext();
    seedLiveModel(context.store);
    try {
      const response = await callHandler(
        createHttpHandler({
          espnClient: espnSummaryClient(
            espnSummaryFixture({
              eventId: "401",
              completed: true,
              homeScore: "101",
              awayScore: "99"
            })
          ),
          kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
          liveTrackingContext: context
        }),
        "/api/nba/projections?event_id=401&scope=live"
      );

      const payload = JSON.parse(response.body) as ProjectionResponse;
      expect(response.statusCode).toBe(200);
      expect(payload.live_projection.status).toBe("ok");
      expect(payload.live_projection.data?.live_projection.data_quality.status).toBe("completed");
      expect(payload.live_projection.data?.live_projection.learned_projection).toBeUndefined();
    } finally {
      context.store.close();
      context.cleanup();
    }
  });
});

async function callHandler(
  handler: ReturnType<typeof createHttpHandler>,
  url: string,
  method = "GET"
): Promise<ServerResponse & { body: string }> {
  const response = createResponseDouble();
  await handler(
    {
      method,
      url,
      headers: { host: "localhost:bad" }
    } as IncomingMessage,
    response
  );
  return response;
}

function createLiveTrackingContext(): LiveTrackingHttpContext & { cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-http-live-"));
  const store = new LiveTrackingStore(path.join(dir, "nba-live.sqlite"));
  return {
    config: {
      enabled: true,
      dbPath: store.dbPath,
      intervalSeconds: 30,
      concurrency: 2,
      minSnapshots: 50
    },
    store,
    tracker: null,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function seedLiveModel(store: LiveTrackingStore): void {
  store.recordProjectionSnapshot({
    trigger: "tracker",
    payload: {
      event_id: "401",
      teams: {
        home: { id: "2", name: "Boston Celtics", abbreviation: "BOS", score: 83 },
        away: { id: "18", name: "New York Knicks", abbreviation: "NY", score: 78 }
      },
      game_status: {
        state: "in",
        description: "In Progress",
        detail: "9:25 - 4th Quarter",
        completed: false,
        period: 4,
        clock: "9:25"
      },
      live_projection: {
        projected_home_score: 104,
        projected_away_score: 98,
        projected_total: 202,
        projected_remaining_points: 41,
        market_total_line: 203,
        difference_vs_market: -1,
        p_over: 0.5,
        relationship_to_market: "near_market",
        model_inputs: {
          current_home_score: 83,
          current_away_score: 78,
          period: 4,
          clock: "9:25",
          recent_points: null,
          recent_minutes: null,
          home_fouls_period: null,
          away_fouls_period: null,
          is_playoffs: true
        },
        data_quality: {
          status: "live",
          market_line_source: "auto_search",
          selected_market_ticker: "KXNBA-CELNYK-TOTAL-203"
        },
        debug: {
          selected_market: {
            market: marketFixture("KXNBA-CELNYK-TOTAL-203", 203),
            line: 203
          },
          model_details: {
            elapsed_minutes: 38.58,
            minutes_left: 9.42,
            margin: 5,
            full_game_rate: 4.17,
            prior_rate: 4.23,
            recent_rate: 4.17,
            blended_rate: 4.2
          }
        },
        source_urls: {}
      }
    }
  });
  store.upsertGame({
    event_id: "401",
    final_home_score: 101,
    final_away_score: 99,
    status_state: "post",
    finalized_at: "2026-04-26T02:00:00Z"
  });
  store.trainLatestModel(1);
}

function createResponseDouble(): ServerResponse & { body: string } {
  return {
    statusCode: 0,
    body: "",
    setHeader() {
      return this;
    },
    end(body?: string | Buffer) {
      this.body = body === undefined ? "" : body.toString();
      return this;
    }
  } as ServerResponse & { body: string };
}

interface ProjectionResponse {
  game: {
    short_name: string | null;
  };
  live_projection: {
    status: "ok" | "error";
    error?: string;
    data?: {
      live_projection: {
        market_total_line: number | null;
        learned_projection?: unknown;
        data_quality: {
          status: string;
        };
      };
    };
  };
  historical_projection?: {
    status: "ok" | "error";
  };
}

function espnSummaryClient(summary: unknown): EspnClient {
  return {
    async getGameSummary() {
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401",
        data: summary
      };
    }
  } as EspnClient;
}

function kalshiClientWithMarkets(markets: unknown[]): KalshiClient {
  return {
    async searchMarkets() {
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "https://api.elections.kalshi.com/trade-api/v2/markets",
        data: {
          markets,
          cursor: ""
        }
      };
    }
  } as KalshiClient;
}

function historicalClient(project: (input: Record<string, unknown>) => Record<string, unknown>): HistoricalProjectionClient {
  return new HistoricalProjectionClient({
    runCommand: async (_command, input) => ({
      stdout: JSON.stringify(project(input)),
      stderr: ""
    })
  });
}

function espnSummaryFixture(input: {
  eventId: string;
  homeScore?: string | null;
  awayScore?: string | null;
  completed?: boolean;
}) {
  const completed = input.completed ?? false;
  return {
    header: {
      id: input.eventId,
      name: "New York Knicks at Boston Celtics",
      shortName: "NY @ BOS",
      competitions: [
        {
          date: "2026-04-25T23:00:00Z",
          status: {
            displayClock: completed ? "0.0" : "9:25",
            period: 4,
            type: {
              state: completed ? "post" : "in",
              description: completed ? "Final" : "In Progress",
              detail: completed ? "Final" : "9:25 - 4th Quarter",
              completed
            }
          },
          competitors: [
            {
              homeAway: "home",
              score: input.homeScore === null ? undefined : input.homeScore ?? "83",
              team: { id: "2", displayName: "Boston Celtics", abbreviation: "BOS" },
              linescores: [
                { period: 1, value: 25, displayValue: "25" },
                { period: 2, value: 28, displayValue: "28" },
                { period: 3, value: 30, displayValue: "30" },
                { period: 4, value: 0, displayValue: "0" }
              ]
            },
            {
              homeAway: "away",
              score: input.awayScore === null ? undefined : input.awayScore ?? "78",
              team: { id: "18", displayName: "New York Knicks", abbreviation: "NY" },
              linescores: [
                { period: 1, value: 24, displayValue: "24" },
                { period: 2, value: 24, displayValue: "24" },
                { period: 3, value: 30, displayValue: "30" },
                { period: 4, value: 0, displayValue: "0" }
              ]
            }
          ]
        }
      ]
    }
  };
}

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
    liquidity: 1000
  };
}
