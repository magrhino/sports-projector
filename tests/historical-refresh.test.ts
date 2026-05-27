import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppLogger } from "../src/lib/logger.js";
import { DEFAULT_SETTINGS } from "../src/lib/settings.js";
import {
  HistoricalRefreshScheduler,
  historicalRefreshArgs,
  historicalRefreshConfigFromEnv,
  promoteHistoricalStagingDir,
  runHistoricalRefreshCommand,
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
      SPORTS_PROJECTOR_HISTORICAL_MARKET_TOTALS_MAX_PAGES: "7",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_ESPN_LOOKBACK_SEASONS: "3",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_ESPN_RATE_LIMIT_PER_MINUTE: "90"
    });

    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(120000);
    expect(config.recentDays).toBe(4);
    expect(config.lookaheadDays).toBe(1);
    expect(config.eventIds).toEqual(["2467180", "2466030"]);
    expect(config.sportsDbApiKey).toBe("private");
    expect(config.marketTotalsEnabled).toBe(true);
    expect(config.marketTotalsMaxPages).toBe(7);
    expect(config.espnTeamSchedulesEnabled).toBe(true);
    expect(config.espnLookbackSeasons).toBe(3);
    expect(config.espnRateLimitPerMinute).toBe(90);
  });

  it("can be disabled by env", () => {
    const config = historicalRefreshConfigFromEnv({
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED: "false"
    });

    expect(config.enabled).toBe(false);
  });

  it("allows refresh imports to use a dedicated timeout override", () => {
    const sharedTimeout = historicalRefreshConfigFromEnv({
      SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS: "2000"
    });
    const refreshTimeout = historicalRefreshConfigFromEnv({
      SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS: "2000",
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_TIMEOUT_MS: "90000"
    });

    expect(sharedTimeout.timeoutMs).toBe(2000);
    expect(refreshTimeout.timeoutMs).toBe(90000);
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

  it("logs refresh failures", async () => {
    const logger = fakeErrorLogger();
    const scheduler = new HistoricalRefreshScheduler(
      config(),
      async () => {
        throw new Error("refresh failed");
      },
      () => DEFAULT_SETTINGS,
      logger
    );

    const ran = await scheduler.refresh();

    expect(ran).toBe(false);
    expect(scheduler.status().last_error).toBe("refresh failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Historical refresh failed.",
      expect.objectContaining({
        event: "historical_refresh.error",
        error: expect.any(Error),
        artifact_dir: "/repo/data/historical",
        interval_seconds: 3600
      })
    );
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

describe("promoteHistoricalStagingDir", () => {
  it("promotes staged artifacts atomically over an existing directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-promote-"));
    try {
      const target = path.join(dir, "historical");
      const staging = path.join(dir, ".historical-refresh-abc");
      mkdirSync(target);
      mkdirSync(staging);
      writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ version: "old" }));
      writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ version: "new" }));

      promoteHistoricalStagingDir(staging, target);

      expect(readFileSync(path.join(target, "manifest.json"), "utf-8")).toBe(JSON.stringify({ version: "new" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a unique backup path when the timestamped backup already exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-promote-"));
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const target = path.join(dir, "historical");
      const staging = path.join(dir, ".historical-refresh-abc");
      const existingBackup = `${target}.previous-123`;
      mkdirSync(target);
      mkdirSync(staging);
      mkdirSync(existingBackup);
      writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ version: "old" }));
      writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ version: "new" }));
      writeFileSync(path.join(existingBackup, "manifest.json"), JSON.stringify({ version: "collision" }));

      promoteHistoricalStagingDir(staging, target);

      expect(readFileSync(path.join(target, "manifest.json"), "utf-8")).toBe(JSON.stringify({ version: "new" }));
      expect(readFileSync(path.join(existingBackup, "manifest.json"), "utf-8")).toBe(
        JSON.stringify({ version: "collision" })
      );
    } finally {
      dateNow.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the previous artifact directory when staged promotion fails after backup", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-promote-"));
    try {
      const target = path.join(dir, "historical");
      const missingStaging = path.join(dir, ".historical-refresh-missing");
      mkdirSync(target);
      writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ version: "old" }));

      expect(() => promoteHistoricalStagingDir(missingStaging, target)).toThrow();

      expect(readFileSync(path.join(target, "manifest.json"), "utf-8")).toBe(JSON.stringify({ version: "old" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runHistoricalRefreshCommand", () => {
  it("reports promoted artifact paths instead of deleted staging paths", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-refresh-run-"));
    try {
      const fakePython = path.join(dir, "fake-python.cjs");
      writeFileSync(
        fakePython,
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const artifactDir = process.argv[process.argv.indexOf("--artifact-dir") + 1];
const normalized = path.join(artifactDir, "sportsdb", "normalized");
fs.mkdirSync(normalized, { recursive: true });
fs.writeFileSync(path.join(artifactDir, "manifest.json"), "{}");
process.stdout.write(JSON.stringify({
  ok: true,
  artifact_dir: artifactDir,
  dataset: path.join(normalized, "nba_games.sqlite"),
  team_stats: path.join(normalized, "nba_team_stats.sqlite"),
  market_lines: path.join(normalized, "nba_market_lines.sqlite")
}));
`,
        "utf-8"
      );
      chmodSync(fakePython, 0o755);
      const artifactDir = path.join(dir, "historical");

      const result = await runHistoricalRefreshCommand({
        ...config(),
        root: dir,
        artifactDir,
        python: fakePython,
        marketTotalsEnabled: false,
        espnTeamSchedulesEnabled: false
      });

      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        artifact_dir: artifactDir,
        dataset: path.join(artifactDir, "sportsdb", "normalized", "nba_games.sqlite"),
        team_stats: path.join(artifactDir, "sportsdb", "normalized", "nba_team_stats.sqlite"),
        market_lines: path.join(artifactDir, "sportsdb", "normalized", "nba_market_lines.sqlite"),
        promoted: true
      });
      expect(payload.staged_artifact_dir).toMatch(/^\.historical-refresh-/);
      expect(readFileSync(path.join(artifactDir, "manifest.json"), "utf-8")).toBe("{}");
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
      "--enforce-quality-gates",
      "--espn-team-schedules",
      "--espn-lookback-seasons",
      "2",
      "--espn-rate-limit-per-minute",
      "120",
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
      "--enforce-quality-gates",
      "--espn-team-schedules",
      "--espn-lookback-seasons",
      "2",
      "--espn-rate-limit-per-minute",
      "120",
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

  it("can disable ESPN schedule history imports", () => {
    expect(historicalRefreshArgs({ ...config(), espnTeamSchedulesEnabled: false })).not.toContain(
      "--espn-team-schedules"
    );
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
    espnTeamSchedulesEnabled: true,
    espnLookbackSeasons: 2,
    espnRateLimitPerMinute: 120,
    python: "python3",
    root: "/repo",
    artifactDir: "/repo/data/historical",
    timeoutMs: 30000
  };
}

function fakeErrorLogger(): Pick<AppLogger, "error"> & { error: ReturnType<typeof vi.fn> } {
  return {
    error: vi.fn()
  };
}
