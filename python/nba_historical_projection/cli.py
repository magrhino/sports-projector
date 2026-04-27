from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .artifacts import (
    ArtifactError,
    append_run_log,
    build_artifact_inventory,
    validate_manifest,
    write_state_manifest,
)
from .models import predict_from_artifacts
from .providers.sportsdb import DEFAULT_RATE_LIMIT_PER_MINUTE, DEFAULT_SPORTSDB_API_KEY
from .sportsdb_import import import_sportsdb_artifacts
from .training import train_xgboost_regressors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Historical NBA projection artifact CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    predict_parser = subparsers.add_parser("predict", help="Project a matchup from local artifacts")
    predict_parser.add_argument("--artifact-dir", required=True)
    predict_parser.add_argument("--input", help="JSON request. Defaults to stdin.")

    validate_parser = subparsers.add_parser("validate-artifacts", help="Validate local artifacts")
    validate_parser.add_argument("--artifact-dir", required=True)
    validate_parser.add_argument(
        "--write-state",
        action="store_true",
        help="Write artifact_manifest.json inventory state into the artifact directory.",
    )
    validate_parser.add_argument(
        "--log-run",
        action="store_true",
        help="Append this validation result to artifact_import_log.jsonl.",
    )

    inventory_parser = subparsers.add_parser(
        "inventory-artifacts",
        help="Inventory local historical artifacts without requiring them to be complete.",
    )
    inventory_parser.add_argument("--artifact-dir", required=True)
    inventory_parser.add_argument(
        "--write-state",
        action="store_true",
        help="Write artifact_manifest.json inventory state into the artifact directory.",
    )
    inventory_parser.add_argument(
        "--log-run",
        action="store_true",
        help="Append this inventory result to artifact_import_log.jsonl.",
    )

    train_parser = subparsers.add_parser("train", help="Train historical XGBoost score regressors")
    train_parser.add_argument("--dataset", required=True)
    train_parser.add_argument("--table", required=True)
    train_parser.add_argument("--artifact-dir", required=True)
    train_parser.add_argument("--source-repo", default="magrhino/NBA-Machine-Learning-Sports-Betting")
    train_parser.add_argument("--source-ref", default="master")
    train_parser.add_argument("--season", action="append", default=[])
    train_parser.add_argument("--test-size", type=float, default=0.1)
    train_parser.add_argument("--model-kind", choices=["direct", "market-residual", "auto"], default="direct")
    train_parser.add_argument("--early-stopping-rounds", type=int, default=25)
    train_parser.add_argument("--validation-splits", type=int, default=3)
    train_parser.add_argument("--calibration", choices=["none", "empirical", "isotonic", "platt", "auto"], default="auto")
    train_parser.add_argument("--quantiles")
    train_parser.add_argument("--experimental-market-decorrelation", action="store_true")

    sportsdb_parser = subparsers.add_parser(
        "import-sportsdb",
        help="Import NBA historical artifacts from TheSportsDB v1 and train local linear models",
    )
    sportsdb_parser.add_argument("--artifact-dir", default="data/historical")
    sportsdb_parser.add_argument("--sport", default="nba", choices=["nba"])
    sportsdb_parser.add_argument("--api-key", default=DEFAULT_SPORTSDB_API_KEY)
    sportsdb_parser.add_argument("--season", action="append", default=[])
    sportsdb_parser.add_argument("--lookback-seasons", type=int, default=None)
    sportsdb_parser.add_argument("--rate-limit-per-minute", type=int, default=DEFAULT_RATE_LIMIT_PER_MINUTE)
    sportsdb_parser.add_argument("--market-lines-csv")
    sportsdb_parser.add_argument("--availability-csv")
    sportsdb_parser.add_argument("--model-kind", choices=["direct", "market-residual", "auto"], default="auto")
    sportsdb_parser.add_argument("--validation-splits", type=int, default=3)
    sportsdb_parser.add_argument("--calibration", choices=["none", "empirical", "isotonic", "platt", "auto"], default="auto")
    sportsdb_parser.add_argument("--quantiles")
    sportsdb_parser.add_argument("--rating-features", choices=["none", "market"], default="none")
    sportsdb_parser.add_argument("--rating-line-source", choices=["open", "close", "provided"], default="close")
    sportsdb_parser.add_argument("--skill-features", choices=["none", "score-based"], default="none")
    sportsdb_parser.add_argument("--experimental-market-decorrelation", action="store_true")
    sportsdb_parser.add_argument("--recent-days", type=int, default=3)
    sportsdb_parser.add_argument("--lookahead-days", type=int, default=2)
    sportsdb_parser.add_argument("--event-id", action="append", default=[])
    sportsdb_parser.add_argument(
        "--no-team-last-events",
        action="store_true",
        help="Do not supplement the season import with each team's latest SportsDB event.",
    )
    sportsdb_parser.add_argument(
        "--no-write-state",
        action="store_true",
        help="Do not write artifact_manifest.json after import.",
    )
    sportsdb_parser.add_argument(
        "--no-log-run",
        action="store_true",
        help="Do not append an import-sportsdb entry to artifact_import_log.jsonl.",
    )

    evaluate_parser = subparsers.add_parser("evaluate", help="Report historical artifact validation metrics")
    evaluate_parser.add_argument("--artifact-dir", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "predict":
            request = read_request(args.input)
            result = predict_from_artifacts(args.artifact_dir, request)
            write_json(result)
            return 0
        if args.command == "validate-artifacts":
            manifest = validate_manifest(args.artifact_dir)
            result = {
                "ok": True,
                "artifact_dir": str(Path(args.artifact_dir)),
                "feature_count": len(manifest["feature_columns"]),
                "models": sorted(manifest["models"].keys()),
            }
            if args.write_state or args.log_run:
                inventory = build_artifact_inventory(args.artifact_dir)
                if args.write_state:
                    write_state_manifest(args.artifact_dir, inventory)
                if args.log_run:
                    append_run_log(args.artifact_dir, "validate-artifacts", result)
            write_json(result)
            return 0
        if args.command == "inventory-artifacts":
            inventory = build_artifact_inventory(args.artifact_dir)
            if args.write_state:
                write_state_manifest(args.artifact_dir, inventory)
            if args.log_run:
                append_run_log(args.artifact_dir, "inventory-artifacts", {
                    "ok": inventory["validation"]["ok"],
                    "feature_count": inventory.get("feature_count", 0),
                    "model_count": len(inventory.get("models", {})),
                })
            write_json(inventory)
            return 0
        if args.command == "train":
            manifest = train_xgboost_regressors(
                dataset_path=args.dataset,
                table=args.table,
                artifact_dir=args.artifact_dir,
                source_repo=args.source_repo,
                source_ref=args.source_ref,
                seasons=args.season,
                test_size=args.test_size,
                model_kind=args.model_kind,
                early_stopping_rounds=args.early_stopping_rounds,
                validation_splits=args.validation_splits,
                calibration=args.calibration,
                quantiles=args.quantiles,
                experimental_market_decorrelation=args.experimental_market_decorrelation,
            )
            result = {
                "ok": True,
                "artifact_dir": str(Path(args.artifact_dir)),
                "feature_count": len(manifest["feature_columns"]),
                "models": sorted(manifest["models"].keys()),
            }
            inventory = build_artifact_inventory(args.artifact_dir)
            write_state_manifest(args.artifact_dir, inventory)
            append_run_log(args.artifact_dir, "train", {
                **result,
                "dataset": args.dataset,
                "table": args.table,
                "source_repo": args.source_repo,
                "source_ref": args.source_ref,
                "seasons": args.season,
            })
            write_json(result)
            return 0
        if args.command == "import-sportsdb":
            result = import_sportsdb_artifacts(
                artifact_dir=args.artifact_dir,
                sport=args.sport,
                api_key=args.api_key,
                seasons=args.season,
                lookback_seasons=args.lookback_seasons,
                rate_limit_per_minute=args.rate_limit_per_minute,
                write_state=not args.no_write_state,
                log_run=not args.no_log_run,
                market_lines_csv=args.market_lines_csv,
                availability_csv=args.availability_csv,
                model_kind=args.model_kind,
                validation_splits=args.validation_splits,
                calibration=args.calibration,
                quantiles=args.quantiles,
                rating_features=args.rating_features,
                rating_line_source=args.rating_line_source,
                skill_features=args.skill_features,
                experimental_market_decorrelation=args.experimental_market_decorrelation,
                recent_days=args.recent_days,
                lookahead_days=args.lookahead_days,
                event_ids=args.event_id,
                include_team_last_events=not args.no_team_last_events,
            )
            write_json(result)
            return 0
        if args.command == "evaluate":
            manifest = validate_manifest(args.artifact_dir)
            write_json(evaluation_summary(args.artifact_dir, manifest))
            return 0
    except (ArtifactError, KeyError, TypeError, ValueError, RuntimeError) as exc:
        write_json({"error": {"type": exc.__class__.__name__, "message": str(exc)}}, stream=sys.stderr)
        return 1

    write_json({"error": {"type": "UnknownCommand", "message": str(args.command)}}, stream=sys.stderr)
    return 1


def read_request(raw_input: str | None) -> dict[str, Any]:
    raw = raw_input if raw_input is not None else sys.stdin.read()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Request JSON is invalid: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Request JSON must be an object")
    for key in ("home_team", "away_team", "game_date"):
        if key not in parsed:
            raise ValueError(f"Request JSON is missing required field: {key}")
    return parsed


def write_json(value: Any, stream=None) -> None:
    if stream is None:
        stream = sys.stdout
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")


def evaluation_summary(artifact_dir: str, manifest: dict[str, Any]) -> dict[str, Any]:
    models = manifest.get("models", {})
    return {
        "ok": True,
        "artifact_dir": str(Path(artifact_dir)),
        "generated_at": manifest.get("generated_at"),
        "data_sources": manifest.get("data_sources", {}),
        "feature_generators": manifest.get("feature_generators", {}),
        "calibration": manifest.get("calibration", {}),
        "quantile_models": manifest.get("quantile_models", {}),
        "rating_features": manifest.get("rating_features", {}),
        "skill_features": manifest.get("skill_features", {}),
        "validation_reports": manifest.get("validation_reports", {}),
        "models": {
            key: {
                "type": config.get("type"),
                "target_mode": config.get("target_mode", "direct"),
                "residual_stddev": config.get("residual_stddev"),
                "validation_rmse": config.get("validation_rmse"),
                "validation_mae": config.get("validation_mae"),
                "validation_rows": config.get("validation_rows"),
                "validation": config.get("validation"),
                "uncertainty": config.get("uncertainty"),
            }
            for key, config in models.items()
            if isinstance(config, dict)
        },
    }


if __name__ == "__main__":
    raise SystemExit(main())
