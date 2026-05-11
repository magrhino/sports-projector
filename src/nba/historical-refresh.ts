import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import {
  historicalProjectionConfigFromEnv,
  timeoutMsFromEnv,
  type HistoricalProjectionConfig,
  type HistoricalCommandResult
} from "./historical-client.js";
import { DEFAULT_SETTINGS, type SportsProjectorSettings } from "../lib/settings.js";

export interface HistoricalRefreshConfig extends HistoricalProjectionConfig {
  enabled: boolean;
  intervalSeconds: number;
  recentDays: number;
  lookaheadDays: number;
  eventIds: string[];
  sportsDbApiKey: string;
  marketTotalsEnabled: boolean;
  marketTotalsMaxPages: number;
  espnTeamSchedulesEnabled: boolean;
  espnLookbackSeasons: number;
  espnRateLimitPerMinute: number;
  historicalEnhancementsEnabled?: boolean;
}

export interface HistoricalRefreshStatus {
  enabled: boolean;
  running: boolean;
  interval_seconds: number;
  enhancements_enabled: boolean;
  recent_days: number;
  lookahead_days: number;
  event_ids: string[];
  market_totals_enabled: boolean;
  market_totals_max_pages: number;
  espn_team_schedules_enabled: boolean;
  espn_lookback_seasons: number;
  espn_rate_limit_per_minute: number;
  artifact_dir: string;
  latest_snapshot_date?: string | null;
  artifact_date_range?: {
    start: string;
    end: string;
  } | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_result: Record<string, unknown> | null;
}

export type HistoricalRefreshRunner = (config: HistoricalRefreshConfig) => Promise<HistoricalCommandResult>;
export type HistoricalSettingsReader = () => SportsProjectorSettings;

const ENHANCED_HISTORICAL_QUANTILES = "0.05,0.10,0.25,0.50,0.75,0.90,0.95";
const DEFAULT_HISTORICAL_REFRESH_TIMEOUT_MS = 120000;

