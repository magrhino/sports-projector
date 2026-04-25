import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EspnClient } from "../clients/espn.js";
import { KalshiClient } from "../clients/kalshi.js";
import { HistoricalProjectionClient } from "../nba/historical-client.js";
import { registerHistoricalTools } from "../nba/historical-tool.js";
import { registerLiveProjectionTools } from "../nba/live-tool.js";
import { registerCalculationTools } from "../tools/calculations.js";
import { registerEspnTools } from "../tools/espn.js";
import { registerKalshiTools } from "../tools/kalshi.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "sports-projector",
    version: "0.1.0"
  });
  const espnClient = new EspnClient();
  const kalshiClient = new KalshiClient();

  registerEspnTools(server, espnClient);
  registerKalshiTools(server, kalshiClient);
  registerCalculationTools(server);
  registerHistoricalTools(server, new HistoricalProjectionClient());
  registerLiveProjectionTools(server, espnClient, kalshiClient);

  return server;
}
