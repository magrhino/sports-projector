from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import median
from typing import Any, Protocol

from .artifacts import append_run_log, build_artifact_inventory, utc_timestamp, write_state_manifest
from .dataset import build_game_record
from .training import DROP_COLUMNS, TARGET_COLUMNS
from .providers.sportsdb import (
    DEFAULT_RATE_LIMIT_PER_MINUTE,
    DEFAULT_SPORTSDB_API_KEY,
    SPORT_CONFIGS,
    SportsDbClient,
    SportsDbError,
    write_raw_json,
)


TRAINING_TABLE = "sportsdb_nba_training"
DEFAULT_FIRST_GAME_REST_DAYS = 7.0
BASE_ELO = 1500.0
ELO_K = 20.0


class SportsDbImportClient(Protocol):
    def fetch_all_seasons(self, league_id: str) -> dict[str, Any]:
        ...

    def fetch_all_teams(self, league_name: str) -> dict[str, Any]:
        ...

    def fetch_season_events(self, league_id: str, season: str) -> dict[str, Any]:
        ...


@dataclass(frozen=True)
class SportsDbGame:
    event_id: str
    season: str
    date: str
    home_team: str
    away_team: str
    home_score: float | None
    away_score: float | None

    @property
    def is_final(self) -> bool:
        return self.home_score is not None and self.away_score is not None


@dataclass
class TeamState:
    games: int = 0
    wins: int = 0
    points_for: float = 0.0
    points_against: float = 0.0
    home_points_for: float = 0.0
    home_points_against: float = 0.0
    home_games: int = 0
    away_points_for: float = 0.0
    away_points_against: float = 0.0
    away_games: int = 0
    last_game_date: str | None = None
    elo: float = BASE_ELO
    recent: list[tuple[float, float]] | None = None

    def __post_init__(self) -> None:
        if self.recent is None:
            self.recent = []


def import_sportsdb_artifacts(
    artifact_dir: str | Path,
    sport: str = "nba",
    api_key: str = DEFAULT_SPORTSDB_API_KEY,
    seasons: list[str] | None = None,
    lookback_seasons: int | None = None,
    rate_limit_per_minute: int = DEFAULT_RATE_LIMIT_PER_MINUTE,
    write_state: bool = True,
    log_run: bool = True,
    client: SportsDbImportClient | None = None,
) -> dict[str, Any]:
    if sport not in SPORT_CONFIGS:
        raise SportsDbError(f"Unsupported SportsDB sport: {sport}")
    config = SPORT_CONFIGS[sport]
    root = Path(artifact_dir)
    provider_client = client or SportsDbClient(
        api_key=api_key,
        rate_limit_per_minute=rate_limit_per_minute,
    )

    seasons_payload = provider_client.fetch_all_seasons(config.league_id)
    selected_seasons = select_seasons(
        parse_seasons(seasons_payload),
        requested=seasons or [],
        lookback_seasons=lookback_seasons or config.default_lookback_seasons,
        sport=sport,
    )
    if not selected_seasons:
        raise SportsDbError("No SportsDB seasons selected for import")

    raw_root = root / "sportsdb" / "raw" / sport
    normalized_root = root / "sportsdb" / "normalized"
    write_raw_json(raw_root / "seasons.json", seasons_payload)

    teams_payload = provider_client.fetch_all_teams(config.league_name)
    write_raw_json(raw_root / "teams.json", teams_payload)
    teams = parse_teams(teams_payload)

    season_payloads: dict[str, dict[str, Any]] = {}
    games: list[SportsDbGame] = []
    for season in selected_seasons:
        payload = provider_client.fetch_season_events(config.league_id, season)
        season_payloads[season] = payload
        write_raw_json(raw_root / "seasons" / f"{season}.json", payload)
        games.extend(parse_games(payload, fallback_season=season))

    games = sorted(games, key=lambda game: (game.date, game.event_id))
    if not games:
        raise SportsDbError("SportsDB import found no NBA events")
    team_names = sorted(set(teams) | {game.home_team for game in games} | {game.away_team for game in games})
    dataset_path = normalized_root / "nba_games.sqlite"
    team_stats_path = normalized_root / "nba_team_stats.sqlite"
    training_rows, snapshot_dates = build_training_and_snapshots(games, team_names, dataset_path, team_stats_path)
    if len(training_rows) < 2:
        raise SportsDbError("SportsDB import needs at least two final games to train artifacts")

    model_dir = root / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    feature_columns = derive_feature_columns(training_rows)
    feature_defaults = build_feature_defaults(training_rows, feature_columns)
    total_model = train_linear_model(training_rows, feature_columns, "Score")
    margin_model = train_linear_model(training_rows, feature_columns, "Home-Margin")
    write_model(model_dir / "total_score.json", total_model)
    write_model(model_dir / "home_margin.json", margin_model)

    manifest = {
        "schema_version": 1,
        "generated_at": utc_timestamp(),
        "source": {
            "type": "sportsdb_v1",
            "sport": sport,
            "league": config.league_name,
            "league_id": config.league_id,
            "api_key": "123" if api_key == DEFAULT_SPORTSDB_API_KEY else "configured",
            "rate_limit_per_minute": rate_limit_per_minute,
            "seasons": selected_seasons,
        },
        "seasons": selected_seasons,
        "feature_columns": feature_columns,
        "feature_defaults": feature_defaults,
        "team_stats": {
            "type": "sqlite",
            "path": str(team_stats_path.relative_to(root)),
        },
        "models": {
            "total_score": {
                "type": "linear_json",
                "path": "models/total_score.json",
                **total_model["metrics"],
            },
            "home_margin": {
                "type": "linear_json",
                "path": "models/home_margin.json",
                **margin_model["metrics"],
            },
        },
    }
    write_json(root / "manifest.json", manifest)
    inventory = build_artifact_inventory(root)
    if write_state:
        write_state_manifest(root, inventory)
    summary = {
        "ok": inventory["validation"]["ok"],
        "sport": sport,
        "seasons": selected_seasons,
        "raw_season_files": len(season_payloads),
        "events": len(games),
        "final_games": len(training_rows),
        "snapshot_dates": snapshot_dates,
        "dataset": str(dataset_path),
        "team_stats": str(team_stats_path),
        "feature_count": len(feature_columns),
    }
    if log_run:
        append_run_log(root, "import-sportsdb", summary)
    return {
        **summary,
        "artifact_dir": str(root),
        "validation": inventory["validation"],
    }


