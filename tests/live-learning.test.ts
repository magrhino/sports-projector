import { describe, expect, it } from "vitest";
import {
  predictLearnedProjection,
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
      sample_count: 8,
      game_count: 4,
      effective_sample_count: 4
    });
    expect(model.validation_count).toBeGreaterThan(0);
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
});

function fixedCorrectionModel(input: {
  comparableGameCount: number;
  totalCorrection: number;
  marginCorrection?: number;
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
      "p1:m39-42": {
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
