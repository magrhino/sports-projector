You are Codex working in the uploaded `nba_historical_projection` repository. Your task is to plan and then implement an evidence-based upgrade to the current NBA historical projection model using the five research PDFs bundled in `research_pack/articles/`.

## Goal

Improve the existing NBA totals and home-margin projection pipeline by adding learning and betting-market modeling ideas from the supplied scholarly papers. Do not promise guaranteed betting profit. The output should remain a projection/research tool with strong validation, calibration, no leakage, and transparent uncertainty.

## Current repository architecture to preserve

The uploaded model already includes these important pieces:

- `nba_historical_projection/training.py`
  - Trains XGBoost regressors for `total_score` and `home_margin`.
  - Supports direct targets and market-residual targets.
  - Uses chronological sorting and rolling-origin validation residuals.
  - Stores RMSE, MAE, residual standard deviation, and empirical uncertainty intervals.

- `nba_historical_projection/models.py`
  - Loads artifacts from the manifest.
  - Predicts `projected_total` and `projected_home_margin`.
  - Adds market total/spread back when target mode is `market_residual`.
  - Returns uncertainty and market comparison fields.

- `nba_historical_projection/features.py`
  - Builds feature vectors from request inputs and artifact team stats.
  - Already maps market fields such as `OU`, `Spread`, `MARKET_TOTAL_CLOSE`, `MARKET_SPREAD_CLOSE`, opening lines, and line moves.

- `nba_historical_projection/sportsdb_import.py`
  - Builds training rows and artifacts.
  - Creates market residual targets when market lines are available.
  - Creates linear fallback models.

- `nba_historical_projection/cli.py`
  - Exposes `train`, `import-sportsdb`, `evaluate`, and `predict` commands.

Keep backward compatibility with existing artifacts unless a migration is unavoidable. If schema changes are necessary, add a version field and migration/default handling.

## Research papers to use

Read these PDFs before coding and map each one to implementation work:

1. `01_Walsh_Joshi_2024_ML_for_sports_betting_accuracy_vs_calibration.pdf`
   - Core lesson: model calibration matters more than raw accuracy for betting-style decisions.
   - Implementation hook: add calibrated probabilities, reliability curves/tables, expected calibration error, Brier score, and log-loss. Use calibration metrics as first-class model-selection criteria, not just RMSE/MAE.

2. `02_Hubacek_Sir_2023_Beating_the_market_with_a_bad_predictive_model.pdf`
   - Core lesson: a profitable/value signal may come from being deliberately less correlated with the market while exploiting market-maker bias.
   - Implementation hook: add an experimental market-decorrelation mode or selection criterion for value signals. Start with out-of-fold signal diagnostics and correlation penalties before attempting a custom objective.

3. `03_Dmochowski_2023_Statistical_theory_optimal_decision_making_sports_betting.pdf`
   - Core lesson: spreads/totals are quantile-decision problems; medians and other quantiles can matter more than mean predictions.
   - Implementation hook: add quantile regression for total and margin residuals/direct targets. Return median, interval quantiles, cover/over probabilities, and no-bet thresholds based on uncertainty.

4. `04_Wunderlich_Memmert_2018_Betting_odds_rating_system.pdf`
   - Core lesson: betting odds can be used as strong transferred-information signals to rate teams.
   - Implementation hook: add market-implied team ratings/features from available pregame/closing odds and spreads, while avoiding leakage.

5. `05_Guo_Sanner_Graepel_Buntine_2012_Score_based_Bayesian_skill_learning.pdf`
   - Core lesson: score-based skill models retain more information than win/loss models and can estimate offensive/defensive strengths.
   - Implementation hook: add online score-based team-skill features with uncertainty from prior completed games only.

## Planning instructions

Before editing code, produce a short implementation plan with:

1. Baseline reproduction steps.
2. A module-by-module change list.
3. Validation and leakage checks.
4. Acceptance criteria.
5. A low-risk implementation sequence.

Then implement in small, testable steps. Prefer clear, maintainable code over a one-shot rewrite.

## Phase 0: Baseline and guardrails

1. Reproduce the current training/evaluation path with a small historical dataset or fixture.
2. Save baseline metrics for direct and market-residual models:
   - RMSE
   - MAE
   - residual standard deviation
   - empirical interval coverage
   - current backtest or evaluation outputs
3. Add tests, fixtures, or smoke tests before changing model behavior.
4. Add explicit leakage checks:
   - Feature rows for game `t` may use only information available before game `t`.
   - Team ratings/skills must be updated only after the game is consumed.
   - Closing lines may be used only if the prediction scenario explicitly represents pregame closing-line prediction; otherwise use opening lines or caller-provided market inputs.