def parse_seasons(payload: dict[str, Any]) -> list[str]:
    seasons = payload.get("seasons")
    if not isinstance(seasons, list):
        return []
    parsed = [
        str(item.get("strSeason")).strip()
        for item in seasons
        if isinstance(item, dict) and item.get("strSeason")
    ]
    return sorted(set(parsed), key=season_sort_key)


def parse_teams(payload: dict[str, Any]) -> list[str]:
    teams = payload.get("teams")
    if not isinstance(teams, list):
        return []
    parsed = []
    for item in teams:
        if not isinstance(item, dict):
            continue
        name = clean_string(item.get("strTeam"))
        if name:
            parsed.append(name)
    return sorted(set(parsed))


def select_seasons(
    available: list[str],
    requested: list[str],
    lookback_seasons: int,
    sport: str = "nba",
    today: datetime | None = None,
) -> list[str]:
    if requested:
        return sorted(set(requested), key=season_sort_key)
    if lookback_seasons < 1:
        raise SportsDbError("lookback_seasons must be at least 1")
    if sport == "nba":
        return recent_nba_seasons(lookback_seasons, today=today)
    if available:
        return available[-lookback_seasons:]
    raise SportsDbError(f"Cannot infer recent SportsDB seasons for unsupported sport: {sport}")


def recent_nba_seasons(count: int, today: datetime | None = None) -> list[str]:
    if count < 1:
        raise SportsDbError("season count must be at least 1")
    current = today or datetime.now()
    current_start_year = current.year if current.month >= 10 else current.year - 1
    first_start_year = current_start_year - count + 1
    return [
        f"{start_year}-{start_year + 1}"
        for start_year in range(first_start_year, current_start_year + 1)
    ]


def season_sort_key(season: str) -> tuple[int, str]:
    try:
        return (int(season[:4]), season)
    except ValueError:
        return (0, season)


def parse_games(payload: dict[str, Any], fallback_season: str) -> list[SportsDbGame]:
    events = payload.get("events")
    if not isinstance(events, list):
        return []
    games = []
    for event in events:
        if not isinstance(event, dict):
            continue
        game = parse_game(event, fallback_season)
        if game is not None:
            games.append(game)
    return games


def parse_game(event: dict[str, Any], fallback_season: str) -> SportsDbGame | None:
    event_id = clean_string(event.get("idEvent"))
    home_team = clean_string(event.get("strHomeTeam"))
    away_team = clean_string(event.get("strAwayTeam"))
    date = clean_string(event.get("dateEvent"))
    if not event_id or not home_team or not away_team or not date:
        return None
    if not is_iso_date(date):
        return None
    return SportsDbGame(
        event_id=event_id,
        season=clean_string(event.get("strSeason")) or fallback_season,
        date=date,
        home_team=home_team,
        away_team=away_team,
        home_score=number_or_none(event.get("intHomeScore")),
        away_score=number_or_none(event.get("intAwayScore")),
    )


