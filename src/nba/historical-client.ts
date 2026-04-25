import { execFile } from "node:child_process";
import path from "node:path";

export interface HistoricalProjectionInput {
  home_team: string;
  away_team: string;
  game_date: string;
  season?: string;
  market_total?: number;
  market_spread?: number;
  days_rest_home?: number;
  days_rest_away?: number;
  include_debug?: boolean;
}

export interface HistoricalProjectionConfig {
  python: string;
  root: string;
  artifactDir: string;
  timeoutMs: number;
}

export interface HistoricalCommandResult {
  stdout: string;
  stderr: string;
}

export type HistoricalCommandRunner = (
  command: "predict" | "validate-artifacts" | "train",
  input: Record<string, unknown>,
  config: HistoricalProjectionConfig
) => Promise<HistoricalCommandResult>;

export class HistoricalProjectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HistoricalProjectionError";
  }
}

interface HistoricalProjectionClientOptions {
  env?: NodeJS.ProcessEnv;
  runCommand?: HistoricalCommandRunner;
}

export class HistoricalProjectionClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: HistoricalCommandRunner;

  constructor(options: HistoricalProjectionClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand ?? runHistoricalPythonCommand;
  }

  async project(input: HistoricalProjectionInput): Promise<Record<string, unknown>> {
    const config = historicalProjectionConfigFromEnv(this.env);
    const result = await this.runCommand("predict", input as unknown as Record<string, unknown>, config);
    return parseHistoricalJson(result.stdout);
  }
}

export function historicalProjectionConfigFromEnv(env: NodeJS.ProcessEnv): HistoricalProjectionConfig {
  const root = env.SPORTS_PROJECTOR_HISTORICAL_ROOT ?? process.cwd();
  return {
    python: env.SPORTS_PROJECTOR_HISTORICAL_PYTHON ?? "python3",
    root,
    artifactDir: env.SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR ?? path.join(root, "data", "historical"),
    timeoutMs: timeoutMsFromEnv(env.SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS)
  };
}

export function timeoutMsFromEnv(raw: string | undefined): number {
  if (!raw) {
    return 30000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 30000;
  }
  return Math.min(120000, Math.max(1000, Math.floor(parsed)));
}

export async function runHistoricalPythonCommand(
  command: "predict" | "validate-artifacts" | "train",
  input: Record<string, unknown>,
  config: HistoricalProjectionConfig
): Promise<HistoricalCommandResult> {
  const pythonPath = path.join(config.root, "python");
  const env = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${path.delimiter}${process.env.PYTHONPATH}` : pythonPath
  };
  const args = [
    "-m",
    "nba_historical_projection",
    command,
    "--artifact-dir",
    config.artifactDir
  ];

  return await new Promise<HistoricalCommandResult>((resolve, reject) => {
    const child = execFile(
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
          reject(
            new HistoricalProjectionError("Historical projection command failed", "command_failed", {
              message: error.message,
              stderr,
              stdout
            })
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );

    child.stdin?.end(JSON.stringify(input));
  });
}

export function parseHistoricalJson(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("historical projection output must be a JSON object");
    }
    if ("error" in parsed) {
      throw new HistoricalProjectionError("Historical projection returned an error", "python_error", {
        error: (parsed as Record<string, unknown>).error
      });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HistoricalProjectionError) {
      throw error;
    }
    throw new HistoricalProjectionError("Historical projection returned invalid JSON", "invalid_json", {
      stdout,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
