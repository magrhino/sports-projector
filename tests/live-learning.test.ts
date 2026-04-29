import { describe, expect, it } from "vitest";
import {
  evaluateLiveModel,
  isLiveModelAccuracyGatePassed,
  predictLearnedProjection,
  reviewDataSources,
  trainLiveModel,
  type LiveModelArtifact,
  type LiveTrainingRow
} from "../src/nba/live-learning.js";

const FEATURE_COUNT = 16;

describe("NBA live learned projection calibration", () => {
  it("reports game and effective sample counts after game/time-bucket downsampling", () => {
    const rows = Array.from({ length: 4 }, (_, index) => [
      trainingRow({ eventId: `game-${index}`, finalTotal: 220 + index }),
      trainingRow({ eventId: `game-${index}`, finalTotal: 221 + index })
    ]).flat();

    const model = trainLiveModel(rows, 4);

    expect(model.sample_count).toBe(8);
    expect(model.game_count).toBe(4);
    expect(model.effective_sample_count).toBe(4);
    expect(model.bucket_coverage["p1:m39-42"]).toEqual({
      sample_count: 6,
      game_count: 3,
      effective_sample_count: 3
    });
    expect(model.validation_count).toBeGreaterThan(0);
    expect(model.accuracy_gate.status).toBe("insufficient_data");
    expect(model.accuracy_gate.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/Need at least 5 validation games/)])
    );
  });

  it("passes the accuracy gate when learned corrections improve held-out total and margin MAE", () => {
    const model = trainLiveModel(accuracyRows({ count: 100, totalDelta: 6, marginDelta: 2 }), 50);

    expect(model.accuracy_gate.status).toBe("passed");
    expect(isLiveModelAccuracyGatePassed(model)).toBe(true);
    expect(model.evaluation.validation_game_count).toBe(20);
    expect(model.evaluation.effective_validation_snapshot_count).toBe(20);
    expect(model.evaluation.improvement.mae_total).toBeGreaterThanOrEqual(0.25);
    expect(model.evaluation.improvement.mae_margin).toBeGreaterThanOrEqual(0.25);
    expect(model.evaluation.data_sources[0]).toMatchObject({
      source: "local_live_tracking_snapshots",
      quality: "primary",
      status: "used",
      included_in_accuracy_gate: true
    });
  });

  it("does not count validation-only buckets as comparable training coverage", () => {
    const rows = [
      ...accuracyRows({ count: 80, totalDelta: 6, marginDelta: 2 }),
      ...accuracyRows({
        count: 20,
        totalDelta: 6,
        marginDelta: 2,
        eventPrefix: "validation-only",
        period: 1,
        clock: "4:32",
        elapsedMinutes: 7.47,
        minutesLeft: 40.53
      })
    ];

    const model = trainLiveModel(rows, 50);

    expect(model.bucket_coverage["p1:m39-42"]).toBeUndefined();
    expect(model.evaluation.validation_game_count).toBe(20);
    expect(model.evaluation.improvement.mae_total).toBe(0);
    expect(model.evaluation.improvement.mae_margin).toBe(0);
    expect(model.accuracy_gate.status).toBe("failed");
  });

  it("fails the accuracy gate when learned corrections do not improve held-out accuracy", () => {
    const model = trainLiveModel(accuracyRows({ count: 100, totalDelta: 0, marginDelta: 0 }), 50);

    expect(model.accuracy_gate.status).toBe("failed");
    expect(isLiveModelAccuracyGatePassed(model)).toBe(false);
    expect(model.accuracy_gate.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/Total MAE improvement/), expect.stringMatching(/Margin MAE improvement/)])
    );
  });

  it("evaluates a stored model against local snapshots without changing the stored gate", () => {
    const model = trainLiveModel(accuracyRows({ count: 100, totalDelta: 6, marginDelta: 2 }), 50);
    const review = evaluateLiveModel(model, accuracyRows({ count: 8, totalDelta: 6, marginDelta: 2 }));

    expect(review.source).toBe("local_snapshot_review");
    expect(review.validation_snapshot_count).toBe(8);
    expect(review.baseline.mae_total).toBeGreaterThan(review.learned.mae_total ?? Number.POSITIVE_INFINITY);
  });

  it("labels historical mid-game backfill sources as supplemental when local coverage is thin", () => {
    expect(reviewDataSources(0, 50)).toEqual([
      expect.objectContaining({
        source: "local_live_tracking_snapshots",
        quality: "primary",
        status: "missing",
        included_in_accuracy_gate: true
      }),
      expect.objectContaining({
        source: "kalshi_game_stats_historical_backfill",
        quality: "supplemental",
        status: "requires_event_ids",
        included_in_accuracy_gate: false
      }),
      expect.objectContaining({
        source: "espn_period_linescore_backfill",
        quality: "low",
        status: "requires_event_ids",
        included_in_accuracy_gate: false
      })
    ]);
  });

  it("skips learned corrections when comparable game coverage is thin", () => {
    const learned = predictLearnedProjection(fixedCorrectionModel({ comparableGameCount: 2, totalCorrection: 20 }), projectionData());

    expect(learned).not.toBeNull();
    expect(learned?.adjustment_status).toBe("skipped_low_coverage");
    expect(learned?.projected_total).toBe(240);
    expect(learned?.total_residual_correction).toBe(0);
    expect(learned?.raw_total_residual_correction).toBe(20);
    expect(learned?.comparable_game_count).toBe(2);
  });

  it("clips early Q1 learned corrections when comparable coverage is available", () => {
    const learned = predictLearnedProjection(
      fixedCorrectionModel({ comparableGameCount: 5, totalCorrection: 20, marginCorrection: 20 }),
      projectionData()
    );

    expect(learned).not.toBeNull();
    expect(learned?.adjustment_status).toBe("clipped");
    expect(learned?.correction_cap).toBe(4);
    expect(learned?.total_residual_correction).toBe(4);
    expect(learned?.margin_residual_correction).toBe(6);
    expect(learned?.projected_total).toBe(244);
  });

  it("preserves the adjusted projected total when margin correction hits current score floors", () => {
    const learned = predictLearnedProjection(
      fixedCorrectionModel({
        comparableGameCount: 5,
        totalCorrection: 0,
        marginCorrection: 20,
        bucket: "p4:m0-3"
      }),
      constrainedProjectionData()
    );

    expect(learned).not.toBeNull();
    expect(learned?.projected_total).toBe(200);
    expect((learned?.projected_home_score ?? 0) + (learned?.projected_away_score ?? 0)).toBe(200);
    expect(learned?.margin_residual_correction).toBe(14);
  });
});

