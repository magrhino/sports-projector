#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sports-projector running on stdio");
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
