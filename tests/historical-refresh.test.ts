import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/lib/settings.js";
import {
  HistoricalRefreshScheduler,
  historicalRefreshArgs,
  historicalRefreshConfigFromEnv,
  type HistoricalRefreshConfig
} from "../src/nba/historical-refresh.js";

describe("historical refresh config", () => {
  it("is enabled by default and reads refresh options from env", () => {
    const config = historicalRefreshConfigFromEnv({
      SPORTS_PROJECTOR_HISTORICAL_ROOT: "/repo",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_RECENT_DAYS: "4",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_LOOKAHEAD_DAYS: "1",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_EVENT_IDS: "2467180, 2466030",
      SPORTS_PROJECTOR_SPORTSDB_API_KEY: "private"
    });

    expect(config.enabled).toBe(true);
    expect(config.recentDays).toBe(4);
    expect(config.lookaheadDays).toBe(1);
    expect(config.eventIds).toEqual(["2467180", "2466030"]);
    expect(config.sportsDbApiKey).toBe("private");
  });

  it("can be disabled by env", () => {
    const config = historicalRefreshConfigFromEnv({
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED: "false"
    });

    expect(config.enabled).toBe(false);
  });
});

describe("HistoricalRefreshScheduler", () => {
  it("records successful refresh status", async () => {
    const scheduler = new HistoricalRefreshScheduler(config(), async () => ({
      stdout: JSON.stringify({ ok: true, events: 12 }),
      stderr: ""
    }));

    const ran = await scheduler.refresh();
    const status = scheduler.status();

    expect(ran).toBe(true);
    expect(status.last_error).toBeNull();
    expect(status.last_success_at).toEqual(expect.any(String));
    expect(status.last_result).toMatchObject({ ok: true, events: 12 });
  });

  it("skips overlapping refreshes", async () => {
    let release: (() => void) | null = null;
    const scheduler = new HistoricalRefreshScheduler(config(), async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    });

    const first = scheduler.refresh();
    const second = await scheduler.refresh();
    release?.();
    await first;

    expect(second).toBe(false);
    expect(scheduler.status().last_success_at).toEqual(expect.any(String));
  });

  it("passes current historical enhancement settings to the refresh runner", async () => {
    let runnerConfig: HistoricalRefreshConfig | null = null;
    const scheduler = new HistoricalRefreshScheduler(
      config(),
      async (nextConfig) => {
        runnerConfig = nextConfig;
        return {
          stdout: JSON.stringify({ ok: true }),
          stderr: ""
        };
      },
      () => ({
        ...DEFAULT_SETTINGS,
        historical_enhancements_enabled: false
      })
    );

    const ran = await scheduler.refresh();

    expect(ran).toBe(true);
    expect(runnerConfig?.historicalEnhancementsEnabled).toBe(false);
    expect(scheduler.status().enhancements_enabled).toBe(false);
  });
});

describe("historicalRefreshArgs", () => {
  it("passes enhanced freshness options to the Python importer by default", () => {
    expect(historicalRefreshArgs(config())).toEqual([
      "-m",
      "nba_historical_projection",
      "import-sportsdb",
      "--artifact-dir",
      "/repo/data/historical",
      "--api-key",
      "123",
      "--recent-days",
      "3",
      "--lookahead-days",
      "2",
      "--model-kind",
      "auto",
      "--calibration",
      "auto",
      "--quantiles",
      "0.05,0.10,0.25,0.50,0.75,0.90,0.95",
      "--rating-features",
      "market",
      "--rating-line-source",
      "close",
      "--skill-features",
      "score-based",
      "--experimental-market-decorrelation",
      "--event-id",
      "2467180"
    ]);
  });

  it("can omit enhanced importer flags", () => {
    expect(historicalRefreshArgs({ ...config(), historicalEnhancementsEnabled: false })).toEqual([
      "-m",
      "nba_historical_projection",
      "import-sportsdb",
      "--artifact-dir",
      "/repo/data/historical",
      "--api-key",
      "123",
      "--recent-days",
      "3",
      "--lookahead-days",
      "2",
      "--event-id",
      "2467180"
    ]);
  });
});

function config(): HistoricalRefreshConfig {
  return {
    enabled: true,
    intervalSeconds: 3600,
    recentDays: 3,
    lookaheadDays: 2,
    eventIds: ["2467180"],
    sportsDbApiKey: "123",
    python: "python3",
    root: "/repo",
    artifactDir: "/repo/data/historical",
    timeoutMs: 30000
  };
}