function fixedCorrectionModel(input: {
  comparableGameCount: number;
  totalCorrection: number;
  marginCorrection?: number;
  bucket?: string;
}): LiveModelArtifact {
  return {
    version: 1,
    trained_at: "2026-04-29T02:00:00.000Z",
    sample_count: 100,
    game_count: 10,
    effective_sample_count: 40,
    train_count: 32,
    validation_count: 8,
    feature_columns: [],
    bucket_coverage: {
      [input.bucket ?? "p1:m39-42"]: {
        sample_count: 20,
        game_count: input.comparableGameCount,
        effective_sample_count: input.comparableGameCount
      }
    },
    hidden_size: 1,
    input_mean: Array(FEATURE_COUNT).fill(0),
    input_std: Array(FEATURE_COUNT).fill(1),
    hidden_weights: [Array(FEATURE_COUNT).fill(0)],
    hidden_bias: [0],
    output_weights: [[0], [0]],
    output_bias: [input.totalCorrection, input.marginCorrection ?? 0],
    metrics: {
      train_mae_total: 0,
      train_mae_margin: 0,
      validation_mae_total: 0,
      validation_mae_margin: 0
    },
    evaluation: {
      source: "heldout_validation",
      data_sources: reviewDataSources(100, 50),
      validation_game_count: 20,
      validation_snapshot_count: 20,
      effective_validation_snapshot_count: 20,
      baseline: {
        mae_total: 1,
        mae_margin: 1
      },
      learned: {
        mae_total: 0,
        mae_margin: 0
      },
      improvement: {
        mae_total: 1,
        mae_margin: 1,
        total_fraction: 1,
        margin_fraction: 1
      },
      buckets: []
    },
    accuracy_gate: {
      status: "passed",
      reasons: [],
      min_validation_games: 5,
      min_effective_validation_snapshots: 20,
      required_improvement_points: 0.25,
      required_improvement_fraction: 0.02,
      max_bucket_regression_mae: 1
    }
  };
}

