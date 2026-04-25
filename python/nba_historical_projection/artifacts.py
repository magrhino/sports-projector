from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ArtifactError(ValueError):
    """Raised when local historical projection artifacts are missing or invalid."""


STATE_MANIFEST_NAME = "artifact_manifest.json"
IMPORT_LOG_NAME = "artifact_import_log.jsonl"
REQUEST_DEFAULT_FEATURES = {"Days-Rest-Home", "Days-Rest-Away", "OU", "Spread"}


def artifact_path(root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise ArtifactError(f"Required artifact file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ArtifactError(f"Artifact file is not valid JSON: {path}: {exc}") from exc


def load_manifest(artifact_dir: str | Path) -> dict[str, Any]:
    root = Path(artifact_dir)
    manifest = load_json(root / "manifest.json")
    if not isinstance(manifest, dict):
        raise ArtifactError("manifest.json must contain a JSON object")
    return manifest


def validate_manifest(artifact_dir: str | Path, require_models: bool = True) -> dict[str, Any]:
    root = Path(artifact_dir)
    manifest = load_manifest(root)

    feature_columns = manifest.get("feature_columns")
    if not isinstance(feature_columns, list) or not feature_columns:
        raise ArtifactError("manifest.json must define a non-empty feature_columns array")
    if not all(isinstance(column, str) and column for column in feature_columns):
        raise ArtifactError("manifest feature_columns must contain only non-empty strings")

    models = manifest.get("models")
    if not isinstance(models, dict):
        raise ArtifactError("manifest.json must define a models object")
    for model_key in ("total_score", "home_margin"):
        model_config = models.get(model_key)
        if not isinstance(model_config, dict):
            raise ArtifactError(f"manifest models.{model_key} must be an object")
        model_type = model_config.get("type")
        if model_type not in {"xgboost_json", "linear_json"}:
            raise ArtifactError(
                f"manifest models.{model_key}.type must be xgboost_json or linear_json"
            )
        model_path = model_config.get("path")
        if not isinstance(model_path, str) or not model_path:
            raise ArtifactError(f"manifest models.{model_key}.path must be a non-empty string")
        if require_models and not artifact_path(root, model_path).is_file():
            raise ArtifactError(f"Model artifact is missing for {model_key}: {artifact_path(root, model_path)}")

    team_stats = manifest.get("team_stats")
    if team_stats is not None:
        if not isinstance(team_stats, dict):
            raise ArtifactError("manifest team_stats must be an object when provided")
        stats_path = team_stats.get("path")
        if not isinstance(stats_path, str) or not stats_path:
            raise ArtifactError("manifest team_stats.path must be a non-empty string")
        if require_models and not artifact_path(root, stats_path).is_file():
            raise ArtifactError(f"Team stats artifact is missing: {artifact_path(root, stats_path)}")

    validate_feature_sources(manifest, feature_columns, has_team_stats=team_stats is not None)

    return manifest


def validate_feature_sources(
    manifest: dict[str, Any],
    feature_columns: list[str],
    has_team_stats: bool,
) -> None:
    feature_defaults = manifest.get("feature_defaults", {})
    if feature_defaults is None:
        feature_defaults = {}
    if not isinstance(feature_defaults, dict):
        raise ArtifactError("manifest feature_defaults must be an object when provided")

    invalid_defaults = [
        column
        for column in feature_columns
        if column in feature_defaults and not is_finite_number(feature_defaults[column])
    ]
    if invalid_defaults:
        raise ArtifactError(
            "manifest feature_defaults must contain numeric values for feature_columns: "
            + ", ".join(invalid_defaults[:20])
        )

    missing_request_defaults = [
        column
        for column in feature_columns
        if column in REQUEST_DEFAULT_FEATURES and column not in feature_defaults
    ]
    if missing_request_defaults:
        raise ArtifactError(
            "manifest feature_defaults must define request fallback values for: "
            + ", ".join(missing_request_defaults[:20])
        )

    if has_team_stats:
        return

    missing_defaults = [
        column
        for column in feature_columns
        if column not in feature_defaults
    ]
    if missing_defaults:
        raise ArtifactError(
            "manifest must define feature_defaults for all feature_columns when team_stats is not configured: "
            + ", ".join(missing_defaults[:20])
        )


def is_finite_number(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_summary(path: Path) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "path": str(path),
        "exists": path.is_file(),
    }
    if path.is_file():
        stat = path.stat()
        summary["size_bytes"] = stat.st_size
        summary["modified_at"] = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    return summary


def sqlite_summary(path: Path) -> dict[str, Any]:
    summary: dict[str, Any] = file_summary(path)
    if not path.is_file():
        return summary

    try:
        with sqlite3.connect(path) as connection:
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                ).fetchall()
            ]
    except sqlite3.Error as exc:
        summary["error"] = str(exc)
        return summary

    date_tables = [name for name in tables if is_iso_date(name)]
    summary["table_count"] = len(tables)
    summary["tables_sample"] = tables[:20]
    summary["date_table_count"] = len(date_tables)
    if date_tables:
        summary["date_range"] = {
            "start": min(date_tables),
            "end": max(date_tables),
        }
    return summary