export class HistoricalRefreshScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastStartedAt: string | null = null;
  private lastFinishedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: Record<string, unknown> | null = null;

  constructor(
    readonly config: HistoricalRefreshConfig,
    private readonly runRefresh: HistoricalRefreshRunner = runHistoricalRefreshCommand,
    private readonly readSettings: HistoricalSettingsReader = () => DEFAULT_SETTINGS
  ) {}

  start(): void {
    if (this.timer || !this.config.enabled) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.config.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<boolean> {
    if (this.running || !this.config.enabled) {
      return false;
    }
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    try {
      const settings = this.readSettings();
      const result = await this.runRefresh({
        ...this.config,
        historicalEnhancementsEnabled: settings.historical_enhancements_enabled
      });
      this.lastResult = parseRefreshJson(result.stdout);
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.lastFinishedAt = new Date().toISOString();
      this.running = false;
    }
  }

  status(): HistoricalRefreshStatus {
    const artifactSummary = historicalArtifactSummary(this.config.artifactDir);
    return {
      enabled: this.config.enabled,
      running: this.running,
      interval_seconds: this.config.intervalSeconds,
      enhancements_enabled: this.safeSettings().historical_enhancements_enabled,
      recent_days: this.config.recentDays,
      lookahead_days: this.config.lookaheadDays,
      event_ids: this.config.eventIds,
      market_totals_enabled: this.config.marketTotalsEnabled,
      market_totals_max_pages: this.config.marketTotalsMaxPages,
      espn_team_schedules_enabled: this.config.espnTeamSchedulesEnabled,
      espn_lookback_seasons: this.config.espnLookbackSeasons,
      espn_rate_limit_per_minute: this.config.espnRateLimitPerMinute,
      artifact_dir: this.config.artifactDir,
      latest_snapshot_date: artifactSummary.latestSnapshotDate,
      artifact_date_range: artifactSummary.dateRange,
      last_started_at: this.lastStartedAt,
      last_finished_at: this.lastFinishedAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      last_result: this.lastResult
    };
  }

  private safeSettings(): SportsProjectorSettings {
    try {
      return this.readSettings();
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}

function historicalArtifactSummary(artifactDir: string): {
  latestSnapshotDate: string | null;
  dateRange: { start: string; end: string } | null;
} {
  const statePath = path.join(artifactDir, "artifact_manifest.json");
  if (!existsSync(statePath)) {
    return { latestSnapshotDate: null, dateRange: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { latestSnapshotDate: null, dateRange: null };
    }
    const teamStats = (parsed as Record<string, unknown>).team_stats;
    if (!teamStats || typeof teamStats !== "object" || Array.isArray(teamStats)) {
      return { latestSnapshotDate: null, dateRange: null };
    }
    const record = teamStats as Record<string, unknown>;
    const latestSnapshotDate =
      typeof record.latest_snapshot_date === "string" ? record.latest_snapshot_date : null;
    const dateRange = record.date_range;
    if (!dateRange || typeof dateRange !== "object" || Array.isArray(dateRange)) {
      return { latestSnapshotDate, dateRange: null };
    }
    const rangeRecord = dateRange as Record<string, unknown>;
    const start = typeof rangeRecord.start === "string" ? rangeRecord.start : null;
    const end = typeof rangeRecord.end === "string" ? rangeRecord.end : null;
    return {
      latestSnapshotDate: latestSnapshotDate ?? end,
      dateRange: start && end ? { start, end } : null
    };
  } catch {
    return { latestSnapshotDate: null, dateRange: null };
  }
}

export function historicalRefreshConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HistoricalRefreshConfig {
  const historical = historicalProjectionConfigFromEnv(env);
  return {
    ...historical,
    timeoutMs: timeoutMsFromEnv(
      env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_TIMEOUT_MS ?? env.SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS,
      DEFAULT_HISTORICAL_REFRESH_TIMEOUT_MS
    ),
    enabled: parseBoolean(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED, true),
    intervalSeconds: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_INTERVAL_SECONDS, 3600, 60, 86400),
    recentDays: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_RECENT_DAYS, 3, 0, 30),
    lookaheadDays: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_LOOKAHEAD_DAYS, 2, 0, 30),
    eventIds: splitCsv(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_EVENT_IDS),
    sportsDbApiKey: env.SPORTS_PROJECTOR_SPORTSDB_API_KEY ?? "123",
    marketTotalsEnabled: parseBoolean(env.SPORTS_PROJECTOR_HISTORICAL_MARKET_TOTALS_ENABLED, true),
    marketTotalsMaxPages: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_MARKET_TOTALS_MAX_PAGES, 10, 0, 100),
    espnTeamSchedulesEnabled: parseBoolean(
      env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_ESPN_TEAM_SCHEDULES_ENABLED,
      true
    ),
    espnLookbackSeasons: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_ESPN_LOOKBACK_SEASONS, 2, 1, 10),
    espnRateLimitPerMinute: clampInteger(
      env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_ESPN_RATE_LIMIT_PER_MINUTE,
      120,
      1,
      600
    )
  };
}

export async function runHistoricalRefreshCommand(
  config: HistoricalRefreshConfig
): Promise<HistoricalCommandResult> {
  const pythonPath = path.join(config.root, "python");
  const env = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${path.delimiter}${process.env.PYTHONPATH}` : pythonPath
  };
  const stagingDir = createHistoricalStagingDir(config.artifactDir);
  const args = historicalRefreshArgs({ ...config, artifactDir: stagingDir });

  return await new Promise<HistoricalCommandResult>((resolve, reject) => {
    execFile(
      config.python,
      args,
      {
        cwd: config.root,
        env,
        maxBuffer: 1024 * 1024,
        timeout: config.timeoutMs
      },
      (error, stdout, stderr) => {
        if (error) {
          rmSync(stagingDir, { recursive: true, force: true });
          const message = error.killed
            ? `timed out after ${config.timeoutMs}ms`
            : error.message;
          reject(new Error(`Historical refresh command failed: ${message}${stderr ? `: ${stderr}` : ""}`));
          return;
        }
        try {
          promoteHistoricalStagingDir(stagingDir, config.artifactDir);
          resolve({ stdout: promotedRefreshStdout(stdout, stagingDir, config.artifactDir), stderr });
        } catch (promoteError) {
          rmSync(stagingDir, { recursive: true, force: true });
          const message = promoteError instanceof Error ? promoteError.message : String(promoteError);
          reject(new Error(`Historical refresh artifact promotion failed: ${message}`));
        }
      }
    );
  });
}

function createHistoricalStagingDir(artifactDir: string): string {
  const parent = path.dirname(artifactDir);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, ".historical-refresh-"));
}

export function promoteHistoricalStagingDir(stagingDir: string, artifactDir: string): void {
  const backupDir = uniqueHistoricalBackupDir(artifactDir);
  let backedUp = false;

  if (existsSync(artifactDir)) {
    renameSync(artifactDir, backupDir);
    backedUp = true;
  }

  try {
    renameSync(stagingDir, artifactDir);
  } catch (error) {
    if (backedUp && !existsSync(artifactDir) && existsSync(backupDir)) {
      renameSync(backupDir, artifactDir);
    }
    throw error;
  }

  if (backedUp) {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Unable to remove previous historical artifact backup at ${backupDir}: ${errorMessage(error)}`);
    }
  }
}

