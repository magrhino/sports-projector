import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

const DOCUMENTED_TOOL_NAMES = [
  "get_scoreboard",
  "get_game_summary",
  "get_team_schedule",
  "get_standings",
  "search_kalshi_markets",
  "get_kalshi_market",
  "get_kalshi_orderbook",
  "get_kalshi_trades",
  "calculate_implied_probability_from_price",
  "calculate_binary_market_spread",
  "estimate_total_score_projection",
  "compare_projection_to_market",
  "project_nba_historical_score"
] as const;

describe("sports-projector MCP server tools", () => {
  it("registers every documented tool", async () => {
    const server = createServer();
    const client = new Client({
      name: "sports-projector-test",
      version: "0.0.0"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const toolNames = tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([...DOCUMENTED_TOOL_NAMES].sort());
    } finally {
      await client.close();
      await server.close();
    }
  });
});