def build_training_and_snapshots(
    games: list[SportsDbGame],
    team_names: list[str],
    dataset_path: Path,
    team_stats_path: Path,
) -> tuple[list[dict[str, Any]], int]:
    training_rows: list[dict[str, Any]] = []
    snapshot_dates = 0

    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    team_stats_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(dataset_path) as dataset_connection, sqlite3.connect(team_stats_path) as stats_connection:
        for season in sorted({game.season for game in games}, key=season_sort_key):
            states = {team: TeamState() for team in team_names}
            season_games = [game for game in games if game.season == season]
            for date in sorted({game.date for game in season_games}):
                snapshot_dates += 1
                write_team_snapshot_table(stats_connection, date, states, team_names)
                for game in [candidate for candidate in season_games if candidate.date == date and candidate.is_final]:
                    home_stats = snapshot_for_team(states[game.home_team], game.home_team, date)
                    away_stats = snapshot_for_team(states[game.away_team], game.away_team, date)
                    row = build_game_record(
                        home_stats,
                        away_stats,
                        {
                            "Points": float(game.home_score or 0) + float(game.away_score or 0),
                            "Win_Margin": float(game.home_score or 0) - float(game.away_score or 0),
                        },
                    )
                    row["Date"] = game.date
                    training_rows.append(row)
                    apply_game_result(states, game)
        write_sqlite_rows(dataset_connection, TRAINING_TABLE, training_rows)

    return training_rows, snapshot_dates


def snapshot_for_team(state: TeamState, team_name: str, game_date: str) -> dict[str, Any]:
    recent = state.recent or []
    recent_for = [item[0] for item in recent[-5:]]
    recent_against = [item[1] for item in recent[-5:]]
    return {
        "TEAM_NAME": team_name,
        "PRIOR_GAMES": float(state.games),
        "SEASON_WIN_PCT": safe_div(state.wins, state.games, 0.5),
        "SEASON_AVG_POINTS_FOR": safe_div(state.points_for, state.games, 0.0),
        "SEASON_AVG_POINTS_AGAINST": safe_div(state.points_against, state.games, 0.0),
        "SEASON_AVG_MARGIN": safe_div(state.points_for - state.points_against, state.games, 0.0),
        "ROLLING5_AVG_POINTS_FOR": average(recent_for, safe_div(state.points_for, state.games, 0.0)),
        "ROLLING5_AVG_POINTS_AGAINST": average(recent_against, safe_div(state.points_against, state.games, 0.0)),
        "ROLLING5_AVG_MARGIN": average(
            [for_points - against_points for for_points, against_points in recent[-5:]],
            safe_div(state.points_for - state.points_against, state.games, 0.0),
        ),
        "HOME_AVG_POINTS_FOR": safe_div(state.home_points_for, state.home_games, 0.0),
        "HOME_AVG_POINTS_AGAINST": safe_div(state.home_points_against, state.home_games, 0.0),
        "AWAY_AVG_POINTS_FOR": safe_div(state.away_points_for, state.away_games, 0.0),
        "AWAY_AVG_POINTS_AGAINST": safe_div(state.away_points_against, state.away_games, 0.0),
        "DAYS_REST": days_between(state.last_game_date, game_date),
        "ELO": state.elo,
    }


def write_team_snapshot_table(
    connection: sqlite3.Connection,
    date: str,
    states: dict[str, TeamState],
    team_names: list[str],
) -> None:
    rows = [snapshot_for_team(states[team_name], team_name, date) for team_name in team_names]
    write_sqlite_rows(connection, date, rows)


