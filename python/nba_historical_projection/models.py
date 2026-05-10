from __future__ import annotations

import math
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from .artifacts import ArtifactError, artifact_path, load_json, validate_manifest
from .calibration import apply_calibration, clamp_probability
from .features import build_feature_vector_with_metadata, normalize_team_name
from .quantiles import predict_quantiles
from .training import baseline_feature_for


DEFAULT_MAX_SNAPSHOT_AGE_DAYS = 7
DEFAULT_MIN_PROJECTED_TOTAL = 150.0
DEFAULT_MAX_PROJECTED_TOTAL = 280.0
DEFAULT_MAX_MARKET_TOTAL_DIFFERENCE = 35.0


class Predictor(Protocol):
    def predict(self, features: list[float], feature_columns: list[str]) -> float:
        ...


class LinearJsonPredictor:
    def __init__(self, config: dict[str, Any], model_path: Path):
        data = load_json(model_path)
        if not isinstance(data, dict):
            raise ArtifactError(f"Linear model must contain a JSON object: {model_path}")
        self.intercept = float(data.get("intercept", 0))
        coefficients = data.get("coefficients")
        if not isinstance(coefficients, (list, dict)):
            raise ArtifactError(f"Linear model coefficients must be an array or object: {model_path}")
        self.coefficients = coefficients

    def predict(self, features: list[float], feature_columns: list[str]) -> float:
        if isinstance(self.coefficients, list):
            if len(self.coefficients) != len(features):
                raise ArtifactError("Linear model coefficient count does not match feature_columns")
            return self.intercept + sum(float(weight) * value for weight, value in zip(self.coefficients, features))
        return self.intercept + sum(
            float(self.coefficients.get(column, 0)) * value
            for column, value in zip(feature_columns, features)
        )


class XGBoostJsonPredictor:
    def __init__(self, config: dict[str, Any], model_path: Path):
        try:
            import xgboost as xgb
        except ImportError as exc:
            raise ArtifactError("xgboost is required to load xgboost_json model artifacts") from exc
        self._xgb = xgb
        self._model = xgb.Booster()
        self._model.load_model(str(model_path))
        best_iteration = config.get("best_iteration")
        self._iteration_range = None
        if best_iteration is not None:
            self._iteration_range = (0, int(best_iteration) + 1)

    def predict(self, features: list[float], feature_columns: list[str]) -> float:
        matrix = self._xgb.DMatrix([features], feature_names=feature_columns)
        if self._iteration_range is None:
            prediction = self._model.predict(matrix)
        else:
            prediction = self._model.predict(matrix, iteration_range=self._iteration_range)
        return float(prediction[0])


def load_predictor(root: Path, config: dict[str, Any]) -> Predictor:
    model_path = artifact_path(root, config["path"])
    model_type = config["type"]
    if model_type == "linear_json":
        return LinearJsonPredictor(config, model_path)
    if model_type == "xgboost_json":
        return XGBoostJsonPredictor(config, model_path)
    raise ArtifactError(f"Unsupported model type: {model_type}")


def derive_team_scores(projected_total: float, projected_home_margin: float) -> dict[str, float]:
    projected_home_score = (projected_total + projected_home_margin) / 2
    projected_away_score = projected_total - projected_home_score
    return {
        "projected_home_score": round(projected_home_score, 1),
        "projected_away_score": round(projected_away_score, 1),
        "projected_total": round(projected_total, 1),
        "projected_home_margin": round(projected_home_margin, 1),
    }


