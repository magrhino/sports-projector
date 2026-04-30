import type { Game, ProjectionMetric, Team } from "./types";

export function sortGames(games: Game[]): Game[] {
  return [...games].sort((left, right) => {
    const rankDiff = gameStatusRank(left) - gameStatusRank(right);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    const leftTime = Date.parse(left.start_time || "");
    const rightTime = Date.parse(right.start_time || "");
    return safeTime(leftTime) - safeTime(rightTime);
  });
}

export function isLiveGame(game: Game | null | undefined): boolean {
  const state = String(game?.status?.state || "").toLowerCase();
  if (state === "in") {
    return true;
  }

  const status = `${game?.status?.description || ""} ${game?.status?.detail || ""}`.toLowerCase();
  return !game?.status?.completed && /\b(in progress|quarter|half|period|inning)\b/.test(status);
}

export function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function formatScoreStatus(game: Game | null | undefined): string {
  if (!game) {
    return "-";
  }

  const away = game.teams?.away?.score;
  const home = game.teams?.home?.score;
  const status = game.status?.detail || game.status?.description || "";

  if (away !== null && away !== undefined && home !== null && home !== undefined) {
    return status ? `${away}-${home} | ${status}` : `${away}-${home}`;
  }

  return status || "-";
}

export function formatLiveGameMatchup(game: Game): string {
  const away = game.teams?.away;
  const home = game.teams?.home;
  return `${displayTeamCode(away, "Away")} ${formatNullableNumber(away?.score)} - ${displayTeamCode(
    home,
    "Home"
  )} ${formatNullableNumber(home?.score)}`;
}

export function formatScoreLine(
  awayName: string,
  awayScore: unknown,
  homeName: string,
  homeScore: unknown
): string {
  return `${awayName} ${formatNullableNumber(awayScore)} - ${homeName} ${formatNullableNumber(homeScore)}`;
}

export function displayTeamCode(team: Team | undefined, fallback: string): string {
  const name = String(team?.name || "");
  const abbreviation = String(team?.abbreviation || "");
  if (team?.id === "18" || name.toLowerCase().includes("knicks") || abbreviation.toUpperCase() === "NY") {
    return "NYK";
  }
  return abbreviation || name || fallback;
}

