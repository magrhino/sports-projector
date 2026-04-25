import type { NormalizedKalshiMarket } from "../clients/kalshi.js";

export interface LiveScoreProjectionInput {
  currentHomeScore: number;
  currentAwayScore: number;
  period: number;
  clock: string;
  marketTotalLine?: number | null;
  pregameTotal?: number | null;
  recentPoints?: number | null;
  recentMinutes?: number | null;
  recentHomePoints?: number | null;
  recentAwayPoints?: number | null;
  homeFoulsPeriod?: number | null;
  awayFoulsPeriod?: number | null;
  isPlayoffs?: boolean;
}

export interface LiveScoreProjectionResult {
  current_total: number;
  elapsed_minutes: number;
  minutes_left: number;
  margin: number;
  historical_baseline_total: number;
  full_game_rate: number;
  prior_rate: number;
  recent_rate: number;
  blended_rate: number;
  trailing_fouls_to_give: number | null;
  foul_bonus: number;
  overtime_probability: number;
  overtime_bonus: number;
  blowout_drag: number;
  projected_total: number;
  projected_remaining_points: number;
  market_total_line: number | null;
  difference_vs_market: number | null;
  p_over: number | null;
  relationship_to_market: "above_market" | "below_market" | "near_market" | "unavailable";
  most_likely_score: {
    home: number;
    away: number;
    total: number;
  };
  model_inputs: {
    current_home_score: number;
    current_away_score: number;
    period: number;
    clock: string;
    recent_points: number | null;
    recent_minutes: number | null;
    home_fouls_period: number | null;
    away_fouls_period: number | null;
    is_playoffs: boolean;
  };
  formulas: string[];
}

export interface MarketTotalCandidate {
  market: NormalizedKalshiMarket;
  line: number;
  midpoint_cents: number | null;
  distance_from_even_cents: number | null;
  match_score: number;
}

export interface MatchupText {
  homeName?: string | null;
  awayName?: string | null;
  homeAbbreviation?: string | null;
  awayAbbreviation?: string | null;
  startTime?: string | null;
}

export interface RecentScoringWindow {
  points: number;
  minutes: number;
  home_points: number;
  away_points: number;
  source: "kalshi_game_stats" | "espn_linescore";
}

const NBA_REGULATION_MINUTES = 48;
const NBA_PERIOD_MINUTES = 12;
const NBA_OVERTIME_MINUTES = 5;
const SCORE_SPLIT_PRIOR_WEIGHT = 0.5;