def predict_from_artifacts(artifact_dir: str | Path, request: dict[str, Any]) -> dict[str, Any]:
    root = Path(artifact_dir)
    manifest = validate_manifest(root)
    request_market_total = numeric_or_none(request.get("market_total"))
    market_context = market_total_context(root, manifest, request, request_market_total)
    prediction_request = (
        {**request, "market_total": market_context["market_total"]}
        if request_market_total is None and market_context.get("market_total") is not None
        else request
    )
    feature_columns = manifest["feature_columns"]
    features, feature_values, feature_metadata = build_feature_vector_with_metadata(root, manifest, prediction_request)
    snapshot_age_days = validate_snapshot_freshness(manifest, feature_metadata, prediction_request)

    models = manifest["models"]
    total_model = load_predictor(root, models["total_score"])
    margin_model = load_predictor(root, models["home_margin"])
    projected_total = total_model.predict(features, feature_columns)
    projected_home_margin = margin_model.predict(features, feature_columns)
    if models["total_score"].get("target_mode") == "market_residual":
        projected_total += baseline_value("total_score", feature_values, prediction_request)
    if models["home_margin"].get("target_mode") == "market_residual":
        projected_home_margin += baseline_value("home_margin", feature_values, prediction_request)

    validate_projected_total(manifest, projected_total, prediction_request)
    market_total_used = numeric_or_none(prediction_request.get("market_total"))
    data_quality = data_quality_for_prediction(market_total_used)
    result = {
        **derive_team_scores(projected_total, projected_home_margin),
        "teams": {
            "home": prediction_request["home_team"],
            "away": prediction_request["away_team"],
        },
        "game_date": prediction_request["game_date"],
        "season": prediction_request.get("season"),
        "uncertainty": collect_uncertainty(models),
        "artifact": {
            "generated_at": manifest.get("generated_at"),
            "snapshot_date": feature_metadata.get("snapshot_date"),
            "snapshot_age_days": snapshot_age_days,
            "market_total_used": market_total_used,
            "market_total_source": market_context.get("source"),
            "market_total_confidence": market_context.get("confidence"),
            "seasons": manifest.get("seasons", []),
            "source": manifest.get("source", {}),
            "models": {
                "total_score": {
                    "type": models["total_score"]["type"],
                    "target_mode": models["total_score"].get("target_mode", "direct"),
                },
                "home_margin": {
                    "type": models["home_margin"]["type"],
                    "target_mode": models["home_margin"].get("target_mode", "direct"),
                },
            },
        },
        "data_quality": data_quality,
        "caveats": [
            "Informational projection only.",
            "Historical model quality depends on local artifact freshness and leak-free feature snapshots.",
            "Live in-game state is not included in this historical model.",
        ],
    }

    market_comparison = market_comparison_for_request(prediction_request, result)
    if market_comparison:
        result["market_comparison"] = market_comparison

    quantile_output = quantile_output_for_prediction(manifest, projected_total, projected_home_margin)
    if quantile_output:
        result.update(quantile_output)

    probabilities = probabilities_for_prediction(manifest, models, result, prediction_request)
    if probabilities:
        result["probabilities"] = probabilities

    edge_status = edge_status_for_prediction(result, prediction_request)
    if edge_status:
        result["informational_edge_status"] = edge_status

    if request.get("include_debug"):
        result["debug"] = {
            "feature_columns": feature_columns,
            "feature_values": feature_values,
            "model_types": {
                "total_score": models["total_score"]["type"],
                "home_margin": models["home_margin"]["type"],
            },
            "feature_metadata": feature_metadata,
        }

    return result


def market_total_context(
    root: Path,
    manifest: dict[str, Any],
    request: dict[str, Any],
    request_market_total: float | None,
) -> dict[str, Any]:
    if request_market_total is not None:
        return {
            "market_total": request_market_total,
            "source": "request",
            "confidence": 1.0,
        }

    artifact_total = market_total_from_artifact(root, manifest, request)
    if artifact_total is None:
        return {
            "market_total": None,
            "source": None,
            "confidence": None,
        }
    return artifact_total


