from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any


TARGET_COLUMNS = {"Score", "Home-Margin"}
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


def train_xgboost_regressors(
    dataset_path: str | Path,
    table: str,
    artifact_dir: str | Path,
    source_repo: str,
    source_ref: str,
    seasons: list[str],
    test_size: float = 0.1,
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
    missing_targets = sorted(TARGET_COLUMNS - set(frame.columns))
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
        if column not in TARGET_COLUMNS and column not in DROP_COLUMNS
    ]
    feature_frame = frame[feature_columns].astype(float)
    feature_defaults = build_feature_defaults_from_frame(feature_frame, feature_columns)
    x = feature_frame.to_numpy()
    y_total = frame["Score"].astype(float).to_numpy()
    y_margin = frame["Home-Margin"].astype(float).to_numpy()
    split_index = max(1, int(len(frame) * (1 - test_size)))

    total_model, total_metrics = train_one_model(x, y_total, split_index, xgb, np)
    margin_model, margin_metrics = train_one_model(x, y_margin, split_index, xgb, np)

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
                **total_metrics,
            },
            "home_margin": {
                "type": "xgboost_json",
                "path": "models/home_margin.json",
                **margin_metrics,
            },
        },
    }
    with (artifact_root / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return manifest


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


def train_one_model(x, y, split_index: int, xgb, np):
    x_train, y_train = x[:split_index], y[:split_index]
    x_val, y_val = x[split_index:], y[split_index:]
    if len(x_val) == 0:
        x_train, y_train = x, y
        x_val, y_val = x, y

    model = xgb.XGBRegressor(
        objective="reg:squarederror",
        n_estimators=600,
        max_depth=4,
        learning_rate=0.03,
        subsample=0.85,
        colsample_bytree=0.85,
        random_state=42,
    )
    model.fit(x_train, y_train, eval_set=[(x_val, y_val)], verbose=False)
    predictions = model.predict(x_val)
    residuals = predictions - y_val
    rmse = float(np.sqrt(np.mean(np.square(residuals))))
    residual_stddev = float(np.std(residuals))
    return model, {
        "validation_rmse": round(rmse, 4),
        "residual_stddev": round(residual_stddev, 4),
        "validation_rows": int(len(x_val)),
    }