export function projectLiveNbaScore(input: LiveScoreProjectionInput): LiveScoreProjectionResult {
  const currentTotal = input.currentHomeScore + input.currentAwayScore;
  const margin = Math.abs(input.currentHomeScore - input.currentAwayScore);
  const timing = gameTime(input.period, input.clock);
  const elapsed = timing.elapsed;
  const minutesLeft = timing.remaining;
  const periodLeft = timing.period_left;
  const isPlayoffs = input.isPlayoffs ?? true;

  const fullGameRate = elapsed > 0 ? currentTotal / elapsed : baselineRate(input.marketTotalLine, currentTotal);
  const historicalBaseline = baselineTotal(input, currentTotal, elapsed, minutesLeft);
  const priorRate = historicalBaseline / NBA_REGULATION_MINUTES;
  const recentRate =
    input.recentPoints !== null &&
    input.recentPoints !== undefined &&
    input.recentMinutes !== null &&
    input.recentMinutes !== undefined &&
    input.recentMinutes > 0
      ? input.recentPoints / input.recentMinutes
      : fullGameRate;

  const [wPrior, wFull, wRecent] = dynamicRateWeights(minutesLeft);
  const blendedRate = wPrior * priorRate + wFull * fullGameRate + wRecent * recentRate;

  let trailingFouls: number | null | undefined = null;
  if (input.currentHomeScore < input.currentAwayScore) {
    trailingFouls = input.homeFoulsPeriod;
  } else if (input.currentAwayScore < input.currentHomeScore) {
    trailingFouls = input.awayFoulsPeriod;
  }

  const trailingFoulsToGive = foulsToGiveBeforePenalty(trailingFouls, input.period, periodLeft);
  const foulBonus = lateGameFoulBonus(minutesLeft, margin, trailingFoulsToGive);
  const otProbability = overtimeProbability(minutesLeft, margin);
  const otExpectedPoints = Math.max(18, Math.min(26, blendedRate * NBA_OVERTIME_MINUTES));
  const otBonus = otProbability * otExpectedPoints;
  const drag = blowoutDrag(minutesLeft, margin, isPlayoffs);
  const projectedTotalRaw = currentTotal + blendedRate * minutesLeft + foulBonus + otBonus + drag;
  const projectedTotal = Math.max(currentTotal, projectedTotalRaw);
  const score = mostLikelyScore({
    currentHomeScore: input.currentHomeScore,
    currentAwayScore: input.currentAwayScore,
    projectedTotal,
    recentHomePoints: input.recentHomePoints,
    recentAwayPoints: input.recentAwayPoints
  });
  const marketTotalLine = input.marketTotalLine ?? null;
  const difference = marketTotalLine === null ? null : projectedTotal - marketTotalLine;
  const sigma = residualSigma(minutesLeft);
  const pOver = marketTotalLine === null ? null : 1 - normalCdf((marketTotalLine - projectedTotal) / sigma);

  return {
    current_total: currentTotal,
    elapsed_minutes: roundStat(elapsed),
    minutes_left: roundStat(minutesLeft),
    margin,
    historical_baseline_total: roundStat(historicalBaseline),
    full_game_rate: roundRate(fullGameRate),
    prior_rate: roundRate(priorRate),
    recent_rate: roundRate(recentRate),
    blended_rate: roundRate(blendedRate),
    trailing_fouls_to_give: trailingFoulsToGive,
    foul_bonus: roundStat(foulBonus),
    overtime_probability: roundProbability(otProbability),
    overtime_bonus: roundStat(otBonus),
    blowout_drag: roundStat(drag),
    projected_total: roundStat(projectedTotal),
    projected_remaining_points: roundStat(Math.max(projectedTotal - currentTotal, 0)),
    market_total_line: marketTotalLine,
    difference_vs_market: difference === null ? null : roundStat(difference),
    p_over: pOver === null ? null : roundProbability(pOver),
    relationship_to_market: marketRelationship(difference),
    most_likely_score: score,
    model_inputs: {
      current_home_score: input.currentHomeScore,
      current_away_score: input.currentAwayScore,
      period: input.period,
      clock: input.clock,
      recent_points: input.recentPoints ?? null,
      recent_minutes: input.recentMinutes ?? null,
      home_fouls_period: input.homeFoulsPeriod ?? null,
      away_fouls_period: input.awayFoulsPeriod ?? null,
      is_playoffs: isPlayoffs
    },
    formulas: [
      "projected_total = current_total + blended_rate * minutes_left + foul_bonus + overtime_bonus + blowout_drag",
      "blended_rate = weighted average of prior_rate, full_game_rate, and recent_rate",
      "score split = regularized blend of current scoring share, recent scoring share when available, and a neutral 50/50 prior"
    ]
  };
}

