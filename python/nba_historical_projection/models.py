from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from .artifacts import ArtifactError, artifact_path, load_json, validate_manifest
from .features import build_feature_vector
from .training import baseline_feature_for


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
    feature_columns = manifest["feature_columns"]
    features, feature_values = build_feature_vector(root, manifest, request)

    models = manifest["models"]
    total_model = load_predictor(root, models["total_score"])
    margin_model = load_predictor(root, models["home_margin"])
    projected_total = total_model.predict(features, feature_columns)
    projected_home_margin = margin_model.predict(features, feature_columns)
    if models["total_score"].get("target_mode") == "market_residual":
        projected_total += baseline_value("total_score", feature_values, request)
    if models["home_margin"].get("target_mode") == "market_residual":
        projected_home_margin += baseline_value("home_margin", feature_values, request)

    result = {
        **derive_team_scores(projected_total, projected_home_margin),
        "teams": {
            "home": request["home_team"],
            "away": request["away_team"],
        },
        "game_date": request["game_date"],
        "season": request.get("season"),
        "uncertainty": collect_uncertainty(models),
        "artifact": {
            "generated_at": manifest.get("generated_at"),
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
        "caveats": [
            "Informational projection only.",
            "Historical model quality depends on local artifact freshness and leak-free feature snapshots.",
            "Live in-game state is not included in this historical model.",
        ],
    }

    market_comparison = market_comparison_for_request(request, result)
    if market_comparison:
        result["market_comparison"] = market_comparison

    if request.get("include_debug"):
        result["debug"] = {
            "feature_columns": feature_columns,
            "feature_values": feature_values,
            "model_types": {
                "total_score": models["total_score"]["type"],
                "home_margin": models["home_margin"]["type"],
            },
        }

    return result


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
