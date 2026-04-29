export type League = "nba" | "nfl" | "mlb" | "nhl";

export type Team = {
  id?: string;
  name?: string;
  abbreviation?: string;
  logo?: string | null;
  score?: number | string | null;
};

export type GameStatus = {
  state?: string;
  description?: string;
  detail?: string;
  completed?: boolean;
  period?: number;
  clock?: string;
};

export type Game = {
  id: string;
  name?: string;
  short_name?: string;
  start_time?: string;
  status?: GameStatus;
  teams?: {
    away?: Team;
    home?: Team;
  };
};

export type GameSearchResponse = {
  team?: {
    name?: string;
  };
  games?: Game[];
  source?: string;
};

export type LiveGamesResponse = {
  games?: Game[];
};

export type ProjectionSection =
  | {
      status: "ok";
      data?: Record<string, unknown>;
      error?: never;
    }
  | {
      status: "error";
      error?: string;
      data?: never;
    };

export type ProjectionPayload = {
  event_id?: string;
  fetched_at?: string;
  game?: Game;
  live_projection?: ProjectionSection;
  historical_projection?: ProjectionSection;
};

export type TrackerStatusPayload = {
  running?: boolean;
  polling?: boolean;
  last_poll_at?: string | null;
  last_error?: string | null;
  auto_training?: LiveAutoTrainingStatus;
  tracker?: {
    enabled?: boolean;
    snapshots?: number;
    latest_snapshot?: {
      market_total_line?: number | null;
    } | null;
    games?: {
      live?: number;
    };
    model?: {
      trained_at?: string;
      sample_count?: number;
      game_count?: number | null;
      effective_sample_count?: number | null;
      metrics?: Record<string, unknown>;
    } | null;
    training?: {
      ready?: boolean;
      snapshots?: number;
      effective_snapshots?: number;
      games?: number;
      min_snapshots?: number;
    };
  };
};

export type ProjectorSettings = {
  live_enhancements_enabled: boolean;
  historical_enhancements_enabled: boolean;
  live_auto_training_enabled: boolean;
  live_training_interval_seconds: number;
};

export type SettingsPayload = {
  settings: ProjectorSettings;
  defaults: ProjectorSettings;
};

export type LiveAutoTrainingStatus = {
  enabled?: boolean;
  running?: boolean;
  interval_seconds?: number;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_success_at?: string | null;
  last_skip_reason?: string | null;
  last_error?: string | null;
  last_trained_sample_count?: number | null;
};

export type HistoricalRefreshStatusPayload = {
  enabled?: boolean;
  running?: boolean;
  interval_seconds?: number;
  enhancements_enabled?: boolean;
  recent_days?: number;
  lookahead_days?: number;
  event_ids?: string[];
  artifact_dir?: string;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  last_result?: Record<string, unknown> | null;
};

export type ProjectionMetric = {
  label: string;
  value: string;
};