export function gameTime(period: number, clock: string): {
  elapsed: number;
  remaining: number;
  period_left: number;
  period_length: number;
} {
  const normalizedPeriod = Number.isFinite(period) && period > 0 ? Math.floor(period) : 1;
  const periodLeft = parseClockMinutes(clock);

  if (normalizedPeriod <= 4) {
    const elapsed = (normalizedPeriod - 1) * NBA_PERIOD_MINUTES + (NBA_PERIOD_MINUTES - periodLeft);
    const remaining = (4 - normalizedPeriod) * NBA_PERIOD_MINUTES + periodLeft;
    return {
      elapsed: Math.max(elapsed, 0),
      remaining: Math.max(remaining, 0),
      period_left: Math.max(periodLeft, 0),
      period_length: NBA_PERIOD_MINUTES
    };
  }

  const elapsed = NBA_REGULATION_MINUTES + (normalizedPeriod - 5) * NBA_OVERTIME_MINUTES + (NBA_OVERTIME_MINUTES - periodLeft);
  return {
    elapsed: Math.max(elapsed, 0),
    remaining: Math.max(periodLeft, 0),
    period_left: Math.max(periodLeft, 0),
    period_length: NBA_OVERTIME_MINUTES
  };
}

export function parseClockMinutes(clock: string): number {
  const value = clock.trim();
  if (value.includes(":")) {
    const [minutes, seconds] = value.split(":");
    const parsedMinutes = Number(minutes);
    const parsedSeconds = Number(seconds);
    if (Number.isFinite(parsedMinutes) && Number.isFinite(parsedSeconds)) {
      return parsedMinutes + parsedSeconds / 60;
    }
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds / 60;
  }

  return 0;
}

export function extractTotalLineFromMarket(market: NormalizedKalshiMarket): number | null {
  const numericStrike = firstFiniteNumber([market.floor_strike, market.cap_strike]);
  if (numericStrike !== null && plausibleNbaTotal(numericStrike)) {
    return numericStrike;
  }

  const text = [
    market.functional_strike,
    market.yes_sub_title,
    market.no_sub_title,
    market.title,
    market.subtitle
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return extractPlausibleTotal(text);
}

export function selectLiveTotalMarket(
  markets: NormalizedKalshiMarket[],
  matchup?: MatchupText,
  requireMatch = false
): MarketTotalCandidate | null {
  const candidates = markets
    .map((market) => {
      const line = extractTotalLineFromMarket(market);
      if (line === null) {
        return null;
      }

      const midpoint = marketMidpointCents(market);
      const matchScore = matchup ? marketMatchScore(market, matchup) : 0;
      return {
        market,
        line,
        midpoint_cents: midpoint,
        distance_from_even_cents: midpoint === null ? null : Math.abs(midpoint - 50),
        match_score: matchScore
      };
    })
    .filter((candidate): candidate is MarketTotalCandidate => candidate !== null)
    .filter((candidate) => !requireMatch || candidate.match_score > 0);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.match_score !== left.match_score) {
      return right.match_score - left.match_score;
    }
    return (left.distance_from_even_cents ?? 100) - (right.distance_from_even_cents ?? 100);
  });

  return candidates[0] ?? null;
}

export function extractRecentScoringFromGameStats(input: {
  pbp: unknown;
  period: number;
  clock: string;
  currentHomeScore: number;
  currentAwayScore: number;
  windowMinutes?: number;
}): RecentScoringWindow | null {
  const timing = gameTime(input.period, input.clock);
  const periodElapsed = timing.period_length - timing.period_left;
  if (periodElapsed <= 0) {
    return null;
  }

  const windowMinutes = Math.min(input.windowMinutes ?? 4, periodElapsed);
  const windowStart = periodElapsed - windowMinutes;
  const scoredEvents = flattenPbpEvents(input.pbp)
    .filter((event) => event.period === input.period)
    .filter((event) => event.elapsedInPeriod <= windowStart)
    .filter((event) => event.homeScore !== null && event.awayScore !== null)
    .sort((left, right) => right.elapsedInPeriod - left.elapsedInPeriod);

  const baseline = scoredEvents[0];
  if (!baseline || baseline.homeScore === null || baseline.awayScore === null) {
    return null;
  }

  const homePoints = Math.max(0, input.currentHomeScore - baseline.homeScore);
  const awayPoints = Math.max(0, input.currentAwayScore - baseline.awayScore);
  const points = homePoints + awayPoints;
  if (points <= 0 || windowMinutes <= 0) {
    return null;
  }

  return {
    points,
    minutes: roundStat(windowMinutes),
    home_points: homePoints,
    away_points: awayPoints,
    source: "kalshi_game_stats"
  };
}