def market_total_from_artifact(root: Path, manifest: dict[str, Any], request: dict[str, Any]) -> dict[str, Any] | None:
    config = manifest.get("market_lines")
    if not isinstance(config, dict) or config.get("type") != "sqlite":
        return None
    configured_path = config.get("path")
    if not isinstance(configured_path, str) or not configured_path:
        return None
    table = config.get("table", "market_lines")
    if not isinstance(table, str) or not table.replace("_", "").isalnum():
        return None
    db_path = artifact_path(root, configured_path)
    if not db_path.is_file():
        return None

    home_teams = market_lookup_names(str(request["home_team"]))
    away_teams = market_lookup_names(str(request["away_team"]))
    home_placeholders = ", ".join("?" for _ in home_teams)
    away_placeholders = ", ".join("?" for _ in away_teams)
    game_date = str(request["game_date"])
    try:
        with sqlite3.connect(db_path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                f"""
                SELECT closing_total, source, confidence, market_ticker, event_ticker
                FROM "{table}"
                WHERE game_date = ?
                  AND normalized_home_team IN ({home_placeholders})
                  AND normalized_away_team IN ({away_placeholders})
                ORDER BY
                  CASE WHEN normalized_home_team = ? THEN 0 ELSE 1 END,
                  CASE WHEN normalized_away_team = ? THEN 0 ELSE 1 END
                LIMIT 1
                """,
                (game_date, *home_teams, *away_teams, home_teams[0], away_teams[0]),
            ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    market_total = numeric_or_none(row["closing_total"])
    if market_total is None:
        return None
    return {
        "market_total": market_total,
        "source": row["source"],
        "confidence": numeric_or_none(row["confidence"]),
        "market_ticker": row["market_ticker"],
        "event_ticker": row["event_ticker"],
    }


def normalize_match_name(value: str) -> str:
    return " ".join(str(value).strip().lower().replace(".", "").split())


def market_lookup_names(value: str) -> list[str]:
    text = " ".join(str(value).strip().split())
    candidates = [text, normalize_team_name(text)]
    if normalize_match_name(text) in {"la clippers", "los angeles clippers"}:
        candidates.extend(["LA Clippers", "Los Angeles Clippers"])

    names: list[str] = []
    for candidate in candidates:
        normalized = normalize_match_name(candidate)
        if normalized and normalized not in names:
            names.append(normalized)
    return names or [""]


def validate_snapshot_freshness(
    manifest: dict[str, Any],
    feature_metadata: dict[str, Any],
    request: dict[str, Any],
) -> int | None:
    snapshot_date = feature_metadata.get("snapshot_date")
    if not isinstance(snapshot_date, str) or not snapshot_date:
        return None
    game_date = str(request["game_date"])
    age_days = days_between_dates(snapshot_date, game_date)
    if age_days < 0:
        raise ArtifactError(
            (
                f"Historical team snapshot is after requested game date {game_date}: "
                f"selected snapshot {snapshot_date} is {abs(age_days)} days in the future"
            ),
            code="future_team_snapshot",
            details={
                "requested_game_date": game_date,
                "snapshot_date": snapshot_date,
                "snapshot_age_days": age_days,
            },
        )
    max_age = prediction_guard_number(manifest, "max_snapshot_age_days", DEFAULT_MAX_SNAPSHOT_AGE_DAYS)
    if age_days > max_age:
        raise ArtifactError(
            (
                f"Historical team snapshot is stale for requested game date {game_date}: "
                f"selected snapshot {snapshot_date} is {age_days} days old; max allowed is {int(max_age)} days"
            ),
            code="stale_team_snapshot",
            details={
                "requested_game_date": game_date,
                "snapshot_date": snapshot_date,
                "snapshot_age_days": age_days,
                "max_snapshot_age_days": int(max_age),
            },
        )
    return age_days


def validate_projected_total(
    manifest: dict[str, Any],
    projected_total: float,
    request: dict[str, Any],
) -> None:
    min_total = prediction_guard_number(manifest, "min_projected_total", DEFAULT_MIN_PROJECTED_TOTAL)
    max_total = prediction_guard_number(manifest, "max_projected_total", DEFAULT_MAX_PROJECTED_TOTAL)
    rounded_total = round(float(projected_total), 1)
    if not math.isfinite(projected_total) or projected_total < min_total or projected_total > max_total:
        raise ArtifactError(
            (
                f"Historical projected total {rounded_total} is outside plausible NBA range "
                f"{round(min_total, 1)}-{round(max_total, 1)}"
            ),
            code="implausible_projection",
            details={
                "projected_total": rounded_total,
                "min_projected_total": float(min_total),
                "max_projected_total": float(max_total),
            },
        )

    market_total = numeric_or_none(request.get("market_total"))
    if market_total is None:
        return
    max_difference = prediction_guard_number(
        manifest,
        "max_market_total_difference",
        DEFAULT_MAX_MARKET_TOTAL_DIFFERENCE,
    )
    difference = projected_total - market_total
    if abs(difference) > max_difference:
        raise ArtifactError(
            (
                f"Historical projected total {rounded_total} differs from market total "
                f"{round(market_total, 1)} by {round(difference, 1)} points; "
                f"max allowed difference is {round(max_difference, 1)}"
            ),
            code="implausible_projection",
            details={
                "projected_total": rounded_total,
                "market_total": round(market_total, 1),
                "difference_to_market_total": round(difference, 1),
                "max_market_total_difference": float(max_difference),
            },
        )


def data_quality_for_prediction(market_total: float | None) -> dict[str, Any]:
    if market_total is None:
        return {
            "status": "missing_market_context",
            "reasons": ["market_total was not supplied; projection is not anchored to the current total market."],
        }
    return {
        "status": "ok",
        "reasons": [],
    }


def prediction_guard_number(manifest: dict[str, Any], key: str, default: float) -> float:
    guards = manifest.get("prediction_guards")
    if isinstance(guards, dict):
        value = numeric_or_none(guards.get(key))
        if value is not None:
            return value
    return default


def days_between_dates(start: str, end: str) -> int:
    try:
        start_date = datetime.strptime(start, "%Y-%m-%d")
        end_date = datetime.strptime(end, "%Y-%m-%d")
    except ValueError as exc:
        raise ArtifactError(
            "Unable to compare historical snapshot date and requested game date",
            code="invalid_snapshot_date",
            details={"snapshot_date": start, "requested_game_date": end},
        ) from exc
    return (end_date - start_date).days


def numeric_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def quantile_output_for_prediction(
    manifest: dict[str, Any],
    projected_total: float,
    projected_home_margin: float,
) -> dict[str, Any]:
    quantile_models = manifest.get("quantile_models")
    if not isinstance(quantile_models, dict):
        return {}
    total_quantiles = predict_quantiles(projected_total, quantile_models.get("total_score"))
    margin_quantiles = predict_quantiles(projected_home_margin, quantile_models.get("home_margin"))
    output: dict[str, Any] = {}
    if total_quantiles:
        output["projected_total_quantiles"] = total_quantiles
        if "0.50" in total_quantiles:
            output["median_total"] = total_quantiles["0.50"]
    if margin_quantiles:
        output["projected_home_margin_quantiles"] = margin_quantiles
        if "0.50" in margin_quantiles:
            output["median_home_margin"] = margin_quantiles["0.50"]
    return output


def probabilities_for_prediction(
    manifest: dict[str, Any],
    models: dict[str, Any],
    result: dict[str, Any],
    request: dict[str, Any],
) -> dict[str, Any]:
    calibration = manifest.get("calibration")
    probabilities: dict[str, Any] = {}
    total_line = request.get("market_total")
    if total_line is not None:
        edge = float(result["projected_total"]) - float(total_line)
        raw = normal_probability(edge, float(models["total_score"].get("residual_stddev") or 12.0))
        total_config = calibration.get("totals") if isinstance(calibration, dict) else None
        probability = apply_calibration(raw, total_config if isinstance(total_config, dict) else None)
        probabilities["prob_over_market_total"] = round(probability, 6)
        probabilities["prob_under_market_total"] = round(clamp_probability(1.0 - probability), 6)
    spread_line = request.get("market_spread")
    if spread_line is not None:
        edge = float(result["projected_home_margin"]) - float(spread_line)
        raw = normal_probability(edge, float(models["home_margin"].get("residual_stddev") or 8.0))
        spread_config = calibration.get("spreads") if isinstance(calibration, dict) else None
        probability = apply_calibration(raw, spread_config if isinstance(spread_config, dict) else None)
        probabilities["prob_home_cover"] = round(probability, 6)
        probabilities["prob_away_cover"] = round(clamp_probability(1.0 - probability), 6)
    margin_stddev = float(models["home_margin"].get("residual_stddev") or 8.0)
    probabilities["prob_home_win"] = round(normal_probability(float(result["projected_home_margin"]), margin_stddev), 6)
    if isinstance(calibration, dict) and calibration:
        probabilities["calibration"] = {
            "totals_method": method_name(calibration.get("totals")),
            "spreads_method": method_name(calibration.get("spreads")),
        }
    return probabilities


def normal_probability(edge: float, stddev: float) -> float:
    stddev = max(1e-6, abs(stddev))
    return clamp_probability(0.5 * (1.0 + math.erf(edge / (stddev * math.sqrt(2.0)))))


def method_name(value: Any) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("method"), str):
        return value["method"]
    return None