## Phase 1: Calibration-first probability layer

Inspired by Walsh & Joshi, add calibration diagnostics and probability calibration around the current regression outputs.

Implementation tasks:

1. Generate out-of-fold chronological predictions for:
   - total score
   - home margin
   - total market residual
   - margin market residual
2. Convert projection distributions into event probabilities:
   - `prob_over_market_total`
   - `prob_under_market_total`
   - `prob_home_cover`
   - `prob_away_cover`
   - optionally `prob_home_win`
3. Use empirical residual distributions at first. Then add calibration methods:
   - isotonic calibration for enough samples
   - Platt/logistic calibration as a fallback
   - calibration by market type: totals vs spreads
4. Add metrics:
   - Brier score
   - log-loss
   - expected calibration error (ECE)
   - reliability bin table
   - calibration curve data
5. Persist calibration artifacts in the manifest:
   - calibration method
   - fitted parameters or bin map
   - validation fold period
   - calibration metrics
6. Update `predict` output to include calibrated probabilities and calibration metadata.

Acceptance criteria:

- Existing predictions still work if no calibration artifact exists.
- `evaluate` reports calibration metrics when market lines exist.
- Probability outputs are bounded in `[0, 1]` and monotonic with respect to the projected edge.
- Calibration is selected by Brier/log-loss/ECE, not only RMSE.

## Phase 2: Quantile models and distributional predictions

Inspired by Dmochowski, add quantile-based projections for totals and spreads.

Implementation tasks:

1. Add optional quantile training for both model keys:
   - `total_score`
   - `home_margin`
2. Train quantiles on the same target mode as the chosen model:
   - direct target, or
   - market residual target when market lines are available
3. Recommended quantiles:
   - `0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95`
4. Use XGBoost `reg:quantileerror` if the installed XGBoost supports it. Otherwise use a fallback such as scikit-learn `GradientBoostingRegressor(loss="quantile")` or `HistGradientBoostingRegressor(loss="quantile")`.
5. Add pinball loss and empirical coverage metrics.
6. Add quantile crossing correction by sorting quantiles after prediction or fitting a monotone post-processor.
7. Update prediction response:
   - `projected_total_quantiles`
   - `projected_home_margin_quantiles`
   - `median_total`
   - `median_home_margin`
   - calibrated probabilities for over/under and cover using the quantile/CDF estimate
8. Use a no-bet/no-action zone when uncertainty is too high or edge is below estimated vig/threshold. Label this as an informational model recommendation, not betting advice.

Acceptance criteria:

- Quantile outputs are ordered.
- Coverage on validation data is reported for each interval.
- Quantile models do not degrade existing mean prediction path.
- If quantile training is disabled, artifacts and predictions remain backward-compatible.

## Phase 3: Market-implied rating features

Inspired by Wunderlich & Memmert, add a team-strength feature layer derived from market information.

Implementation tasks:

1. Create a new module, suggested name: `nba_historical_projection/team_ratings.py`.
2. Implement an online market-implied rating system using only prior games and available pregame market data.
3. Candidate features:
   - `HOME_MARKET_RATING`
   - `AWAY_MARKET_RATING`
   - `MARKET_RATING_DIFF`
   - `HOME_MARKET_RATING_PREV_N_AVG`
   - `AWAY_MARKET_RATING_PREV_N_AVG`
   - `MARKET_TOTAL_TEAM_ENVIRONMENT_PRIOR`
   - `MARKET_SPREAD_PRIOR_RESIDUAL_FORM`
4. For NBA spreads, treat the closing or opening spread as a market estimate of home margin, adjusted for home-court advantage if you add one. Keep the sign convention consistent with existing `MARKET_SPREAD_CLOSE` and `Home-Margin`.
5. Add CLI flags:
   - `--rating-features none|market`
   - `--rating-line-source open|close|provided`
6. Add no-leakage tests proving ratings for a game are computed before that game is used to update ratings.

Acceptance criteria:

- Ratings are deterministic and reproducible.
- New feature columns are listed in the manifest.
- A model can be trained with or without rating features.
- Validation includes an ablation comparing baseline vs rating features.

## Phase 4: Score-based Bayesian/online skill features

Inspired by Guo, Sanner, Graepel & Buntine, add score-based team-skill features.

Implementation tasks:

1. Start with a pragmatic online approximation before implementing full Bayesian message passing:
   - offensive skill mean and variance/uncertainty
   - defensive skill mean and variance/uncertainty
   - pace/total-environment skill if useful
