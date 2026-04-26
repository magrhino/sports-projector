import { describe, expect, it } from "vitest";
import {
  displayTeamCode,
  formatGameTimeLeft,
  formatProbability,
  formatScoreStatus,
  formatTrainingError,
  isLiveGame,
  sortGames,
  teamLogoUrl
} from "../web/src/format";

describe("web formatting helpers", () => {
  it("keeps Knicks abbreviation compatibility", () => {
    expect(displayTeamCode({ id: "18", name: "New York Knicks", abbreviation: "NY" }, "Away")).toBe("NYK");
    expect(displayTeamCode({ name: "Boston Celtics", abbreviation: "BOS" }, "Home")).toBe("BOS");
  });

  it("keeps team logo URLs limited to web image protocols", () => {
    expect(teamLogoUrl({ logo: "https://example.com/logo.png" })).toBe("https://example.com/logo.png");
    expect(teamLogoUrl({ logo: "javascript:alert(1)" })).toBe("");
  });

  it("detects and sorts live games first", () => {
    const games = sortGames([
      { id: "final", start_time: "2026-04-25T22:00:00Z", status: { state: "post", completed: true } },
      { id: "future", start_time: "2026-04-25T21:00:00Z", status: { state: "pre" } },
      { id: "live", start_time: "2026-04-25T23:00:00Z", status: { description: "In Progress" } }
    ]);

    expect(games.map((game) => game.id)).toEqual(["live", "future", "final"]);
    expect(isLiveGame(games[0])).toBe(true);
  });

  it("preserves score, period, probability, and training error formatting", () => {
    expect(
      formatScoreStatus({
        id: "401",
        teams: { away: { score: 99 }, home: { score: 101 } },
        status: { detail: "Final" }
      })
    ).toBe("99-101 | Final");
    expect(formatGameTimeLeft({ clock: "9:25", period: 4 }, {})).toBe("9:25 Q4");
    expect(formatProbability(0.534)).toBe("53%");
    expect(
      formatTrainingError({
        error: "Need at least 50 snapshots.",
        tracker: { snapshots: 10, training: { snapshots: 3 } }
      })
    ).toBe("Need at least 50 snapshots. 10 collected snapshots, 3 finalized trainable snapshots.");
  });
});
