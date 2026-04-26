import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EspnClient } from "../src/clients/espn.js";
import type { KalshiClient } from "../src/clients/kalshi.js";
import { LiveNbaTracker } from "../src/nba/live-tracker.js";
import { LiveTrackingStore, type LiveTrackingConfig } from "../src/nba/live-tracking-store.js";

describe("LiveTrackingStore", () => {
  it("creates schema, stores snapshots, finalizes games, and stores trained models", () => {
    const { store, cleanup } = createStore();
    try {
      const first = projectionPayload({ eventId: "401", homeScore: 83, awayScore: 78, projectedTotal: 202 });
      const second = projectionPayload({ eventId: "401", homeScore: 90, awayScore: 88, projectedTotal: 214 });
      store.recordProjectionSnapshot({ trigger: "tracker", payload: first });
      store.recordProjectionSnapshot({ trigger: "tracker", payload: second });
      store.upsertGame({
        event_id: "401",
        final_home_score: 101,
        final_away_score: 99,
        status_state: "post",
        finalized_at: "2026-04-26T02:00:00Z"
      });

      const result = store.trainLatestModel(2);
      const status = store.status(true);

      expect(status.snapshots).toBe(2);
      expect(status.training.snapshots).toBe(2);
      expect(status.games.finalized).toBe(1);
      expect(result.model.sample_count).toBe(2);
      expect(store.loadLatestModel()?.sample_count).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("does not store non-live projection snapshots", () => {
    const { store, cleanup } = createStore();
    try {
      store.recordProjectionSnapshot({
        trigger: "user",
        payload: projectionPayload({
          eventId: "402",
          homeScore: 0,
          awayScore: 0,
          projectedTotal: 203,
          state: "pre"
        })
      });
      store.recordProjectionSnapshot({
        trigger: "user",
        payload: projectionPayload({
          eventId: "403",
          homeScore: 101,
          awayScore: 99,
          projectedTotal: 200,
          state: "post",
          completed: true
        })
      });

      const status = store.status(true);
      expect(status.snapshots).toBe(0);
      expect(status.training.snapshots).toBe(0);
      expect(status.games.tracked).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("LiveNbaTracker", () => {
  it("discovers live NBA games, records market snapshots, and finalizes completed games", async () => {
    const { store, cleanup } = createStore();
    try {
      const tracker = new LiveNbaTracker(
        {
          enabled: true,
          dbPath: store.dbPath,
          intervalSeconds: 30,
          concurrency: 2,
          minSnapshots: 50
        },
        store,
        espnClientDouble(),
        kalshiClientDouble()
      );

      await tracker.poll();
      await tracker.poll();
      const status = store.status(true);

      expect(status.snapshots).toBeGreaterThanOrEqual(1);
      expect(status.latest_snapshot?.selected_market_ticker).toBe("KXNBA-CELNYK-TOTAL-203");
      expect(status.games.finalized).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("skips overlapping polls", async () => {
    const { store, cleanup } = createStore();
    try {
      let scoreboardCalls = 0;
      let release: (() => void) | null = null;
      const espnClient = {
        async getScoreboard() {
          scoreboardCalls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            cacheStatus: "bypass" as const,
            sourceUrl: "espn-scoreboard",
            data: scoreboardFixture(false)
          };
        }
      } as EspnClient;
      const tracker = new LiveNbaTracker(config(store), store, espnClient, kalshiClientDouble());

      const firstPoll = tracker.poll();
      await tracker.poll();
      release?.();
      await firstPoll;

      expect(scoreboardCalls).toBe(1);
    } finally {
      cleanup();
    }
  });
});

function createStore(): { store: LiveTrackingStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sports-projector-live-"));
  const store = new LiveTrackingStore(path.join(dir, "nba-live.sqlite"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function config(store: LiveTrackingStore): LiveTrackingConfig {
  return {
    enabled: true,
    dbPath: store.dbPath,
    intervalSeconds: 30,
    concurrency: 2,
    minSnapshots: 50
  };
}

function espnClientDouble(): EspnClient {
  let scoreboardCompleted = false;
  let summaryCompleted = false;
  return {
    async getScoreboard() {
      const data = scoreboardFixture(scoreboardCompleted);
      summaryCompleted = scoreboardCompleted;
      scoreboardCompleted = true;
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "espn-scoreboard",
        data
      };
    },
    async getGameSummary() {
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "espn-summary",
        data: espnSummaryFixture({ completed: summaryCompleted })
      };
    }
  } as EspnClient;
}

function kalshiClientDouble(): KalshiClient {
  return {
    async searchMarkets() {
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "kalshi-markets",
        data: {
          markets: [marketFixture()],
          cursor: ""
        }
      };
    },
    async getMilestones() {
      return {
        cacheStatus: "bypass" as const,
        sourceUrl: "kalshi-milestones",
        data: {
          milestones: [],
          cursor: ""
        }
      };
    }
  } as KalshiClient;
}

function projectionPayload(input: {
  eventId: string;
  homeScore: number;
  awayScore: number;
  projectedTotal: number;
  state?: string;
  completed?: boolean;
}) {
  const state = input.state ?? "in";
  const completed = input.completed ?? false;
  return {
    event_id: input.eventId,
    teams: {
      home: { id: "2", name: "Boston Celtics", abbreviation: "BOS", score: input.homeScore },
      away: { id: "18", name: "New York Knicks", abbreviation: "NY", score: input.awayScore }
    },
    game_status: {
      state,
      description: completed ? "Final" : state === "pre" ? "Scheduled" : "In Progress",
      detail: completed ? "Final" : state === "pre" ? "7:00 PM" : "9:25 - 4th Quarter",
      completed,
      period: 4,
      clock: completed ? "0.0" : "9:25"
    },
    live_projection: {
      projected_home_score: Math.round(input.projectedTotal / 2 + 3),
      projected_away_score: Math.round(input.projectedTotal / 2 - 3),
      projected_total: input.projectedTotal,
      projected_remaining_points: input.projectedTotal - input.homeScore - input.awayScore,
      market_total_line: 203,
      difference_vs_market: input.projectedTotal - 203,
      p_over: 0.5,
      relationship_to_market: "near_market",
      model_inputs: {
        current_home_score: input.homeScore,
        current_away_score: input.awayScore,
        period: 4,
        clock: "9:25",
        recent_points: null,
        recent_minutes: null,
        home_fouls_period: null,
        away_fouls_period: null,
        is_playoffs: true
      },
      data_quality: {
        market_line_source: "auto_search",
        selected_market_ticker: "KXNBA-CELNYK-TOTAL-203"
      },
      debug: {
        selected_market: {
          market: marketFixture(),
          line: 203
        },
        model_details: {
          elapsed_minutes: 38.58,
          minutes_left: 9.42,
          margin: Math.abs(input.homeScore - input.awayScore),
          full_game_rate: 4.17,
          prior_rate: 4.23,
          recent_rate: 4.17,
          blended_rate: 4.2
        }
      },
      source_urls: {}
    }
  };
}

function scoreboardFixture(completed: boolean) {
  return {
    events: [
      {
        id: "401",
        name: "New York Knicks at Boston Celtics",
        shortName: "NY @ BOS",
        date: "2026-04-25T23:00:00Z",
        competitions: [competitionFixture(completed)]
      }
    ]
  };
}

function espnSummaryFixture(input: { completed: boolean }) {
  return {
    header: {
      id: "401",
      name: "New York Knicks at Boston Celtics",
      shortName: "NY @ BOS",
      competitions: [competitionFixture(input.completed)]
    }
  };
}

function competitionFixture(completed: boolean) {
  return {
    date: "2026-04-25T23:00:00Z",
    status: {
      displayClock: completed ? "0.0" : "9:25",
      period: completed ? 4 : 4,
      type: {
        state: completed ? "post" : "in",
        description: completed ? "Final" : "In Progress",
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
  };
}

function marketFixture() {
  return {
    ticker: "KXNBA-CELNYK-TOTAL-203",
    title: "Boston Celtics and New York Knicks total points",
    yes_sub_title: "At least 203 points",
    event_ticker: "KXNBA-CELNYK",
    series_ticker: "KXNBATOTAL",
    status: "open",
    floor_strike: 203,
    yes_bid_cents: 49,
    yes_ask_cents: 51,
    no_bid_cents: 49,
    no_ask_cents: 51,
    last_price_cents: 50
  };
}
