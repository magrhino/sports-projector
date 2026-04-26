import { execFile } from "node:child_process";
import path from "node:path";
import {
  historicalProjectionConfigFromEnv,
  type HistoricalProjectionConfig,
  type HistoricalCommandResult
} from "./historical-client.js";

export interface HistoricalRefreshConfig extends HistoricalProjectionConfig {
  enabled: boolean;
  intervalSeconds: number;
  recentDays: number;
  lookaheadDays: number;
  eventIds: string[];
  sportsDbApiKey: string;
}

export interface HistoricalRefreshStatus {
  enabled: boolean;
  running: boolean;
  interval_seconds: number;
  recent_days: number;
  lookahead_days: number;
  event_ids: string[];
  artifact_dir: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_result: Record<string, unknown> | null;
}

export type HistoricalRefreshRunner = (config: HistoricalRefreshConfig) => Promise<HistoricalCommandResult>;

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
    private readonly runRefresh: HistoricalRefreshRunner = runHistoricalRefreshCommand
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
      const result = await this.runRefresh(this.config);
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
    return {
      enabled: this.config.enabled,
      running: this.running,
      interval_seconds: this.config.intervalSeconds,
      recent_days: this.config.recentDays,
      lookahead_days: this.config.lookaheadDays,
      event_ids: this.config.eventIds,
      artifact_dir: this.config.artifactDir,
      last_started_at: this.lastStartedAt,
      last_finished_at: this.lastFinishedAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      last_result: this.lastResult
    };
  }
}

export function historicalRefreshConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HistoricalRefreshConfig {
  const historical = historicalProjectionConfigFromEnv(env);
  return {
    ...historical,
    enabled: parseBoolean(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED, true),
    intervalSeconds: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_INTERVAL_SECONDS, 3600, 60, 86400),
    recentDays: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_RECENT_DAYS, 3, 0, 30),
    lookaheadDays: clampInteger(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_LOOKAHEAD_DAYS, 2, 0, 30),
    eventIds: splitCsv(env.SPORTS_PROJECTOR_HISTORICAL_REFRESH_EVENT_IDS),
    sportsDbApiKey: env.SPORTS_PROJECTOR_SPORTSDB_API_KEY ?? "123"
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
  const args = historicalRefreshArgs(config);

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
          reject(new Error(`Historical refresh command failed: ${error.message}${stderr ? `: ${stderr}` : ""}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
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
  for (const eventId of config.eventIds) {
    args.push("--event-id", eventId);
  }
  return args;
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
