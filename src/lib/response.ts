import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CacheStatus } from "./cache.js";

export interface ResearchToolResponse<TData> {
  source: "espn" | "kalshi" | "calculation" | "historical";
  fetched_at: string;
  source_url: string | null;
  cache_status: CacheStatus;
  summary: string;
  data: TData;
  caveats: string[];
}

export function makeResponse<TData>(response: ResearchToolResponse<TData>): CallToolResult {
  return {
    structuredContent: response as unknown as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: `${response.summary}\n\n${JSON.stringify(response, null, 2)}`
      }
    ]
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
