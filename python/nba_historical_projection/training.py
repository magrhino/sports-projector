from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any


TARGET_COLUMNS = {"Score", "Home-Margin"}
RESIDUAL_TARGET_COLUMNS = {"Total-Market-Residual", "Margin-Market-Residual"}
ALL_TARGET_COLUMNS = TARGET_COLUMNS | RESIDUAL_TARGET_COLUMNS
MODEL_KINDS = {"direct", "market-residual", "auto"}
DROP_COLUMNS = {
    "index",
    "TEAM_NAME",
    "TEAM_NAME.1",
    "TEAM_ID",
    "TEAM_ID.1",
    "Date",
    "Date.1",
    "Home-Team-Win",
    "OU-Cover",
}


def target_column_for(model_key: str, target_mode: str) -> str:
    if target_mode == "market_residual":
        return "Total-Market-Residual" if model_key == "total_score" else "Margin-Market-Residual"
    return "Score" if model_key == "total_score" else "Home-Margin"


def baseline_feature_for(model_key: str) -> str:
    return "MARKET_TOTAL_CLOSE" if model_key == "total_score" else "MARKET_SPREAD_CLOSE"


def target_mode_from_kind(model_kind: str) -> str:
    if model_kind not in MODEL_KINDS:
        raise RuntimeError(f"model_kind must be one of: {', '.join(sorted(MODEL_KINDS))}")
    return "market_residual" if model_kind == "market-residual" else "direct"


def target_modes_for_kind(model_kind: str, columns: set[str], model_key: str) -> list[str]:
    if model_kind == "direct":
        return ["direct"]
    if model_kind == "market-residual":
        return ["market_residual"]
    modes = ["direct"]
    if target_column_for(model_key, "market_residual") in columns:
        modes.append("market_residual")
    return modes


