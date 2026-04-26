export type League = "nba" | "nfl" | "mlb" | "nhl";

export type Team = {
  id?: string;
  name?: string;
  abbreviation?: string;
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
  last_error?: string | null;
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
      sample_count?: number;
    } | null;
    training?: {
      ready?: boolean;
      snapshots?: number;
      min_snapshots?: number;
    };
  };
};

export type ProjectionMetric = {
  label: string;
  value: string;
};
