import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  evaluateLiveModel,
  liveModelAccuracyGate,
  reviewDataSources,
  trainLiveModel,
  type LiveModelAccuracyGate,
  type LiveModelArtifact,
  type LiveModelEvaluation,
  type LiveModelReviewDataSource,
  type LiveTrainingRow
} from "./live-learning.js";

export interface LiveTrackingConfig {
  enabled: boolean;
  dbPath: string;
  intervalSeconds: number;
  concurrency: number;
  minSnapshots: number;
}

export interface LiveTrackingStatus {
  enabled: boolean;
  games: {
    tracked: number;
    live: number;
    finalized: number;
  };
  snapshots: number;
  training: {
    snapshots: number;
    min_snapshots: number | null;
    ready: boolean;
  };
  latest_snapshot: {
    event_id: string;
    captured_at: string;
    score: string;
    clock: string | null;
    market_total_line: number | null;
    selected_market_ticker: string | null;
    projected_total: number | null;
    learned_projected_total: number | null;
  } | null;
  model: {
    trained_at: string;
    sample_count: number;
    game_count: number | null;
    effective_sample_count: number | null;
    metrics: LiveModelArtifact["metrics"];
    accuracy_gate: LiveModelAccuracyGate;
    evaluation: LiveModelEvaluation | null;
  } | null;
}

export interface LiveTrainingResult {
  status: "trained";
  model: LiveModelArtifact;
}

export interface LiveModelReviewResult {
  status: "reviewed";
  db_path: string;
  generated_at: string;
  training: {
    snapshots: number;
    min_snapshots: number;
    ready: boolean;
  };
  data_sources: LiveModelReviewDataSource[];
  latest_model: {
    trained_at: string;
    sample_count: number;
    game_count: number | null;
    effective_sample_count: number | null;
    metrics: LiveModelArtifact["metrics"];
    accuracy_gate: LiveModelAccuracyGate;
    evaluation: LiveModelEvaluation | null;
    local_snapshot_review: LiveModelEvaluation;
  } | null;
}

export interface ProjectionSnapshotInput {
  trigger: "tracker" | "user";
  payload: unknown;
}

type StatementRecord = Record<string, unknown>;

export class LiveTrackingStore {
  private readonly db: Database.Database;