export function teamLogoUrl(team: Team | undefined): string {
  const logo = String(team?.logo || "");
  if (!logo) {
    return "";
  }

  try {
    const url = new URL(logo);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "-";
}

export function formatNullableNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

export function formatDisplayScore(value: unknown): string {
  const numericScore = scoreAsNumber(value);
  if (numericScore !== undefined) {
    return formatScoreNumber(numericScore);
  }

  const label = typeof value === "string" ? value.trim() : "";
  return label || "-";
}

export function formatScoreTotal(awayScore: unknown, homeScore: unknown): string {
  const away = scoreAsNumber(awayScore);
  const home = scoreAsNumber(homeScore);
  return away !== undefined && home !== undefined ? formatScoreNumber(away + home) : "-";
}

export function formatGameTimeLeft(status: unknown, inputs: unknown): string {
  const gameStatus = asRecord(status) ?? {};
  const modelInputs = asRecord(inputs) ?? {};
  const clock = asString(gameStatus.clock) || asString(modelInputs.clock);
  const period = asNumber(gameStatus.period) ?? asNumber(modelInputs.period);
  const periodLabel = formatPeriodLabel(period);
  if (!clock) {
    return periodLabel || "-";
  }
  return periodLabel ? `${clock} ${periodLabel}` : String(clock);
}

export function formatPeriodLabel(period: number | undefined): string {
  if (typeof period !== "number" || !Number.isFinite(period)) {
    return "";
  }
  return period > 4 ? `OT${period - 4}` : `Q${period}`;
}

export function formatProbability(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "-";
}

export function formatTrainingError(payload: unknown): string {
  const body = asRecord(payload) ?? {};
  const tracker = asRecord(body.tracker) ?? {};
  const training = asRecord(tracker.training);
  const collected = tracker.snapshots;
  if (training && typeof collected === "number") {
    const effective = asNumber(training.effective_snapshots);
    const effectiveNote = effective === undefined ? "" : `, ${effective} effective`;
    return `${asString(body.error) || "Training failed."} ${collected} collected snapshots, ${
      asNumber(training.snapshots) || 0
    } finalized trainable snapshots${effectiveNote}.`;
  }
  return asString(body.error) || "Training failed.";
}

export function leagueLabel(league: string): string {
  return String(league || "").toUpperCase();
}

export function formatSignedNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

export function liveMetrics(data: Record<string, unknown>): ProjectionMetric[] {
  const projection = asRecord(data.live_projection) ?? {};
  const learned = asRecord(projection.learned_projection);
  const teams = asRecord(data.teams) ?? {};
  const home = (asRecord(teams.home) ?? {}) as Team;
  const away = (asRecord(teams.away) ?? {}) as Team;
  const metrics = [
    {
      label: "Projected score",
      value: formatScoreLine(
        displayTeamCode(away, "Away"),
        projection.projected_away_score,
        displayTeamCode(home, "Home"),
        projection.projected_home_score
      )
    },
    { label: "Projected total", value: formatNumber(projection.projected_total) },
    { label: "Time left", value: formatGameTimeLeft(data.game_status, projection.model_inputs) },
    {
      label: "Current score",
      value: formatScoreLine(displayTeamCode(away, "Away"), away.score, displayTeamCode(home, "Home"), home.score)
    },
    { label: "Market total", value: formatNullableNumber(projection.market_total_line) },
    { label: "Over probability", value: formatProbability(projection.p_over) }
  ];
  if (learned) {
    metrics.push(
      {
        label: "Learned score",
        value: formatScoreLine(
          displayTeamCode(away, "Away"),
          learned.projected_away_score,
          displayTeamCode(home, "Home"),
          learned.projected_home_score
        )
      },
      { label: "Learned total", value: formatNumber(learned.projected_total) }
    );
  }
  return metrics;
}

export function historicalMetrics(data: Record<string, unknown>): ProjectionMetric[] {
  const teams = asRecord(data.teams) ?? {};
  const homeName = asString(teams.home) || "Home";
  const awayName = asString(teams.away) || "Away";
  const marketComparison = asRecord(data.market_comparison) ?? {};
  const metrics = [
    {
      label: "Projected score",
      value: formatScoreLine(awayName, data.projected_away_score, homeName, data.projected_home_score)
    },
    { label: "Projected total", value: formatNumber(data.projected_total) },
    { label: "Home margin", value: formatNullableNumber(data.projected_home_margin) }
  ];
  if (typeof marketComparison.market_total === "number" && Number.isFinite(marketComparison.market_total)) {
    metrics.push({ label: "Pregame market total", value: formatNullableNumber(marketComparison.market_total) });
  }
  return metrics;
}

export function projectionNote(data: Record<string, unknown>, kind: "live" | "historical"): string {
  if (kind === "live") {
    const projection = asRecord(data.live_projection) ?? {};
    const quality = asRecord(projection.data_quality);
    const inputs = asRecord(projection.model_inputs) ?? {};
    const marketDifference = projection.difference_vs_market;
    const learned = asRecord(projection.learned_projection);
    if (!quality) {
      return "";
    }
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
    const recentWindow =
      typeof inputs.recent_points === "number" && typeof inputs.recent_minutes === "number"
        ? `Recent window: ${inputs.recent_points} pts / ${inputs.recent_minutes} min`
        : "";
    const marketNote =
      typeof marketDifference === "number" && Math.abs(marketDifference) >= 15
        ? `High variance: ${formatSignedNumber(marketDifference)} vs market`
        : "";
    const learnedModel = learned ? formatLearnedModelNote(learned) : "";
    const learnedCaution = learned ? formatLearnedCaution(learned) : "";
    return [
      asString(quality.status) ? `Status: ${quality.status}` : "",
      asString(quality.recent_scoring_source) ? `Source: ${quality.recent_scoring_source}` : "",
      recentWindow,
      learnedModel,
      learnedCaution,
      marketNote,
      String(warnings[0] || "")
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return [
    "Historical baseline; live in-game state and live market movement are excluded.",
    asString(data.game_date) ? `Game date: ${data.game_date}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function formatLearnedModelNote(learned: Record<string, unknown>): string {
  const samples = asNumber(learned.sample_count);
  const games = asNumber(learned.game_count);
  if (games !== undefined && samples !== undefined) {
    return `Learned model: ${games} games / ${samples} snapshots`;
  }
  if (samples !== undefined) {
    return `Learned model: ${samples} snapshots`;
  }
  return "";
}

function formatLearnedCaution(learned: Record<string, unknown>): string {
  const status = asString(learned.adjustment_status);
  if (status === "skipped_low_coverage") {
    return "Learned correction skipped: low coverage";
  }
  if (status === "clipped") {
    return "Learned correction clipped";
  }
  return "";
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function gameStatusRank(game: Game): number {
  if (isLiveGame(game)) {
    return 0;
  }
  if (game.status?.completed || game.status?.state === "post") {
    return 2;
  }
  return 1;
}

function safeTime(value: number): number {
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function scoreAsNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function formatScoreNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
