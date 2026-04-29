export interface LiveTrainingRow {
  event_id: string;
  period: number | null;
  clock: string | null;
  current_home_score: number | null;
  current_away_score: number | null;
  projected_home_score: number | null;
  projected_away_score: number | null;
  projected_total: number | null;
  projected_home_margin: number | null;
  market_total_line: number | null;
  difference_vs_market: number | null;
  elapsed_minutes: number | null;
  minutes_left: number | null;
  margin: number | null;
  full_game_rate: number | null;
  prior_rate: number | null;
  recent_rate: number | null;
  blended_rate: number | null;
  p_over: number | null;
  final_home_score: number;
  final_away_score: number;
}

export interface LiveModelArtifact {
  version: 1;
  trained_at: string;
  sample_count: number;
  game_count: number;
  effective_sample_count: number;
  train_count: number;
  validation_count: number;
  feature_columns: string[];
  bucket_coverage: Record<string, LiveModelBucketCoverage>;
  hidden_size: number;
  input_mean: number[];
  input_std: number[];
  hidden_weights: number[][];
  hidden_bias: number[];
  output_weights: number[][];
  output_bias: number[];
  metrics: {
    train_mae_total: number;
    train_mae_margin: number;
    validation_mae_total: number | null;
    validation_mae_margin: number | null;
  };
}

export interface LiveModelBucketCoverage {
  sample_count: number;
  game_count: number;
  effective_sample_count: number;
}

export interface LearnedProjection {
  projected_home_score: number;
  projected_away_score: number;
  projected_total: number;
  projected_home_margin: number;
  total_residual_correction: number;
  margin_residual_correction: number;
  raw_total_residual_correction: number;
  raw_margin_residual_correction: number;
  correction_cap: number;
  adjustment_status: "applied" | "clipped" | "skipped_low_coverage";
  warning: string | null;
  model_version: number;
  trained_at: string;
  sample_count: number;
  game_count: number | null;
  effective_sample_count: number | null;
  comparable_bucket: string;
  comparable_game_count: number;
  comparable_sample_count: number;
}

const FEATURE_COLUMNS = [
  "current_total",
  "current_home_score",
  "current_away_score",
  "heuristic_total",
  "heuristic_home_margin",
  "market_total_line",
  "difference_vs_market",
  "elapsed_minutes",
  "minutes_left",
  "margin",
  "full_game_rate",
  "prior_rate",
  "recent_rate",
  "blended_rate",
  "p_over",
  "period"
];

const DEFAULT_HIDDEN_SIZE = 8;
const TRAIN_FRACTION = 0.8;
const EPOCHS = 350;
const LEARNING_RATE = 0.01;
const TIME_BUCKET_MINUTES = 3;
const MIN_COMPARABLE_GAMES = 3;

interface TrainingExample {
  row: LiveTrainingRow;
  eventId: string;
  bucket: string;
  features: number[];
  targets: [number, number];
}