function baselineTotal(
  input: LiveScoreProjectionInput,
  currentTotal: number,
  elapsed: number,
  minutesLeft: number
): number {
  if (input.pregameTotal !== null && input.pregameTotal !== undefined) {
    return input.pregameTotal;
  }
  if (input.marketTotalLine !== null && input.marketTotalLine !== undefined) {
    return input.marketTotalLine;
  }
  if (elapsed > 0) {
    return currentTotal + (currentTotal / elapsed) * minutesLeft;
  }
  return currentTotal;
}

function baselineRate(marketTotalLine: number | null | undefined, currentTotal: number): number {
  if (marketTotalLine !== null && marketTotalLine !== undefined) {
    return marketTotalLine / NBA_REGULATION_MINUTES;
  }
  return currentTotal / NBA_REGULATION_MINUTES;
}

function dynamicRateWeights(minutesLeft: number): [number, number, number] {
  if (minutesLeft > 24) {
    return [0.5, 0.35, 0.15];
  }
  if (minutesLeft > 12) {
    return [0.35, 0.4, 0.25];
  }
  if (minutesLeft > 6) {
    return [0.3, 0.3, 0.4];
  }
  if (minutesLeft > 2) {
    return [0.25, 0.25, 0.5];
  }
  return [0.2, 0.2, 0.6];
}

function foulsToGiveBeforePenalty(
  teamFoulsPeriod: number | null | undefined,
  period: number,
  periodLeft: number
): number | null {
  if (teamFoulsPeriod === null || teamFoulsPeriod === undefined) {
    return null;
  }
  if (period <= 4) {
    if (periodLeft <= 2) {
      return teamFoulsPeriod < 4 ? 1 : 0;
    }
    return Math.max(0, 4 - teamFoulsPeriod);
  }
  if (periodLeft <= 2) {
    return teamFoulsPeriod < 3 ? 1 : 0;
  }
  return Math.max(0, 3 - teamFoulsPeriod);
}

function lateGameFoulBonus(
  minutesLeft: number,
  margin: number,
  trailingFoulsToGive: number | null
): number {
  let bonus = 0;
  if (minutesLeft <= 1) {
    if (margin === 0) {
      bonus = 0.5;
    } else if (margin <= 3) {
      bonus = 1.5;
    } else if (margin <= 8) {
      bonus = 5.5;
    } else if (margin <= 12) {
      bonus = 3;
    }
  } else if (minutesLeft <= 2) {
    if (margin === 0) {
      bonus = 1;
    } else if (margin <= 3) {
      bonus = 2;
    } else if (margin <= 6) {
      bonus = 4;
    } else if (margin <= 10) {
      bonus = 2;
    }
  } else if (minutesLeft <= 5) {
    if (margin <= 3) {
      bonus = 2;
    } else if (margin <= 6) {
      bonus = 1.5;
    } else if (margin <= 10) {
      bonus = 0.5;
    }
  } else if (minutesLeft <= 10) {
    if (margin <= 6) {
      bonus = 1;
    } else if (margin <= 10) {
      bonus = 0.25;
    }
  }

  if (trailingFoulsToGive !== null && minutesLeft <= 2) {
    if (trailingFoulsToGive === 0) {
      bonus *= 1.15;
    } else if (trailingFoulsToGive === 1) {
      bonus *= 0.8;
    } else {
      bonus *= 0.65;
    }
  }

  return Math.max(-1, bonus);
}

