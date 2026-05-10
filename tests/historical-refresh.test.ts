import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
      SPORTS_PROJECTOR_SPORTSDB_API_KEY: "private",
      SPORTS_PROJECTOR_HISTORICAL_MARKET_TOTALS_MAX_PAGES: "7"
    });

    expect(config.enabled).toBe(true);
    expect(config.recentDays).toBe(4);
    expect(config.lookaheadDays).toBe(1);
    expect(config.eventIds).toEqual(["2467180", "2466030"]);
    expect(config.sportsDbApiKey).toBe("private");
    expect(config.marketTotalsEnabled).toBe(true);
    expect(config.marketTotalsMaxPages).toBe(7);
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
      stdout: JSON.stringify({
        ok: true,
        events: 12,
        market_line_source_counts: { kalshi_current: 3 },
        market_line_auto: {
          matched_rows: 3,
          ambiguous_matches: 1,
          skipped_markets: 2,
          sources: {
            kalshi_current: { pages: 1, markets: 5, truncated: false }
          }
        }
      }),
      stderr: ""
    }));

    const ran = await scheduler.refresh();
    const status = scheduler.status();

    expect(ran).toBe(true);
    expect(status.last_error).toBeNull();
    expect(status.last_success_at).toEqual(expect.any(String));
    expect(status.last_result).toMatchObject({
      ok: true,
      events: 12,
      market_line_source_counts: { kalshi_current: 3 },
      market_line_auto: {
        matched_rows: 3,
        ambiguous_matches: 1,
        skipped_markets: 2
      }
    });
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

  it("surfaces historical artifact snapshot dates from inventory state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-historical-status-"));
    try {
      writeFileSync(
        path.join(dir, "artifact_manifest.json"),
        JSON.stringify({
          team_stats: {
            latest_snapshot_date: "2026-05-08",
            date_range: {
              start: "2025-10-21",
              end: "2026-05-08"
            }
          }
        })
      );
      const scheduler = new HistoricalRefreshScheduler({ ...config(), artifactDir: dir });

      expect(scheduler.status()).toMatchObject({
        latest_snapshot_date: "2026-05-08",
        artifact_date_range: {
          start: "2025-10-21",
          end: "2026-05-08"
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      "--auto-market-lines",
      "--market-lines-max-pages",
      "10",
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
      "--auto-market-lines",
      "--market-lines-max-pages",
      "10",
      "--event-id",
      "2467180"
    ]);
  });

  it("can disable automatic market total imports", () => {
    expect(historicalRefreshArgs({ ...config(), marketTotalsEnabled: false })).not.toContain("--auto-market-lines");
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
    marketTotalsEnabled: true,
    marketTotalsMaxPages: 10,
    python: "python3",
    root: "/repo",
    artifactDir: "/repo/data/historical",
    timeoutMs: 30000
  };
}
