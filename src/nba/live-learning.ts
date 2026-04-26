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
  train_count: number;
  validation_count: number;
  feature_columns: string[];
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

export interface LearnedProjection {
  projected_home_score: number;
  projected_away_score: number;
  projected_total: number;
  projected_home_margin: number;
  total_residual_correction: number;
  margin_residual_correction: number;
  model_version: number;
  trained_at: string;
  sample_count: number;
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

interface TrainingExample {
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

  const trainCount = Math.max(1, Math.floor(examples.length * TRAIN_FRACTION));
  const trainExamples = examples.slice(0, trainCount);
  const validationExamples = examples.slice(trainCount);
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
    train_count: normalizedTrain.length,
    validation_count: normalizedValidation.length,
    feature_columns: FEATURE_COLUMNS,
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
  const [totalCorrection, marginCorrection] = forward(model, normalized);
  const heuristicTotal = row.projected_total as number;
  const heuristicMargin = row.projected_home_margin as number;
  const currentHome = row.current_home_score ?? 0;
  const currentAway = row.current_away_score ?? 0;
  const projectedTotal = Math.max(currentHome + currentAway, heuristicTotal + totalCorrection);
  const projectedMargin = heuristicMargin + marginCorrection;
  const homeRaw = (projectedTotal + projectedMargin) / 2;
  const home = Math.max(currentHome, Math.round(homeRaw));
  const away = Math.max(currentAway, Math.round(projectedTotal - home));

  return {
    projected_home_score: home,
    projected_away_score: away,
    projected_total: roundMetric(home + away),
    projected_home_margin: roundMetric(home - away),
    total_residual_correction: roundMetric(totalCorrection),
    margin_residual_correction: roundMetric(marginCorrection),
    model_version: model.version,
    trained_at: model.trained_at,
    sample_count: model.sample_count
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
