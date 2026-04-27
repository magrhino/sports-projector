from __future__ import annotations

import math
from typing import Any

from .training import quantile_nearest_rank


DEFAULT_QUANTILES = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]


def parse_quantiles(raw: str | None) -> list[float]:
    if raw is None or raw.strip() == "":
        return []
    values = []
    for item in raw.split(","):
        try:
            value = float(item.strip())
        except ValueError as exc:
            raise ValueError(f"quantile must be numeric: {item}") from exc
        if not 0.0 < value < 1.0:
            raise ValueError("quantiles must be between 0 and 1")
        values.append(value)
    return sorted(set(values))


def residual_quantile_artifact(residuals: list[float], quantiles: list[float]) -> dict[str, Any]:
    finite = sorted(float(value) for value in residuals if math.isfinite(float(value)))
    if not finite or not quantiles:
        return {"method": "none", "quantiles": {}, "rows": len(finite)}
    return {
        "method": "empirical_residual",
        "rows": len(finite),
        "quantiles": {
            quantile_key(quantile): round(quantile_nearest_rank(finite, quantile), 6)
            for quantile in quantiles
        },
    }


def predict_quantiles(mean_prediction: float, artifact: dict[str, Any] | None) -> dict[str, float]:
    if not isinstance(artifact, dict) or artifact.get("method") in {None, "none"}:
        return {}
    raw = artifact.get("quantiles")
    if not isinstance(raw, dict):
        return {}
    predictions = predicted_quantiles_for_value(mean_prediction, raw)
    return sort_crossing_quantiles(predictions)


def sort_crossing_quantiles(values: dict[str, float]) -> dict[str, float]:
    ordered_keys = sorted(values, key=lambda key: float(key))
    ordered_values = sorted(values[key] for key in ordered_keys)
    return {
        key: round(value, 1)
        for key, value in zip(ordered_keys, ordered_values)
    }


def quantile_summary(residuals: list[float], predictions: list[float], targets: list[float], quantiles: list[float]) -> dict[str, Any]:
    artifact = residual_quantile_artifact(residuals, quantiles)
    if not predictions or not targets or artifact.get("method") == "none":
        return {**artifact, "pinball_loss": {}, "coverage": {}}
    quantile_offsets = artifact["quantiles"]
    loss: dict[str, float] = {}
    for key in sorted(quantile_offsets, key=float):
        quantile = float(key)
        predicted_values = [
            predicted_quantiles_for_value(prediction, quantile_offsets).get(key)
            for prediction in predictions
        ]
        scored = [
            (predicted, target)
            for predicted, target in zip(predicted_values, targets)
            if predicted is not None
        ]
        if not scored:
            continue
        loss[key] = round(
            sum(pinball_loss(target - predicted, quantile) for predicted, target in scored)
            / len(scored),
            6,
        )
    coverage = {}
    if "0.10" in quantile_offsets and "0.90" in quantile_offsets:
        lower = [predicted_quantiles_for_value(prediction, quantile_offsets)["0.10"] for prediction in predictions]
        upper = [predicted_quantiles_for_value(prediction, quantile_offsets)["0.90"] for prediction in predictions]
        coverage["80"] = round(sum(lo <= target <= hi for lo, hi, target in zip(lower, upper, targets)) / len(targets), 6)
    if "0.05" in quantile_offsets and "0.95" in quantile_offsets:
        lower = [predicted_quantiles_for_value(prediction, quantile_offsets)["0.05"] for prediction in predictions]
        upper = [predicted_quantiles_for_value(prediction, quantile_offsets)["0.95"] for prediction in predictions]
        coverage["90"] = round(sum(lo <= target <= hi for lo, hi, target in zip(lower, upper, targets)) / len(targets), 6)
    return {**artifact, "pinball_loss": loss, "coverage": coverage}


def predicted_quantiles_for_value(mean_prediction: float, residual_quantiles: dict[str, Any]) -> dict[str, float]:
    predictions: dict[str, float] = {}
    for key in sorted(residual_quantiles, key=float):
        if not finite_number(residual_quantiles.get(key)):
            continue
        inverse_key = quantile_key(1.0 - float(key))
        offset = residual_quantiles.get(inverse_key, residual_quantiles.get(key))
        if not finite_number(offset):
            continue
        predictions[key] = float(mean_prediction) - float(offset)
    return sort_crossing_quantiles(predictions)


def pinball_loss(error: float, quantile: float) -> float:
    return max(quantile * error, (quantile - 1.0) * error)


def quantile_key(value: float) -> str:
    return f"{value:.2f}"


def finite_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False
