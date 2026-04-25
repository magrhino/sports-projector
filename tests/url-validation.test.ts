import { describe, expect, it } from "vitest";
import {
  buildEspnScoreboardUrl,
  buildEspnStandingsUrl,
  buildEspnSummaryUrl,
  buildEspnTeamScheduleUrl
} from "../src/clients/espn.js";
import {
  buildKalshiMarketUrl,
  buildKalshiMarketsUrl,
  buildKalshiOrderbookUrl,
  buildKalshiTradesUrl
} from "../src/clients/kalshi.js";
import {
  EventIdSchema,
  KalshiTickerSchema,
  LeagueSchema,
  SafeSearchTextSchema,
  TeamQuerySchema
} from "../src/lib/validation.js";

describe("URL builders", () => {
  it("builds only allowlisted ESPN URLs", () => {
    const urls = [
      buildEspnScoreboardUrl("nba", "20260424", 10),
      buildEspnSummaryUrl("nfl", "401000000"),
      buildEspnTeamScheduleUrl("mlb", "6", 2026),
      buildEspnStandingsUrl("nhl")
    ];

    for (const url of urls) {
      expect(url.origin).toBe("https://site.api.espn.com");
      expect(url.toString()).not.toContain("http://evil.test");
    }
  });

  it("builds only allowlisted Kalshi URLs", () => {
    const urls = [
      buildKalshiMarketsUrl({ limit: 10, status: "open", seriesTicker: "KXNBA" }),
      buildKalshiMarketUrl("KXTEST-26APR"),
      buildKalshiOrderbookUrl("KXTEST-26APR", 10),
      buildKalshiTradesUrl({ ticker: "KXTEST-26APR", limit: 5 })
    ];

    for (const url of urls) {
      expect(url.origin).toBe("https://api.elections.kalshi.com");
      expect(url.toString()).not.toContain("http://evil.test");
    }
  });
});

describe("input validation", () => {
  it("normalizes supported leagues", () => {
    expect(LeagueSchema.parse(" NBA ")).toBe("nba");
  });

  it("rejects unsafe user inputs", () => {
    expect(() => LeagueSchema.parse("soccer")).toThrow();
    expect(() => TeamQuerySchema.parse("https://example.com/team")).toThrow();
    expect(() => SafeSearchTextSchema.parse("http://example.com")).toThrow();
    expect(() => EventIdSchema.parse("401/evil")).toThrow();
    expect(() => KalshiTickerSchema.parse("KXTEST/evil")).toThrow();
  });
});
