import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SportsProjectorSettings {
  live_enhancements_enabled: boolean;
  historical_enhancements_enabled: boolean;
  live_auto_training_enabled: boolean;
  live_training_interval_seconds: number;
}

export type SportsProjectorSettingsPatch = Partial<SportsProjectorSettings>;

export const DEFAULT_SETTINGS: SportsProjectorSettings = {
  live_enhancements_enabled: true,
  historical_enhancements_enabled: true,
  live_auto_training_enabled: true,
  live_training_interval_seconds: 3600
};

const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const MIN_LIVE_TRAINING_INTERVAL_SECONDS = 60;
const MAX_LIVE_TRAINING_INTERVAL_SECONDS = 86400;

export class SettingsStore {
  constructor(readonly filePath: string = settingsPathFromEnv()) {}

  read(): SportsProjectorSettings {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isNotFound(error)) {
        return defaultSettings();
      }
      throw new Error(`Unable to read settings: ${errorMessage(error)}`);
    }

    return normalizeSettings(settingsPayload(parsed));
  }

  update(patch: unknown): SportsProjectorSettings {
    const validatedPatch = validateSettingsPatch(patch);
    const next = normalizeSettings({
      ...this.read(),
      ...validatedPatch
    });
    this.write(next);
    return next;
  }

  private write(settings: SportsProjectorSettings): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

export function settingsPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SPORTS_PROJECTOR_HISTORICAL_ROOT ?? process.cwd();
  return path.resolve(root, env.SPORTS_PROJECTOR_SETTINGS_PATH ?? "data/settings.json");
}

export function defaultSettings(): SportsProjectorSettings {
  return { ...DEFAULT_SETTINGS };
}

export function validateSettingsPatch(value: unknown): SportsProjectorSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings update must be a JSON object.");
  }

  const input = value as Record<string, unknown>;
  const patch: SportsProjectorSettingsPatch = {};
  for (const key of Object.keys(input)) {
    if (!SETTINGS_KEYS.has(key)) {
      throw new Error(`Unknown settings field: ${key}`);
    }
  }

  if ("live_enhancements_enabled" in input) {
    patch.live_enhancements_enabled = booleanSetting(input.live_enhancements_enabled, "live_enhancements_enabled");
  }
  if ("historical_enhancements_enabled" in input) {
    patch.historical_enhancements_enabled = booleanSetting(
      input.historical_enhancements_enabled,
      "historical_enhancements_enabled"
    );
  }
  if ("live_auto_training_enabled" in input) {
    patch.live_auto_training_enabled = booleanSetting(input.live_auto_training_enabled, "live_auto_training_enabled");
  }
  if ("live_training_interval_seconds" in input) {
    patch.live_training_interval_seconds = intervalSetting(input.live_training_interval_seconds);
  }

  return patch;
}

function settingsPayload(value: unknown): unknown {
  const record = asRecord(value);
  return "settings" in record ? record.settings : value;
}

function normalizeSettings(value: unknown): SportsProjectorSettings {
  const input = asRecord(value);
  return {
    live_enhancements_enabled:
      typeof input.live_enhancements_enabled === "boolean"
        ? input.live_enhancements_enabled
        : DEFAULT_SETTINGS.live_enhancements_enabled,
    historical_enhancements_enabled:
      typeof input.historical_enhancements_enabled === "boolean"
        ? input.historical_enhancements_enabled
        : DEFAULT_SETTINGS.historical_enhancements_enabled,
    live_auto_training_enabled:
      typeof input.live_auto_training_enabled === "boolean"
        ? input.live_auto_training_enabled
        : DEFAULT_SETTINGS.live_auto_training_enabled,
    live_training_interval_seconds:
      typeof input.live_training_interval_seconds === "number"
        ? intervalSetting(input.live_training_interval_seconds)
        : DEFAULT_SETTINGS.live_training_interval_seconds
  };
}

function booleanSetting(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }
  return value;
}

function intervalSetting(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("live_training_interval_seconds must be an integer.");
  }
  if (value < MIN_LIVE_TRAINING_INTERVAL_SECONDS || value > MAX_LIVE_TRAINING_INTERVAL_SECONDS) {
    throw new Error(
      `live_training_interval_seconds must be between ${MIN_LIVE_TRAINING_INTERVAL_SECONDS} and ${MAX_LIVE_TRAINING_INTERVAL_SECONDS}.`
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
