# NBA Historical Projection Research Pack

This pack contains five scholarly/open-access PDFs selected to improve the uploaded `nba_historical_projection` model. The focus is on practical additions that match the current codebase: market-residual targets, NBA totals/spreads, XGBoost regressors, chronological validation, and prediction artifacts.

## Included articles

1. `01_Walsh_Joshi_2024_ML_for_sports_betting_accuracy_vs_calibration.pdf`  
   **Conor Walsh & Alok Joshi (2024), Machine Learning with Applications**  
   Main use: add calibration-first model selection and reliability diagnostics for betting-style probability outputs.

2. `02_Hubacek_Sir_2023_Beating_the_market_with_a_bad_predictive_model.pdf`  
   **Ondřej Hubáček & Gustav Šír (2023), International Journal of Forecasting**  
   Main use: add a market-decorrelation/value-signal experiment so the model is not merely restating closing lines.

3. `03_Dmochowski_2023_Statistical_theory_optimal_decision_making_sports_betting.pdf`  
   **Jacek P. Dmochowski (2023), PLOS ONE**  
   Main use: add quantile models and decision thresholds around spreads/totals rather than relying only on mean predictions.

4. `04_Wunderlich_Memmert_2018_Betting_odds_rating_system.pdf`  
   **Fabian Wunderlich & Daniel Memmert (2018), PLOS ONE**  
   Main use: add market-implied team-strength/rating features derived from pregame odds and closing lines.

5. `05_Guo_Sanner_Graepel_Buntine_2012_Score_based_Bayesian_skill_learning.pdf`  
   **Shengbo Guo, Scott Sanner, Thore Graepel & Wray Buntine (2012), ECML PKDD / LNCS**  
   Main use: add online score-based offensive and defensive team-skill features with uncertainty.

## Recommended integration order

1. Calibration and reliability diagnostics.
2. Quantile regression and distributional outputs.
3. Market-implied rating features.
4. Online score-based skill features.
5. Experimental market-decorrelation objective/selection criterion.

## Notes

The uploaded model already supports direct and market-residual targets, chronological validation, uncertainty intervals, and market total/spread comparison. These papers were chosen to extend those strengths rather than replace the current architecture.