function overtimeProbability(minutesLeft: number, margin: number): number {
  if (minutesLeft <= 1) {
    if (margin === 0) {
      return 0.22;
    }
    if (margin === 1) {
      return 0.16;
    }
    if (margin === 2) {
      return 0.1;
    }
    if (margin === 3) {
      return 0.07;
    }
    if (margin <= 5) {
      return 0.02;
    }
    return 0.003;
  }
  if (minutesLeft <= 2) {
    if (margin === 0) {
      return 0.18;
    }
    if (margin === 1) {
      return 0.12;
    }
    if (margin === 2) {
      return 0.08;
    }
    if (margin === 3) {
      return 0.06;
    }
    if (margin <= 5) {
      return 0.025;
    }
    return 0.005;
  }
  if (minutesLeft <= 5) {
    if (margin <= 1) {
      return 0.07;
    }
    if (margin <= 3) {
      return 0.04;
    }
    if (margin <= 6) {
      return 0.02;
    }
    return 0.003;
  }
  if (minutesLeft <= 10) {
    if (margin <= 3) {
      return 0.02;
    }
    if (margin <= 6) {
      return 0.01;
    }
  }
  return 0;
}

function blowoutDrag(minutesLeft: number, margin: number, isPlayoffs: boolean): number {
  const playoffOffset = isPlayoffs ? 0.5 : 0;
  if (minutesLeft <= 2 && margin >= 12) {
    return -2 + playoffOffset;
  }
  if (minutesLeft <= 5 && margin >= 14) {
    return -1.5 + playoffOffset;
  }
  if (minutesLeft <= 10 && margin >= 18) {
    return -1 + playoffOffset;
  }
  return 0;
}

function residualSigma(minutesLeft: number): number {
  if (minutesLeft > 12) {
    return 11;
  }
  if (minutesLeft > 6) {
    return 8;
  }
  if (minutesLeft > 2) {
    return 5.5;
  }
  return 4;
}

function mostLikelyScore(input: {
  currentHomeScore: number;
  currentAwayScore: number;
  projectedTotal: number;
  recentHomePoints?: number | null;
  recentAwayPoints?: number | null;
}): { home: number; away: number; total: number } {
  const roundedTotal = Math.max(Math.round(input.projectedTotal), input.currentHomeScore + input.currentAwayScore);
  const remainingPoints = Math.max(roundedTotal - input.currentHomeScore - input.currentAwayScore, 0);
  const currentShare =
    input.currentHomeScore + input.currentAwayScore > 0
      ? input.currentHomeScore / (input.currentHomeScore + input.currentAwayScore)
      : 0.5;
  const recentTotal = (input.recentHomePoints ?? 0) + (input.recentAwayPoints ?? 0);
  const recentShare = recentTotal > 0 ? (input.recentHomePoints ?? 0) / recentTotal : currentShare;
  const homeShare = clamp(
    SCORE_SPLIT_PRIOR_WEIGHT * 0.5 + 0.3 * currentShare + 0.2 * recentShare,
    0.35,
    0.65
  );
  let home = input.currentHomeScore + Math.round(remainingPoints * homeShare);
  home = Math.max(input.currentHomeScore, Math.min(home, roundedTotal - input.currentAwayScore));
  const away = Math.max(input.currentAwayScore, roundedTotal - home);

  return {
    home,
    away,
    total: home + away
  };
}

function marketRelationship(difference: number | null): "above_market" | "below_market" | "near_market" | "unavailable" {
  if (difference === null) {
    return "unavailable";
  }
  if (Math.abs(difference) <= 1) {
    return "near_market";
  }
  return difference > 0 ? "above_market" : "below_market";
}

function marketMidpointCents(market: NormalizedKalshiMarket): number | null {
  if (market.yes_bid_cents !== null && market.yes_ask_cents !== null) {
    return (market.yes_bid_cents + market.yes_ask_cents) / 2;
  }
  if (market.yes_bid_cents !== null && market.no_bid_cents !== null) {
    return (market.yes_bid_cents + (100 - market.no_bid_cents)) / 2;
  }
  if (market.last_price_cents !== null) {
    return market.last_price_cents;
  }
  return null;
}

