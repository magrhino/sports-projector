from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from nba_historical_projection.artifacts import (
    ArtifactError,
    IMPORT_LOG_NAME,
    STATE_MANIFEST_NAME,
    build_artifact_inventory,
    validate_manifest,
)
from nba_historical_projection.cli import main as cli_main
from nba_historical_projection.dataset import build_game_record
from nba_historical_projection.models import derive_team_scores, predict_from_artifacts
from nba_historical_projection.training import build_feature_defaults_from_frame


class HistoricalProjectionTests(unittest.TestCase):
    def test_derives_team_scores_from_total_and_margin(self):
        self.assertEqual(
            derive_team_scores(224.0, 6.0),
            {
                "projected_home_score": 115.0,
                "projected_away_score": 109.0,
                "projected_total": 224.0,
                "projected_home_margin": 6.0,
            },
        )

    def test_build_game_record_preserves_score_and_home_margin_targets(self):
        record = build_game_record(
            home_stats={"PACE": 99.1, "TEAM_NAME": "Boston Celtics"},
            away_stats={"PACE": 97.4, "TEAM_NAME": "New York Knicks"},
            game_result={
                "Points": 221,
                "Win_Margin": 7,
                "OU": 219.5,
                "Days_Rest_Home": 2,
                "Days_Rest_Away": 1,
            },
        )

        self.assertEqual(record["Score"], 221.0)
        self.assertEqual(record["Home-Margin"], 7.0)
        self.assertEqual(record["Home-Team-Win"], 1)
        self.assertEqual(record["OU-Cover"], 1)
        self.assertEqual(record["PACE"], 99.1)
        self.assertEqual(record["PACE.1"], 97.4)

    def test_validate_manifest_fails_when_model_is_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_json(
                root / "manifest.json",
                {
                    "feature_columns": ["POWER"],
                    "models": {
                        "total_score": {"type": "linear_json", "path": "missing-total.json"},
                        "home_margin": {"type": "linear_json", "path": "missing-margin.json"},
                    },
                },
            )

            with self.assertRaises(ArtifactError):
                validate_manifest(root)

    def test_artifact_inventory_reports_missing_model_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_json(
                root / "manifest.json",
                {
                    "feature_columns": ["POWER"],
                    "models": {
                        "total_score": {"type": "linear_json", "path": "missing-total.json"},
                        "home_margin": {"type": "linear_json", "path": "missing-margin.json"},
                    },
                },
            )

            inventory = build_artifact_inventory(root)

            self.assertFalse(inventory["validation"]["ok"])
            self.assertEqual(inventory["feature_count"], 1)
            self.assertFalse(inventory["models"]["total_score"]["exists"])
            self.assertIn("Model artifact is missing", inventory["validation"]["issues"][0])

    def test_validate_manifest_fails_without_team_stats_or_feature_defaults(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "models").mkdir()
            self.write_json(root / "models" / "total.json", {"intercept": 200, "coefficients": [1]})
            self.write_json(root / "models" / "margin.json", {"intercept": 0, "coefficients": [1]})
            self.write_json(
                root / "manifest.json",
                {
                    "feature_columns": ["POWER"],
                    "models": {
                        "total_score": {"type": "linear_json", "path": "models/total.json"},
                        "home_margin": {"type": "linear_json", "path": "models/margin.json"},
                    },
                },
            )

            with self.assertRaisesRegex(ArtifactError, "feature_defaults"):
                validate_manifest(root)

    def test_training_feature_defaults_use_numeric_medians(self):
        defaults = build_feature_defaults_from_frame(
            {
                "HOME_POWER": [1, 3, 5],
                "AWAY_POWER": ["2", "4", "6"],
            },
            ["HOME_POWER", "AWAY_POWER"],
        )

        self.assertEqual(defaults, {"HOME_POWER": 3.0, "AWAY_POWER": 4.0})

    def test_validate_cli_can_write_state_and_run_log(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "models").mkdir()
            self.write_json(root / "models" / "total.json", {"intercept": 200, "coefficients": [1]})
            self.write_json(root / "models" / "margin.json", {"intercept": 0, "coefficients": [1]})
            self.write_json(
                root / "manifest.json",
                {
                    "feature_columns": ["POWER"],
                    "feature_defaults": {"POWER": 1},
                    "models": {
                        "total_score": {"type": "linear_json", "path": "models/total.json"},
                        "home_margin": {"type": "linear_json", "path": "models/margin.json"},
                    },
                },
            )

            with redirect_stdout(StringIO()):
                exit_code = cli_main([
                    "validate-artifacts",
                    "--artifact-dir",
                    str(root),
                    "--write-state",
                    "--log-run",
                ])

            self.assertEqual(exit_code, 0)
            state = json.loads((root / STATE_MANIFEST_NAME).read_text(encoding="utf-8"))
            self.assertTrue(state["validation"]["ok"])
            log_lines = (root / IMPORT_LOG_NAME).read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(log_lines), 1)
            self.assertEqual(json.loads(log_lines[0])["event"], "validate-artifacts")

    def test_predict_contract_with_fixture_linear_models(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "models").mkdir()
            self.write_json(root / "models" / "total.json", {"intercept": 200, "coefficients": [2, 1]})
            self.write_json(root / "models" / "margin.json", {"intercept": 0, "coefficients": [1, -1]})
            self.write_json(
                root / "manifest.json",
                {
                    "generated_at": "2026-04-25T00:00:00+00:00",
                    "source": {"repo": "magrhino/NBA-Machine-Learning-Sports-Betting", "ref": "fixture"},
                    "seasons": ["2025-26"],
                    "feature_columns": ["HOME_POWER", "AWAY_POWER"],
                    "feature_defaults": {"HOME_POWER": 3, "AWAY_POWER": 2},
                    "models": {
                        "total_score": {"type": "linear_json", "path": "models/total.json", "residual_stddev": 9},
                        "home_margin": {"type": "linear_json", "path": "models/margin.json", "residual_stddev": 5},
                    },
                },
            )

            result = predict_from_artifacts(
                root,
                {
                    "home_team": "Boston Celtics",
                    "away_team": "New York Knicks",
                    "game_date": "2026-04-25",
                    "include_debug": True,
                },
            )

            self.assertEqual(result["projected_total"], 208.0)
            self.assertEqual(result["projected_home_margin"], 1.0)
            self.assertEqual(result["projected_home_score"], 104.5)
            self.assertEqual(result["projected_away_score"], 103.5)
            self.assertEqual(result["uncertainty"]["total_score_residual_stddev"], 9.0)
            serialized = json.dumps(result).lower()
            self.assertNotIn("kelly", serialized)
            self.assertNotIn("stake", serialized)
            self.assertNotIn("wager", serialized)

    def write_json(self, path: Path, value):
        with path.open("w", encoding="utf-8") as handle:
            json.dump(value, handle)


if __name__ == "__main__":
    unittest.main()
