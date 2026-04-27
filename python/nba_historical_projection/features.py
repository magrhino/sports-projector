from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .artifacts import ArtifactError, artifact_path, load_json


TEAM_INDEX_CURRENT = {
    "Atlanta Hawks": 0,
    "Boston Celtics": 1,
    "Brooklyn Nets": 2,
    "Charlotte Hornets": 3,
    "Chicago Bulls": 4,
    "Cleveland Cavaliers": 5,
    "Dallas Mavericks": 6,
    "Denver Nuggets": 7,
    "Detroit Pistons": 8,
    "Golden State Warriors": 9,
    "Houston Rockets": 10,
    "Indiana Pacers": 11,
    "Los Angeles Clippers": 12,
    "LA Clippers": 12,
    "Los Angeles Lakers": 13,
    "Memphis Grizzlies": 14,
    "Miami Heat": 15,
    "Milwaukee Bucks": 16,
    "Minnesota Timberwolves": 17,
    "New Orleans Pelicans": 18,
    "New York Knicks": 19,
    "Oklahoma City Thunder": 20,
    "Orlando Magic": 21,
    "Philadelphia 76ers": 22,
    "Phoenix Suns": 23,
    "Portland Trail Blazers": 24,
    "Sacramento Kings": 25,
    "San Antonio Spurs": 26,
    "Toronto Raptors": 27,
    "Utah Jazz": 28,
    "Washington Wizards": 29,
}


def normalize_team_name(value: str) -> str:
    normalized = " ".join(value.strip().split())
    if normalized == "Los Angeles Clippers":
        return "LA Clippers"
    return normalized


def build_feature_vector(
    artifact_dir: str | Path,
    manifest: dict[str, Any],
    request: dict[str, Any],
) -> tuple[list[float], dict[str, float]]:
    root = Path(artifact_dir)
    feature_columns = manifest["feature_columns"]
    feature_defaults = manifest.get("feature_defaults", {})
    if not isinstance(feature_defaults, dict):
        raise ArtifactError("manifest feature_defaults must be an object when provided")

    home_team = normalize_team_name(str(request["home_team"]))
    away_team = normalize_team_name(str(request["away_team"]))
    game_date = str(request["game_date"])
    home_stats, away_stats = load_matchup_stats(root, manifest, game_date, home_team, away_team)

    feature_values: dict[str, float] = {}
    missing: list[str] = []
    for column in feature_columns:
        value = resolve_feature_value(column, request, home_stats, away_stats, feature_defaults)
        if value is None:
            missing.append(column)
            continue
        feature_values[column] = float(value)

    if missing:
        raise ArtifactError(
            "Unable to build historical feature vector; missing values for: "
            + ", ".join(missing[:20])
        )

    return [feature_values[column] for column in feature_columns], feature_values


