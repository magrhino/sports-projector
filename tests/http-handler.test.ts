import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { EspnClient } from "../src/clients/espn.js";
import type { KalshiClient } from "../src/clients/kalshi.js";
import { createHttpHandler } from "../src/http/index.js";
import type { HistoricalRefreshHttpContext } from "../src/http/historical-refresh.js";
import { HistoricalRefreshScheduler } from "../src/nba/historical-refresh.js";
import type { LiveTrackingHttpContext } from "../src/http/live-tracking.js";
import { HistoricalProjectionClient, HistoricalProjectionError } from "../src/nba/historical-client.js";
import { SettingsStore } from "../src/lib/settings.js";
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

  it("serves web app icon assets with specific content types", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-http-static-"));
    try {
      writeFileSync(path.join(dir, "favicon.ico"), "icon");
      writeFileSync(path.join(dir, "favicon-32x32.png"), "png");
      writeFileSync(path.join(dir, "site.webmanifest"), "{}");

      const handler = createHttpHandler({ publicDir: dir });

      const ico = await callHandler(handler, "/favicon.ico");
      const png = await callHandler(handler, "/favicon-32x32.png");
      const manifest = await callHandler(handler, "/site.webmanifest");

      expect(ico.statusCode).toBe(200);
      expect(ico.headers["content-type"]).toBe("image/x-icon");
      expect(png.statusCode).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(payload.live_projection.data?.teams.home.logo).toBe("https://example.com/celtics.png");
    expect(payload.live_projection.data?.teams.away.logo).toBe("https://example.com/knicks.png");
    expect(payload.live_projection.data?.live_projection.market_total_line).toBe(203);
    expect(payload.historical_projection?.status).toBe("ok");
    expect(historicalInputs[0]).toMatchObject({
      home_team: "Boston Celtics",
      away_team: "New York Knicks",
      game_date: "2026-04-25",
      market_total: 203
    });
  });

  it("bypasses API client caches for live-only projection refreshes", async () => {
    const summaryOptions: Array<{ cacheMode?: string } | undefined> = [];
    const marketOptions: Array<{ cacheMode?: string } | undefined> = [];
    const response = await callHandler(
      createHttpHandler({
        espnClient: {
          async getGameSummary(
            _input: { league: "nba"; eventId: string },
            options?: { cacheMode?: "default" | "bypass" }
          ) {
            summaryOptions.push(options);
            return {
              cacheStatus: "bypass" as const,
              sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401",
              data: espnSummaryFixture({ eventId: "401" })
            };
          }
        } as EspnClient,
        kalshiClient: {
          async searchMarkets(_input: Record<string, unknown>, options?: { cacheMode?: "default" | "bypass" }) {
            marketOptions.push(options);
            return {
              cacheStatus: "bypass" as const,
              sourceUrl: "https://api.elections.kalshi.com/trade-api/v2/markets",
              data: {
                markets: [marketFixture("KXNBA-CELNYK-TOTAL-203", 203)],
                cursor: ""
              }
            };
          }
        } as KalshiClient
      }),
      "/api/nba/projections?event_id=401&scope=live"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.live_projection.status).toBe("ok");
    expect(payload.live_projection.data?.live_projection.cache_status).toBe("bypass");
    expect(payload.historical_projection).toBeUndefined();
    expect(summaryOptions).toEqual([{ cacheMode: "bypass" }]);
    expect(marketOptions).toEqual([{ cacheMode: "bypass" }]);
  });

  it("omits historical market total when no live market line is available", async () => {
    const historicalInputs: Record<string, unknown>[] = [];
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([]),
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
            data_quality: {
              status: "missing_market_context",
              reasons: ["market_total was not supplied."]
            }
          };
        })
      }),
      "/api/nba/projections?event_id=401"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.live_projection.data?.live_projection.market_total_line).toBeNull();
    expect(payload.historical_projection?.status).toBe("ok");
    expect(historicalInputs[0]).not.toHaveProperty("market_total");
  });

  it("tracks a custom live total without replacing the market line", async () => {
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)])
      }),
      "/api/nba/projections?event_id=401&scope=live&tracked_total_line=215.5"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    const projection = payload.live_projection.data?.live_projection;
    expect(response.statusCode).toBe(200);
    expect(payload.live_projection.status).toBe("ok");
    expect(projection?.market_total_line).toBe(203);
    expect(projection?.tracked_total_line).toBe(215.5);
    expect(projection?.p_over).not.toBe(projection?.tracked_p_over);
  });

  it("returns 400 for invalid tracked live totals", async () => {
    const response = await callHandler(
      createHttpHandler(),
      "/api/nba/projections?event_id=401&scope=live&tracked_total_line=99"
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/tracked_total_line/i);
  });

  it("preserves stale historical artifact errors instead of displaying fallback projections", async () => {
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
        historicalClient: new HistoricalProjectionClient({
          runCommand: async () => {
            throw new HistoricalProjectionError(
              "Historical team snapshot is stale for requested game date 2026-04-25",
              "stale_team_snapshot"
            );
          }
        })
      }),
      "/api/nba/projections?event_id=401"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.historical_projection?.status).toBe("error");
    expect(payload.historical_projection?.error).toContain("stale");
  });

  it("preserves invalid historical model health errors instead of displaying fallback projections", async () => {
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
        kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
        historicalClient: new HistoricalProjectionClient({
          runCommand: async () => {
            throw new HistoricalProjectionError(
              "Historical artifact failed model health gates",
              "invalid_model_health"
            );
          }
        })
      }),
      "/api/nba/projections?event_id=401"
    );

    const payload = JSON.parse(response.body) as ProjectionResponse;
    expect(response.statusCode).toBe(200);
    expect(payload.historical_projection?.status).toBe("error");
    expect(payload.historical_projection?.error).toContain("model health");
  });

  it("uses the NBA Eastern game date for late UTC evening starts", async () => {
    const historicalInputs: Record<string, unknown>[] = [];
    const response = await callHandler(
      createHttpHandler({
        espnClient: espnSummaryClient(
          espnSummaryFixture({
            eventId: "401",
            startTime: "2026-05-09T01:30:00Z"
          })
        ),
        kalshiClient: kalshiClientWithMarkets([]),
        historicalClient: historicalClient((input) => {
          historicalInputs.push(input);
          return {
            teams: {
              home: input.home_team,
              away: input.away_team
            },
            game_date: input.game_date,
            projected_home_score: 110,
            projected_away_score: 103,
            projected_total: 213
          };
        })
      }),
      "/api/nba/projections?event_id=401"
    );

    expect(response.statusCode).toBe(200);
    expect(historicalInputs[0]).toMatchObject({
      game_date: "2026-05-08"
    });
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
    const payload = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(payload.tracker.enabled).toBe(false);
    expect(payload.tracker).not.toHaveProperty("db_path");
    expect(payload.tracker.training.snapshots).toBe(0);
  });

  it("returns a live tracking storage error instead of crashing when status reads fail", async () => {
    const context = createLiveTrackingContext();
    context.store.status = vi.fn(() => {
      throw new Error("database disk image is malformed");
    }) as LiveTrackingStore["status"];
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context
        }),
        "/api/nba/live-tracking/status"
      );

      const payload = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(payload.last_error).toMatch(/database disk image is malformed/);
      expect(payload.tracker.enabled).toBe(true);
      expect(payload.tracker.training.ready).toBe(false);
      expect(payload.auto_training.enabled).toBe(false);
    } finally {
      context.store.close();
      context.cleanup();
    }
  });

  it("returns historical refresh status", async () => {
    const context = createHistoricalRefreshContext();
    const response = await callHandler(
      createHttpHandler({
        historicalRefreshContext: context
      }),
      "/api/nba/historical-refresh/status"
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      enabled: true,
      running: false,
      recent_days: 3,
      lookahead_days: 2,
      event_ids: ["2467180"]
    });
  });

  it("returns settings defaults", async () => {
    const { store, cleanup } = createSettingsStore();
    try {
      const response = await callHandler(
        createHttpHandler({
          settingsStore: store
        }),
        "/api/settings"
      );

      const payload = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(payload.settings).toMatchObject({
        live_enhancements_enabled: true,
        historical_enhancements_enabled: true,
        live_auto_training_enabled: true,
        live_training_interval_seconds: 3600
      });
    } finally {
      cleanup();
    }
  });

  it("rejects remote settings updates without the configured admin token", async () => {
    const { store, cleanup } = createSettingsStore();
    try {
      const response = await callHandler(
        createHttpHandler({
          settingsStore: store
        }),
        "/api/settings",
        "PATCH",
        {
          body: JSON.stringify({ live_enhancements_enabled: false }),
          headers: { "content-type": "application/json" },
          remoteAddress: "203.0.113.10"
        }
      );

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error).toMatch(/local admin request/i);
    } finally {
      cleanup();
    }
  });

  it("persists protected settings updates", async () => {
    const { store, cleanup } = createSettingsStore();
    try {
      const response = await callHandler(
        createHttpHandler({
          settingsStore: store,
          liveModelTrainToken: "test-admin-token"
        }),
        "/api/settings",
        "PATCH",
        {
          body: JSON.stringify({
            live_enhancements_enabled: false,
            live_training_interval_seconds: 21600
          }),
          headers: {
            "content-type": "application/json",
            "x-sports-projector-admin-token": "test-admin-token"
          },
          remoteAddress: "203.0.113.10"
        }
      );

      const payload = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(payload.settings.live_enhancements_enabled).toBe(false);
      expect(payload.settings.live_training_interval_seconds).toBe(21600);
      expect(store.read().live_enhancements_enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects live model training without an admin request guard", async () => {
    const context = createLiveTrackingContext();
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context
        }),
        "/api/nba/live-model/train",
        "POST",
        {
          remoteAddress: "::1"
        }
      );

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error).toMatch(/local admin request/i);
    } finally {
      context.store.close();
      context.cleanup();
    }
  });

  it("rejects remote live model training without the configured admin token", async () => {
    const context = createLiveTrackingContext();
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context
        }),
        "/api/nba/live-model/train",
        "POST",
        {
          headers: {
            "x-sports-projector-action": "train-live-model"
          },
          remoteAddress: "203.0.113.10"
        }
      );

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error).toMatch(/local admin request/i);
    } finally {
      context.store.close();
      context.cleanup();
    }
  });

  it("returns a training error when there are not enough finalized snapshots", async () => {
    const context = createLiveTrackingContext();
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context
        }),
        "/api/nba/live-model/train",
        "POST",
        {
          headers: {
            "x-sports-projector-action": "train-live-model"
          },
          remoteAddress: "::1"
        }
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

  it("allows protected live model training with the configured admin token", async () => {
    const context = createLiveTrackingContext();
    try {
      const response = await callHandler(
        createHttpHandler({
          liveTrackingContext: context,
          liveModelTrainToken: "test-admin-token"
        }),
        "/api/nba/live-model/train",
        "POST",
        {
          headers: {
            "x-sports-projector-action": "train-live-model",
            "x-sports-projector-admin-token": "test-admin-token"
          },
          remoteAddress: "203.0.113.10"
        }
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/Need at least/i);
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

  it("attaches learned live corrections when live enhancements are enabled", async () => {
    const context = createLiveTrackingContext();
    const { store: settingsStore, cleanup: cleanupSettings } = createSettingsStore();
    seedLiveModel(context.store);
    try {
      const response = await callHandler(
        createHttpHandler({
          espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
          kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
          liveTrackingContext: context,
          settingsStore
        }),
        "/api/nba/projections?event_id=401&scope=live"
      );

      const payload = JSON.parse(response.body) as ProjectionResponse;
      expect(response.statusCode).toBe(200);
      expect(payload.live_projection.data?.live_projection.learned_projection).toBeDefined();
    } finally {
      context.store.close();
      context.cleanup();
      cleanupSettings();
    }
  });

  it("skips learned live corrections when live enhancements are disabled", async () => {
    const context = createLiveTrackingContext();
    const { store: settingsStore, cleanup: cleanupSettings } = createSettingsStore();
    seedLiveModel(context.store);
    settingsStore.update({ live_enhancements_enabled: false });
    try {
      const response = await callHandler(
        createHttpHandler({
          espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
          kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
          liveTrackingContext: context,
          settingsStore
        }),
        "/api/nba/projections?event_id=401&scope=live"
      );

      const payload = JSON.parse(response.body) as ProjectionResponse;
      expect(response.statusCode).toBe(200);
      expect(payload.live_projection.data?.live_projection.learned_projection).toBeUndefined();
    } finally {
      context.store.close();
      context.cleanup();
      cleanupSettings();
    }
  });

  it("skips learned live corrections when the latest model has not passed accuracy review", async () => {
    const context = createLiveTrackingContext();
    const { store: settingsStore, cleanup: cleanupSettings } = createSettingsStore();
    seedInsufficientLiveModel(context.store);
    try {
      const response = await callHandler(
        createHttpHandler({
          espnClient: espnSummaryClient(espnSummaryFixture({ eventId: "401" })),
          kalshiClient: kalshiClientWithMarkets([marketFixture("KXNBA-CELNYK-TOTAL-203", 203)]),
          liveTrackingContext: context,
          settingsStore
        }),
        "/api/nba/projections?event_id=401&scope=live"
      );

      const payload = JSON.parse(response.body) as ProjectionResponse;
      expect(response.statusCode).toBe(200);
      expect(context.store.status(true).model?.accuracy_gate.status).toBe("insufficient_data");
      expect(payload.live_projection.data?.live_projection.learned_projection).toBeUndefined();
    } finally {
      context.store.close();
      context.cleanup();
      cleanupSettings();
    }
  });
});

async function callHandler(
  handler: ReturnType<typeof createHttpHandler>,
  url: string,
  method = "GET",
  options: {
    body?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {}
): Promise<ResponseDouble> {
  const response = createResponseDouble();
  const request = Readable.from(options.body === undefined ? [] : [options.body]) as IncomingMessage;
  Object.assign(request, {
    method,
    url,
    headers: { host: "localhost:bad", ...options.headers },
    socket: { remoteAddress: options.remoteAddress ?? "203.0.113.10" }
  });
  await handler(
    request,
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
      dbRecovery: "auto",
      sqliteBin: "sqlite3",
      intervalSeconds: 30,
      concurrency: 2,
      minSnapshots: 50
    },
    store,
    tracker: null,
    trainer: null,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function createSettingsStore(): { store: SettingsStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-http-settings-"));
  return {
    store: new SettingsStore(path.join(dir, "settings.json")),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function createHistoricalRefreshContext(): HistoricalRefreshHttpContext {
  return {
    scheduler: new HistoricalRefreshScheduler(
      {
        enabled: true,
        intervalSeconds: 3600,
        recentDays: 3,
        lookaheadDays: 2,
        eventIds: ["2467180"],
        sportsDbApiKey: "123",
        marketTotalsEnabled: true,
        marketTotalsMaxPages: 10,
        espnTeamSchedulesEnabled: true,
        espnLookbackSeasons: 2,
        espnRateLimitPerMinute: 120,
        python: "python3",
        root: "/repo",
        artifactDir: "/repo/data/historical",
        timeoutMs: 30000
      },
      async () => ({ stdout: "{\"ok\":true}", stderr: "" })
    )
  };
}

function seedLiveModel(store: LiveTrackingStore): void {
  for (let index = 0; index < 100; index += 1) {
    const eventId = `accuracy-${index}`;
    store.recordProjectionSnapshot({
      trigger: "tracker",
      payload: {
        event_id: eventId,
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
      event_id: eventId,
      final_home_score: 108,
      final_away_score: 100,
      status_state: "post",
      finalized_at: "2026-04-26T02:00:00Z"
    });
  }
  store.trainLatestModel(50);
}

function seedInsufficientLiveModel(store: LiveTrackingStore): void {
  store.recordProjectionSnapshot({
    trigger: "tracker",
    payload: {
      event_id: "thin-model",
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
    event_id: "thin-model",
    final_home_score: 101,
    final_away_score: 99,
    status_state: "post",
    finalized_at: "2026-04-26T02:00:00Z"
  });
  store.trainLatestModel(1);
}

type ResponseDouble = ServerResponse & {
  body: string;
  headers: Record<string, number | string | string[]>;
};

function createResponseDouble(): ResponseDouble {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(body?: string | Buffer) {
      this.body = body === undefined ? "" : body.toString();
      return this;
    }
  } as ResponseDouble;
}

interface ProjectionResponse {
  game: {
    short_name: string | null;
  };
  live_projection: {
    status: "ok" | "error";
    error?: string;
    data?: {
      teams: {
        home: { logo: string | null };
        away: { logo: string | null };
      };
      live_projection: {
        market_total_line: number | null;
        p_over?: number | null;
        tracked_total_line?: number | null;
        tracked_p_over?: number | null;
        cache_status?: string;
        learned_projection?: unknown;
        data_quality: {
          status: string;
        };
      };
    };
  };
  historical_projection?: {
    status: "ok" | "error";
    error?: string;
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
  startTime?: string;
}) {
  const completed = input.completed ?? false;
  return {
    header: {
      id: input.eventId,
      name: "New York Knicks at Boston Celtics",
      shortName: "NY @ BOS",
      competitions: [
        {
          date: input.startTime ?? "2026-04-25T23:00:00Z",
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
              team: {
                id: "2",
                displayName: "Boston Celtics",
                abbreviation: "BOS",
                logo: "https://example.com/celtics.png"
              },
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
              team: {
                id: "18",
                displayName: "New York Knicks",
                abbreviation: "NY",
                logo: "https://example.com/knicks.png"
              },
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