def write_sqlite_rows(connection: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = list(rows[0].keys())
    quoted_table = quote_identifier(table)
    connection.execute(f"DROP TABLE IF EXISTS {quoted_table}")
    column_defs = ", ".join(f"{quote_identifier(column)} {sqlite_type(rows[0][column])}" for column in columns)
    connection.execute(f"CREATE TABLE {quoted_table} ({column_defs})")
    placeholders = ", ".join("?" for _ in columns)
    quoted_columns = ", ".join(quote_identifier(column) for column in columns)
    connection.executemany(
        f"INSERT INTO {quoted_table} ({quoted_columns}) VALUES ({placeholders})",
        [[row.get(column) for column in columns] for row in rows],
    )
    connection.commit()


def apply_game_result(states: dict[str, TeamState], game: SportsDbGame) -> None:
    home_score = float(game.home_score or 0)
    away_score = float(game.away_score or 0)
    home_state = states[game.home_team]
    away_state = states[game.away_team]
    home_expected = expected_score(home_state.elo, away_state.elo)
    away_expected = 1.0 - home_expected
    home_actual = 1.0 if home_score > away_score else 0.0 if home_score < away_score else 0.5
    away_actual = 1.0 - home_actual

    update_team_state(home_state, game.date, home_score, away_score, home_score > away_score, True)
    update_team_state(away_state, game.date, away_score, home_score, away_score > home_score, False)
    home_state.elo += ELO_K * (home_actual - home_expected)
    away_state.elo += ELO_K * (away_actual - away_expected)


def update_team_state(
    state: TeamState,
    date: str,
    points_for: float,
    points_against: float,
    won: bool,
    home: bool,
) -> None:
    state.games += 1
    state.wins += 1 if won else 0
    state.points_for += points_for
    state.points_against += points_against
    state.last_game_date = date
    state.recent = [*(state.recent or []), (points_for, points_against)][-10:]
    if home:
        state.home_games += 1
        state.home_points_for += points_for
        state.home_points_against += points_against
    else:
        state.away_games += 1
        state.away_points_for += points_for
        state.away_points_against += points_against


def derive_feature_columns(rows: list[dict[str, Any]]) -> list[str]:
    columns = [
        column
        for column in rows[0].keys()
        if column not in TARGET_COLUMNS and column not in DROP_COLUMNS
    ]
    for row in rows[1:]:
        for column in row.keys():
            if column not in columns and column not in TARGET_COLUMNS and column not in DROP_COLUMNS:
                columns.append(column)
    return columns


def build_feature_defaults(rows: list[dict[str, Any]], feature_columns: list[str]) -> dict[str, float]:
    defaults: dict[str, float] = {}
    for column in feature_columns:
        values = [float(row[column]) for row in rows if row.get(column) is not None and is_finite(row[column])]
        if not values:
            defaults[column] = 0.0
            continue
        defaults[column] = round(float(median(values)), 6)
    return defaults


def train_linear_model(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    target_column: str,
) -> dict[str, Any]:
    x = [[1.0, *[float(row[column]) for column in feature_columns]] for row in rows]
    y = [float(row[target_column]) for row in rows]
    coefficients = solve_ridge_regression(x, y, ridge=1.0)
    predictions = [sum(weight * value for weight, value in zip(coefficients, row)) for row in x]
    residuals = [prediction - target for prediction, target in zip(predictions, y)]
    rmse = math.sqrt(sum(value * value for value in residuals) / len(residuals))
    residual_mean = sum(residuals) / len(residuals)
    residual_stddev = math.sqrt(sum((value - residual_mean) ** 2 for value in residuals) / len(residuals))
    return {
        "intercept": round(coefficients[0], 8),
        "coefficients": {
            column: round(coefficients[index + 1], 8)
            for index, column in enumerate(feature_columns)
        },
        "metrics": {
            "validation_rmse": round(rmse, 4),
            "residual_stddev": round(residual_stddev, 4),
            "validation_rows": len(rows),
        },
    }


def solve_ridge_regression(x: list[list[float]], y: list[float], ridge: float) -> list[float]:
    width = len(x[0])
    matrix = [[0.0 for _ in range(width)] for _ in range(width)]
    vector = [0.0 for _ in range(width)]
    for row, target in zip(x, y):
        for i in range(width):
            vector[i] += row[i] * target
            for j in range(width):
                matrix[i][j] += row[i] * row[j]
    for i in range(1, width):
        matrix[i][i] += ridge
    return gaussian_solve(matrix, vector)


def gaussian_solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(matrix[row][column]))
        if abs(matrix[pivot][column]) < 1e-12:
            matrix[pivot][column] = 1e-12
        if pivot != column:
            matrix[column], matrix[pivot] = matrix[pivot], matrix[column]
            vector[column], vector[pivot] = vector[pivot], vector[column]
        pivot_value = matrix[column][column]
        for item in range(column, size):
            matrix[column][item] /= pivot_value
        vector[column] /= pivot_value
        for row in range(size):
            if row == column:
                continue
            factor = matrix[row][column]
            if factor == 0:
                continue
            for item in range(column, size):
                matrix[row][item] -= factor * matrix[column][item]
            vector[row] -= factor * vector[column]
    return vector


def expected_score(elo_a: float, elo_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / 400.0))


def average(values: list[float], default: float) -> float:
    if not values:
        return default
    return sum(values) / len(values)


def safe_div(numerator: float, denominator: float, default: float) -> float:
    if denominator == 0:
        return default
    return numerator / denominator


def days_between(previous: str | None, current: str) -> float:
    if previous is None:
        return DEFAULT_FIRST_GAME_REST_DAYS
    return float((datetime.strptime(current, "%Y-%m-%d") - datetime.strptime(previous, "%Y-%m-%d")).days)


def number_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def is_finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def clean_string(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().split())


def is_iso_date(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def sqlite_type(value: Any) -> str:
    return "TEXT" if isinstance(value, str) else "REAL"


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def write_model(path: Path, model: dict[str, Any]) -> None:
    write_json(
        path,
        {
            "intercept": model["intercept"],
            "coefficients": model["coefficients"],
        },
    )


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
