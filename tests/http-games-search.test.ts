import { describe, expect, it } from "vitest";
import { getLiveGames, searchGamesByTeam } from "../src/http/games-search.js";

describe("searchGamesByTeam", () => {
  it("returns normalized ESPN games for a valid team search", async () => {
    const client = {
      async getTeamSchedule(input: { league: "nba"; team: string; season?: number }) {
        expect(input).toEqual({ league: "nba", team: "celts" });
        return {
          cacheStatus: "bypass" as const,
          sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/schedule",
          data: {
            resolved_team: {
              id: "2",
              name: "Boston Celtics",
              abbreviation: "BOS",
              location: "Boston",
              nickname: "Celtics",
              short_name: "Celtics"
            },
            schedule: {
              events: [
                {
                  id: "401",
                  name: "Boston Celtics at New York Knicks",
                  shortName: "BOS @ NY",
                  date: "2026-04-25T23:00:00Z",
                  competitions: [
                    {
                      status: {
                        period: 4,
                        displayClock: "0.0",
                        type: {
                          state: "post",
                          description: "Final",
                          completed: true
                        }
                      },
                      competitors: [
                        {
                          homeAway: "home",
                          score: "101",
                          team: { id: "18", displayName: "New York Knicks", abbreviation: "NY" }
                        },
                        {
                          homeAway: "away",
                          score: "108",
                          team: { id: "2", displayName: "Boston Celtics", abbreviation: "BOS" }
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        };
      }
    };

    const result = await searchGamesByTeam(new URLSearchParams({ team: "celts" }), client);

    expect(result.status).toBe(200);
    expect(result.body.source).toBe("espn");
    expect(result.body.team?.name).toBe("Boston Celtics");
    expect(result.body.count).toBe(1);
    expect(result.body.games?.[0]?.teams.away?.name).toBe("Boston Celtics");
    expect(result.body.games?.[0]?.teams.home?.score).toBe(101);
  });

  it("returns 400 when team is missing", async () => {
    const result = await searchGamesByTeam(new URLSearchParams(), {
      async getTeamSchedule() {
        throw new Error("should not be called");
      }
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/team/i);
  });

  it("returns 400 when league is invalid", async () => {
    const result = await searchGamesByTeam(new URLSearchParams({ team: "Celtics", league: "soccer" }), {
      async getTeamSchedule() {
        throw new Error("should not be called");
      }
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/league|enum/i);
  });

  it("returns 404 when ESPN cannot resolve the team", async () => {
    const result = await searchGamesByTeam(new URLSearchParams({ team: "Not A Team", league: "nba" }), {
      async getTeamSchedule() {
        throw new Error('Could not resolve ESPN team "Not A Team" for NBA');
      }
    });

    expect(result.status).toBe(404);
    expect(result.body.error).toMatch(/Could not resolve ESPN team/);
  });

  it("returns all live ESPN scoreboard games for the selected league", async () => {
    const result = await getLiveGames(new URLSearchParams({ league: "nba" }), {
      async getScoreboard(input: { league: "nba"; limit?: number }) {
        expect(input).toEqual({ league: "nba", limit: 100 });
        return {
          cacheStatus: "bypass" as const,
          sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=100",
          data: {
            day: {
              date: "2026-04-25"
            },
            events: [
              scoreboardEvent("401", "in", false),
              scoreboardEvent("402", "pre", false),
              scoreboardEvent("403", "post", true)
            ]
          }
        };
      }
    });

    expect(result.status).toBe(200);
    expect(result.body.league).toBe("nba");
    expect(result.body.count).toBe(1);
    expect(result.body.games?.map((game) => game.id)).toEqual(["401"]);
  });
});

function scoreboardEvent(id: string, state: string, completed: boolean) {
  return {
    id,
    name: "New York Knicks at Boston Celtics",
    shortName: "NY @ BOS",
    date: "2026-04-25T23:00:00Z",
    competitions: [
      {
        status: {
          period: 4,
          displayClock: completed ? "0.0" : "9:25",
          type: {
            state,
            description: completed ? "Final" : state === "pre" ? "Scheduled" : "In Progress",
            completed
          }
        },
        competitors: [
          {
            homeAway: "home",
            score: completed ? "101" : "83",
            team: { id: "2", displayName: "Boston Celtics", abbreviation: "BOS" }
          },
          {
            homeAway: "away",
            score: completed ? "99" : "78",
            team: { id: "18", displayName: "New York Knicks", abbreviation: "NY" }
          }
        ]
      }
    ]
  };
}
