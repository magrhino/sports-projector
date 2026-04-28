import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore, settingsPathFromEnv } from "../src/lib/settings.js";

describe("SettingsStore", () => {
  it("uses default settings when no file exists", () => {
    const { store, cleanup } = createStore();
    try {
      expect(store.read()).toEqual(DEFAULT_SETTINGS);
    } finally {
      cleanup();
    }
  });

  it("persists validated partial updates", () => {
    const { store, cleanup } = createStore();
    try {
      const settings = store.update({
        live_enhancements_enabled: false,
        live_training_interval_seconds: 21600
      });

      expect(settings).toMatchObject({
        live_enhancements_enabled: false,
        live_training_interval_seconds: 21600
      });
      expect(store.read()).toEqual(settings);
      expect(JSON.parse(readFileSync(store.filePath, "utf8"))).toEqual(settings);
    } finally {
      cleanup();
    }
  });

  it("rejects unknown fields and invalid values", () => {
    const { store, cleanup } = createStore();
    try {
      expect(() => store.update({ unknown: true })).toThrow(/Unknown settings field/);
      expect(() => store.update({ live_training_interval_seconds: 30 })).toThrow(/between 60 and 86400/);
      expect(() => store.update({ historical_enhancements_enabled: "yes" })).toThrow(/must be a boolean/);
    } finally {
      cleanup();
    }
  });

  it("resolves the settings path from env", () => {
    expect(
      settingsPathFromEnv({
        SPORTS_PROJECTOR_HISTORICAL_ROOT: "/repo",
        SPORTS_PROJECTOR_SETTINGS_PATH: "state/settings.json"
      })
    ).toBe(path.join("/repo", "state", "settings.json"));
  });
});

function createStore(): { store: SettingsStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-settings-"));
  return {
    store: new SettingsStore(path.join(dir, "settings.json")),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