def resolve_feature_value(
    column: str,
    request: dict[str, Any],
    home_stats: dict[str, Any],
    away_stats: dict[str, Any],
    defaults: dict[str, Any],
) -> float | None:
    if column == "Days-Rest-Home":
        return numeric_or_none(request.get("days_rest_home", defaults.get(column)))
    if column == "Days-Rest-Away":
        return numeric_or_none(request.get("days_rest_away", defaults.get(column)))
    if column == "OU":
        return numeric_or_none(request.get("market_total", defaults.get(column)))
    if column == "Spread":
        return numeric_or_none(request.get("market_spread", defaults.get(column)))
    if column == "MARKET_TOTAL_CLOSE":
        return numeric_or_none(request.get("market_total", defaults.get(column)))
    if column == "MARKET_SPREAD_CLOSE":
        return numeric_or_none(request.get("market_spread", defaults.get(column)))
    if column in {
        "MARKET_TOTAL_OPEN",
        "MARKET_SPREAD_OPEN",
        "MARKET_TOTAL_MOVE",
        "MARKET_SPREAD_MOVE",
        "HOME_UNAVAILABLE_MINUTES",
        "AWAY_UNAVAILABLE_MINUTES",
        "HOME_UNAVAILABLE_VALUE",
        "AWAY_UNAVAILABLE_VALUE",
    }:
        return numeric_or_none(defaults.get(column))

    if column == "HOME_MARKET_RATING":
        return snapshot_or_default(home_stats, "MARKET_RATING", defaults, column)
    if column == "AWAY_MARKET_RATING":
        return snapshot_or_default(away_stats, "MARKET_RATING", defaults, column)
    if column == "MARKET_RATING_DIFF":
        home_rating = snapshot_number(home_stats, "MARKET_RATING")
        away_rating = snapshot_number(away_stats, "MARKET_RATING")
        if home_rating is None or away_rating is None:
            return numeric_or_none(defaults.get(column))
        return home_rating - away_rating
    if column == "HOME_MARKET_RATING_PREV_N_AVG":
        return snapshot_or_default(home_stats, "MARKET_RATING_PREV_N_AVG", defaults, column)
    if column == "AWAY_MARKET_RATING_PREV_N_AVG":
        return snapshot_or_default(away_stats, "MARKET_RATING_PREV_N_AVG", defaults, column)
    if column == "MARKET_TOTAL_TEAM_ENVIRONMENT_PRIOR":
        home_total = snapshot_number(home_stats, "MARKET_TOTAL_ENVIRONMENT_PRIOR")
        away_total = snapshot_number(away_stats, "MARKET_TOTAL_ENVIRONMENT_PRIOR")
        if home_total is None or away_total is None:
            return numeric_or_none(defaults.get(column))
        return (home_total + away_total) / 2.0
    if column == "MARKET_SPREAD_PRIOR_RESIDUAL_FORM":
        home_form = snapshot_number(home_stats, "MARKET_SPREAD_RESIDUAL_FORM")
        away_form = snapshot_number(away_stats, "MARKET_SPREAD_RESIDUAL_FORM")
        if home_form is None or away_form is None:
            return numeric_or_none(defaults.get(column))
        return home_form - away_form

    skill_value = resolve_skill_feature(column, home_stats, away_stats, defaults)
    if skill_value is not None:
        return skill_value

    if column.endswith(".1"):
        value = away_stats.get(column[:-2], away_stats.get(column))
    else:
        value = home_stats.get(column)
    if value is None:
        value = defaults.get(column)
    return numeric_or_none(value)


def snapshot_or_default(
    stats: dict[str, Any],
    snapshot_column: str,
    defaults: dict[str, Any],
    feature_column: str,
) -> float | None:
    return numeric_or_none(stats.get(snapshot_column, defaults.get(feature_column)))


def snapshot_number(stats: dict[str, Any], snapshot_column: str) -> float | None:
    return numeric_or_none(stats.get(snapshot_column))


def resolve_skill_feature(
    column: str,
    home_stats: dict[str, Any],
    away_stats: dict[str, Any],
    defaults: dict[str, Any],
) -> float | None:
    mappings = {
        "HOME_OFF_SKILL_MEAN": (home_stats, "OFF_SKILL_MEAN"),
        "HOME_OFF_SKILL_STD": (home_stats, "OFF_SKILL_STD"),
        "HOME_DEF_SKILL_MEAN": (home_stats, "DEF_SKILL_MEAN"),
        "HOME_DEF_SKILL_STD": (home_stats, "DEF_SKILL_STD"),
        "AWAY_OFF_SKILL_MEAN": (away_stats, "OFF_SKILL_MEAN"),
        "AWAY_OFF_SKILL_STD": (away_stats, "OFF_SKILL_STD"),
        "AWAY_DEF_SKILL_MEAN": (away_stats, "DEF_SKILL_MEAN"),
        "AWAY_DEF_SKILL_STD": (away_stats, "DEF_SKILL_STD"),
    }
    if column in mappings:
        stats, snapshot_column = mappings[column]
        return snapshot_or_default(stats, snapshot_column, defaults, column)
    if column == "SKILL_MARGIN_PRIOR" or column == "SKILL_TOTAL_PRIOR":
        home_off = snapshot_number(home_stats, "OFF_SKILL_MEAN")
        home_def = snapshot_number(home_stats, "DEF_SKILL_MEAN")
        away_off = snapshot_number(away_stats, "OFF_SKILL_MEAN")
        away_def = snapshot_number(away_stats, "DEF_SKILL_MEAN")
        if home_off is None or home_def is None or away_off is None or away_def is None:
            return numeric_or_none(defaults.get(column))
        home_expected = (home_off + away_def) / 2.0
        away_expected = (away_off + home_def) / 2.0
        if column == "SKILL_MARGIN_PRIOR":
            return home_expected - away_expected
        return home_expected + away_expected
    return None