2. Update skills from actual scores after each completed game.
3. Candidate features:
   - `HOME_OFF_SKILL_MEAN`
   - `HOME_OFF_SKILL_STD`
   - `HOME_DEF_SKILL_MEAN`
   - `HOME_DEF_SKILL_STD`
   - `AWAY_OFF_SKILL_MEAN`
   - `AWAY_OFF_SKILL_STD`
   - `AWAY_DEF_SKILL_MEAN`
   - `AWAY_DEF_SKILL_STD`
   - `SKILL_MARGIN_PRIOR`
   - `SKILL_TOTAL_PRIOR`
4. Prefer a stable first implementation:
   - ridge/Kalman/Elo-like update with shrinkage to league average
   - optional Bayesian variance update
   - configurable learning rate and prior variance
5. Store parameters in the manifest and document defaults.
6. Add tests for season boundary behavior, expansion/unknown teams, and prior-only predictions.

Acceptance criteria:

- Skill features are based on prior games only.
- Unknown teams receive sensible priors.
- Skill features improve at least one validation metric or the ablation report explains why not.
- The implementation can be disabled with a flag.

## Phase 5: Market-decorrelation/value-signal experiment

Inspired by Hubáček & Šír, add an experimental mode that evaluates whether the model has a useful value signal that is not just a replica of the market.

Implementation tasks:

1. Create an out-of-fold signal table with:
   - model projection
   - market line
   - model edge vs market
   - residual target
   - event outcome
   - calibrated probability
   - market-implied probability if odds/payouts are available
2. Add diagnostics:
   - correlation of model edge with market line
   - correlation of model residual with market-implied baseline
   - calibration by edge bucket
   - ROI-style simulation only as a secondary diagnostic and only with realistic vig/payouts
   - closing-line-value metric when open and close lines exist
3. Add an optional selection score:
   - primary: Brier/log-loss/ECE and pinball loss
   - secondary: decorrelation penalty and CLV
   - optional formula: `selection_score = brier + alpha * abs(corr(edge, market_line)) - beta * clv_zscore`
4. Keep this behind an explicit CLI flag:
   - `--experimental-market-decorrelation`
5. Do not make decorrelation the default until validation demonstrates stable improvement.

Acceptance criteria:

- The experiment cannot accidentally contaminate default model selection.
- Reports clearly separate predictive accuracy, calibration, CLV, and ROI-like diagnostics.
- The code warns if payout/odds assumptions are missing or unrealistic.

## Phase 6: CLI, artifact, and API updates

Add or update CLI options carefully:

- `train`
  - `--model-kind direct|market-residual|auto`
  - `--calibration none|isotonic|platt|auto`
  - `--quantiles 0.05,0.10,0.25,0.50,0.75,0.90,0.95`
  - `--rating-features none|market`
  - `--skill-features none|score-based`
  - `--experimental-market-decorrelation`

- `evaluate`
  - include baseline metrics
  - include calibration metrics
  - include quantile/pinball metrics
  - include coverage tables
  - include market-decorrelation diagnostics when enabled

- `predict`
  - preserve existing fields
  - add calibrated probabilities when available
  - add quantile outputs when available
  - add model version/calibration metadata

Manifest additions:

- `schema_version`
- `feature_generators`
- `calibration`
- `quantile_models`
- `rating_features`
- `skill_features`
- `validation_reports`

## Testing requirements

Add tests covering:

1. Existing artifacts still load.
2. Feature vectors preserve column order.
3. Market-residual predictions add the correct baseline back.
4. Calibration probabilities stay in `[0, 1]`.
5. Calibration bin tables are reproducible.
6. Quantiles are ordered after crossing correction.
7. No future games are used in market-rating features.
8. No future games are used in score-skill features.
9. CLI smoke tests for baseline training and enhanced training.
10. Evaluation report includes the new metrics when market data exists.

## Documentation requirements

Update the project documentation with:

1. How to train the baseline model.
2. How to train the enhanced model.
3. What data columns are required for market-residual, calibration, quantile, rating, and skill features.
4. How to interpret calibrated probabilities and quantile ranges.
5. What validation metrics should be trusted most.
6. Explicit warning that model outputs are estimates, not guaranteed betting advice.

## Final deliverable expected from Codex

Return:

1. A concise implementation plan.
2. The code changes.
3. Test results.
4. A before/after validation table.
5. A short explanation of how each of the five papers influenced the implementation.

Do not skip validation. If a proposed feature does not improve the rolling-origin backtest, keep it optional and document the result rather than forcing it into the default path.