function uniqueHistoricalBackupDir(artifactDir: string): string {
  const baseDir = `${artifactDir}.previous-${Date.now()}`;
  if (!existsSync(baseDir)) {
    return baseDir;
  }

  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${baseDir}-${suffix}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to allocate historical artifact backup directory for ${artifactDir}.`);
}

function promotedRefreshStdout(stdout: string, stagingDir: string, artifactDir: string): string {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return stdout;
    }
    const promoted: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      artifact_dir: artifactDir,
      staged_artifact_dir: path.basename(stagingDir),
      promoted: true
    };
    for (const key of ["dataset", "team_stats", "market_lines"]) {
      const value = promoted[key];
      if (typeof value === "string") {
        promoted[key] = promotedRefreshPath(value, stagingDir, artifactDir);
      }
    }
    return JSON.stringify(promoted);
  } catch {
    return stdout;
  }
}

function promotedRefreshPath(value: string, stagingDir: string, artifactDir: string): string {
  const relativePath = path.relative(path.resolve(stagingDir), path.resolve(value));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return value;
  }
  return path.join(artifactDir, relativePath);
}

export function historicalRefreshArgs(config: HistoricalRefreshConfig): string[] {
  const args = [
    "-m",
    "nba_historical_projection",
    "import-sportsdb",
    "--artifact-dir",
    config.artifactDir,
    "--api-key",
    config.sportsDbApiKey,
    "--recent-days",
    String(config.recentDays),
    "--lookahead-days",
    String(config.lookaheadDays)
  ];
  if (historicalEnhancementsEnabled(config)) {
    args.push(
      "--model-kind",
      "auto",
      "--calibration",
      "auto",
      "--quantiles",
      ENHANCED_HISTORICAL_QUANTILES,
      "--rating-features",
      "market",
      "--rating-line-source",
      "close",
      "--skill-features",
      "score-based",
      "--experimental-market-decorrelation"
    );
  }
  args.push("--enforce-quality-gates");
  if (config.espnTeamSchedulesEnabled) {
    args.push(
      "--espn-team-schedules",
      "--espn-lookback-seasons",
      String(config.espnLookbackSeasons),
      "--espn-rate-limit-per-minute",
      String(config.espnRateLimitPerMinute)
    );
  }
  if (config.marketTotalsEnabled) {
    args.push("--auto-market-lines", "--market-lines-max-pages", String(config.marketTotalsMaxPages));
  }
  for (const eventId of config.eventIds) {
    args.push("--event-id", eventId);
  }
  return args;
}

function historicalEnhancementsEnabled(config: HistoricalRefreshConfig): boolean {
  return config.historicalEnhancementsEnabled ?? DEFAULT_SETTINGS.historical_enhancements_enabled;
}

function parseRefreshJson(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("historical refresh output must be a JSON object");
  }
  if ("error" in parsed) {
    throw new Error(`historical refresh returned an error: ${JSON.stringify((parsed as Record<string, unknown>).error)}`);
  }
  return parsed as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