export function trainLiveModel(rows: LiveTrainingRow[], minSnapshots: number): LiveModelArtifact {
  const examples = rows
    .map((row) => toTrainingExample(row))
    .filter((example): example is TrainingExample => example !== null);
  if (examples.length < minSnapshots) {
    throw new Error(`Need at least ${minSnapshots} finalized live snapshots to train; found ${examples.length}.`);
  }

  const effectiveExamples = downsampleExamples(examples);
  if (effectiveExamples.length < minSnapshots) {
    throw new Error(
      `Need at least ${minSnapshots} game/time-bucket snapshots to train; found ${effectiveExamples.length}.`
    );
  }

  const split = splitExamplesByGame(effectiveExamples);
  const trainExamples = split.train;
  const validationExamples = split.validation;
  const normalization = normalizeExamples(trainExamples);
  const normalizedTrain = applyNormalization(trainExamples, normalization);
  const normalizedValidation = applyNormalization(validationExamples, normalization);
  const hiddenSize = DEFAULT_HIDDEN_SIZE;
  const parameters = initialParameters(FEATURE_COLUMNS.length, hiddenSize);

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const example of normalizedTrain) {
      trainOne(parameters, example, LEARNING_RATE);
    }
  }

  const trainMetrics = metrics(parameters, normalizedTrain);
  const validationMetrics = normalizedValidation.length > 0 ? metrics(parameters, normalizedValidation) : null;

  return {
    version: 1,
    trained_at: new Date().toISOString(),
    sample_count: examples.length,
    game_count: distinctCount(examples.map((example) => example.eventId)),
    effective_sample_count: effectiveExamples.length,
    train_count: normalizedTrain.length,
    validation_count: normalizedValidation.length,
    feature_columns: FEATURE_COLUMNS,
    bucket_coverage: bucketCoverage(examples, effectiveExamples),
    hidden_size: hiddenSize,
    input_mean: normalization.mean,
    input_std: normalization.std,
    hidden_weights: parameters.hiddenWeights,
    hidden_bias: parameters.hiddenBias,
    output_weights: parameters.outputWeights,
    output_bias: parameters.outputBias,
    metrics: {
      train_mae_total: roundMetric(trainMetrics.total),
      train_mae_margin: roundMetric(trainMetrics.margin),
      validation_mae_total: validationMetrics ? roundMetric(validationMetrics.total) : null,
      validation_mae_margin: validationMetrics ? roundMetric(validationMetrics.margin) : null
    }
  };
}

export function predictLearnedProjection(model: LiveModelArtifact, projectionData: unknown): LearnedProjection | null {
  const row = rowFromProjectionData(projectionData);
  if (!row) {
    return null;
  }

  const features = FEATURE_COLUMNS.map((column) => featureValue(row, column));
  const normalized = features.map((value, index) => (value - model.input_mean[index]) / model.input_std[index]);
  const [rawTotalCorrection, rawMarginCorrection] = forward(model, normalized);
  const heuristicTotal = row.projected_total as number;
  const heuristicMargin = row.projected_home_margin as number;
  const currentHome = row.current_home_score ?? 0;
  const currentAway = row.current_away_score ?? 0;
  const bucket = projectionBucket(row);
  const coverage = model.bucket_coverage?.[bucket] ?? null;
  const comparableGameCount = coverage?.game_count ?? 0;
  const comparableSampleCount = coverage?.sample_count ?? 0;
  const correctionCap = totalCorrectionCap(row.minutes_left ?? null);
  const marginCap = marginCorrectionCap(row.minutes_left ?? null);
  const coverageIsThin = comparableGameCount < MIN_COMPARABLE_GAMES;
  const clippedTotalCorrection = clamp(rawTotalCorrection, -correctionCap, correctionCap);
  const clippedMarginCorrection = clamp(rawMarginCorrection, -marginCap, marginCap);
  const wasClipped =
    clippedTotalCorrection !== rawTotalCorrection || clippedMarginCorrection !== rawMarginCorrection;
  const totalCorrection = coverageIsThin ? 0 : clippedTotalCorrection;
  const marginCorrection = coverageIsThin ? 0 : clippedMarginCorrection;
  const projectedTotal = Math.max(currentHome + currentAway, heuristicTotal + totalCorrection);
  const projectedMargin = heuristicMargin + marginCorrection;
  const homeRaw = (projectedTotal + projectedMargin) / 2;
  const home = Math.max(currentHome, Math.round(homeRaw));
  const away = Math.max(currentAway, Math.round(projectedTotal - home));
  const adjustmentStatus = coverageIsThin ? "skipped_low_coverage" : wasClipped ? "clipped" : "applied";

  return {
    projected_home_score: home,
    projected_away_score: away,
    projected_total: roundMetric(home + away),
    projected_home_margin: roundMetric(home - away),
    total_residual_correction: roundMetric(totalCorrection),
    margin_residual_correction: roundMetric(marginCorrection),
    raw_total_residual_correction: roundMetric(rawTotalCorrection),
    raw_margin_residual_correction: roundMetric(rawMarginCorrection),
    correction_cap: correctionCap,
    adjustment_status: adjustmentStatus,
    warning:
      adjustmentStatus === "skipped_low_coverage"
        ? `Learned correction skipped: ${comparableGameCount} comparable games in ${bucket}.`
        : adjustmentStatus === "clipped"
          ? `Learned correction clipped to ${correctionCap} points for this game phase.`
          : null,
    model_version: model.version,
    trained_at: model.trained_at,
    sample_count: model.sample_count,
    game_count: model.game_count ?? null,
    effective_sample_count: model.effective_sample_count ?? null,
    comparable_bucket: bucket,
    comparable_game_count: comparableGameCount,
    comparable_sample_count: comparableSampleCount
  };
}