def is_iso_date(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def build_artifact_inventory(
    artifact_dir: str | Path,
    require_models: bool = True,
) -> dict[str, Any]:
    root = Path(artifact_dir)
    inventory: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": utc_timestamp(),
        "artifact_dir": str(root),
        "model_manifest": file_summary(root / "manifest.json"),
        "validation": {
            "ok": True,
            "issues": [],
        },
        "feature_count": 0,
        "models": {},
        "team_stats": None,
        "artifact_files": scan_artifact_files(root),
    }

    try:
        manifest = validate_manifest(root, require_models=require_models)
    except ArtifactError as exc:
        inventory["validation"]["ok"] = False
        inventory["validation"]["issues"].append(str(exc))
        try:
            manifest = load_manifest(root)
        except ArtifactError:
            return inventory

    feature_columns = manifest.get("feature_columns")
    if isinstance(feature_columns, list):
        inventory["feature_count"] = len(feature_columns)
        inventory["feature_columns_sample"] = feature_columns[:20]

    models = manifest.get("models")
    if isinstance(models, dict):
        for model_key, model_config in models.items():
            if not isinstance(model_config, dict):
                continue
            configured_path = model_config.get("path")
            model_summary = {
                "type": model_config.get("type"),
                "configured_path": configured_path,
            }
            if isinstance(configured_path, str) and configured_path:
                model_summary.update(file_summary(artifact_path(root, configured_path)))
            inventory["models"][model_key] = model_summary

    team_stats = manifest.get("team_stats")
    if isinstance(team_stats, dict):
        stats_path = team_stats.get("path")
        stats_summary: dict[str, Any] = {
            "type": team_stats.get("type", "json"),
            "configured_path": stats_path,
        }
        if isinstance(stats_path, str) and stats_path:
            resolved = artifact_path(root, stats_path)
            if stats_summary["type"] == "sqlite":
                stats_summary.update(sqlite_summary(resolved))
            else:
                stats_summary.update(file_summary(resolved))
        inventory["team_stats"] = stats_summary

    return inventory


def scan_artifact_files(root: Path, max_files: int = 200) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "directory_exists": root.is_dir(),
        "count": 0,
        "total_size_bytes": 0,
        "truncated": False,
        "files": [],
    }
    if not root.is_dir():
        return summary

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        summary["count"] += 1
        summary["total_size_bytes"] += path.stat().st_size
        if len(summary["files"]) >= max_files:
            summary["truncated"] = True
            continue
        summary["files"].append({
            "path": str(path.relative_to(root)),
            "size_bytes": path.stat().st_size,
        })
    return summary


def write_state_manifest(artifact_dir: str | Path, inventory: dict[str, Any]) -> Path:
    root = Path(artifact_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / STATE_MANIFEST_NAME
    with path.open("w", encoding="utf-8") as handle:
        json.dump(inventory, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return path


def append_run_log(
    artifact_dir: str | Path,
    event: str,
    summary: dict[str, Any],
) -> Path:
    root = Path(artifact_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / IMPORT_LOG_NAME
    record = {
        "logged_at": utc_timestamp(),
        "event": event,
        "summary": summary,
    }
    with path.open("a", encoding="utf-8") as handle:
        json.dump(record, handle, sort_keys=True)
        handle.write("\n")
    return path
