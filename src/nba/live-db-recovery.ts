import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { AppLogger } from "../lib/logger.js";

export type LiveDbRecoveryMode = "auto" | "off";

export interface LiveDbRecoveryCounts {
  games: number | null;
  snapshots: number | null;
  models: number | null;
}

export type LiveDbRecoveryResult =
  | {
      status: "missing" | "healthy";
      dbPath: string;
    }
  | {
      status: "disabled";
      dbPath: string;
      error: string;
    }
  | {
      status: "recovered";
      dbPath: string;
      quarantineDir: string;
      counts: LiveDbRecoveryCounts;
    }
  | {
      status: "fresh";
      dbPath: string;
      quarantineDir: string;
      error: string;
    };

export interface PrepareLiveTrackingDatabaseOptions {
  dbPath: string;
  mode?: LiveDbRecoveryMode;
  sqliteBin?: string;
  logger?: LiveDbRecoveryLogger;
}

type LiveDbRecoveryLogger = Pick<AppLogger, "error" | "info" | "warn">;

interface DatabaseHealth {
  ok: boolean;
  missing: boolean;
  message: string | null;
}

interface QuarantinedDatabase {
  directory: string;
  dbPath: string;
}

const DEFAULT_SQLITE_BIN = "sqlite3";
const SQLITE_STDIO_MAX_BUFFER = 10 * 1024 * 1024;

export function prepareLiveTrackingDatabase(options: PrepareLiveTrackingDatabaseOptions): LiveDbRecoveryResult {
  const dbPath = options.dbPath;
  const mode = options.mode ?? "auto";
  const sqliteBin = options.sqliteBin?.trim() || DEFAULT_SQLITE_BIN;
  const logger = options.logger ?? console;
  const health = checkDatabaseHealth(dbPath);

  if (health.missing) {
    logger.info(`Live tracking database does not exist yet; creating ${dbPath}.`, {
      event: "live_db.missing",
      db_path: dbPath
    });
    return { status: "missing", dbPath };
  }

  if (health.ok) {
    logger.info(`Live tracking database passed quick_check: ${dbPath}.`, {
      event: "live_db.healthy",
      db_path: dbPath
    });
    return { status: "healthy", dbPath };
  }

  const message = health.message ?? "unknown SQLite integrity failure";
  if (mode === "off") {
    logger.warn(`Live tracking database failed quick_check and recovery is disabled: ${message}.`, {
      event: "live_db.recovery_disabled",
      db_path: dbPath,
      error: message
    });
    return { status: "disabled", dbPath, error: message };
  }

  logger.warn(`Live tracking database failed quick_check; quarantining and attempting recovery: ${message}.`, {
    event: "live_db.recovery_start",
    db_path: dbPath,
    error: message
  });
  const quarantine = quarantineDatabase(dbPath);

  try {
    const counts = recoverQuarantinedDatabase(quarantine, dbPath, sqliteBin);
    logger.warn(
      `Recovered live tracking database at ${dbPath}; snapshots=${formatCount(counts.snapshots)}, games=${formatCount(
        counts.games
      )}, models=${formatCount(counts.models)}, quarantine=${quarantine.directory}.`,
      {
        event: "live_db.recovered",
        db_path: dbPath,
        quarantine_dir: quarantine.directory,
        counts
      }
    );
    return {
      status: "recovered",
      dbPath,
      quarantineDir: quarantine.directory,
      counts
    };
  } catch (error) {
    const recoveryError = errorMessage(error);
    createEmptyDatabase(dbPath);
    logger.error(
      `Unable to recover live tracking database; starting with a fresh database at ${dbPath}. ` +
        `Original files are quarantined at ${quarantine.directory}. Recovery error: ${recoveryError}.`,
      {
        event: "live_db.recovery_failed",
        db_path: dbPath,
        quarantine_dir: quarantine.directory,
        error
      }
    );
    return {
      status: "fresh",
      dbPath,
      quarantineDir: quarantine.directory,
      error: recoveryError
    };
  }
}

function checkDatabaseHealth(dbPath: string): DatabaseHealth {
  if (!existsSync(dbPath)) {
    return { ok: false, missing: true, message: null };
  }

  const quickCheck = quickCheckDatabase(dbPath);
  return {
    ok: quickCheck.ok,
    missing: false,
    message: quickCheck.message
  };
}

function quickCheckDatabase(dbPath: string): { ok: boolean; message: string | null } {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const messages = rows.map(firstColumnValue).filter((value): value is string => value !== null);
    if (messages.length === 1 && messages[0] === "ok") {
      return { ok: true, message: null };
    }
    return {
      ok: false,
      message: messages.length > 0 ? messages.join("; ") : "PRAGMA quick_check did not return ok"
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  } finally {
    db?.close();
  }
}

