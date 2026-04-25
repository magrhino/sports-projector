import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeResponse, nowIso } from "../lib/response.js";
import { DepthSchema } from "../lib/validation.js";

const CALCULATION_CAVEATS = [
  "Informational research only; this is not an instruction to take action.",
  "Formulas are simplified and do not account for all market, injury, overtime, lineup, or game-state effects."
];

const PriceFormatSchema = z.enum(["auto", "cents", "dollars"]).default("auto");

const ProbabilityInputSchema = z.object({
  price: z.number().min(0),
  price_format: PriceFormatSchema,
  contract_side: z.enum(["yes", "no"]).default("yes")
});

const BinarySpreadInputSchema = z.object({
  best_yes_bid_cents: z.number().min(0).max(100),
  best_no_bid_cents: z.number().min(0).max(100),
  depth_levels_used: DepthSchema.optional()
});

const TotalProjectionInputSchema = z.object({
  current_home_score: z.number().min(0),
  current_away_score: z.number().min(0),
  elapsed_game_seconds: z.number().min(0),
  regulation_seconds: z.number().positive(),
  recent_pace_points_per_minute: z.number().positive().optional(),
  expected_possessions_remaining: z.number().min(0).optional(),
  points_per_possession: z.number().min(0).optional(),
  final_minute_foul_adjustment_points: z.number().default(0)
});

const CompareProjectionInputSchema = z.object({
  projection_total: z.number(),
  market_total: z.number(),
  tolerance_points: z.number().min(0).default(1)
});

export function registerCalculationTools(server: McpServer): void {
  server.registerTool(
    "calculate_implied_probability_from_price",
    {
      description:
        "Convert a binary contract price into an implied probability using transparent arithmetic. Informational research only; not betting advice.",
      inputSchema: ProbabilityInputSchema
    },
    async (input) =>
      makeResponse({
        source: "calculation",
        fetched_at: nowIso(),
        source_url: null,
        cache_status: "not_applicable",
        summary: "Calculated implied probability from a binary market price.",
        data: calculateImpliedProbabilityFromPrice(input),
        caveats: CALCULATION_CAVEATS
      })
  );

  server.registerTool(
    "calculate_binary_market_spread",
    {
      description:
        "Calculate a binary market spread from Kalshi-style YES and NO bids. Informational research only; not betting advice.",
      inputSchema: BinarySpreadInputSchema
    },
    async (input) =>
      makeResponse({
        source: "calculation",
        fetched_at: nowIso(),
        source_url: null,
        cache_status: "not_applicable",
        summary: "Calculated the implied YES ask and bid/ask spread from YES and NO bids.",
        data: calculateBinaryMarketSpread(input),
        caveats: [
          ...CALCULATION_CAVEATS,
          "Kalshi orderbooks return YES bids and NO bids. A NO bid at X cents implies a YES ask at 100 - X cents."
        ]
      })
  );

  server.registerTool(
    "estimate_total_score_projection",
    {
      description:
        "Estimate a regulation total score projection from current score, elapsed time, and optional pace inputs. Informational research only; not betting advice.",
      inputSchema: TotalProjectionInputSchema
    },
    async (input) =>
      makeResponse({
        source: "calculation",
        fetched_at: nowIso(),
        source_url: null,
        cache_status: "not_applicable",
        summary: "Estimated a transparent regulation total score projection.",
        data: estimateTotalScoreProjection(input),
        caveats: [
          ...CALCULATION_CAVEATS,
          "Projection assumes regulation time unless the caller explicitly adjusts inputs.",
          "Late-game fouling, substitutions, overtime, and clock strategy can materially change outcomes."
        ]
      })
  );

  server.registerTool(
    "compare_projection_to_market",
    {
      description:
        "Compare a transparent projection to a market total without recommending any wager. Informational research only; not betting advice.",
      inputSchema: CompareProjectionInputSchema
    },
    async (input) =>
      makeResponse({
        source: "calculation",
        fetched_at: nowIso(),
        source_url: null,
        cache_status: "not_applicable",
        summary: "Compared the projection to the market total.",
        data: compareProjectionToMarket(input),
        caveats: CALCULATION_CAVEATS
      })
  );
}

export function calculateImpliedProbabilityFromPrice(input: z.infer<typeof ProbabilityInputSchema>): {
  input_price: number;
  price_format_used: "cents" | "dollars";
  contract_side: "yes" | "no";
  contract_probability: number;
  yes_probability: number;
  formula: string;
} {
  const price = normalizePriceToCents(input.price, input.price_format);
  const contractProbability = roundProbability(price.cents / 100);
  return {
    input_price: input.price,
    price_format_used: price.format,
    contract_side: input.contract_side,
    contract_probability: contractProbability,
    yes_probability:
      input.contract_side === "yes" ? contractProbability : roundProbability(1 - contractProbability),
    formula:
      input.contract_side === "yes"
        ? "YES probability = price_cents / 100"
        : "NO probability = price_cents / 100; YES probability = 1 - NO probability"
  };
}

