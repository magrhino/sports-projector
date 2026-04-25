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


if __name__ == "__main__":
    raise SystemExit(main())
