import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger, createLoggerFromEnv } from "../src/lib/logger.js";

describe("rolling logger", () => {
  it("creates the log directory, writes JSONL records, and mirrors logs to console", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sports-projector-logger-"));
    const logDir = path.join(root, "nested", "logs");
    const consoleSink = fakeConsole();
    try {
      const logger = createLogger({
        logDir,
        console: consoleSink,
        now: () => new Date("2026-05-27T12:00:00.000Z")
      });

      logger.info("Web app starting.", {
        event: "web.starting",
        port: 8080,
        adminToken: "private",
        nested: { apiKey: "secret" }
      });
      logger.warn("Shutdown requested.", { event: "process.shutdown_signal", signal: "SIGTERM" });
      logger.error("Request failed.", { event: "http.request_unhandled_error", error: new Error("boom") });

      const lines = readLogLines(logDir);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({
        timestamp: "2026-05-27T12:00:00.000Z",
        level: "info",
        event: "web.starting",
        message: "Web app starting.",
        context: {
          port: 8080,
          adminToken: "[redacted]",
          nested: { apiKey: "[redacted]" }
        }
      });
      expect(lines[2]).toMatchObject({
        level: "error",
        event: "http.request_unhandled_error",
        error: {
          name: "Error",
          message: "boom"
        }
      });
      expect(consoleSink.info).toHaveBeenCalledTimes(1);
      expect(consoleSink.warn).toHaveBeenCalledTimes(1);
      expect(consoleSink.error).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates active logs by size and retains the configured number of files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sports-projector-logger-"));
    const consoleSink = fakeConsole();
    try {
      const logger = createLogger({
        logDir: root,
        maxBytes: 1,
        maxFiles: 2,
        console: consoleSink,
        now: () => new Date("2026-05-27T12:00:00.000Z")
      });

      for (let index = 0; index < 6; index += 1) {
        logger.info(`log ${index}`, { event: `test.${index}` });
      }

      expect(existsSync(path.join(root, "sports-projector.log"))).toBe(true);
      expect(existsSync(path.join(root, "sports-projector.1.log"))).toBe(true);
      expect(existsSync(path.join(root, "sports-projector.2.log"))).toBe(true);
      expect(existsSync(path.join(root, "sports-projector.3.log"))).toBe(false);
      expect(readLogLines(root)[0]).toMatchObject({ event: "test.5" });
      expect(readLogLines(root, "sports-projector.1.log")[0]).toMatchObject({ event: "test.4" });
      expect(readLogLines(root, "sports-projector.2.log")[0]).toMatchObject({ event: "test.3" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to safe defaults for invalid environment values", () => {
    const logger = createLoggerFromEnv(
      {
        SPORTS_PROJECTOR_LOG_MAX_BYTES: "not-a-number",
        SPORTS_PROJECTOR_LOG_MAX_FILES: "0",
        SPORTS_PROJECTOR_LOG_LEVEL: "verbose"
      } as NodeJS.ProcessEnv,
      fakeConsole()
    );

    expect(logger.status()).toMatchObject({
      file_logging_enabled: false,
      log_dir: null,
      log_file: null,
      max_bytes: 10485760,
      max_files: 5,
      level: "info",
      error: null
    });
  });
});

function fakeConsole() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function readLogLines(logDir: string, fileName = "sports-projector.log"): Record<string, unknown>[] {
  return readFileSync(path.join(logDir, fileName), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
