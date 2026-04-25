import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HistoricalProjectionClient,
  HistoricalProjectionError,
  historicalProjectionConfigFromEnv,
  parseHistoricalJson,
  timeoutMsFromEnv
} from "../src/nba/historical-client.js";
import { HistoricalProjectionInputSchema, registerHistoricalTools } from "../src/nba/historical-tool.js";
import { createServer } from "../src/mcp/server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ARTIFACT_DIR = path.join(REPO_ROOT, "fixtures", "nba-historical-linear");

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

describe("project_nba_historical_score MCP bridge", () => {
  it("returns bounded command failure diagnostics without secret values", async () => {
    const response = await callHistoricalTool(
      new HistoricalProjectionClient({
        runCommand: async () => {
          throw new HistoricalProjectionError("Historical projection command failed", "command_failed", {
            message: "Command failed: python -m nba_historical_projection predict",
            stderr: `missing manifest\nAPI_KEY=super-secret-key\n${"x".repeat(3000)}`,
            stdout: `partial output\nTOKEN=super-secret-token\n${"y".repeat(3000)}`
          });
        }
      })
    );

    expect(response.data.error).toBe("Historical projection command failed");
    expect(response.data.code).toBe("command_failed");

    const diagnostics = response.data.diagnostics as Record<string, HistoricalDiagnosticText>;
    expect(diagnostics.message.text).toContain("Command failed");
    expect(diagnostics.stderr.text).toContain("missing manifest");
    expect(diagnostics.stderr.text).toContain("API_KEY=[redacted]");
    expect(diagnostics.stderr.text).not.toContain("super-secret-key");
    expect(diagnostics.stderr.truncated).toBe(true);
    expect(Array.from(diagnostics.stderr.text).length).toBeLessThanOrEqual(diagnostics.stderr.max_chars);
    expect(diagnostics.stdout.text).toContain("partial output");
    expect(diagnostics.stdout.text).toContain("TOKEN=[redacted]");
    expect(diagnostics.stdout.text).not.toContain("super-secret-token");
    expect(diagnostics.stdout.truncated).toBe(true);
    expect(Array.from(diagnostics.stdout.text).length).toBeLessThanOrEqual(diagnostics.stdout.max_chars);
  });

  it("returns bounded invalid JSON diagnostics without secret values", async () => {
    const response = await callHistoricalTool(
      new HistoricalProjectionClient({
        runCommand: async () => ({
          stdout: `not json\nPASSWORD=hunter2\n${"z".repeat(3000)}`,
          stderr: ""
        })
      })
    );

    expect(response.data.error).toBe("Historical projection returned invalid JSON");
    expect(response.data.code).toBe("invalid_json");

    const diagnostics = response.data.diagnostics as Record<string, HistoricalDiagnosticText>;
    expect(diagnostics.message.text.toLowerCase()).toContain("json");
    expect(diagnostics.stdout.text).toContain("not json");
    expect(diagnostics.stdout.text).toContain("PASSWORD=[redacted]");
    expect(diagnostics.stdout.text).not.toContain("hunter2");
    expect(diagnostics.stdout.truncated).toBe(true);
    expect(Array.from(diagnostics.stdout.text).length).toBeLessThanOrEqual(diagnostics.stdout.max_chars);
    expect(diagnostics.stderr).toBeUndefined();
  });

  it("calls the Python CLI with the documented linear_json fixture artifacts", async () => {
    const previousEnv = {
      root: process.env.SPORTS_PROJECTOR_HISTORICAL_ROOT,
      artifactDir: process.env.SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR,
      timeoutMs: process.env.SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS
    };
    process.env.SPORTS_PROJECTOR_HISTORICAL_ROOT = REPO_ROOT;
    process.env.SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR = FIXTURE_ARTIFACT_DIR;
    process.env.SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS = "10000";

    const server = createServer();
    const client = new Client({
      name: "sports-projector-historical-fixture-test",
      version: "0.0.0"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "project_nba_historical_score",
        arguments: {
          home_team: "Boston Celtics",
          away_team: "New York Knicks",
          game_date: "2026-04-25",
          market_total: 221.5,
          market_spread: 2.5,
          days_rest_home: 3,
          days_rest_away: 1,
          include_debug: true
        }
      });

      const response = result.structuredContent as {
        source: string;
        data: Record<string, unknown>;
      };

      expect(response.source).toBe("historical");
      expect(response.data).toMatchObject({
        projected_home_score: 114,
        projected_away_score: 109.5,
        projected_total: 223.5,
        projected_home_margin: 4.5,
        game_date: "2026-04-25"
      });
      expect(response.data.teams).toEqual({
        home: "Boston Celtics",
        away: "New York Knicks"
      });
      expect(response.data.market_comparison).toMatchObject({
        market_total: 221.5,
        difference_to_market_total: 2,
        market_spread: 2.5,
        difference_to_market_spread: 2
      });
      expect(response.data.debug).toMatchObject({
        model_types: {
          total_score: "linear_json",
          home_margin: "linear_json"
        }
      });
      expect(JSON.stringify(response).toLowerCase()).not.toContain("xgboost");
    } finally {
      await client.close();
      await server.close();
      restoreEnv("SPORTS_PROJECTOR_HISTORICAL_ROOT", previousEnv.root);
      restoreEnv("SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR", previousEnv.artifactDir);
      restoreEnv("SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS", previousEnv.timeoutMs);
    }
  });
});

interface HistoricalDiagnosticText {
  text: string;
  truncated: boolean;
  max_chars: number;
}

async function callHistoricalTool(clientImpl: HistoricalProjectionClient): Promise<{
  data: Record<string, unknown>;
}> {
  const server = new McpServer({
    name: "sports-projector-historical-test",
    version: "0.0.0"
  });
  registerHistoricalTools(server, clientImpl);

  const client = new Client({
    name: "sports-projector-historical-test",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "project_nba_historical_score",
      arguments: {
        home_team: "Boston Celtics",
        away_team: "New York Knicks",
        game_date: "2026-04-25"
      }
    });

    return result.structuredContent as {
      data: Record<string, unknown>;
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