function rowFromProjectionData(projectionData: unknown): Partial<LiveTrainingRow> | null {
  if (!projectionData || typeof projectionData !== "object") {
    return null;
  }
  const data = projectionData as Record<string, unknown>;
  const projection = asRecord(data.live_projection);
  const teams = asRecord(data.teams);
  const home = asRecord(teams.home);
  const away = asRecord(teams.away);
  const modelInputs = asRecord(projection.model_inputs);
  const modelDetails = asRecord(asRecord(projection.debug).model_details);

  const projectedHome = finiteNumber(projection.projected_home_score);
  const projectedAway = finiteNumber(projection.projected_away_score);
  const projectedTotal = finiteNumber(projection.projected_total);
  const currentHome = finiteNumber(home.score) ?? finiteNumber(modelInputs.current_home_score);
  const currentAway = finiteNumber(away.score) ?? finiteNumber(modelInputs.current_away_score);
  if (projectedHome === null || projectedAway === null || projectedTotal === null) {
    return null;
  }

  return {
    event_id: String(data.event_id ?? ""),
    period: finiteNumber(asRecord(data.game_status).period),
    clock: typeof asRecord(data.game_status).clock === "string" ? (asRecord(data.game_status).clock as string) : null,
    current_home_score: currentHome,
    current_away_score: currentAway,
    projected_home_score: projectedHome,
    projected_away_score: projectedAway,
    projected_total: projectedTotal,
    projected_home_margin: projectedHome - projectedAway,
    market_total_line: finiteNumber(projection.market_total_line),
    difference_vs_market: finiteNumber(projection.difference_vs_market),
    elapsed_minutes: finiteNumber(modelDetails.elapsed_minutes) ?? null,
    minutes_left: finiteNumber(modelDetails.minutes_left) ?? null,
    margin: finiteNumber(modelDetails.margin) ?? null,
    full_game_rate: finiteNumber(modelDetails.full_game_rate) ?? null,
    prior_rate: finiteNumber(modelDetails.prior_rate) ?? null,
    recent_rate: finiteNumber(modelDetails.recent_rate) ?? null,
    blended_rate: finiteNumber(modelDetails.blended_rate) ?? null,
    p_over: finiteNumber(projection.p_over)
  };
}

function toTrainingExample(row: LiveTrainingRow): TrainingExample | null {
  if (row.projected_total === null || row.projected_home_margin === null) {
    return null;
  }

  const finalTotal = row.final_home_score + row.final_away_score;
  const finalMargin = row.final_home_score - row.final_away_score;
  return {
    row,
    eventId: row.event_id || "unknown",
    bucket: projectionBucket(row),
    features: FEATURE_COLUMNS.map((column) => featureValue(row, column)),
    targets: [finalTotal - row.projected_total, finalMargin - row.projected_home_margin]
  };
}

function featureValue(row: Partial<LiveTrainingRow>, column: string): number {
  switch (column) {
    case "current_total":
      return (row.current_home_score ?? 0) + (row.current_away_score ?? 0);
    case "heuristic_total":
      return row.projected_total ?? 0;
    case "heuristic_home_margin":
      return row.projected_home_margin ?? 0;
    case "market_total_line":
      return row.market_total_line ?? row.projected_total ?? 0;
    case "p_over":
      return row.p_over ?? 0.5;
    default:
      return finiteNumber((row as Record<string, unknown>)[column]) ?? 0;
  }
}