  constructor(readonly dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  recordProjectionSnapshot(input: ProjectionSnapshotInput): void {
    const payload = asRecord(input.payload);
    const projection = asRecord(payload.live_projection);
    const debug = asRecord(projection.debug);
    const modelDetails = asRecord(debug.model_details);
    const selectedMarket = asRecord(debug.selected_market).market ?? debug.selected_market;
    const market = asRecord(selectedMarket);
    const teams = asRecord(payload.teams);
    const home = asRecord(teams.home);
    const away = asRecord(teams.away);
    const status = asRecord(payload.game_status);
    const eventId = stringValue(payload.event_id);
    if (!eventId) {
      return;
    }
    if (!isLiveProjectionPayload(status, projection)) {
      return;
    }

    const currentHomeScore = numberValue(home.score) ?? numberValue(asRecord(projection.model_inputs).current_home_score);
    const currentAwayScore = numberValue(away.score) ?? numberValue(asRecord(projection.model_inputs).current_away_score);
    const projectedHomeScore = numberValue(projection.projected_home_score);
    const projectedAwayScore = numberValue(projection.projected_away_score);
    const projectedTotal = numberValue(projection.projected_total);
    const learned = asRecord(projection.learned_projection);
    const learnedProjectedTotal = numberValue(learned.projected_total);
    const capturedAt = new Date().toISOString();

    this.upsertGame({
      event_id: eventId,
      home_team_id: stringValue(home.id),
      home_team_name: stringValue(home.name),
      home_team_abbreviation: stringValue(home.abbreviation),
      away_team_id: stringValue(away.id),
      away_team_name: stringValue(away.name),
      away_team_abbreviation: stringValue(away.abbreviation),
      status_state: stringValue(status.state),
      status_detail: stringValue(status.detail ?? status.description),
      current_home_score: currentHomeScore,
      current_away_score: currentAwayScore,
      final_home_score: Boolean(status.completed) ? currentHomeScore : null,
      final_away_score: Boolean(status.completed) ? currentAwayScore : null,
      finalized_at: Boolean(status.completed) ? capturedAt : null
    });

    this.db
      .prepare(
        `INSERT INTO live_projection_snapshots (
          event_id, captured_at, trigger, period, clock,
          current_home_score, current_away_score,
          projected_home_score, projected_away_score, projected_total, projected_home_margin,
          projected_remaining_points, market_total_line, difference_vs_market, p_over,
          relationship_to_market, market_line_source, selected_market_ticker,
          selected_market_yes_bid_cents, selected_market_yes_ask_cents, selected_market_last_price_cents,
          selected_market_json, model_inputs_json, source_urls_json, raw_projection_json,
          elapsed_minutes, minutes_left, margin, full_game_rate, prior_rate, recent_rate, blended_rate,
          learned_projected_home_score, learned_projected_away_score, learned_projected_total, learned_projected_home_margin
        ) VALUES (
          @event_id, @captured_at, @trigger, @period, @clock,
          @current_home_score, @current_away_score,
          @projected_home_score, @projected_away_score, @projected_total, @projected_home_margin,
          @projected_remaining_points, @market_total_line, @difference_vs_market, @p_over,
          @relationship_to_market, @market_line_source, @selected_market_ticker,
          @selected_market_yes_bid_cents, @selected_market_yes_ask_cents, @selected_market_last_price_cents,
          @selected_market_json, @model_inputs_json, @source_urls_json, @raw_projection_json,
          @elapsed_minutes, @minutes_left, @margin, @full_game_rate, @prior_rate, @recent_rate, @blended_rate,
          @learned_projected_home_score, @learned_projected_away_score, @learned_projected_total, @learned_projected_home_margin
        )`
      )
      .run({
        event_id: eventId,
        captured_at: capturedAt,
        trigger: input.trigger,
        period: numberValue(status.period),
        clock: stringValue(status.clock),
        current_home_score: currentHomeScore,
        current_away_score: currentAwayScore,
        projected_home_score: projectedHomeScore,
        projected_away_score: projectedAwayScore,
        projected_total: projectedTotal,
        projected_home_margin:
          projectedHomeScore !== null && projectedAwayScore !== null ? projectedHomeScore - projectedAwayScore : null,
        projected_remaining_points: numberValue(projection.projected_remaining_points),
        market_total_line: numberValue(projection.market_total_line),
        difference_vs_market: numberValue(projection.difference_vs_market),
        p_over: numberValue(projection.p_over),
        relationship_to_market: stringValue(projection.relationship_to_market),
        market_line_source: stringValue(asRecord(projection.data_quality).market_line_source),
        selected_market_ticker:
          stringValue(asRecord(projection.data_quality).selected_market_ticker) ?? stringValue(market.ticker),
        selected_market_yes_bid_cents: numberValue(market.yes_bid_cents),
        selected_market_yes_ask_cents: numberValue(market.yes_ask_cents),
        selected_market_last_price_cents: numberValue(market.last_price_cents),
        selected_market_json: jsonString(market),
        model_inputs_json: jsonString(projection.model_inputs),
        source_urls_json: jsonString(projection.source_urls),
        raw_projection_json: jsonString(input.payload),
        elapsed_minutes: numberValue(modelDetails.elapsed_minutes),
        minutes_left: numberValue(modelDetails.minutes_left),
        margin: numberValue(modelDetails.margin),
        full_game_rate: numberValue(modelDetails.full_game_rate),
        prior_rate: numberValue(modelDetails.prior_rate),
        recent_rate: numberValue(modelDetails.recent_rate),
        blended_rate: numberValue(modelDetails.blended_rate),
        learned_projected_home_score: numberValue(learned.projected_home_score),
        learned_projected_away_score: numberValue(learned.projected_away_score),
        learned_projected_total: learnedProjectedTotal,
        learned_projected_home_margin: numberValue(learned.projected_home_margin)
      });
  }

  upsertGame(input: StatementRecord): void {
    this.db
      .prepare(
        `INSERT INTO live_games (
          event_id, home_team_id, home_team_name, home_team_abbreviation,
          away_team_id, away_team_name, away_team_abbreviation,
          start_time, status_state, status_detail,
          current_home_score, current_away_score,
          final_home_score, final_away_score, first_seen_at, last_seen_at, finalized_at
        ) VALUES (
          @event_id, @home_team_id, @home_team_name, @home_team_abbreviation,
          @away_team_id, @away_team_name, @away_team_abbreviation,
          @start_time, @status_state, @status_detail,
          @current_home_score, @current_away_score,
          @final_home_score, @final_away_score, COALESCE(@first_seen_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, @finalized_at
        )
        ON CONFLICT(event_id) DO UPDATE SET
          home_team_id = COALESCE(excluded.home_team_id, live_games.home_team_id),
          home_team_name = COALESCE(excluded.home_team_name, live_games.home_team_name),
          home_team_abbreviation = COALESCE(excluded.home_team_abbreviation, live_games.home_team_abbreviation),
          away_team_id = COALESCE(excluded.away_team_id, live_games.away_team_id),
          away_team_name = COALESCE(excluded.away_team_name, live_games.away_team_name),
          away_team_abbreviation = COALESCE(excluded.away_team_abbreviation, live_games.away_team_abbreviation),
          start_time = COALESCE(excluded.start_time, live_games.start_time),
          status_state = COALESCE(excluded.status_state, live_games.status_state),
          status_detail = COALESCE(excluded.status_detail, live_games.status_detail),
          current_home_score = COALESCE(excluded.current_home_score, live_games.current_home_score),
          current_away_score = COALESCE(excluded.current_away_score, live_games.current_away_score),
          final_home_score = COALESCE(excluded.final_home_score, live_games.final_home_score),
          final_away_score = COALESCE(excluded.final_away_score, live_games.final_away_score),
          last_seen_at = CURRENT_TIMESTAMP,
          finalized_at = COALESCE(excluded.finalized_at, live_games.finalized_at)`
      )
      .run({
        event_id: input.event_id,
        home_team_id: input.home_team_id ?? null,
        home_team_name: input.home_team_name ?? null,
        home_team_abbreviation: input.home_team_abbreviation ?? null,
        away_team_id: input.away_team_id ?? null,
        away_team_name: input.away_team_name ?? null,
        away_team_abbreviation: input.away_team_abbreviation ?? null,
        start_time: input.start_time ?? null,
        status_state: input.status_state ?? null,
        status_detail: input.status_detail ?? null,
        current_home_score: input.current_home_score ?? null,
        current_away_score: input.current_away_score ?? null,
        final_home_score: input.final_home_score ?? null,
        final_away_score: input.final_away_score ?? null,
        first_seen_at: input.first_seen_at ?? null,
        finalized_at: input.finalized_at ?? null
      });
  }

  unfinalizedEventIds(): string[] {
    const rows = this.db
      .prepare("SELECT event_id FROM live_games WHERE finalized_at IS NULL ORDER BY last_seen_at DESC LIMIT 50")
      .all() as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }

  loadLatestModel(): LiveModelArtifact | null {
    const row = this.db
      .prepare("SELECT artifact_json FROM live_models ORDER BY trained_at DESC, id DESC LIMIT 1")
      .get() as { artifact_json?: string } | undefined;
    if (!row?.artifact_json) {
      return null;
    }
    try {
      return JSON.parse(row.artifact_json) as LiveModelArtifact;
    } catch {
      return null;
    }
  }

  trainLatestModel(minSnapshots: number): LiveTrainingResult {
    const rows = this.trainingRows();
    const model = trainLiveModel(rows, minSnapshots);
    this.db
      .prepare(
        `INSERT INTO live_models (
          version, trained_at, sample_count, feature_columns_json, metrics_json, artifact_json
        ) VALUES (@version, @trained_at, @sample_count, @feature_columns_json, @metrics_json, @artifact_json)`
      )
      .run({
        version: model.version,
        trained_at: model.trained_at,
        sample_count: model.sample_count,
        feature_columns_json: jsonString(model.feature_columns),
        metrics_json: jsonString(model.metrics),
        artifact_json: jsonString(model)
    });
    return { status: "trained", model };
  }

  reviewLatestModel(minSnapshots: number): LiveModelReviewResult {
    const rows = this.trainingRows();
    const trainingSnapshots = rows.length;
    const model = this.loadLatestModel();
    return {
      status: "reviewed",
      db_path: this.dbPath,
      generated_at: new Date().toISOString(),
      training: {
        snapshots: trainingSnapshots,
        min_snapshots: minSnapshots,
        ready: trainingSnapshots >= minSnapshots
      },
      data_sources: reviewDataSources(trainingSnapshots, minSnapshots),
      latest_model: model
        ? {
            trained_at: model.trained_at,
            sample_count: model.sample_count,
            game_count: model.game_count ?? null,
            effective_sample_count: model.effective_sample_count ?? null,
            metrics: model.metrics,
            accuracy_gate: liveModelAccuracyGate(model),
            evaluation: model.evaluation ?? null,
            local_snapshot_review: evaluateLiveModel(model, rows)
          }
        : null
    };
  }

  status(enabled = true, minSnapshots: number | null = null): LiveTrackingStatus {
    const gameCounts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS tracked,
          SUM(CASE WHEN status_state = 'in' THEN 1 ELSE 0 END) AS live,
          SUM(CASE WHEN finalized_at IS NOT NULL THEN 1 ELSE 0 END) AS finalized
        FROM live_games`
      )
      .get() as { tracked: number; live: number | null; finalized: number | null };
    const snapshotCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM live_projection_snapshots")
      .get() as { count: number };
    const trainingSnapshotCount = this.trainingSnapshotCount();
    const latest = this.db
      .prepare(
        `SELECT event_id, captured_at, current_home_score, current_away_score, period, clock,
          market_total_line, selected_market_ticker, projected_total, learned_projected_total
        FROM live_projection_snapshots
        ORDER BY captured_at DESC, id DESC
        LIMIT 1`
      )
      .get() as StatementRecord | undefined;
    const model = this.loadLatestModel();

    return {
      enabled,
      games: {
        tracked: gameCounts.tracked,
        live: gameCounts.live ?? 0,
        finalized: gameCounts.finalized ?? 0
      },
      snapshots: snapshotCount.count,
      training: {
        snapshots: trainingSnapshotCount,
        min_snapshots: minSnapshots,
        ready: minSnapshots === null ? trainingSnapshotCount > 0 : trainingSnapshotCount >= minSnapshots
      },
      latest_snapshot: latest
        ? {
            event_id: String(latest.event_id),
            captured_at: String(latest.captured_at),
            score: `${latest.current_away_score ?? "-"}-${latest.current_home_score ?? "-"}`,
            clock: stringValue(latest.clock),
            market_total_line: numberValue(latest.market_total_line),
            selected_market_ticker: stringValue(latest.selected_market_ticker),
            projected_total: numberValue(latest.projected_total),
            learned_projected_total: numberValue(latest.learned_projected_total)
          }
        : null,
      model: model
        ? {
            trained_at: model.trained_at,
            sample_count: model.sample_count,
            game_count: model.game_count ?? null,
            effective_sample_count: model.effective_sample_count ?? null,
            metrics: model.metrics,
            accuracy_gate: liveModelAccuracyGate(model),
            evaluation: model.evaluation ?? null
          }
        : null
    };
  }

  private trainingRows(): LiveTrainingRow[] {
    return this.db
      .prepare(
        `SELECT
          s.event_id, s.period, s.clock, s.current_home_score, s.current_away_score,
          s.projected_home_score, s.projected_away_score, s.projected_total, s.projected_home_margin,
          s.market_total_line, s.difference_vs_market, s.elapsed_minutes, s.minutes_left, s.margin,
          s.full_game_rate, s.prior_rate, s.recent_rate, s.blended_rate, s.p_over,
          g.final_home_score, g.final_away_score
        FROM live_projection_snapshots s
        JOIN live_games g ON g.event_id = s.event_id
        WHERE g.final_home_score IS NOT NULL
          AND g.final_away_score IS NOT NULL
          AND s.projected_total IS NOT NULL
          AND s.projected_home_margin IS NOT NULL
        ORDER BY s.captured_at ASC, s.id ASC`
      )
      .all() as LiveTrainingRow[];
  }

  private trainingSnapshotCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
        FROM live_projection_snapshots s
        JOIN live_games g ON g.event_id = s.event_id
        WHERE g.final_home_score IS NOT NULL
          AND g.final_away_score IS NOT NULL
          AND s.projected_total IS NOT NULL
          AND s.projected_home_margin IS NOT NULL`
      )
      .get() as { count: number };
    return row.count;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_games (
        event_id TEXT PRIMARY KEY,
        home_team_id TEXT,
        home_team_name TEXT,
        home_team_abbreviation TEXT,
        away_team_id TEXT,
        away_team_name TEXT,
        away_team_abbreviation TEXT,
        start_time TEXT,
        status_state TEXT,
        status_detail TEXT,
        current_home_score REAL,
        current_away_score REAL,
        final_home_score REAL,
        final_away_score REAL,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finalized_at TEXT
      );

      CREATE TABLE IF NOT EXISTS live_projection_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        period INTEGER,
        clock TEXT,
        current_home_score REAL,
        current_away_score REAL,
        projected_home_score REAL,
        projected_away_score REAL,
        projected_total REAL,
        projected_home_margin REAL,
        projected_remaining_points REAL,
        market_total_line REAL,
        difference_vs_market REAL,
        p_over REAL,
        relationship_to_market TEXT,
        market_line_source TEXT,
        selected_market_ticker TEXT,
        selected_market_yes_bid_cents REAL,
        selected_market_yes_ask_cents REAL,
        selected_market_last_price_cents REAL,
        selected_market_json TEXT,
        model_inputs_json TEXT,
        source_urls_json TEXT,
        raw_projection_json TEXT NOT NULL,
        elapsed_minutes REAL,
        minutes_left REAL,
        margin REAL,
        full_game_rate REAL,
        prior_rate REAL,
        recent_rate REAL,
        blended_rate REAL,
        learned_projected_home_score REAL,
        learned_projected_away_score REAL,
        learned_projected_total REAL,
        learned_projected_home_margin REAL,
        FOREIGN KEY(event_id) REFERENCES live_games(event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_live_snapshots_event ON live_projection_snapshots(event_id, captured_at);

      CREATE TABLE IF NOT EXISTS live_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        trained_at TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        feature_columns_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        artifact_json TEXT NOT NULL
      );
    `);
  }
}

export function liveTrackingConfig(env: NodeJS.ProcessEnv = process.env): LiveTrackingConfig {
  const root = env.SPORTS_PROJECTOR_HISTORICAL_ROOT ?? process.cwd();
  return {
    enabled: parseBoolean(env.SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED),
    dbPath: path.resolve(root, env.SPORTS_PROJECTOR_LIVE_DB_PATH ?? "data/live-tracking/nba-live.sqlite"),
    intervalSeconds: clampInteger(env.SPORTS_PROJECTOR_LIVE_TRACKING_INTERVAL_SECONDS, 30, 5, 300),
    concurrency: clampInteger(env.SPORTS_PROJECTOR_LIVE_TRACKING_CONCURRENCY, 2, 1, 8),
    minSnapshots: clampInteger(env.SPORTS_PROJECTOR_LIVE_MODEL_MIN_SNAPSHOTS, 50, 5, 100000)
  };
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function isLiveProjectionPayload(status: Record<string, unknown>, projection: Record<string, unknown>): boolean {
  const qualityStatus = stringValue(asRecord(projection.data_quality).status);
  if (qualityStatus) {
    return qualityStatus === "live";
  }

  return !Boolean(status.completed) && stringValue(status.state) === "in";
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}