def edge_status_for_prediction(result: dict[str, Any], request: dict[str, Any]) -> dict[str, Any] | None:
    comparison = result.get("market_comparison")
    if not isinstance(comparison, dict):
        return None
    status: dict[str, Any] = {}
    total_diff = comparison.get("difference_to_market_total")
    if total_diff is not None:
        status["total"] = "inside_uncertainty_band" if abs(float(total_diff)) < 1.0 else "outside_uncertainty_band"
    spread_diff = comparison.get("difference_to_market_spread")
    if spread_diff is not None:
        status["spread"] = "inside_uncertainty_band" if abs(float(spread_diff)) < 1.0 else "outside_uncertainty_band"
    return status or None


def collect_uncertainty(models: dict[str, Any]) -> dict[str, Any]:
    uncertainty: dict[str, Any] = {}
    total_stddev = models["total_score"].get("residual_stddev")
    margin_stddev = models["home_margin"].get("residual_stddev")
    if total_stddev is not None:
        uncertainty["total_score_residual_stddev"] = float(total_stddev)
    if margin_stddev is not None:
        uncertainty["home_margin_residual_stddev"] = float(margin_stddev)
    add_interval_uncertainty(uncertainty, "total_score", models["total_score"])
    add_interval_uncertainty(uncertainty, "home_margin", models["home_margin"])
    calibration_sources = sorted(
        {
            source
            for model_config in (models["total_score"], models["home_margin"])
            for source in [model_config.get("uncertainty", {}).get("calibration_source")]
            if source
        }
    )
    if calibration_sources:
        uncertainty["calibration_source"] = ",".join(calibration_sources)
    return uncertainty