export function calculateBinaryMarketSpread(input: z.infer<typeof BinarySpreadInputSchema>): {
  best_yes_bid_cents: number;
  best_no_bid_cents: number;
  implied_yes_ask_cents: number;
  spread_cents: number;
  mid_cents: number;
  formulas: string[];
} {
  const impliedYesAsk = roundCents(100 - input.best_no_bid_cents);
  const spread = roundCents(impliedYesAsk - input.best_yes_bid_cents);
  return {
    best_yes_bid_cents: input.best_yes_bid_cents,
    best_no_bid_cents: input.best_no_bid_cents,
    implied_yes_ask_cents: impliedYesAsk,
    spread_cents: spread,
    mid_cents: roundCents((input.best_yes_bid_cents + impliedYesAsk) / 2),
    formulas: [
      "implied_yes_ask_cents = 100 - best_no_bid_cents",
      "spread_cents = implied_yes_ask_cents - best_yes_bid_cents",
      "mid_cents = (best_yes_bid_cents + implied_yes_ask_cents) / 2"
    ]
  };
}

export function estimateTotalScoreProjection(input: z.infer<typeof TotalProjectionInputSchema>): {
  current_total: number;
  elapsed_minutes: number;
  remaining_minutes: number;
  projection_total: number;
  projected_remaining_points: number;
  method: "possessions" | "pace";
  assumptions: string[];
  formula: string;
} {
  const currentTotal = input.current_home_score + input.current_away_score;
  const elapsedMinutes = input.elapsed_game_seconds / 60;
  const remainingSeconds = Math.max(input.regulation_seconds - input.elapsed_game_seconds, 0);
  const remainingMinutes = remainingSeconds / 60;
  const foulAdjustment = input.final_minute_foul_adjustment_points;

  if (
    input.expected_possessions_remaining !== undefined &&
    input.points_per_possession !== undefined
  ) {
    const projectedRemaining = input.expected_possessions_remaining * input.points_per_possession + foulAdjustment;
    return {
      current_total: currentTotal,
      elapsed_minutes: roundStat(elapsedMinutes),
      remaining_minutes: roundStat(remainingMinutes),
      projection_total: roundStat(currentTotal + projectedRemaining),
      projected_remaining_points: roundStat(projectedRemaining),
      method: "possessions",
      assumptions: [
        `Expected possessions remaining: ${input.expected_possessions_remaining}`,
        `Points per possession: ${input.points_per_possession}`,
        `Final-minute foul adjustment points: ${foulAdjustment}`
      ],
      formula:
        "projection_total = current_total + (expected_possessions_remaining * points_per_possession) + final_minute_foul_adjustment_points"
    };
  }

  const currentPace = elapsedMinutes > 0 ? currentTotal / elapsedMinutes : 0;
  const pace = input.recent_pace_points_per_minute ?? currentPace;
  const projectedRemaining = pace * remainingMinutes + foulAdjustment;

  return {
    current_total: currentTotal,
    elapsed_minutes: roundStat(elapsedMinutes),
    remaining_minutes: roundStat(remainingMinutes),
    projection_total: roundStat(currentTotal + projectedRemaining),
    projected_remaining_points: roundStat(projectedRemaining),
    method: "pace",
    assumptions: [
      `Pace points per minute used: ${roundStat(pace)}`,
      input.recent_pace_points_per_minute === undefined
        ? "Pace was derived from current total divided by elapsed minutes."
        : "Pace was provided by caller as recent_pace_points_per_minute.",
      `Final-minute foul adjustment points: ${foulAdjustment}`
    ],
    formula:
      "projection_total = current_total + (pace_points_per_minute * remaining_minutes) + final_minute_foul_adjustment_points"
  };
}

export function compareProjectionToMarket(input: z.infer<typeof CompareProjectionInputSchema>): {
  projection_total: number;
  market_total: number;
  difference_points: number;
  absolute_difference_points: number;
  relationship: "above_market" | "below_market" | "near_market";
  tolerance_points: number;
  formula: string;
} {
  const difference = roundStat(input.projection_total - input.market_total);
  const absoluteDifference = Math.abs(difference);
  let relationship: "above_market" | "below_market" | "near_market" = "near_market";
  if (absoluteDifference > input.tolerance_points) {
    relationship = difference > 0 ? "above_market" : "below_market";
  }

  return {
    projection_total: input.projection_total,
    market_total: input.market_total,
    difference_points: difference,
    absolute_difference_points: roundStat(absoluteDifference),
    relationship,
    tolerance_points: input.tolerance_points,
    formula: "difference_points = projection_total - market_total"
  };
}

function normalizePriceToCents(price: number, format: "auto" | "cents" | "dollars"): {
  cents: number;
  format: "cents" | "dollars";
} {
  if (format === "dollars") {
    return { cents: roundCents(price * 100), format: "dollars" };
  }

  if (format === "cents") {
    return { cents: roundCents(price), format: "cents" };
  }

  return price <= 1 ? { cents: roundCents(price * 100), format: "dollars" } : { cents: roundCents(price), format: "cents" };
}

function roundCents(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundProbability(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}
