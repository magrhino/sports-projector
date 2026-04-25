import { describe, expect, it } from "vitest";
import {
  buildEspnScoreboardUrl,
  buildEspnStandingsUrl,
  buildEspnSummaryUrl,
  buildEspnTeamScheduleUrl
} from "../src/clients/espn.js";
import {
  buildKalshiEventUrl,
  buildKalshiGameStatsUrl,
  buildKalshiLiveDataUrl,
  buildKalshiMarketUrl,
  buildKalshiMarketsUrl,
  buildKalshiMilestonesUrl,
  buildKalshiOrderbookUrl,
  buildKalshiTradesUrl
} from "../src/clients/kalshi.js";
import {
  EspnDateSchema,
  EventIdSchema,
  IsoDateSchema,
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
      buildKalshiMarketsUrl({ tickers: ["KXTEST-26APR", "KXTEST-26MAY"] }),
      buildKalshiMarketUrl("KXTEST-26APR"),
      buildKalshiEventUrl("KXEVENT-26APR", true),
      buildKalshiMilestonesUrl({ relatedEventTicker: "KXEVENT-26APR", category: "Sports", limit: 10 }),
      buildKalshiLiveDataUrl("milestone-123"),
      buildKalshiGameStatsUrl("milestone-123"),
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

  it("rejects impossible calendar dates", () => {
    expect(EspnDateSchema.parse("2024-02-29")).toBe("20240229");
    expect(EspnDateSchema.parse("20240229")).toBe("20240229");
    expect(IsoDateSchema.parse("2024-02-29")).toBe("2024-02-29");
    expect(() => EspnDateSchema.parse("20260231")).toThrow();
    expect(() => EspnDateSchema.parse("2026-99-99")).toThrow();
    expect(() => IsoDateSchema.parse("2026-02-31")).toThrow();
  });
});
