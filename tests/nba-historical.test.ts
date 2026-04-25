import { describe, expect, it } from "vitest";
import {
  HistoricalProjectionClient,
  HistoricalProjectionError,
  historicalProjectionConfigFromEnv,
  parseHistoricalJson,
  timeoutMsFromEnv
} from "../src/nba/historical-client.js";
import { HistoricalProjectionInputSchema } from "../src/nba/historical-tool.js";

describe("HistoricalProjectionInputSchema", () => {
  it("validates historical projection input", () => {
    const parsed = HistoricalProjectionInputSchema.parse({
      home_team: "Boston Celtics",
      away_team: "New York Knicks",
      game_date: "2026-04-25",
      market_total: 221.5,
      days_rest_home: 2
    });

    expect(parsed.include_debug).toBe(false);
    expect(parsed.home_team).toBe("Boston Celtics");
  });

  it("rejects unsafe teams and malformed dates", () => {
    expect(() =>
      HistoricalProjectionInputSchema.parse({
        home_team: "https://example.com/team",
        away_team: "New York Knicks",
        game_date: "2026-04-25"
      })
    ).toThrow();
    expect(() =>
      HistoricalProjectionInputSchema.parse({
        home_team: "Boston Celtics",
        away_team: "New York Knicks",
        game_date: "20260425"
      })
    ).toThrow();
  });
});

describe("HistoricalProjectionClient", () => {
  it("returns parsed projection output from the Python bridge", async () => {
    const client = new HistoricalProjectionClient({
      env: { SPORTS_PROJECTOR_HISTORICAL_ROOT: "/repo" },
      runCommand: async (_command, input, config) => {
        expect(config.root).toBe("/repo");
        expect(input.home_team).toBe("Boston Celtics");
        return {
          stdout: JSON.stringify({
            projected_home_score: 112.1,
            projected_away_score: 108.4,
            projected_total: 220.5,
            projected_home_margin: 3.7
          }),
          stderr: ""
        };
      }
    });

    await expect(
      client.project({
        home_team: "Boston Celtics",
        away_team: "New York Knicks",
        game_date: "2026-04-25"
      })
    ).resolves.toMatchObject({
      projected_total: 220.5,
      projected_home_margin: 3.7
    });
  });

  it("surfaces invalid bridge JSON as structured errors", () => {
    expect(() => parseHistoricalJson("not json")).toThrow(HistoricalProjectionError);
    try {
      parseHistoricalJson("not json");
    } catch (error) {
      expect(error).toBeInstanceOf(HistoricalProjectionError);
      expect((error as HistoricalProjectionError).code).toBe("invalid_json");
    }
  });

  it("preserves command failures from the bridge runner", async () => {
    const client = new HistoricalProjectionClient({
      runCommand: async () => {
        throw new HistoricalProjectionError("Historical projection command failed", "command_failed", {
          stderr: "missing manifest"
        });
      }
    });

    await expect(
      client.project({
        home_team: "Boston Celtics",
        away_team: "New York Knicks",
        game_date: "2026-04-25"
      })
    ).rejects.toMatchObject({ code: "command_failed" });
  });

  it("treats Python error payloads as errors", () => {
    expect(() =>
      parseHistoricalJson(JSON.stringify({ error: { type: "ArtifactError", message: "missing model" } }))
    ).toThrow(HistoricalProjectionError);
  });

  it("parses environment defaults safely", () => {
    expect(timeoutMsFromEnv(undefined)).toBe(30000);
    expect(timeoutMsFromEnv("bad")).toBe(30000);
    expect(timeoutMsFromEnv("5")).toBe(1000);
    expect(timeoutMsFromEnv("999999")).toBe(120000);

    expect(
      historicalProjectionConfigFromEnv({
        SPORTS_PROJECTOR_HISTORICAL_ROOT: "/repo",
        SPORTS_PROJECTOR_HISTORICAL_PYTHON: "/usr/bin/python3",
        SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR: "/artifacts",
        SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS: "2000"
      })
    ).toEqual({
      python: "/usr/bin/python3",
      root: "/repo",
      artifactDir: "/artifacts",
      timeoutMs: 2000
    });
  });

  it("does not include betting-action terms in projection payloads", () => {
    const text = JSON.stringify({
      projected_home_score: 112,
      projected_away_score: 109,
      caveats: [
        "Informational projection only.",
        "Live in-game state is not included in this historical model."
      ]
    }).toLowerCase();

    expect(text).not.toContain("kelly");
    expect(text).not.toContain("stake");
    expect(text).not.toContain("wager");
    expect(text).not.toContain("bet ");
    expect(text).not.toContain("recommend");
  });
});