def train_xgboost_regressors(
    dataset_path: str | Path,
    table: str,
    artifact_dir: str | Path,
    source_repo: str,
    source_ref: str,
    seasons: list[str],
    test_size: float = 0.1,
    model_kind: str = "direct",
    early_stopping_rounds: int = 25,
    validation_splits: int = 3,
) -> dict[str, Any]:
    try:
        import numpy as np
        import pandas as pd
        import xgboost as xgb
    except ImportError as exc:
        raise RuntimeError("Training requires pandas, numpy, and xgboost") from exc

    artifact_root = Path(artifact_dir)
    model_dir = artifact_root / "models"
    model_dir.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(dataset_path) as connection:
        frame = pd.read_sql_query(f'SELECT * FROM "{table}"', connection)

    if frame.empty:
        raise RuntimeError(f"Dataset table is empty: {table}")
    if model_kind not in MODEL_KINDS:
        raise RuntimeError(f"model_kind must be one of: {', '.join(sorted(MODEL_KINDS))}")
    frame_columns = set(frame.columns)
    required_targets = {
        target_column_for(model_key, mode)
        for model_key in ("total_score", "home_margin")
        for mode in target_modes_for_kind(model_kind, frame_columns, model_key)
    }
    missing_targets = sorted(required_targets - set(frame.columns))
    if missing_targets:
        raise RuntimeError(
            "Dataset must include numeric score targets before training: "
            + ", ".join(missing_targets)
        )

    if "Date" in frame.columns:
        frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
        frame = frame.sort_values("Date")

    feature_columns = [
        column
        for column in frame.columns
        if column not in ALL_TARGET_COLUMNS and column not in DROP_COLUMNS
    ]
    feature_frame = frame[feature_columns].astype(float)
    feature_defaults = build_feature_defaults_from_frame(feature_frame, feature_columns)
    x = feature_frame.to_numpy()
    train_fraction = 1 - test_size

    total_model, total_metrics, total_mode = train_best_xgboost_model(
        x,
        frame,
        "total_score",
        model_kind,
        train_fraction,
        xgb,
        np,
        early_stopping_rounds,
        validation_splits,
    )
    margin_model, margin_metrics, margin_mode = train_best_xgboost_model(
        x,
        frame,
        "home_margin",
        model_kind,
        train_fraction,
        xgb,
        np,
        early_stopping_rounds,
        validation_splits,
    )

    total_path = model_dir / "total_score.json"
    margin_path = model_dir / "home_margin.json"
    total_model.save_model(str(total_path))
    margin_model.save_model(str(margin_path))

    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "repo": source_repo,
            "ref": source_ref,
        },
        "seasons": seasons,
        "feature_columns": feature_columns,
        "feature_defaults": feature_defaults,
        "models": {
            "total_score": {
                "type": "xgboost_json",
                "path": "models/total_score.json",
                "target_mode": total_mode,
                **total_metrics,
            },
            "home_margin": {
                "type": "xgboost_json",
                "path": "models/home_margin.json",
                "target_mode": margin_mode,
                **margin_metrics,
            },
        },
    }
    with (artifact_root / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return manifest


def train_best_xgboost_model(
    x,
    frame,
    model_key: str,
    model_kind: str,
    train_fraction: float,
    xgb,
    np,
    early_stopping_rounds: int,
    validation_splits: int,
):
    candidates = []
    frame_columns = set(frame.columns)
    for target_mode in target_modes_for_kind(model_kind, frame_columns, model_key):
        target_column = target_column_for(model_key, target_mode)
        raw_y = frame[target_column].astype(float).to_numpy()
        target_x, y = finite_target_arrays(x, raw_y)
        if len(y) == 0:
            continue
        model, metrics = train_one_model(
            target_x,
            y,
            split_index_for_rows(len(y), train_fraction),
            xgb,
            np,
            early_stopping_rounds=early_stopping_rounds,
            validation_splits=validation_splits,
        )
        candidates.append((target_mode, model, metrics))
    if not candidates:
        raise RuntimeError(f"No finite target rows available for {model_key} with model_kind={model_kind}")
    target_mode, model, metrics = min(candidates, key=lambda candidate: candidate[2]["residual_stddev"])
    return model, metrics, target_mode


def finite_target_arrays(x, y):
    indexes = [
        index
        for index, value in enumerate(y)
        if math.isfinite(float(value))
    ]
    try:
        return x[indexes], y[indexes]
    except TypeError:
        return [x[index] for index in indexes], [y[index] for index in indexes]


def split_index_for_rows(row_count: int, train_fraction: float) -> int:
    if row_count <= 1:
        return row_count
    return min(row_count - 1, max(1, int(row_count * train_fraction)))


def build_feature_defaults_from_frame(feature_frame: Any, feature_columns: list[str]) -> dict[str, float]:
    defaults: dict[str, float] = {}
    missing: list[str] = []
    for column in feature_columns:
        values = numeric_values(feature_frame[column])
        if not values:
            missing.append(column)
            continue
        defaults[column] = round(float(median(values)), 6)

    if missing:
        raise RuntimeError(
            "Unable to derive numeric feature defaults for: "
            + ", ".join(missing[:20])
        )

    return defaults


def numeric_values(values: Any) -> list[float]:
    numbers: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            numbers.append(number)
    return numbers


def train_one_model(
    x,
    y,
    split_index: int,
    xgb,
    np,
    early_stopping_rounds: int = 25,
    validation_splits: int = 3,
):
    x_train, y_train = x[:split_index], y[:split_index]
    x_val, y_val = x[split_index:], y[split_index:]
    if len(x_val) == 0:
        x_train, y_train = x, y
        x_val, y_val = x, y

    model = build_xgb_regressor(xgb, early_stopping_rounds)
    model.fit(x_train, y_train, eval_set=[(x_val, y_val)], verbose=False)
    residuals = xgboost_validation_residuals(x, y, xgb, early_stopping_rounds, validation_splits)
    if not residuals:
        predictions = model.predict(x_val)
        residuals = [float(value) for value in predictions - y_val]
    metrics = metrics_from_residuals(residuals)
    metrics["validation"] = {
        "method": "rolling_origin" if residuals else "chronological_holdout",
        "rows": metrics["validation_rows"],
        "splits": len(chronological_splits(len(y), validation_splits)),
        "rmse": metrics["validation_rmse"],
        "mae": metrics["validation_mae"],
        "residual_stddev": metrics["residual_stddev"],
    }
    best_iteration = getattr(model, "best_iteration", None)
    if best_iteration is not None:
        metrics["best_iteration"] = int(best_iteration)
    return model, metrics


def build_xgb_regressor(xgb, early_stopping_rounds: int):
    return xgb.XGBRegressor(
        objective="reg:squarederror",
        n_estimators=600,
        max_depth=4,
        learning_rate=0.03,
        subsample=0.85,
        colsample_bytree=0.85,
        random_state=42,
        early_stopping_rounds=max(1, int(early_stopping_rounds)),
    )


def xgboost_validation_residuals(
    x,
    y,
    xgb,
    early_stopping_rounds: int,
    validation_splits: int,
) -> list[float]:
    residuals: list[float] = []
    for train_indexes, test_indexes in chronological_splits(len(y), validation_splits):
        model = build_xgb_regressor(xgb, early_stopping_rounds)
        x_train, y_train = x[train_indexes], y[train_indexes]
        x_test, y_test = x[test_indexes], y[test_indexes]
        model.fit(x_train, y_train, eval_set=[(x_test, y_test)], verbose=False)
        predictions = model.predict(x_test)
        residuals.extend(float(value) for value in predictions - y_test)
    return residuals


def metrics_from_residuals(residuals: list[float]) -> dict[str, Any]:
    if not residuals:
        return {
            "validation_rmse": 0.0,
            "validation_mae": 0.0,
            "residual_stddev": 0.0,
            "validation_rows": 0,
            "uncertainty": {
                "calibration_source": "no_validation_residuals",
                "intervals": {},
                "coverage": {},
            },
        }

    mean = sum(residuals) / len(residuals)
    rmse = math.sqrt(sum(value * value for value in residuals) / len(residuals))
    mae = sum(abs(value) for value in residuals) / len(residuals)
    residual_stddev = math.sqrt(sum((value - mean) ** 2 for value in residuals) / len(residuals))
    intervals = calibrated_intervals(residuals)
    return {
        "validation_rmse": round(rmse, 4),
        "validation_mae": round(mae, 4),
        "residual_stddev": round(residual_stddev, 4),
        "validation_rows": len(residuals),
        "uncertainty": {
            "calibration_source": "chronological_validation_residuals",
            "intervals": intervals,
            "coverage": interval_coverage(residuals, intervals),
        },
    }


def calibrated_intervals(residuals: list[float]) -> dict[str, float]:
    absolute_errors = sorted(abs(value) for value in residuals)
    return {
        "68": round(quantile_nearest_rank(absolute_errors, 0.68), 4),
        "80": round(quantile_nearest_rank(absolute_errors, 0.80), 4),
        "90": round(quantile_nearest_rank(absolute_errors, 0.90), 4),
    }


def interval_coverage(residuals: list[float], intervals: dict[str, float]) -> dict[str, float]:
    if not residuals:
        return {}
    return {
        level: round(
            sum(1 for residual in residuals if abs(residual) <= width) / len(residuals),
            4,
        )
        for level, width in intervals.items()
    }


def quantile_nearest_rank(sorted_values: list[float], quantile: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(0, min(len(sorted_values) - 1, math.ceil(quantile * len(sorted_values)) - 1))
    return float(sorted_values[index])


def chronological_splits(row_count: int, validation_splits: int) -> list[tuple[list[int], list[int]]]:
    if row_count < 2:
        return []
    split_count = max(1, min(validation_splits, row_count - 1))
    test_size = max(1, row_count // (split_count + 1))
    splits: list[tuple[list[int], list[int]]] = []
    for split_index in range(split_count):
        train_end = row_count - test_size * (split_count - split_index)
        test_end = min(row_count, train_end + test_size)
        if train_end < 1 or test_end <= train_end:
            continue
        splits.append((list(range(train_end)), list(range(train_end, test_end))))
    return splits
