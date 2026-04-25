from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime
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
from nba_historical_projection.providers.sportsdb import (
    DEFAULT_SPORTSDB_API_KEY,
    SportsDbRateLimiter,
    build_sportsdb_url,
)
from nba_historical_projection.sportsdb_import import (
    TRAINING_TABLE,
    SportsDbGame,
    build_training_and_snapshots,
    import_sportsdb_artifacts,
    load_availability_csv,
    load_market_lines_csv,
    parse_games,
    recent_nba_seasons,
    select_seasons,
)
from nba_historical_projection.training import (
    build_feature_defaults_from_frame,
    finite_target_arrays,
    split_index_for_rows,
)


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

    def test_xgboost_target_filter_drops_non_finite_labels(self):
        target_x, target_y = finite_target_arrays(
            [[1.0], [2.0], [3.0], [4.0]],
            [220.0, float("nan"), 215.0, float("inf")],
        )

        self.assertEqual(target_x, [[1.0], [3.0]])
        self.assertEqual(target_y, [220.0, 215.0])
        self.assertEqual(split_index_for_rows(len(target_y), 0.9), 1)

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
                        "total_score": {
                            "type": "linear_json",
                            "path": "models/total.json",
                            "target_mode": "direct",
                            "residual_stddev": 9,
                            "uncertainty": {
                                "calibration_source": "chronological_validation_residuals",
                                "intervals": {"90": 12},
                            },
                        },
                        "home_margin": {
                            "type": "linear_json",
                            "path": "models/margin.json",
                            "target_mode": "direct",
                            "residual_stddev": 5,
                            "uncertainty": {
                                "calibration_source": "chronological_validation_residuals",
                                "intervals": {"90": 7},
                            },
                        },
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
            self.assertEqual(result["uncertainty"]["total_score_interval_90"], [-12.0, 12.0])
            self.assertEqual(result["uncertainty"]["home_margin_interval_90"], [-7.0, 7.0])
            self.assertEqual(result["artifact"]["models"]["total_score"]["target_mode"], "direct")
            serialized = json.dumps(result).lower()
            self.assertNotIn("kelly", serialized)
            self.assertNotIn("stake", serialized)
            self.assertNotIn("wager", serialized)

    def test_predict_reconstructs_market_residual_models(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "models").mkdir()
            self.write_json(root / "models" / "total.json", {"intercept": 2, "coefficients": [0, 0]})
            self.write_json(root / "models" / "margin.json", {"intercept": -1, "coefficients": [0, 0]})
            self.write_json(
                root / "manifest.json",
                {
                    "feature_columns": ["MARKET_TOTAL_CLOSE", "MARKET_SPREAD_CLOSE"],
                    "feature_defaults": {"MARKET_TOTAL_CLOSE": 220, "MARKET_SPREAD_CLOSE": 3},
                    "models": {
                        "total_score": {
                            "type": "linear_json",
                            "path": "models/total.json",
                            "target_mode": "market_residual",
                            "uncertainty": {"intervals": {"90": 10}},
                        },
                        "home_margin": {
                            "type": "linear_json",
                            "path": "models/margin.json",
                            "target_mode": "market_residual",
                            "uncertainty": {"intervals": {"90": 6}},
                        },
                    },
                },
            )

            result = predict_from_artifacts(
                root,
                {
                    "home_team": "Boston Celtics",
                    "away_team": "New York Knicks",
                    "game_date": "2026-04-25",
                    "market_total": 221.5,
                    "market_spread": 4.5,
                },
            )

            self.assertEqual(result["projected_total"], 223.5)
            self.assertEqual(result["projected_home_margin"], 3.5)
            self.assertEqual(result["artifact"]["models"]["total_score"]["target_mode"], "market_residual")

    def test_validate_manifest_rejects_malformed_uncertainty_interval(self):
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
                        "total_score": {
                            "type": "linear_json",
                            "path": "models/total.json",
                            "uncertainty": {"intervals": {"90": -1}},
                        },
                        "home_margin": {"type": "linear_json", "path": "models/margin.json"},
                    },
                },
            )

            with self.assertRaisesRegex(ArtifactError, "interval width"):
                validate_manifest(root)

    def test_sportsdb_url_defaults_to_public_test_key(self):
        url = build_sportsdb_url(
            DEFAULT_SPORTSDB_API_KEY,
            "eventsseason.php",
            {"id": "4387", "s": "2025-2026"},
        )

        self.assertEqual(
            url,
            "https://www.thesportsdb.com/api/v1/json/123/eventsseason.php?id=4387&s=2025-2026",
        )

    def test_sportsdb_rate_limiter_spaces_requests(self):
        current = {"value": 0.0}
        sleeps = []

        def clock():
            return current["value"]

        def sleep(seconds):
            sleeps.append(seconds)
            current["value"] += seconds

        limiter = SportsDbRateLimiter(requests_per_minute=30, clock=clock, sleep=sleep)

        limiter.wait()
        current["value"] += 0.5
        limiter.wait()
        limiter.wait_after_429()

        self.assertAlmostEqual(sleeps[0], 1.5)
        self.assertEqual(sleeps[1], 65.0)

    def test_sportsdb_selects_recent_present_day_seasons_by_default(self):
        self.assertEqual(
            recent_nba_seasons(6, today=datetime(2026, 4, 25)),
            ["2020-2021", "2021-2022", "2022-2023", "2023-2024", "2024-2025", "2025-2026"],
        )

    def test_sportsdb_default_selection_ignores_stale_provider_season_list(self):
        self.assertEqual(
            select_seasons(
                ["1960-1961", "1961-1962", "1962-1963", "1963-1964", "1964-1965"],
                requested=[],
                lookback_seasons=3,
                sport="nba",
                today=datetime(2026, 4, 25),
            ),
            ["2023-2024", "2024-2025", "2025-2026"],
        )

    def test_sportsdb_parser_skips_future_games_without_scores(self):
        games = parse_games(
            {
                "events": [
                    {
                        "idEvent": "1",
                        "strSeason": "2025-2026",
                        "dateEvent": "2025-10-21",
                        "strHomeTeam": "Boston Celtics",
                        "strAwayTeam": "New York Knicks",
                        "intHomeScore": "114",
                        "intAwayScore": "107",
                    },
                    {
                        "idEvent": "2",
                        "strSeason": "2025-2026",
                        "dateEvent": "2026-04-25",
                        "strHomeTeam": "Boston Celtics",
                        "strAwayTeam": "Brooklyn Nets",
                        "intHomeScore": None,
                        "intAwayScore": None,
                    },
                ]
            },
            fallback_season="2025-2026",
        )

        self.assertEqual(len(games), 2)
        self.assertTrue(games[0].is_final)
        self.assertFalse(games[1].is_final)

    def test_market_and_availability_csv_parsers_match_normalized_teams(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            market_path = root / "market_lines.csv"
            availability_path = root / "availability.csv"
            market_path.write_text(
                "game_date,home_team,away_team,closing_total,closing_spread,opening_total,opening_spread\n"
                "2025-10-21,Boston Celtics,New York Knicks,220.5,4.5,218.5,3.5\n",
                encoding="utf-8",
            )
            availability_path.write_text(
                "date,team,unavailable_minutes,unavailable_value\n"
                "2025-10-21,Boston Celtics,32,5.5\n"
                "2025-10-21,boston celtics,8,1.5\n",
                encoding="utf-8",
            )

            market_lines = load_market_lines_csv(market_path)
            availability = load_availability_csv(availability_path)

            self.assertEqual(len(market_lines), 1)
            market_line = next(iter(market_lines.values()))
            self.assertEqual(market_line.closing_total, 220.5)
            self.assertEqual(market_line.opening_spread, 3.5)
            self.assertEqual(len(availability), 1)
            self.assertEqual(next(iter(availability.values())).unavailable_minutes, 40.0)

    def test_sportsdb_import_writes_manifest_models_and_local_snapshots(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            result = import_sportsdb_artifacts(
                artifact_dir=root,
                seasons=["2025-2026"],
                client=FakeSportsDbClient(),
            )

            self.assertTrue(result["validation"]["ok"])
            self.assertEqual(result["final_games"], 4)
            self.assertTrue((root / "manifest.json").is_file())
            self.assertTrue((root / "artifact_manifest.json").is_file())
            self.assertTrue((root / "artifact_import_log.jsonl").is_file())
            self.assertTrue((root / "models" / "total_score.json").is_file())
            self.assertTrue((root / "sportsdb" / "normalized" / "nba_games.sqlite").is_file())
            self.assertTrue((root / "sportsdb" / "normalized" / "nba_team_stats.sqlite").is_file())

            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["source"]["type"], "sportsdb_v1")
            self.assertEqual(manifest["source"]["api_key"], "123")
            self.assertEqual(manifest["source"]["rate_limit_per_minute"], 30)
            self.assertEqual(manifest["team_stats"]["type"], "sqlite")
            self.assertIn("PRIOR_GAMES", manifest["feature_columns"])
            self.assertIn("PRIOR_GAMES.1", manifest["feature_columns"])

            projection = predict_from_artifacts(
                root,
                {
                    "home_team": "Boston Celtics",
                    "away_team": "New York Knicks",
                    "game_date": "2026-04-25",
                    "include_debug": True,
                },
            )
            self.assertIn("projected_total", projection)
            self.assertEqual(projection["artifact"]["source"]["type"], "sportsdb_v1")

    def test_sportsdb_import_enriches_market_lines_and_availability(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            market_path = root / "market_lines.csv"
            availability_path = root / "availability.csv"
            market_path.write_text(
                "game_date,home_team,away_team,closing_total,closing_spread,opening_total,opening_spread\n"
                "2025-10-21,Boston Celtics,New York Knicks,220,6,218,5\n"
                "2025-10-22,Brooklyn Nets,Boston Celtics,205,-7,204,-6\n"
                "2025-10-24,New York Knicks,Brooklyn Nets,211,7,210,6\n"
                "2025-10-26,Boston Celtics,Brooklyn Nets,214,8,213,7\n",
                encoding="utf-8",
            )
            availability_path.write_text(
                "date,team,unavailable_minutes,unavailable_value\n"
                "2025-10-21,Boston Celtics,24,3\n"
                "2025-10-22,Brooklyn Nets,18,2\n",
                encoding="utf-8",
            )

            result = import_sportsdb_artifacts(
                artifact_dir=root,
                seasons=["2025-2026"],
                client=FakeSportsDbClient(),
                market_lines_csv=market_path,
                availability_csv=availability_path,
                model_kind="market-residual",
                validation_splits=2,
            )

            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(result["market_line_matches"], 4)
            self.assertEqual(manifest["data_sources"]["market_lines"]["matched_rows"], 4)
            self.assertIn("MARKET_TOTAL_CLOSE", manifest["feature_columns"])
            self.assertIn("HOME_UNAVAILABLE_MINUTES", manifest["feature_columns"])
            self.assertNotIn("Total-Market-Residual", manifest["feature_columns"])
            self.assertEqual(manifest["models"]["total_score"]["target_mode"], "market_residual")
            self.assertIn("uncertainty", manifest["models"]["total_score"])

            with sqlite3.connect(root / "sportsdb" / "normalized" / "nba_games.sqlite") as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute(
                    f'SELECT * FROM "{TRAINING_TABLE}" WHERE "Date" = ?',
                    ("2025-10-21",),
                ).fetchone()
            self.assertEqual(row["MARKET_TOTAL_CLOSE"], 220.0)
            self.assertEqual(row["Total-Market-Residual"], 1.0)
            self.assertEqual(row["HOME_UNAVAILABLE_MINUTES"], 24.0)

    def test_sportsdb_import_default_uses_recent_seasons_when_provider_lists_old_samples(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            result = import_sportsdb_artifacts(
                artifact_dir=root,
                lookback_seasons=1,
                client=FakeSportsDbClient(stale_season_list=True),
            )

            self.assertEqual(result["seasons"], ["2025-2026"])

    def test_sportsdb_training_features_reset_at_season_boundaries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            dataset_path = root / "games.sqlite"
            team_stats_path = root / "team_stats.sqlite"

            build_training_and_snapshots(
                [
                    SportsDbGame("1", "2024-2025", "2025-04-15", "Boston Celtics", "New York Knicks", 120, 110),
                    SportsDbGame("2", "2025-2026", "2025-10-21", "Boston Celtics", "New York Knicks", 100, 90),
                ],
                ["Boston Celtics", "New York Knicks"],
                dataset_path,
                team_stats_path,
            )

            with sqlite3.connect(dataset_path) as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute(
                    f'SELECT * FROM "{TRAINING_TABLE}" WHERE "Date" = ?',
                    ("2025-10-21",),
                ).fetchone()

            self.assertIsNotNone(row)
            self.assertEqual(row["PRIOR_GAMES"], 0.0)
            self.assertEqual(row["PRIOR_GAMES.1"], 0.0)
            self.assertEqual(row["DAYS_REST"], 7.0)
            self.assertEqual(row["DAYS_REST.1"], 7.0)

    def write_json(self, path: Path, value):
        with path.open("w", encoding="utf-8") as handle:
            json.dump(value, handle)


class FakeSportsDbClient:
    def __init__(self, stale_season_list=False):
        self.stale_season_list = stale_season_list

    def fetch_all_seasons(self, league_id: str):
        self.assert_nba_league(league_id)
        if self.stale_season_list:
            return {
                "seasons": [
                    {"strSeason": "1960-1961"},
                    {"strSeason": "1961-1962"},
                    {"strSeason": "1962-1963"},
                    {"strSeason": "1963-1964"},
                    {"strSeason": "1964-1965"},
                ]
            }
        return {
            "seasons": [
                {"strSeason": "2024-2025"},
                {"strSeason": "2025-2026"},
            ]
        }

    def fetch_all_teams(self, league_name: str):
        if league_name != "NBA":
            raise AssertionError(f"unexpected league: {league_name}")
        return {
            "teams": [
                {"strTeam": "Boston Celtics"},
                {"strTeam": "New York Knicks"},
                {"strTeam": "Brooklyn Nets"},
            ]
        }

    def fetch_season_events(self, league_id: str, season: str):
        self.assert_nba_league(league_id)
        if season != "2025-2026":
            raise AssertionError(f"unexpected season: {season}")
        return {
            "events": [
                self.event("1001", "2025-10-21", "Boston Celtics", "New York Knicks", 114, 107),
                self.event("1002", "2025-10-22", "Brooklyn Nets", "Boston Celtics", 98, 106),
                self.event("1003", "2025-10-24", "New York Knicks", "Brooklyn Nets", 109, 101),
                self.event("1004", "2025-10-26", "Boston Celtics", "Brooklyn Nets", 111, 104),
                self.event("1005", "2026-04-25", "Boston Celtics", "New York Knicks", None, None),
            ]
        }

    def event(self, event_id, date, home, away, home_score, away_score):
        return {
            "idEvent": event_id,
            "strSeason": "2025-2026",
            "dateEvent": date,
            "strHomeTeam": home,
            "strAwayTeam": away,
            "intHomeScore": None if home_score is None else str(home_score),
            "intAwayScore": None if away_score is None else str(away_score),
        }

    def assert_nba_league(self, league_id: str):
        if league_id != "4387":
            raise AssertionError(f"unexpected league id: {league_id}")


if __name__ == "__main__":
    unittest.main()
