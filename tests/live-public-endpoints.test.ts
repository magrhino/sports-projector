import { describe, expect, it } from "vitest";
import { EspnClient, type EspnTeam } from "../src/clients/espn.js";
import { KalshiClient } from "../src/clients/kalshi.js";
import { ESPN_SITE_ORIGIN, buildUrl, fetchJson } from "../src/lib/http.js";
import type { League } from "../src/lib/validation.js";

const LIVE_TESTS_ENABLED = process.env.SPORTS_PROJECTOR_LIVE_TESTS === "1";
const describeLive = LIVE_TESTS_ENABLED ? describe : describe.skip;
const LIVE_HTTP_TIMEOUT_MS = 10000;
const LIVE_TEST_TIMEOUT_MS = 15000;
const ESPN_LIVE_LEAGUES: Array<{
  league: League;
  sportPath: string;
  leaguePath: string;
}> = [
  { league: "nba", sportPath: "basketball", leaguePath: "nba" },
  { league: "nfl", sportPath: "football", leaguePath: "nfl" },
  { league: "mlb", sportPath: "baseball", leaguePath: "mlb" },
  { league: "nhl", sportPath: "hockey", leaguePath: "nhl" }
];

describeLive("live public endpoint smoke tests", () => {
  it.each(ESPN_LIVE_LEAGUES)("fetches ESPN $league scoreboard endpoint", async ({ league, sportPath, leaguePath }) => {
    const client = new EspnClient({
      env: {
        SPORTS_KALSHI_ESPN_SCOREBOARD_TTL_SECONDS: "0",
        SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS: "0"
      },
      timeoutMs: LIVE_HTTP_TIMEOUT_MS
    });

    const result = await client.getScoreboard({ league, limit: 1 });
    const sourceUrl = new URL(result.sourceUrl);
    const data = asRecord(result.data);

    expect(result.cacheStatus).toBe("bypass");
    expect(sourceUrl.origin).toBe(ESPN_SITE_ORIGIN);
    expect(sourceUrl.pathname).toBe(`/apis/site/v2/sports/${sportPath}/${leaguePath}/scoreboard`);
    expect(Array.isArray(data.events)).toBe(true);
  }, LIVE_TEST_TIMEOUT_MS);

  it.each(ESPN_LIVE_LEAGUES)("fetches ESPN $league teams endpoint", async ({ league, sportPath, leaguePath }) => {
    const client = new EspnClient({
      env: {
        SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS: "0"
      },
      timeoutMs: LIVE_HTTP_TIMEOUT_MS
    });

    const result = await client.getTeams({ league });
    const sourceUrl = new URL(result.sourceUrl);
    const data = asRecord(result.data);

    expect(result.cacheStatus).toBe("bypass");
    expect(sourceUrl.origin).toBe(ESPN_SITE_ORIGIN);
    expect(sourceUrl.pathname).toBe(`/apis/site/v2/sports/${sportPath}/${leaguePath}/teams`);
    expect(Array.isArray(data.sports)).toBe(true);
    expect(extractFirstTeam(data)).not.toBeNull();
  }, LIVE_TEST_TIMEOUT_MS);

  it.each(ESPN_LIVE_LEAGUES)("fetches ESPN $league specific team endpoint", async ({ league, sportPath, leaguePath }) => {
    const client = new EspnClient({
      env: {
        SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS: "0"
      },
      timeoutMs: LIVE_HTTP_TIMEOUT_MS
    });

    const teamsResult = await client.getTeams({ league });
    const team = extractFirstTeam(asRecord(teamsResult.data));
    expect(team).not.toBeNull();

    const url = buildUrl(ESPN_SITE_ORIGIN, [
      "apis",
      "site",
      "v2",
      "sports",
      sportPath,
      leaguePath,
      "teams",
      team?.id ?? ""
    ]);
    const data = asRecord(await fetchJson(url, { timeoutMs: LIVE_HTTP_TIMEOUT_MS }));

    expect(url.origin).toBe(ESPN_SITE_ORIGIN);
    expect(url.pathname).toBe(`/apis/site/v2/sports/${sportPath}/${leaguePath}/teams/${team?.id}`);
    expect(hasTeamResponseShape(data)).toBe(true);
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

function extractFirstTeam(data: Record<string, unknown>): EspnTeam | null {
  for (const sport of asArray(data.sports)) {
    for (const league of asArray(asRecord(sport).leagues)) {
      for (const entry of asArray(asRecord(league).teams)) {
        const team = asRecord(asRecord(entry).team);
        const id = asString(team.id);
        if (id) {
          return {
            id,
            name: asString(team.displayName) ?? id,
            abbreviation: asString(team.abbreviation) ?? id,
            location: asString(team.location) ?? undefined,
            nickname: asString(team.name) ?? undefined,
            short_name: asString(team.shortDisplayName) ?? undefined
          };
        }
      }
    }
  }
  return null;
}

function hasTeamResponseShape(data: Record<string, unknown>): boolean {
  return Array.isArray(data.sports) || Object.keys(asRecord(data.team)).length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