function projectionData() {
  return {
    event_id: "401869386",
    teams: {
      home: { abbreviation: "SA", score: 26 },
      away: { abbreviation: "POR", score: 17 }
    },
    game_status: {
      period: 1,
      clock: "4:32"
    },
    live_projection: {
      projected_home_score: 125,
      projected_away_score: 115,
      projected_total: 240,
      market_total_line: 226.5,
      difference_vs_market: 13.5,
      p_over: 0.75,
      model_inputs: {
        current_home_score: 26,
        current_away_score: 17
      },
      debug: {
        model_details: {
          elapsed_minutes: 7.47,
          minutes_left: 40.53,
          margin: 9,
          full_game_rate: 4.9,
          prior_rate: 4.719,
          recent_rate: 5.1,
          blended_rate: 4.85
        }
      }
    }
  };
}

function constrainedProjectionData() {
  return {
    event_id: "margin-floor",
    teams: {
      home: { abbreviation: "BOS", score: 100 },
      away: { abbreviation: "NY", score: 99 }
    },
    game_status: {
      period: 4,
      clock: "1:30"
    },
    live_projection: {
      projected_home_score: 100,
      projected_away_score: 100,
      projected_total: 200,
      market_total_line: 203,
      difference_vs_market: -3,
      p_over: 0.5,
      model_inputs: {
        current_home_score: 100,
        current_away_score: 99
      },
      debug: {
        model_details: {
          elapsed_minutes: 46.5,
          minutes_left: 1.5,
          margin: 1,
          full_game_rate: 4.17,
          prior_rate: 4.23,
          recent_rate: 4.17,
          blended_rate: 4.2
        }
      }
    }
  };
}

function trainingRow(input: { eventId: string; finalTotal: number }): LiveTrainingRow {
  const finalHomeScore = Math.round(input.finalTotal / 2 + 5);
  return {
    event_id: input.eventId,
    period: 1,
    clock: "4:32",
    current_home_score: 26,
    current_away_score: 17,
    projected_home_score: 125,
    projected_away_score: 115,
    projected_total: 240,
    projected_home_margin: 10,
    market_total_line: 226.5,
    difference_vs_market: 13.5,
    elapsed_minutes: 7.47,
    minutes_left: 40.53,
    margin: 9,
    full_game_rate: 4.9,
    prior_rate: 4.719,
    recent_rate: 5.1,
    blended_rate: 4.85,
    p_over: 0.75,
    final_home_score: finalHomeScore,
    final_away_score: input.finalTotal - finalHomeScore
  };
}

function accuracyRows(input: {
  count: number;
  totalDelta: number;
  marginDelta: number;
  eventPrefix?: string;
  period?: number;
  clock?: string;
  elapsedMinutes?: number;
  minutesLeft?: number;
}): LiveTrainingRow[] {
  return Array.from({ length: input.count }, (_, index) => {
    const projectedHomeScore = 100;
    const projectedAwayScore = 100;
    const finalTotal = projectedHomeScore + projectedAwayScore + input.totalDelta;
    const finalMargin = projectedHomeScore - projectedAwayScore + input.marginDelta;
    return {
      event_id: `${input.eventPrefix ?? "accuracy-game"}-${index}`,
      period: input.period ?? 4,
      clock: input.clock ?? "9:25",
      current_home_score: 80,
      current_away_score: 78,
      projected_home_score: projectedHomeScore,
      projected_away_score: projectedAwayScore,
      projected_total: projectedHomeScore + projectedAwayScore,
      projected_home_margin: projectedHomeScore - projectedAwayScore,
      market_total_line: 203,
      difference_vs_market: -3,
      elapsed_minutes: input.elapsedMinutes ?? 38.58,
      minutes_left: input.minutesLeft ?? 9.42,
      margin: 2,
      full_game_rate: 4.17,
      prior_rate: 4.23,
      recent_rate: 4.17,
      blended_rate: 4.2,
      p_over: 0.5,
      final_home_score: (finalTotal + finalMargin) / 2,
      final_away_score: (finalTotal - finalMargin) / 2
    };
  });
}