def numeric_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_matchup_stats(
    root: Path,
    manifest: dict[str, Any],
    game_date: str,
    home_team: str,
    away_team: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    team_stats_config = manifest.get("team_stats")
    if team_stats_config is None:
        return {}, {}

    stats_type = team_stats_config.get("type", "json")
    if stats_type == "json":
        teams = load_json_team_stats(root, team_stats_config, game_date)
        return team_stats_for_name(teams, home_team), team_stats_for_name(teams, away_team)
    if stats_type == "sqlite":
        return load_sqlite_team_stats(root, team_stats_config, game_date, home_team, away_team)
    raise ArtifactError(f"Unsupported team_stats.type: {stats_type}")


def load_json_team_stats(root: Path, config: dict[str, Any], game_date: str) -> dict[str, Any]:
    path = artifact_path(root, config["path"])
    data = load_json(path)
    if not isinstance(data, dict):
        raise ArtifactError(f"Team stats JSON must contain an object: {path}")
    if "teams" in data:
        teams = data["teams"]
    elif game_date in data:
        dated = data[game_date]
        teams = dated.get("teams") if isinstance(dated, dict) and "teams" in dated else dated
    elif "latest" in data:
        latest = data["latest"]
        teams = latest.get("teams") if isinstance(latest, dict) and "teams" in latest else latest
    else:
        teams = data
    if not isinstance(teams, dict):
        raise ArtifactError(f"Unable to find team stats mapping in: {path}")
    return teams


def team_stats_for_name(teams: dict[str, Any], name: str) -> dict[str, Any]:
    stats = teams.get(name)
    if stats is None and name == "LA Clippers":
        stats = teams.get("Los Angeles Clippers")
    if not isinstance(stats, dict):
        raise ArtifactError(f"Missing historical team stats for {name}")
    return stats


def load_sqlite_team_stats(
    root: Path,
    config: dict[str, Any],
    game_date: str,
    home_team: str,
    away_team: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = artifact_path(root, config["path"])
    if not path.is_file():
        raise ArtifactError(f"Team stats SQLite database is missing: {path}")

    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        table = str(config.get("table") or select_snapshot_table(connection, game_date))
        try:
            rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
        except sqlite3.Error as exc:
            raise ArtifactError(f"Unable to read team stats table {table}: {exc}") from exc

    if not rows:
        raise ArtifactError(f"Team stats table is empty: {table}")

    by_name = {
        str(row["TEAM_NAME"]): dict(row)
        for row in rows
        if "TEAM_NAME" in row.keys() and row["TEAM_NAME"] is not None
    }
    if by_name:
        return team_stats_for_name(by_name, home_team), team_stats_for_name(by_name, away_team)

    home_index = TEAM_INDEX_CURRENT.get(home_team)
    away_index = TEAM_INDEX_CURRENT.get(away_team)
    if home_index is None or away_index is None:
        raise ArtifactError("Unable to resolve team index for SQLite row-based team stats")
    if max(home_index, away_index) >= len(rows):
        raise ArtifactError(f"Team stats table {table} has fewer rows than expected")
    return dict(rows[home_index]), dict(rows[away_index])


def select_snapshot_table(connection: sqlite3.Connection, game_date: str) -> str:
    if not is_iso_date_name(game_date):
        return game_date
    try:
        rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    except sqlite3.Error as exc:
        raise ArtifactError(f"Unable to list team stats tables: {exc}") from exc

    candidates = sorted(
        str(row[0])
        for row in rows
        if row[0] is not None and is_iso_date_name(str(row[0])) and str(row[0]) <= game_date
    )
    if not candidates:
        raise ArtifactError(f"No team stats snapshot table on or before {game_date}")
    return candidates[-1]


def is_iso_date_name(value: str) -> bool:
    return (
        len(value) == 10
        and value[4] == "-"
        and value[7] == "-"
        and value[:4].isdigit()
        and value[5:7].isdigit()
        and value[8:].isdigit()
    )
