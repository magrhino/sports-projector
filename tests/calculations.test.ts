import { describe, expect, it } from "vitest";
import {
  calculateBinaryMarketSpread,
  calculateImpliedProbabilityFromPrice,
  compareProjectionToMarket,
  estimateTotalScoreProjection
} from "../src/tools/calculations.js";

describe("calculation helpers", () => {
  it("converts cents and dollars prices to probabilities", () => {
    expect(
      calculateImpliedProbabilityFromPrice({
        price: 55,
        price_format: "cents",
        contract_side: "yes"
      }).yes_probability
    ).toBe(0.55);

    expect(
      calculateImpliedProbabilityFromPrice({
        price: 0.4,
        price_format: "auto",
        contract_side: "no"
      }).yes_probability
    ).toBe(0.6);
  });

  it("calculates binary spread from YES and NO bids", () => {
    expect(
      calculateBinaryMarketSpread({
        best_yes_bid_cents: 46,
        best_no_bid_cents: 50
      })
    ).toMatchObject({
      implied_yes_ask_cents: 50,
      spread_cents: 4,
      mid_cents: 48
    });
  });

  it("estimates total score projection from pace", () => {
    const result = estimateTotalScoreProjection({
      current_home_score: 50,
      current_away_score: 48,
      elapsed_game_seconds: 24 * 60,
      regulation_seconds: 48 * 60,
      final_minute_foul_adjustment_points: 2
    });

    expect(result.method).toBe("pace");
    expect(result.current_total).toBe(98);
    expect(result.projection_total).toBe(198);
    expect(result.formula).toContain("projection_total");
  });

  it("compares projection to market without action language", () => {
    const result = compareProjectionToMarket({
      projection_total: 224,
      market_total: 220.5,
      tolerance_points: 1
    });
    const text = JSON.stringify(result).toLowerCase();

    expect(result.relationship).toBe("above_market");
    expect(result.difference_points).toBe(3.5);
    expect(text).not.toContain("wager");
    expect(text).not.toContain("bet ");
    expect(text).not.toContain("recommend");
  });
});
