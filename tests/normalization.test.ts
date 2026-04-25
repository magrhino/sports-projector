import { describe, expect, it } from "vitest";
import { normalizeGameSummary, normalizeScoreboard } from "../src/clients/espn.js";
import { normalizeOrderbook } from "../src/clients/kalshi.js";

describe("ESPN normalization", () => {
  it("normalizes scoreboard games", () => {
    const result = normalizeScoreboard("nba", {
      day: { date: "2026-04-24" },
      events: [
        {
          id: "401",
          name: "Away at Home",
          shortName: "AWY @ HOM",
          date: "2026-04-24T23:00Z",
          competitions: [
            {
              status: {
                displayClock: "5:12",
                period: 2,
                type: {
                  state: "in",
                  description: "In Progress",
                  completed: false
                }
              },
              venue: {
                fullName: "Example Arena",
                address: { city: "Chicago", state: "IL" }
              },
              competitors: [
                {
                  homeAway: "home",
                  score: "51",
                  team: { id: "1", displayName: "Home Team", abbreviation: "HOM" },
                  linescores: [{ period: 1, value: 25, displayValue: "25" }]
                },
                {
                  homeAway: "away",
                  score: "48",
                  team: { id: "2", displayName: "Away Team", abbreviation: "AWY" },
                  linescores: [{ period: 1, value: 24, displayValue: "24" }]
                }
              ]
            }
          ]
        }
      ]
    });

    expect(result.count).toBe(1);
    expect(result.games[0].status.period_name).toBe("quarter");
    expect(result.games[0].status.clock).toBe("5:12");
    expect(result.games[0].teams.home?.score).toBe(51);
    expect(result.games[0].venue?.name).toBe("Example Arena");
  });

  it("normalizes game summaries", () => {
    const result = normalizeGameSummary("nba", "401", {
      header: {
        id: "401",
        competitions: [
          {
            status: {
              type: {
                state: "post",
                description: "Final",
                completed: true
              }
            },
            competitors: [
              {
                homeAway: "home",
                score: "100",
                team: { id: "1", displayName: "Home Team", abbreviation: "HOM" }
              },
              {
                homeAway: "away",
                score: "90",
                team: { id: "2", displayName: "Away Team", abbreviation: "AWY" }
              }
            ]
          }
        ]
      },
      leaders: [{ name: "points" }]
    });

    expect(result.event_id).toBe("401");
    expect(result.game?.status.completed).toBe(true);
    expect(result.game?.teams.away?.score).toBe(90);
    expect(result.leaders).toHaveLength(1);
  });
});

describe("Kalshi normalization", () => {
  it("normalizes YES and NO bid orderbooks into spread fields", () => {
    const result = normalizeOrderbook({
      orderbook_fp: {
        yes_dollars: [
          ["0.4600", "100.00"],
          ["0.4400", "50.00"]
        ],
        no_dollars: [["0.5000", "100.00"]]
      }
    });

    expect(result.best_yes_bid_cents).toBe(46);
    expect(result.best_no_bid_cents).toBe(50);
    expect(result.implied_yes_ask_cents).toBe(50);
    expect(result.spread_cents).toBe(4);
    expect(result.explanation).toContain("YES bids and NO bids");
  });
});
