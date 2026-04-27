from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


EPSILON = 1e-12


@dataclass(frozen=True)
class CalibrationEvent:
    edge: float
    outcome: int
    probability: float


def clamp_probability(value: float) -> float:
    if not math.isfinite(value):
        return 0.5
    return min(1.0 - EPSILON, max(EPSILON, float(value)))


def empirical_probability(edge: float, residuals: list[float]) -> float:
    """Return P(actual target is above the market line) from model residuals.

    Residuals are defined as prediction - actual. For a model edge of
    prediction - line, the event actual > line occurs when residual < edge.
    """

    if not residuals:
        return 0.5
    return clamp_probability(sum(1 for residual in residuals if residual < edge) / len(residuals))


def build_calibration_events(edges: list[float], outcomes: list[int], residuals: list[float]) -> list[CalibrationEvent]:
    events: list[CalibrationEvent] = []
    for edge, outcome in zip(edges, outcomes):
        if not math.isfinite(float(edge)) or outcome not in {0, 1}:
            continue
        events.append(CalibrationEvent(float(edge), int(outcome), empirical_probability(float(edge), residuals)))
    return events


def fit_probability_calibrator(
    events: list[CalibrationEvent],
    requested: str = "auto",
    min_isotonic_rows: int = 30,
    min_platt_rows: int = 12,
) -> dict[str, Any]:
    if requested not in {"none", "empirical", "isotonic", "platt", "auto"}:
        raise ValueError("calibration must be none, empirical, isotonic, platt, or auto")
    if requested == "none" or not events:
        return {"method": "none", "metrics": {}, "reliability_bins": []}

    method = requested
    if method == "auto":
        if len(events) >= min_isotonic_rows:
            method = "isotonic"
        elif len(events) >= min_platt_rows:
            method = "platt"
        else:
            method = "empirical"

    raw_probabilities = [event.probability for event in events]
    outcomes = [event.outcome for event in events]
    if method == "isotonic":
        fitted = fit_isotonic(raw_probabilities, outcomes)
        probabilities = [apply_isotonic(event.probability, fitted) for event in events]
        config: dict[str, Any] = {
            "method": "isotonic",
            "points": fitted,
        }
    elif method == "platt":
        slope, intercept = fit_platt(raw_probabilities, outcomes)
        probabilities = [apply_platt(event.probability, slope, intercept) for event in events]
        config = {
            "method": "platt",
            "slope": round(slope, 8),
            "intercept": round(intercept, 8),
        }
    else:
        probabilities = raw_probabilities
        config = {"method": "empirical"}

    bins = reliability_bins(probabilities, outcomes)
    config["metrics"] = calibration_metrics(probabilities, outcomes, bins)
    config["reliability_bins"] = bins
    config["rows"] = len(events)
    return config


def fit_isotonic(probabilities: list[float], outcomes: list[int]) -> list[dict[str, float]]:
    pairs = sorted((clamp_probability(probability), int(outcome)) for probability, outcome in zip(probabilities, outcomes))
    blocks: list[dict[str, float]] = []
    for probability, outcome in pairs:
        blocks.append({"min": probability, "max": probability, "sum": float(outcome), "count": 1.0})
        while len(blocks) >= 2:
            previous = blocks[-2]["sum"] / blocks[-2]["count"]
            current = blocks[-1]["sum"] / blocks[-1]["count"]
            if previous <= current:
                break
            merged = {
                "min": blocks[-2]["min"],
                "max": blocks[-1]["max"],
                "sum": blocks[-2]["sum"] + blocks[-1]["sum"],
                "count": blocks[-2]["count"] + blocks[-1]["count"],
            }
            blocks[-2:] = [merged]
    return [
        {
            "min_probability": round(block["min"], 8),
            "max_probability": round(block["max"], 8),
            "calibrated_probability": round(clamp_probability(block["sum"] / block["count"]), 8),
        }
        for block in blocks
    ]


def apply_isotonic(probability: float, points: list[dict[str, float]]) -> float:
    if not points:
        return clamp_probability(probability)
    probability = clamp_probability(probability)
    for point in points:
        if probability <= float(point["max_probability"]):
            return clamp_probability(float(point["calibrated_probability"]))
    return clamp_probability(float(points[-1]["calibrated_probability"]))


def fit_platt(probabilities: list[float], outcomes: list[int], iterations: int = 200) -> tuple[float, float]:
    slope = 1.0
    intercept = 0.0
    features = [logit(probability) for probability in probabilities]
    for _ in range(iterations):
        grad_slope = 0.0
        grad_intercept = 0.0
        h_slope = EPSILON
        h_intercept = EPSILON
        for feature, outcome in zip(features, outcomes):
            prediction = sigmoid(slope * feature + intercept)
            error = prediction - outcome
            weight = prediction * (1.0 - prediction)
            grad_slope += error * feature
            grad_intercept += error
            h_slope += weight * feature * feature
            h_intercept += weight
        slope -= grad_slope / h_slope
        intercept -= grad_intercept / h_intercept
        slope = max(-10.0, min(10.0, slope))
        intercept = max(-10.0, min(10.0, intercept))
    return slope, intercept


def apply_platt(probability: float, slope: float, intercept: float) -> float:
    return clamp_probability(sigmoid(slope * logit(probability) + intercept))


def logit(probability: float) -> float:
    probability = clamp_probability(probability)
    return math.log(probability / (1.0 - probability))


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def calibration_metrics(probabilities: list[float], outcomes: list[int], bins: list[dict[str, float]]) -> dict[str, float]:
    if not probabilities:
        return {}
    brier = sum((probability - outcome) ** 2 for probability, outcome in zip(probabilities, outcomes)) / len(probabilities)
    log_loss = -sum(
        outcome * math.log(clamp_probability(probability))
        + (1 - outcome) * math.log(clamp_probability(1.0 - probability))
        for probability, outcome in zip(probabilities, outcomes)
    ) / len(probabilities)
    ece = sum(abs(item["avg_probability"] - item["event_rate"]) * item["count"] for item in bins) / len(probabilities)
    return {
        "brier": round(brier, 6),
        "log_loss": round(log_loss, 6),
        "ece": round(ece, 6),
    }


def reliability_bins(probabilities: list[float], outcomes: list[int], bin_count: int = 10) -> list[dict[str, float]]:
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(bin_count)]
    for probability, outcome in zip(probabilities, outcomes):
        index = min(bin_count - 1, max(0, int(clamp_probability(probability) * bin_count)))
        buckets[index].append((clamp_probability(probability), int(outcome)))

    rows: list[dict[str, float]] = []
    for index, bucket in enumerate(buckets):
        lower = index / bin_count
        upper = (index + 1) / bin_count
        if bucket:
            avg_probability = sum(item[0] for item in bucket) / len(bucket)
            event_rate = sum(item[1] for item in bucket) / len(bucket)
        else:
            avg_probability = 0.0
            event_rate = 0.0
        rows.append(
            {
                "lower": round(lower, 4),
                "upper": round(upper, 4),
                "count": float(len(bucket)),
                "avg_probability": round(avg_probability, 6),
                "event_rate": round(event_rate, 6),
            }
        )
    return rows


def apply_calibration(probability: float, config: dict[str, Any] | None) -> float:
    if not isinstance(config, dict):
        return clamp_probability(probability)
    method = config.get("method")
    if method == "isotonic":
        points = config.get("points", [])
        return apply_isotonic(probability, points if isinstance(points, list) else [])
    if method == "platt":
        return apply_platt(probability, float(config.get("slope", 1.0)), float(config.get("intercept", 0.0)))
    return clamp_probability(probability)