function marketMatchScore(market: NormalizedKalshiMarket, matchup: MatchupText): number {
  const text = normalizeText(
    [
      market.ticker,
      market.event_ticker,
      market.title,
      market.subtitle,
      market.yes_sub_title,
      market.no_sub_title
    ].join(" ")
  );
  const homeTokens = teamTokens(matchup.homeName, matchup.homeAbbreviation);
  const awayTokens = teamTokens(matchup.awayName, matchup.awayAbbreviation);
  let score = 0;
  if (homeTokens.some((token) => text.includes(token))) {
    score += 2;
  }
  if (awayTokens.some((token) => text.includes(token))) {
    score += 2;
  }

  const occurrenceTime = parseDateMs(market.occurrence_datetime ?? market.open_time ?? market.close_time);
  const startTime = parseDateMs(matchup.startTime);
  if (occurrenceTime !== null && startTime !== null && Math.abs(occurrenceTime - startTime) <= 36 * 60 * 60 * 1000) {
    score += 1;
  }

  return score;
}

function teamTokens(name?: string | null, abbreviation?: string | null): string[] {
  const tokens = [name, abbreviation]
    .filter((part): part is string => Boolean(part))
    .flatMap((part) => {
      const normalized = normalizeText(part);
      const split = normalized.split(" ").filter((token) => token.length >= 3);
      return [normalized.replaceAll(" ", ""), ...split];
    });
  return Array.from(new Set(tokens)).filter((token) => token.length >= 3);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstFiniteNumber(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function extractPlausibleTotal(text: string): number | null {
  const candidates = Array.from(text.matchAll(/\b([1-3]\d{2}(?:\.\d+)?)\b/g))
    .map((match) => Number(match[1]))
    .filter(plausibleNbaTotal);
  return candidates[0] ?? null;
}

function plausibleNbaTotal(value: number): boolean {
  return Number.isFinite(value) && value >= 120 && value <= 320;
}

interface PbpScoredEvent {
  period: number;
  elapsedInPeriod: number;
  homeScore: number | null;
  awayScore: number | null;
}

function flattenPbpEvents(pbp: unknown): PbpScoredEvent[] {
  const root = asRecord(pbp);
  const periods = asArray(root.periods);
  return periods.flatMap((period, index) => {
    const periodRecord = asRecord(period);
    const periodNumber =
      numberFromUnknown(periodRecord.number ?? periodRecord.period ?? periodRecord.period_number ?? periodRecord.sequence) ??
      index + 1;
    return asArray(periodRecord.events).map((event) => {
      const item = asRecord(event);
      return {
        period: periodNumber,
        elapsedInPeriod: eventElapsedInPeriod(item),
        homeScore: scoreFromEvent(item, "home"),
        awayScore: scoreFromEvent(item, "away")
      };
    });
  });
}

function eventElapsedInPeriod(event: Record<string, unknown>): number {
  const elapsed = numberFromUnknown(event.elapsed_time ?? event.elapsed ?? event.period_elapsed);
  if (elapsed !== null) {
    return elapsed > 100 ? elapsed / 60 : elapsed;
  }

  const clock = stringFromUnknown(event.clock ?? event.wall_clock ?? event.game_clock ?? event.time);
  if (!clock) {
    return 0;
  }
  return Math.max(NBA_PERIOD_MINUTES - parseClockMinutes(clock), 0);
}

function scoreFromEvent(event: Record<string, unknown>, side: "home" | "away"): number | null {
  const candidates =
    side === "home"
      ? [event.home_points, event.home_score, event.homeScore, event.hscore]
      : [event.away_points, event.away_score, event.awayScore, event.ascore];
  return numberFromUnknown(candidates.find((candidate) => numberFromUnknown(candidate) !== null));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundProbability(value: number): number {
  return Math.round(value * 1000) / 1000;
}
