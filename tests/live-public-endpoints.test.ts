import { describe, expect, it } from "vitest";
import { EspnClient } from "../src/clients/espn.js";
import { KalshiClient } from "../src/clients/kalshi.js";

const LIVE_TESTS_ENABLED = process.env.SPORTS_PROJECTOR_LIVE_TESTS === "1";
const describeLive = LIVE_TESTS_ENABLED ? describe : describe.skip;
const LIVE_HTTP_TIMEOUT_MS = 10000;
const LIVE_TEST_TIMEOUT_MS = 15000;

describeLive("live public endpoint smoke tests", () => {
  it("fetches a minimal ESPN public teams response through EspnClient", async () => {
    const client = new EspnClient({
      env: {
        SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS: "0"
      },
      timeoutMs: LIVE_HTTP_TIMEOUT_MS
    });

    const result = await client.getTeams({ league: "nba" });
    const sourceUrl = new URL(result.sourceUrl);
    const data = asRecord(result.data);

    expect(result.cacheStatus).toBe("bypass");
    expect(sourceUrl.origin).toBe("https://site.api.espn.com");
    expect(sourceUrl.pathname).toBe("/apis/site/v2/sports/basketball/nba/teams");
    expect(Array.isArray(data.sports)).toBe(true);
  }, LIVE_TEST_TIMEOUT_MS);

  it("fetches a minimal Kalshi public markets response through KalshiClient", async () => {
    const client = new KalshiClient({
      env: {
        SPORTS_KALSHI_KALSHI_TTL_SECONDS: "0"
      },
      timeoutMs: LIVE_HTTP_TIMEOUT_MS
    });

    const result = await client.searchMarkets({ limit: 1 });
    const sourceUrl = new URL(result.sourceUrl);
    const data = asRecord(result.data);

    expect(result.cacheStatus).toBe("bypass");
    expect(sourceUrl.origin).toBe("https://api.elections.kalshi.com");
    expect(sourceUrl.pathname).toBe("/trade-api/v2/markets");
    expect(sourceUrl.searchParams.get("limit")).toBe("1");
    expect(Array.isArray(data.markets)).toBe(true);
  }, LIVE_TEST_TIMEOUT_MS);
});

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}
