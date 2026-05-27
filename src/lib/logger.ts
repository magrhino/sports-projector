import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogContext = Record<string, unknown>;

export interface AppLogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  flush(): void;
  status(): LoggerStatus;
}

export interface LoggerStatus {
  file_logging_enabled: boolean;
  log_dir: string | null;
  log_file: string | null;
  max_bytes: number;
  max_files: number;
  level: LogLevel;
  error: string | null;
}

export interface LoggerOptions {
  logDir?: string | null;
  maxBytes?: number;
  maxFiles?: number;
  level?: LogLevel;
  console?: ConsoleSink;
  now?: () => Date;
}

interface ConsoleSink {
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  context?: unknown;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_LEVEL: LogLevel = "info";
const LOG_FILE_NAME = "sports-projector.log";
const LEVEL_PRIORITIES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};
const SECRET_KEY_PATTERN = /(authorization|cookie|credential|key|password|secret|token)/i;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;

export function createLoggerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  consoleSink: ConsoleSink = console
): AppLogger {
  return createLogger({
    logDir: env.SPORTS_PROJECTOR_LOG_DIR,
    maxBytes: positiveIntegerFromEnv(env.SPORTS_PROJECTOR_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxFiles: positiveIntegerFromEnv(env.SPORTS_PROJECTOR_LOG_MAX_FILES, DEFAULT_MAX_FILES),
    level: logLevelFromEnv(env.SPORTS_PROJECTOR_LOG_LEVEL, DEFAULT_LEVEL),
    console: consoleSink
  });
}

export function createLogger(options: LoggerOptions = {}): AppLogger {
  return new RollingLogger(options);
}

export const noopLogger: AppLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
  status() {
    return {
      file_logging_enabled: false,
      log_dir: null,
      log_file: null,
      max_bytes: DEFAULT_MAX_BYTES,
      max_files: DEFAULT_MAX_FILES,
      level: DEFAULT_LEVEL,
      error: null
    };
  }
};

class RollingLogger implements AppLogger {
  private readonly console: ConsoleSink;
  private readonly now: () => Date;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly logDir: string | null;
  private readonly logFile: string | null;
  private fileError: string | null = null;
  private fileErrorReported = false;

  constructor(options: LoggerOptions) {
    this.console = options.console ?? console;
    this.now = options.now ?? (() => new Date());
    this.level = options.level ?? DEFAULT_LEVEL;
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    const configuredLogDir = options.logDir?.trim();
    this.logDir = configuredLogDir ? path.resolve(configuredLogDir) : null;
    this.logFile = this.logDir ? path.join(this.logDir, LOG_FILE_NAME) : null;

    if (this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch (error) {
        this.fileError = errorMessage(error);
      }
    }
  }

  debug(message: string, context: LogContext = {}): void {
    this.write("debug", message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.write("info", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write("warn", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write("error", message, context);
  }

  fatal(message: string, context: LogContext = {}): void {
    this.write("fatal", message, context);
  }

  flush(): void {
    // File writes are synchronous so there is no buffered application state to flush.
  }

  status(): LoggerStatus {
    return {
      file_logging_enabled: this.logFile !== null && this.fileError === null,
      log_dir: this.logDir,
      log_file: this.logFile,
      max_bytes: this.maxBytes,
      max_files: this.maxFiles,
      level: this.level,
      error: this.fileError
    };
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_PRIORITIES[level] < LEVEL_PRIORITIES[this.level]) {
      return;
    }

    const { event, error, context: safeContext } = recordParts(context);
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      event,
      message
    };
    if (error) {
      record.error = errorData(error);
    }
    if (safeContext !== undefined) {
      record.context = safeContext;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.writeConsole(level, line.trimEnd());
    this.writeFile(line);
  }

  private writeConsole(level: LogLevel, line: string): void {
    if (level === "warn") {
      this.console.warn(line);
      return;
    }
    if (level === "error" || level === "fatal") {
      this.console.error(line);
      return;
    }
    this.console.info(line);
  }

  private writeFile(line: string): void {
    if (!this.logFile || this.fileError) {
      this.reportFileError();
      return;
    }

    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.logFile, line, "utf-8");
    } catch (error) {
      this.fileError = errorMessage(error);
      this.reportFileError();
    }
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!this.logFile || !existsSync(this.logFile)) {
      return;
    }
    const size = statSync(this.logFile).size;
    if (size + nextBytes <= this.maxBytes) {
      return;
    }

    const oldest = rotatedPath(this.logFile, this.maxFiles);
    rmSync(oldest, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = rotatedPath(this.logFile, index);
      if (existsSync(source)) {
        renameSync(source, rotatedPath(this.logFile, index + 1));
      }
    }
    renameSync(this.logFile, rotatedPath(this.logFile, 1));
  }

  private reportFileError(): void {
    if (!this.fileError || this.fileErrorReported) {
      return;
    }
    this.fileErrorReported = true;
    this.console.error(
      JSON.stringify({
        timestamp: this.now().toISOString(),
        level: "error",
        event: "logger.file_unavailable",
        message: "File logging is unavailable.",
        context: {
          log_dir: this.logDir,
          error: this.fileError
        }
      })
    );
  }
}

function recordParts(context: LogContext): { event: string; error: unknown; context: unknown } {
  const event = typeof context.event === "string" && context.event.trim() ? context.event : "app.log";
  const { event: _event, error, ...rest } = context;
  const safeContext = sanitize(rest);
  return {
    event,
    error,
    context: safeContext
  };
}

function errorData(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return {
    name: "Error",
    message: String(error)
  };
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return errorData(value);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitize(entry, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitize(entry, depth + 1);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function positiveIntegerFromEnv(rawValue: string | undefined, fallback: number): number {
  return positiveInteger(Number(rawValue), fallback);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function logLevelFromEnv(rawValue: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = rawValue?.trim().toLowerCase();
  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
      return normalized;
    default:
      return fallback;
  }
}

function rotatedPath(logFile: string, index: number): string {
  return `${logFile.slice(0, -path.extname(logFile).length)}.${index}${path.extname(logFile)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