function downsampleExamples(examples: TrainingExample[]): TrainingExample[] {
  const seen = new Set<string>();
  const selected: TrainingExample[] = [];
  for (const example of examples) {
    const key = `${example.eventId}:${example.bucket}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(example);
  }
  return selected;
}

function splitExamplesByGame(examples: TrainingExample[]): { train: TrainingExample[]; validation: TrainingExample[] } {
  const gameIds = unique(examples.map((example) => example.eventId));
  if (gameIds.length <= 1) {
    return {
      train: examples,
      validation: []
    };
  }

  const trainGameCount = Math.min(gameIds.length - 1, Math.max(1, Math.floor(gameIds.length * TRAIN_FRACTION)));
  const trainGames = new Set(gameIds.slice(0, trainGameCount));
  return {
    train: examples.filter((example) => trainGames.has(example.eventId)),
    validation: examples.filter((example) => !trainGames.has(example.eventId))
  };
}

function bucketCoverage(
  examples: TrainingExample[],
  effectiveExamples: TrainingExample[]
): Record<string, LiveModelBucketCoverage> {
  const coverage: Record<string, { sample_count: number; games: Set<string>; effective_sample_count: number }> = {};
  for (const example of examples) {
    const entry = coverage[example.bucket] ?? {
      sample_count: 0,
      games: new Set<string>(),
      effective_sample_count: 0
    };
    entry.sample_count += 1;
    entry.games.add(example.eventId);
    coverage[example.bucket] = entry;
  }
  for (const example of effectiveExamples) {
    const entry = coverage[example.bucket];
    if (entry) {
      entry.effective_sample_count += 1;
    }
  }

  return Object.fromEntries(
    Object.entries(coverage).map(([bucket, entry]) => [
      bucket,
      {
        sample_count: entry.sample_count,
        game_count: entry.games.size,
        effective_sample_count: entry.effective_sample_count
      }
    ])
  );
}

function projectionBucket(row: Partial<LiveTrainingRow>): string {
  const period = finiteNumber(row.period) ?? periodFromMinutesLeft(row.minutes_left);
  const minutesLeft = finiteNumber(row.minutes_left);
  if (minutesLeft === null) {
    return `p${period}:unknown`;
  }

  const bucketStart = Math.floor(minutesLeft / TIME_BUCKET_MINUTES) * TIME_BUCKET_MINUTES;
  return `p${period}:m${bucketStart}-${bucketStart + TIME_BUCKET_MINUTES}`;
}

function periodFromMinutesLeft(minutesLeft: number | null | undefined): number {
  if (typeof minutesLeft !== "number" || !Number.isFinite(minutesLeft)) {
    return 0;
  }
  if (minutesLeft > 36) {
    return 1;
  }
  if (minutesLeft > 24) {
    return 2;
  }
  if (minutesLeft > 12) {
    return 3;
  }
  if (minutesLeft > 0) {
    return 4;
  }
  return 4;
}

function totalCorrectionCap(minutesLeft: number | null): number {
  if (minutesLeft === null || minutesLeft > 36) {
    return 4;
  }
  if (minutesLeft > 24) {
    return 6;
  }
  if (minutesLeft > 12) {
    return 8;
  }
  if (minutesLeft > 6) {
    return 10;
  }
  if (minutesLeft > 2) {
    return 12;
  }
  return 14;
}

function marginCorrectionCap(minutesLeft: number | null): number {
  if (minutesLeft === null || minutesLeft > 36) {
    return 6;
  }
  if (minutesLeft > 24) {
    return 8;
  }
  if (minutesLeft > 12) {
    return 10;
  }
  return 14;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function distinctCount(values: string[]): number {
  return unique(values).length;
}

function normalizeExamples(examples: TrainingExample[]): { mean: number[]; std: number[] } {
  const mean = FEATURE_COLUMNS.map((_, index) =>
    examples.reduce((sum, example) => sum + example.features[index], 0) / examples.length
  );
  const std = FEATURE_COLUMNS.map((_, index) => {
    const variance =
      examples.reduce((sum, example) => sum + Math.pow(example.features[index] - mean[index], 2), 0) / examples.length;
    return Math.max(0.000001, Math.sqrt(variance));
  });
  return { mean, std };
}

function applyNormalization(
  examples: TrainingExample[],
  normalization: { mean: number[]; std: number[] }
): TrainingExample[] {
  return examples.map((example) => ({
    ...example,
    targets: example.targets,
    features: example.features.map((value, index) => (value - normalization.mean[index]) / normalization.std[index])
  }));
}

function initialParameters(inputSize: number, hiddenSize: number) {
  const random = seededRandom(42);
  return {
    hiddenWeights: Array.from({ length: hiddenSize }, () =>
      Array.from({ length: inputSize }, () => (random() - 0.5) * 0.2)
    ),
    hiddenBias: Array.from({ length: hiddenSize }, () => 0),
    outputWeights: Array.from({ length: 2 }, () => Array.from({ length: hiddenSize }, () => (random() - 0.5) * 0.2)),
    outputBias: [0, 0]
  };
}

function trainOne(
  parameters: ReturnType<typeof initialParameters>,
  example: TrainingExample,
  learningRate: number
): void {
  const hidden = parameters.hiddenWeights.map((weights, index) =>
    Math.tanh(dot(weights, example.features) + parameters.hiddenBias[index])
  );
  const output = parameters.outputWeights.map((weights, index) => dot(weights, hidden) + parameters.outputBias[index]);
  const outputErrors = output.map((value, index) => value - example.targets[index]);
  const hiddenErrors = hidden.map((hiddenValue, hiddenIndex) => {
    const downstream = outputErrors.reduce(
      (sum, error, outputIndex) => sum + error * parameters.outputWeights[outputIndex][hiddenIndex],
      0
    );
    return downstream * (1 - hiddenValue * hiddenValue);
  });

  for (let outputIndex = 0; outputIndex < parameters.outputWeights.length; outputIndex += 1) {
    for (let hiddenIndex = 0; hiddenIndex < hidden.length; hiddenIndex += 1) {
      parameters.outputWeights[outputIndex][hiddenIndex] -= learningRate * outputErrors[outputIndex] * hidden[hiddenIndex];
    }
    parameters.outputBias[outputIndex] -= learningRate * outputErrors[outputIndex];
  }

  for (let hiddenIndex = 0; hiddenIndex < parameters.hiddenWeights.length; hiddenIndex += 1) {
    for (let inputIndex = 0; inputIndex < example.features.length; inputIndex += 1) {
      parameters.hiddenWeights[hiddenIndex][inputIndex] -=
        learningRate * hiddenErrors[hiddenIndex] * example.features[inputIndex];
    }
    parameters.hiddenBias[hiddenIndex] -= learningRate * hiddenErrors[hiddenIndex];
  }
}

function metrics(parameters: ReturnType<typeof initialParameters>, examples: TrainingExample[]): { total: number; margin: number } {
  if (examples.length === 0) {
    return { total: 0, margin: 0 };
  }
  const sums = examples.reduce(
    (acc, example) => {
      const output = forward(parameters, example.features);
      acc.total += Math.abs(output[0] - example.targets[0]);
      acc.margin += Math.abs(output[1] - example.targets[1]);
      return acc;
    },
    { total: 0, margin: 0 }
  );
  return {
    total: sums.total / examples.length,
    margin: sums.margin / examples.length
  };
}

function forward(
  model: Pick<LiveModelArtifact, "hidden_weights" | "hidden_bias" | "output_weights" | "output_bias">,
  features: number[]
): [number, number];
function forward(parameters: ReturnType<typeof initialParameters>, features: number[]): [number, number];
function forward(
  model: Pick<LiveModelArtifact, "hidden_weights" | "hidden_bias" | "output_weights" | "output_bias"> | ReturnType<typeof initialParameters>,
  features: number[]
): [number, number] {
  const hiddenWeights = "hidden_weights" in model ? model.hidden_weights : model.hiddenWeights;
  const hiddenBias = "hidden_bias" in model ? model.hidden_bias : model.hiddenBias;
  const outputWeights = "output_weights" in model ? model.output_weights : model.outputWeights;
  const outputBias = "output_bias" in model ? model.output_bias : model.outputBias;
  const hidden = hiddenWeights.map((weights, index) => Math.tanh(dot(weights, features) + hiddenBias[index]));
  return [
    dot(outputWeights[0], hidden) + outputBias[0],
    dot(outputWeights[1], hidden) + outputBias[1]
  ];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
