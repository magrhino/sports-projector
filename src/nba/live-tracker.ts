import {
  EspnClient,
  normalizeGameSummary,
  normalizeScoreboard,
  type EspnNormalizedGame,
  type EspnNormalizedTeam
} from "../clients/espn.js";
import { KalshiClient } from "../clients/kalshi.js";
import { predictLearnedProjection } from "./live-learning.js";
import { projectNbaLiveScore } from "./live-tool.js";
import { type LiveTrackingConfig, LiveTrackingStore } from "./live-tracking-store.js";

export interface LiveTrackerStatus {
  running: boolean;
  polling: boolean;
  last_poll_at: string | null;
  last_error: string | null;
  tracker: ReturnType<LiveTrackingStore["status"]>;
}

export class LiveNbaTracker {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: LiveTrackingConfig,
    private readonly store: LiveTrackingStore,
    private readonly espnClient: EspnClient,
    private readonly kalshiClient: KalshiClient
  ) {}

  start(): void {
    if (this.timer || !this.config.enabled) {
      return;
    }
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;
    this.lastPollAt = new Date().toISOString();
    try {
      const scoreboardResult = await this.espnClient.getScoreboard({ league: "nba", limit: 100 });
      const scoreboard = normalizeScoreboard("nba", scoreboardResult.data);
      const liveGames = scoreboard.games.filter((game) => game.status.state === "in");
      for (const game of scoreboard.games) {
        if (game.status.state === "in" || game.status.completed) {
          this.store.upsertGame(gameRecord(game));
        }
      }

      const eventIds = unique([...liveGames.map((game) => game.id), ...this.store.unfinalizedEventIds()]);
      await eachLimit(eventIds, this.config.concurrency, async (eventId) => {
        await this.trackEvent(eventId);
      });
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.polling = false;
    }
  }

  status(): LiveTrackerStatus {
    return {
      running: this.timer !== null,
      polling: this.polling,
      last_poll_at: this.lastPollAt,
      last_error: this.lastError,
      tracker: this.store.status(this.config.enabled, this.config.minSnapshots)
    };
  }

  private async trackEvent(eventId: string): Promise<void> {
    const model = this.store.loadLatestModel();
    const projection = await projectNbaLiveScore({ event_id: eventId, include_debug: true }, this.espnClient, this.kalshiClient);
    if (model) {
      const learnedProjection = predictLearnedProjection(model, projection);
      if (learnedProjection) {
        projection.live_projection.learned_projection = learnedProjection;
      }
    }
    this.store.recordProjectionSnapshot({
      trigger: "tracker",
      payload: projection
    });

    if (projection.game_status.completed) {
      const summary = await this.espnClient.getGameSummary({ league: "nba", eventId });
      const game = normalizeGameSummary("nba", eventId, summary.data).game;
      if (game) {
        this.store.upsertGame(gameRecord(game));
      }
    }
  }
}

export function maybeCreateLiveTracker(input: {
  config: LiveTrackingConfig;
  store: LiveTrackingStore;
  espnClient: EspnClient;
  kalshiClient: KalshiClient;
}): LiveNbaTracker | null {
  if (!input.config.enabled) {
    return null;
  }
  return new LiveNbaTracker(input.config, input.store, input.espnClient, input.kalshiClient);
}

function gameRecord(game: EspnNormalizedGame) {
  return {
    event_id: game.id,
    home_team_id: game.teams.home?.id ?? null,
    home_team_name: game.teams.home?.name ?? null,
    home_team_abbreviation: game.teams.home?.abbreviation ?? null,
    away_team_id: game.teams.away?.id ?? null,
    away_team_name: game.teams.away?.name ?? null,
    away_team_abbreviation: game.teams.away?.abbreviation ?? null,
    start_time: game.start_time,
    status_state: game.status.state,
    status_detail: game.status.detail ?? game.status.description,
    current_home_score: teamScore(game.teams.home),
    current_away_score: teamScore(game.teams.away),
    final_home_score: game.status.completed ? teamScore(game.teams.home) : null,
    final_away_score: game.status.completed ? teamScore(game.teams.away) : null,
    finalized_at: game.status.completed ? new Date().toISOString() : null
  };
}

function teamScore(team: EspnNormalizedTeam | null): number | null {
  return typeof team?.score === "number" && Number.isFinite(team.score) ? team.score : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

async function eachLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(workers);
}
