import { describe, expect, it } from "vitest";
import { KalshiClient, normalizeMarkets } from "../src/clients/kalshi.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("KalshiClient.searchMarkets", () => {
  it("preserves single-page market listing when no query is provided", async () => {
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      return jsonResponse({
        cursor: "next-page",
        markets: [{ ticker: "KXNBA", title: "NBA market" }]
      });
    };
    const client = new KalshiClient({
      env: { SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0" },
      fetchImpl,
      timeoutMs: 1000
    });

    const result = await client.searchMarkets({ limit: 2, status: "open" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("limit")).toBe("2");
    expect(requests[0]?.searchParams.get("status")).toBe("open");
    expect(requests[0]?.searchParams.has("query")).toBe(false);
    expect(result.data).toEqual({
      cursor: "next-page",
      markets: [{ ticker: "KXNBA", title: "NBA market" }]
    });
  });

  it("passes explicit ticker filters to the markets endpoint", async () => {
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      return jsonResponse({
        cursor: "",
        markets: [{ ticker: "KXNBA-CELNYK-TOTAL-203", title: "NBA total market" }]
      });
    };
    const client = new KalshiClient({
      env: { SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0" },
      fetchImpl,
      timeoutMs: 1000
    });

    await client.searchMarkets({
      tickers: ["KXNBA-CELNYK-TOTAL-203", "KXNBA-CELNYK-TOTAL-204"],
      limit: 2
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("tickers")).toBe("KXNBA-CELNYK-TOTAL-203,KXNBA-CELNYK-TOTAL-204");
  });

  it("paginates query searches until enough matching markets are found", async () => {
    const requests: URL[] = [];
    const pages: Record<string, unknown> = {
      first: {
        cursor: "page-2",
        markets: [
          { ticker: "KXNHL", title: "Hockey market" },
          { ticker: "KXMLB", title: "Baseball market" }
        ]
      },
      "page-2": {
        cursor: "page-3",
        markets: [
          { ticker: "KXNBAONE", title: "NBA first market" },
          { ticker: "KXTENNIS", title: "Tennis market" }
        ]
      },
      "page-3": {
        cursor: "page-4",
        markets: [{ ticker: "KXNBATWO", title: "NBA second market" }]
      }
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      expect(url.searchParams.has("query")).toBe(false);
      return jsonResponse(pages[url.searchParams.get("cursor") ?? "first"]);
    };
    const client = new KalshiClient({
      env: { SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0" },
      fetchImpl,
      timeoutMs: 1000
    });

    const result = await client.searchMarkets({ limit: 2, query: "nba", status: "open" });
    const data = normalizeMarkets(result.data, "nba");

    expect(requests.map((url) => [url.searchParams.get("limit"), url.searchParams.get("cursor")])).toEqual([
      ["2", null],
      ["2", "page-2"],
      ["1", "page-3"]
    ]);
    expect(data.cursor).toBe("page-4");
    expect(data.markets.map((market) => market.ticker)).toEqual(["KXNBAONE", "KXNBATWO"]);
  });

  it("stops query pagination at a bounded page cap", async () => {
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      return jsonResponse({
        cursor: `page-${requests.length + 1}`,
        markets: [{ ticker: "KXNHL", title: "Hockey market" }]
      });
    };
    const client = new KalshiClient({
      env: { SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0" },
      fetchImpl,
      timeoutMs: 1000
    });

    const result = await client.searchMarkets({ limit: 3, query: "nba", status: "open" });
    const data = normalizeMarkets(result.data, "nba");

    expect(requests).toHaveLength(5);
    expect(data.count).toBe(0);
    expect(data.cursor).toBe("page-6");
  });
});