function quarantineDatabase(dbPath: string): QuarantinedDatabase {
  const directory = path.dirname(dbPath);
  const baseName = path.basename(dbPath);
  const quarantineDir = uniqueQuarantineDir(directory, baseName);
  mkdirSync(quarantineDir, { recursive: false });

  let movedMainDatabase = false;
  for (const sourcePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(sourcePath)) {
      continue;
    }
    renameSync(sourcePath, path.join(quarantineDir, path.basename(sourcePath)));
    if (sourcePath === dbPath) {
      movedMainDatabase = true;
    }
  }

  if (!movedMainDatabase) {
    throw new Error(`Unable to quarantine live tracking database because ${dbPath} is missing.`);
  }

  return {
    directory: quarantineDir,
    dbPath: path.join(quarantineDir, baseName)
  };
}

function recoverQuarantinedDatabase(
  quarantine: QuarantinedDatabase,
  targetDbPath: string,
  sqliteBin: string
): LiveDbRecoveryCounts {
  const targetDir = path.dirname(targetDbPath);
  mkdirSync(targetDir, { recursive: true });
  const recoveryBase = `${path.basename(targetDbPath)}.recovery-${timestamp()}`;
  const tempSqlPath = path.join(targetDir, `${recoveryBase}.sql`);
  const tempDbPath = path.join(targetDir, `${recoveryBase}.sqlite`);

  try {
    removeDatabaseFiles(tempDbPath);
    runSqliteRecover(sqliteBin, quarantine.dbPath, tempSqlPath);
    runSqliteImport(sqliteBin, tempDbPath, tempSqlPath);

    const quickCheck = quickCheckDatabase(tempDbPath);
    if (!quickCheck.ok) {
      throw new Error(`recovered database failed quick_check: ${quickCheck.message ?? "unknown failure"}`);
    }

    const counts = liveDbCounts(tempDbPath);
    renameSync(tempDbPath, targetDbPath);
    removeDatabaseFiles(tempDbPath);
    return counts;
  } finally {
    rmSync(tempSqlPath, { force: true });
    removeDatabaseFiles(tempDbPath);
  }
}

function runSqliteRecover(sqliteBin: string, sourceDbPath: string, tempSqlPath: string): void {
  const outputFd = openSync(tempSqlPath, "w");
  try {
    const result = spawnSync(sqliteBin, [sourceDbPath, ".recover --ignore-freelist"], {
      encoding: "utf8",
      maxBuffer: SQLITE_STDIO_MAX_BUFFER,
      stdio: ["ignore", outputFd, "pipe"]
    });
    assertSqliteCommandSucceeded(result, "sqlite recover");
  } finally {
    closeSync(outputFd);
  }
}

function runSqliteImport(sqliteBin: string, targetDbPath: string, tempSqlPath: string): void {
  const inputFd = openSync(tempSqlPath, "r");
  try {
    const result = spawnSync(sqliteBin, [targetDbPath], {
      encoding: "utf8",
      maxBuffer: SQLITE_STDIO_MAX_BUFFER,
      stdio: [inputFd, "pipe", "pipe"]
    });
    assertSqliteCommandSucceeded(result, "sqlite import");
  } finally {
    closeSync(inputFd);
  }
}

function assertSqliteCommandSucceeded(result: ReturnType<typeof spawnSync>, label: string): void {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : String(result.stderr ?? "").trim();
    throw new Error(`${label} failed with exit code ${result.status}: ${stderr || "no stderr"}`);
  }
}

function liveDbCounts(dbPath: string): LiveDbRecoveryCounts {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return {
      games: tableCount(db, "live_games"),
      snapshots: tableCount(db, "live_projection_snapshots"),
      models: tableCount(db, "live_models")
    };
  } finally {
    db?.close();
  }
}

function tableCount(db: Database.Database, table: string): number | null {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { 1: number } | undefined;
  if (!exists) {
    return null;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function createEmptyDatabase(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  removeDatabaseFiles(dbPath);
  const db = new Database(dbPath);
  db.close();
}

function removeDatabaseFiles(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function uniqueQuarantineDir(directory: string, baseName: string): string {
  const baseDir = path.join(directory, `${baseName}.corrupt-${timestamp()}`);
  if (!existsSync(baseDir)) {
    return baseDir;
  }

  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${baseDir}-${suffix}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to allocate quarantine directory for ${baseName}.`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function firstColumnValue(row: Record<string, unknown>): string | null {
  const value = Object.values(row)[0];
  return typeof value === "string" ? value : value === undefined || value === null ? null : String(value);
}

function formatCount(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