def add_interval_uncertainty(
    uncertainty: dict[str, Any],
    model_key: str,
    model_config: dict[str, Any],
) -> None:
    intervals = model_config.get("uncertainty", {}).get("intervals")
    if not isinstance(intervals, dict) or "90" not in intervals:
        return
    width = float(intervals["90"])
    field = "total_score_interval_90" if model_key == "total_score" else "home_margin_interval_90"
    uncertainty[field] = [0.0, 0.0] if width == 0 else [-width, width]


def baseline_value(
    model_key: str,
    feature_values: dict[str, float],
    request: dict[str, Any],
) -> float:
    request_key = "market_total" if model_key == "total_score" else "market_spread"
    if request.get(request_key) is not None:
        return float(request[request_key])
    return float(feature_values[baseline_feature_for(model_key)])


def market_comparison_for_request(request: dict[str, Any], result: dict[str, Any]) -> dict[str, float] | None:
    comparison: dict[str, float] = {}
    if request.get("market_total") is not None:
        market_total = float(request["market_total"])
        comparison["market_total"] = market_total
        comparison["difference_to_market_total"] = round(result["projected_total"] - market_total, 1)
    if request.get("market_spread") is not None:
        market_spread = float(request["market_spread"])
        comparison["market_spread"] = market_spread
        comparison["difference_to_market_spread"] = round(result["projected_home_margin"] - market_spread, 1)
    return comparison or None
