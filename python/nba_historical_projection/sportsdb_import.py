from __future__ import annotations

import csv
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any, Protocol

from .artifacts import append_run_log, build_artifact_inventory, utc_timestamp, write_state_manifest
from .dataset import build_game_record
from .training import (
    ALL_TARGET_COLUMNS,
    DROP_COLUMNS,
    chronological_splits,
    metrics_from_residuals,
    target_column_for,
)
from .calibration import CalibrationEvent, empirical_probability, fit_probability_calibrator
from .market_diagnostics import market_decorrelation_report
from .quantiles import DEFAULT_QUANTILES, parse_quantiles, quantile_summary
from .team_ratings import (
    MARKET_RATING_COLUMNS,
    MarketRatingState,
    market_line_value,
    market_rating_features,
    market_rating_snapshot_features,
    update_market_ratings,
)
from .team_skills import (
    SKILL_FEATURE_COLUMNS,
    ScoreSkillState,
    score_skill_features,
    score_skill_snapshot_features,
    update_score_skills,
)
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

    def fetch_day_events(self, league_id: str, date: str) -> dict[str, Any]:
        ...

    def fetch_team_last_events(self, team_id: str) -> dict[str, Any]:
        ...

    def fetch_event(self, event_id: str) -> dict[str, Any]:
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


@dataclass(frozen=True)
class SportsDbTeam:
    team_id: str
    name: str


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


@dataclass(frozen=True)
class MarketLine:
    game_date: str
    home_team: str
    away_team: str
    closing_total: float | None = None
    closing_spread: float | None = None
    opening_total: float | None = None
    opening_spread: float | None = None


@dataclass
class Availability:
    unavailable_minutes: float = 0.0
    unavailable_value: float = 0.0


def import_sportsdb_artifacts(
    artifact_dir: str | Path,
    sport: str = "nba",
    api_key: str = DEFAULT_SPORTSDB_API_KEY,
    seasons: list[str] | None = None,
    lookback_seasons: int | None = None,
    rate_limit_per_minute: int = DEFAULT_RATE_LIMIT_PER_MINUTE,
    write_state: bool = True,
    log_run: bool = True,
    market_lines_csv: str | Path | None = None,
    availability_csv: str | Path | None = None,
    model_kind: str = "auto",
    validation_splits: int = 3,
    recent_days: int = 3,
    lookahead_days: int = 2,
    event_ids: list[str] | None = None,
    include_team_last_events: bool = True,
    today: date | datetime | None = None,
    client: SportsDbImportClient | None = None,
    calibration: str = "auto",
    quantiles: str | None = None,
    rating_features: str = "none",
    rating_line_source: str = "close",
    skill_features: str = "none",
    experimental_market_decorrelation: bool = False,
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
    if model_kind not in {"direct", "market-residual", "auto"}:
        raise SportsDbError("model_kind must be direct, market-residual, or auto")
    if calibration not in {"none", "empirical", "isotonic", "platt", "auto"}:
        raise SportsDbError("calibration must be none, empirical, isotonic, platt, or auto")
    if rating_features not in {"none", "market"}:
        raise SportsDbError("rating_features must be none or market")
    if rating_line_source not in {"open", "close", "provided"}:
        raise SportsDbError("rating_line_source must be open, close, or provided")
    if skill_features not in {"none", "score-based"}:
        raise SportsDbError("skill_features must be none or score-based")
    if recent_days < 0:
        raise SportsDbError("recent_days must be at least 0")
    if lookahead_days < 0:
        raise SportsDbError("lookahead_days must be at least 0")

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

    supplemental_summary = collect_supplemental_games(
        provider_client,
        config.league_id,
        raw_root,
        selected_seasons,
        teams,
        recent_days=recent_days,
        lookahead_days=lookahead_days,
        event_ids=event_ids or [],
        include_team_last_events=include_team_last_events,
        today=today,
    )
    games.extend(supplemental_summary["games"])

    games = dedupe_games(games)
    if not games:
        raise SportsDbError("SportsDB import found no NBA events")
    team_names = sorted({team.name for team in teams} | {game.home_team for game in games} | {game.away_team for game in games})
    dataset_path = normalized_root / "nba_games.sqlite"
    team_stats_path = normalized_root / "nba_team_stats.sqlite"
    market_lines = load_market_lines_csv(market_lines_csv) if market_lines_csv else {}
    availability = load_availability_csv(availability_csv) if availability_csv else {}
    training_rows, snapshot_dates = build_training_and_snapshots(
        games,
        team_names,
        dataset_path,
        team_stats_path,
        market_lines=market_lines,
        availability=availability,
        rating_features=rating_features,
        rating_line_source=rating_line_source,
        skill_features=skill_features,
    )
    if len(training_rows) < 2:
        raise SportsDbError("SportsDB import needs at least two final games to train artifacts")

    model_dir = root / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    feature_columns = derive_feature_columns(training_rows)
    feature_defaults = build_feature_defaults(training_rows, feature_columns)
    total_model, total_mode = train_best_linear_model(
        training_rows,
        feature_columns,
        "total_score",
        model_kind,
        validation_splits,
    )
    margin_model, margin_mode = train_best_linear_model(
        training_rows,
        feature_columns,
        "home_margin",
        model_kind,
        validation_splits,
    )
    validation_reports = build_validation_reports(
        training_rows,
        feature_columns,
        {
            "total_score": total_model,
            "home_margin": margin_model,
        },
        {
            "total_score": total_mode,
            "home_margin": margin_mode,
        },
        validation_splits,
        calibration,
        parse_quantiles(quantiles) or ([] if quantiles is None else DEFAULT_QUANTILES),
        experimental_market_decorrelation,
    )
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
            "recent_days": recent_days,
            "lookahead_days": lookahead_days,
            "event_ids": event_ids or [],
            "team_last_events": include_team_last_events,
        },
        "data_sources": {
            "market_lines": data_source_summary(market_lines_csv, len(market_lines)),
            "availability": data_source_summary(availability_csv, len(availability)),
        },
        "seasons": selected_seasons,
        "feature_columns": feature_columns,
        "feature_defaults": feature_defaults,
        "feature_generators": {
            "rating_features": rating_features,
            "rating_line_source": rating_line_source,
            "skill_features": skill_features,
        },
        "team_stats": {
            "type": "sqlite",
            "path": str(team_stats_path.relative_to(root)),
        },
        "models": {
            "total_score": {
                "type": "linear_json",
                "path": "models/total_score.json",
                "target_mode": total_mode,
                **total_model["metrics"],
            },
            "home_margin": {
                "type": "linear_json",
                "path": "models/home_margin.json",
                "target_mode": margin_mode,
                **margin_model["metrics"],
            },
        },
        "calibration": validation_reports.get("calibration", {}),
        "quantile_models": validation_reports.get("quantile_models", {}),
        "rating_features": {
            "enabled": rating_features == "market",
            "columns": [column for column in MARKET_RATING_COLUMNS if column in feature_columns],
            "line_source": rating_line_source,
        },
        "skill_features": {
            "enabled": skill_features == "score-based",
            "columns": [column for column in SKILL_FEATURE_COLUMNS if column in feature_columns],
        },
        "validation_reports": validation_reports,
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
        "raw_recent_day_files": supplemental_summary["day_payloads"],
        "raw_team_last_files": supplemental_summary["team_payloads"],
        "raw_event_files": supplemental_summary["event_payloads"],
        "supplemental_events": supplemental_summary["event_count"],
        "events": len(games),
        "final_games": len(training_rows),
        "snapshot_dates": snapshot_dates,
        "dataset": str(dataset_path),
        "team_stats": str(team_stats_path),
        "feature_count": len(feature_columns),
        "market_line_matches": sum(1 for row in training_rows if row.get("MARKET_TOTAL_CLOSE") is not None),
        "availability_team_matches": sum(
            1
            for row in training_rows
            if row.get("HOME_UNAVAILABLE_MINUTES", 0.0) or row.get("AWAY_UNAVAILABLE_MINUTES", 0.0)
        ),
    }
    if validation_reports:
        summary["validation_reports"] = validation_reports
    if log_run:
        append_run_log(root, "import-sportsdb", summary)
    return {
        **summary,
        "artifact_dir": str(root),
        "validation": inventory["validation"],
    }


def collect_supplemental_games(
    client: SportsDbImportClient,
    league_id: str,
    raw_root: Path,
    selected_seasons: list[str],
    teams: list[SportsDbTeam],
    recent_days: int,
    lookahead_days: int,
    event_ids: list[str],
    include_team_last_events: bool,
    today: date | datetime | None,
) -> dict[str, Any]:
    games: list[SportsDbGame] = []
    forced_games: list[SportsDbGame] = []
    day_payloads = 0
    team_payloads = 0
    event_payloads = 0
    current_date = current_import_date(today)

    for event_date in supplemental_event_dates(current_date, recent_days, lookahead_days):
        date_text = event_date.isoformat()
        payload = client.fetch_day_events(league_id, date_text)
        day_payloads += 1
        write_raw_json(raw_root / "recent" / "days" / f"{date_text}.json", payload)
        games.extend(parse_games(payload, fallback_season=season_for_date(event_date)))

    if include_team_last_events:
        for team in teams:
            if not team.team_id:
                continue
            payload = client.fetch_team_last_events(team.team_id)
            team_payloads += 1
            write_raw_json(raw_root / "recent" / "team-last" / f"{safe_filename(team.team_id)}.json", payload)
            games.extend(parse_games(payload, fallback_season=season_for_date(current_date)))

    for event_id in sorted(set(clean_string(value) for value in event_ids if clean_string(value))):
        payload = client.fetch_event(event_id)
        event_payloads += 1
        write_raw_json(raw_root / "events" / f"{safe_filename(event_id)}.json", payload)
        forced_games.extend(parse_games(payload, fallback_season=season_for_date(current_date)))

    filtered_games = [
        game
        for game in games
        if not selected_seasons or game.season in selected_seasons
    ] + forced_games

    return {
        "games": filtered_games,
        "day_payloads": day_payloads,
        "team_payloads": team_payloads,
        "event_payloads": event_payloads,
        "event_count": len(dedupe_games(filtered_games)),
    }


def current_import_date(value: date | datetime | None) -> date:
    if value is None:
        return datetime.now().date()
    if isinstance(value, datetime):
        return value.date()
    return value


def supplemental_event_dates(current_date: date, recent_days: int, lookahead_days: int) -> list[date]:
    start = current_date - timedelta(days=recent_days)
    end = current_date + timedelta(days=lookahead_days)
    return [
        start + timedelta(days=offset)
        for offset in range((end - start).days + 1)
    ]


def season_for_date(value: date) -> str:
    start_year = value.year if value.month >= 10 else value.year - 1
    return f"{start_year}-{start_year + 1}"


def safe_filename(value: str) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in value)


def dedupe_games(games: list[SportsDbGame]) -> list[SportsDbGame]:
    by_id: dict[str, SportsDbGame] = {}
    for game in games:
        current = by_id.get(game.event_id)
        if current is None or game_quality(game) >= game_quality(current):
            by_id[game.event_id] = game
    return sorted(by_id.values(), key=lambda game: (game.date, game.event_id))


def game_quality(game: SportsDbGame) -> int:
    if game.home_score is not None and game.away_score is not None:
        return 3
    if game.home_score is not None or game.away_score is not None:
        return 2
    return 1


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


def parse_teams(payload: dict[str, Any]) -> list[SportsDbTeam]:
    teams = payload.get("teams")
    if not isinstance(teams, list):
        return []
    parsed: list[SportsDbTeam] = []
    for item in teams:
        if not isinstance(item, dict):
            continue
        name = clean_string(item.get("strTeam"))
        team_id = clean_string(item.get("idTeam"))
        if name:
            parsed.append(SportsDbTeam(team_id=team_id, name=name))
    return sorted({team.name: team for team in parsed}.values(), key=lambda team: team.name)


def load_market_lines_csv(path: str | Path) -> dict[tuple[str, str, str], MarketLine]:
    market_lines: dict[tuple[str, str, str], MarketLine] = {}
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            date = first_text(row, "game_date", "date", "Date")
            home_team = first_text(row, "home_team", "home", "Home")
            away_team = first_text(row, "away_team", "away", "Away")
            if not date or not home_team or not away_team:
                continue
            market_line = MarketLine(
                game_date=date,
                home_team=home_team,
                away_team=away_team,
                closing_total=first_number(row, "closing_total", "market_total", "total", "OU"),
                closing_spread=first_number(row, "closing_spread", "market_spread", "spread"),
                opening_total=first_number(row, "opening_total", "open_total"),
                opening_spread=first_number(row, "opening_spread", "open_spread"),
            )
            market_lines[matchup_key(date, home_team, away_team)] = market_line
    return market_lines


def load_availability_csv(path: str | Path) -> dict[tuple[str, str], Availability]:
    availability: dict[tuple[str, str], Availability] = {}
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            date = first_text(row, "game_date", "date", "Date")
            team = first_text(row, "team", "team_name", "Team")
            if not date or not team:
                continue
            key = (date, normalize_match_name(team))
            current = availability.setdefault(key, Availability())
            current.unavailable_minutes += first_number(row, "unavailable_minutes", "minutes", "mp") or 0.0
            current.unavailable_value += first_number(row, "unavailable_value", "value", "player_value") or 0.0
    return availability


def data_source_summary(path: str | Path | None, matched_rows: int) -> dict[str, Any]:
    return {
        "configured": path is not None,
        "path": None if path is None else str(path),
        "matched_rows": matched_rows,
    }


def matchup_key(date: str, home_team: str, away_team: str) -> tuple[str, str, str]:
    return (date, normalize_match_name(home_team), normalize_match_name(away_team))


def normalize_match_name(value: str) -> str:
    return " ".join(str(value).strip().lower().replace(".", "").split())


def first_text(row: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def first_number(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if value is None or str(value).strip() == "":
            continue
        number = number_or_none(value)
        if number is not None:
            return number
    return None


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
    events = event_items(payload)
    if not events:
        return []
    games = []
    for event in events:
        if not isinstance(event, dict):
            continue
        game = parse_game(event, fallback_season)
        if game is not None:
            games.append(game)
    return games


def event_items(payload: dict[str, Any]) -> list[Any]:
    for key in ("events", "results"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


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
    market_lines: dict[tuple[str, str, str], MarketLine] | None = None,
    availability: dict[tuple[str, str], Availability] | None = None,
    rating_features: str = "none",
    rating_line_source: str = "close",
    skill_features: str = "none",
) -> tuple[list[dict[str, Any]], int]:
    training_rows: list[dict[str, Any]] = []
    snapshot_dates = 0
    market_lines = market_lines or {}
    availability = availability or {}

    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    team_stats_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(dataset_path) as dataset_connection, sqlite3.connect(team_stats_path) as stats_connection:
        for season in sorted({game.season for game in games}, key=season_sort_key):
            states = {team: TeamState() for team in team_names}
            market_states = {team: MarketRatingState() for team in team_names}
            skill_states = {team: ScoreSkillState() for team in team_names}
            season_games = [game for game in games if game.season == season]
            first_season_date = min((game.date for game in season_games), default=None)
            for date in sorted({game.date for game in season_games}):
                snapshot_dates += 1
                write_team_snapshot_table(
                    stats_connection,
                    date,
                    states,
                    team_names,
                    market_states=market_states if rating_features == "market" else None,
                    skill_states=skill_states if skill_features == "score-based" else None,
                )
                for game in [candidate for candidate in season_games if candidate.date == date and candidate.is_final]:
                    home_stats = snapshot_for_team(states[game.home_team], game.home_team, date)
                    away_stats = snapshot_for_team(states[game.away_team], game.away_team, date)
                    market_line = market_lines.get(matchup_key(game.date, game.home_team, game.away_team))
                    row = build_game_record(
                        home_stats,
                        away_stats,
                        {
                            "Points": float(game.home_score or 0) + float(game.away_score or 0),
                            "Win_Margin": float(game.home_score or 0) - float(game.away_score or 0),
                            "OU": market_line.closing_total if market_line else None,
                        },
                    )
                    row["Date"] = game.date
                    if rating_features == "market":
                        row.update(market_rating_features(market_states, game.home_team, game.away_team))
                    if skill_features == "score-based":
                        row.update(score_skill_features(skill_states, game.home_team, game.away_team))
                    add_enriched_game_features(
                        row,
                        game,
                        home_stats,
                        away_stats,
                        market_line,
                        availability,
                        first_season_date,
                    )
                    training_rows.append(row)
                    apply_game_result(states, game)
                    if rating_features == "market":
                        update_market_ratings(
                            market_states,
                            game.home_team,
                            game.away_team,
                            float(game.home_score or 0) - float(game.away_score or 0),
                            float(game.home_score or 0) + float(game.away_score or 0),
                            market_line_value(market_line, rating_line_source, "spread"),
                            market_line_value(market_line, rating_line_source, "total"),
                        )
                    if skill_features == "score-based":
                        update_score_skills(
                            skill_states,
                            game.home_team,
                            game.away_team,
                            float(game.home_score or 0),
                            float(game.away_score or 0),
                        )
        write_sqlite_rows(dataset_connection, TRAINING_TABLE, training_rows)

    return training_rows, snapshot_dates


def snapshot_for_team(state: TeamState, team_name: str, game_date: str) -> dict[str, Any]:
    recent = state.recent or []
    recent3_for = [item[0] for item in recent[-3:]]
    recent3_against = [item[1] for item in recent[-3:]]
    recent_for = [item[0] for item in recent[-5:]]
    recent_against = [item[1] for item in recent[-5:]]
    recent10_for = [item[0] for item in recent[-10:]]
    recent10_against = [item[1] for item in recent[-10:]]
    return {
        "TEAM_NAME": team_name,
        "PRIOR_GAMES": float(state.games),
        "SEASON_WIN_PCT": safe_div(state.wins, state.games, 0.5),
        "SEASON_AVG_POINTS_FOR": safe_div(state.points_for, state.games, 0.0),
        "SEASON_AVG_POINTS_AGAINST": safe_div(state.points_against, state.games, 0.0),
        "SEASON_AVG_MARGIN": safe_div(state.points_for - state.points_against, state.games, 0.0),
        "ROLLING3_AVG_POINTS_FOR": average(recent3_for, safe_div(state.points_for, state.games, 0.0)),
        "ROLLING3_AVG_POINTS_AGAINST": average(recent3_against, safe_div(state.points_against, state.games, 0.0)),
        "ROLLING3_AVG_MARGIN": average(
            [for_points - against_points for for_points, against_points in recent[-3:]],
            safe_div(state.points_for - state.points_against, state.games, 0.0),
        ),
        "ROLLING5_AVG_POINTS_FOR": average(recent_for, safe_div(state.points_for, state.games, 0.0)),
        "ROLLING5_AVG_POINTS_AGAINST": average(recent_against, safe_div(state.points_against, state.games, 0.0)),
        "ROLLING5_AVG_MARGIN": average(
            [for_points - against_points for for_points, against_points in recent[-5:]],
            safe_div(state.points_for - state.points_against, state.games, 0.0),
        ),
        "ROLLING10_AVG_POINTS_FOR": average(recent10_for, safe_div(state.points_for, state.games, 0.0)),
        "ROLLING10_AVG_POINTS_AGAINST": average(recent10_against, safe_div(state.points_against, state.games, 0.0)),
        "ROLLING10_AVG_MARGIN": average(
            [for_points - against_points for for_points, against_points in recent[-10:]],
            safe_div(state.points_for - state.points_against, state.games, 0.0),
        ),
        "HOME_AVG_POINTS_FOR": safe_div(state.home_points_for, state.home_games, 0.0),
        "HOME_AVG_POINTS_AGAINST": safe_div(state.home_points_against, state.home_games, 0.0),
        "AWAY_AVG_POINTS_FOR": safe_div(state.away_points_for, state.away_games, 0.0),
        "AWAY_AVG_POINTS_AGAINST": safe_div(state.away_points_against, state.away_games, 0.0),
        "DAYS_REST": days_between(state.last_game_date, game_date),
        "ELO": state.elo,
    }


def add_enriched_game_features(
    row: dict[str, Any],
    game: SportsDbGame,
    home_stats: dict[str, Any],
    away_stats: dict[str, Any],
    market_line: MarketLine | None,
    availability: dict[tuple[str, str], Availability],
    first_season_date: str | None,
) -> None:
    home_availability = availability.get((game.date, normalize_match_name(game.home_team)), Availability())
    away_availability = availability.get((game.date, normalize_match_name(game.away_team)), Availability())
    row["ELO_DELTA"] = float(home_stats["ELO"]) - float(away_stats["ELO"])
    row["HOME_BACK_TO_BACK"] = 1.0 if float(home_stats["DAYS_REST"]) <= 1 else 0.0
    row["AWAY_BACK_TO_BACK"] = 1.0 if float(away_stats["DAYS_REST"]) <= 1 else 0.0
    row["SEASON_WEEK"] = season_week(first_season_date, game.date)
    row["EARLY_SEASON"] = 1.0 if row["SEASON_WEEK"] <= 3 else 0.0
    row["HOME_UNAVAILABLE_MINUTES"] = home_availability.unavailable_minutes
    row["AWAY_UNAVAILABLE_MINUTES"] = away_availability.unavailable_minutes
    row["HOME_UNAVAILABLE_VALUE"] = home_availability.unavailable_value
    row["AWAY_UNAVAILABLE_VALUE"] = away_availability.unavailable_value

    if market_line is None:
        return
    if market_line.closing_total is not None:
        row["MARKET_TOTAL_CLOSE"] = market_line.closing_total
        row["Total-Market-Residual"] = row["Score"] - market_line.closing_total
    if market_line.closing_spread is not None:
        row["MARKET_SPREAD_CLOSE"] = market_line.closing_spread
        row["Margin-Market-Residual"] = row["Home-Margin"] - market_line.closing_spread
    if market_line.opening_total is not None:
        row["MARKET_TOTAL_OPEN"] = market_line.opening_total
    if market_line.opening_spread is not None:
        row["MARKET_SPREAD_OPEN"] = market_line.opening_spread
    if market_line.opening_total is not None and market_line.closing_total is not None:
        row["MARKET_TOTAL_MOVE"] = market_line.closing_total - market_line.opening_total
    if market_line.opening_spread is not None and market_line.closing_spread is not None:
        row["MARKET_SPREAD_MOVE"] = market_line.closing_spread - market_line.opening_spread


def season_week(first_season_date: str | None, game_date: str) -> float:
    if first_season_date is None:
        return 1.0
    try:
        first = datetime.strptime(first_season_date, "%Y-%m-%d")
        current = datetime.strptime(game_date, "%Y-%m-%d")
    except ValueError:
        return 1.0
    return float(max(1, ((current - first).days // 7) + 1))


def write_team_snapshot_table(
    connection: sqlite3.Connection,
    date: str,
    states: dict[str, TeamState],
    team_names: list[str],
    market_states: dict[str, MarketRatingState] | None = None,
    skill_states: dict[str, ScoreSkillState] | None = None,
) -> None:
    rows = [
        team_snapshot_row(states, team_name, date, market_states=market_states, skill_states=skill_states)
        for team_name in team_names
    ]
    write_sqlite_rows(connection, date, rows)


def team_snapshot_row(
    states: dict[str, TeamState],
    team_name: str,
    date: str,
    market_states: dict[str, MarketRatingState] | None = None,
    skill_states: dict[str, ScoreSkillState] | None = None,
) -> dict[str, Any]:
    row = snapshot_for_team(states[team_name], team_name, date)
    if market_states is not None:
        row.update(market_rating_snapshot_features(market_states, team_name))
    if skill_states is not None:
        row.update(score_skill_snapshot_features(skill_states, team_name))
    return row


def write_sqlite_rows(connection: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = list(rows[0].keys())
    for row in rows[1:]:
        for column in row:
            if column not in columns:
                columns.append(column)
    quoted_table = quote_identifier(table)
    connection.execute(f"DROP TABLE IF EXISTS {quoted_table}")
    column_defs = ", ".join(f"{quote_identifier(column)} {sqlite_type(first_column_value(rows, column))}" for column in columns)
    connection.execute(f"CREATE TABLE {quoted_table} ({column_defs})")
    placeholders = ", ".join("?" for _ in columns)
    quoted_columns = ", ".join(quote_identifier(column) for column in columns)
    connection.executemany(
        f"INSERT INTO {quoted_table} ({quoted_columns}) VALUES ({placeholders})",
        [[row.get(column) for column in columns] for row in rows],
    )
    connection.commit()


def first_column_value(rows: list[dict[str, Any]], column: str) -> Any:
    for row in rows:
        if column in row and row[column] is not None:
            return row[column]
    return 0.0


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
        if column not in ALL_TARGET_COLUMNS and column not in DROP_COLUMNS
    ]
    for row in rows[1:]:
        for column in row.keys():
            if column not in columns and column not in ALL_TARGET_COLUMNS and column not in DROP_COLUMNS:
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
    validation_splits: int = 3,
) -> dict[str, Any]:
    defaults = build_feature_defaults(rows, feature_columns)
    training_rows = [row for row in rows if is_finite(row.get(target_column))]
    if not training_rows:
        raise SportsDbError(f"No rows available for target: {target_column}")
    x = [[1.0, *[feature_value(row, column, defaults) for column in feature_columns]] for row in training_rows]
    y = [float(row[target_column]) for row in training_rows]
    coefficients = solve_ridge_regression(x, y, ridge=1.0)
    residuals = chronological_linear_residuals(training_rows, feature_columns, target_column, defaults, validation_splits)
    if not residuals:
        predictions = [sum(weight * value for weight, value in zip(coefficients, row)) for row in x]
        residuals = [prediction - target for prediction, target in zip(predictions, y)]
    metrics = metrics_from_residuals(residuals)
    metrics["validation"] = {
        "method": "rolling_origin",
        "splits": len(chronological_splits(len(training_rows), validation_splits)),
        "rows": metrics["validation_rows"],
        "rmse": metrics["validation_rmse"],
        "mae": metrics["validation_mae"],
        "residual_stddev": metrics["residual_stddev"],
    }
    return {
        "intercept": round(coefficients[0], 8),
        "coefficients": {
            column: round(coefficients[index + 1], 8)
            for index, column in enumerate(feature_columns)
        },
        "metrics": metrics,
    }


def train_best_linear_model(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    model_key: str,
    model_kind: str,
    validation_splits: int,
) -> tuple[dict[str, Any], str]:
    candidates: list[tuple[str, dict[str, Any]]] = []
    if model_kind in {"direct", "auto"}:
        candidates.append((
            "direct",
            train_linear_model(rows, feature_columns, target_column_for(model_key, "direct"), validation_splits),
        ))
    if model_kind in {"market-residual", "auto"}:
        residual_target = target_column_for(model_key, "market_residual")
        if any(is_finite(row.get(residual_target)) for row in rows):
            candidates.append((
                "market_residual",
                train_linear_model(rows, feature_columns, residual_target, validation_splits),
            ))
        elif model_kind == "market-residual":
            raise SportsDbError(f"Market residual target is unavailable: {residual_target}")
    selected_mode, selected_model = min(
        candidates,
        key=lambda candidate: candidate[1]["metrics"]["residual_stddev"],
    )
    return selected_model, selected_mode


def chronological_linear_residuals(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    target_column: str,
    defaults: dict[str, float],
    validation_splits: int,
) -> list[float]:
    residuals: list[float] = []
    for train_indexes, test_indexes in chronological_splits(len(rows), validation_splits):
        train_rows = [rows[index] for index in train_indexes]
        test_rows = [rows[index] for index in test_indexes]
        x_train = [[1.0, *[feature_value(row, column, defaults) for column in feature_columns]] for row in train_rows]
        y_train = [float(row[target_column]) for row in train_rows]
        coefficients = solve_ridge_regression(x_train, y_train, ridge=1.0)
        for row in test_rows:
            features = [1.0, *[feature_value(row, column, defaults) for column in feature_columns]]
            prediction = sum(weight * value for weight, value in zip(coefficients, features))
            residuals.append(prediction - float(row[target_column]))
    return residuals


def build_validation_reports(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    models: dict[str, dict[str, Any]],
    target_modes: dict[str, str],
    validation_splits: int,
    calibration: str,
    quantiles: list[float],
    experimental_market_decorrelation: bool,
) -> dict[str, Any]:
    predictions = {
        model_key: chronological_linear_prediction_rows(
            rows,
            feature_columns,
            target_column_for(model_key, target_modes[model_key]),
            target_modes[model_key],
            validation_splits,
            model_key,
        )
        for model_key in ("total_score", "home_margin")
    }
    report: dict[str, Any] = {
        "baseline": {
            model_key: {
                "target_mode": target_modes[model_key],
                "validation_rmse": models[model_key]["metrics"].get("validation_rmse"),
                "validation_mae": models[model_key]["metrics"].get("validation_mae"),
                "residual_stddev": models[model_key]["metrics"].get("residual_stddev"),
                "interval_coverage": models[model_key]["metrics"].get("uncertainty", {}).get("coverage", {}),
            }
            for model_key in ("total_score", "home_margin")
        },
    }

    report["calibration"] = calibration_report(predictions, calibration)
    report["quantile_models"] = quantile_report(predictions, quantiles)
    report["ablations"] = {
        "rating_features": "enabled" if any(column in feature_columns for column in MARKET_RATING_COLUMNS) else "disabled",
        "skill_features": "enabled" if any(column in feature_columns for column in SKILL_FEATURE_COLUMNS) else "disabled",
    }
    if experimental_market_decorrelation:
        report["market_decorrelation"] = market_decorrelation_report(signal_rows(predictions))
    return report


def chronological_linear_prediction_rows(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    target_column: str,
    target_mode: str,
    validation_splits: int,
    model_key: str,
) -> list[dict[str, Any]]:
    training_rows = [row for row in rows if is_finite(row.get(target_column))]
    defaults = build_feature_defaults(training_rows, feature_columns)
    predictions: list[dict[str, Any]] = []
    prior_validation_residuals: list[float] = []
    for fold_id, (train_indexes, test_indexes) in enumerate(chronological_splits(len(training_rows), validation_splits)):
        train_rows = [training_rows[index] for index in train_indexes]
        test_rows = [training_rows[index] for index in test_indexes]
        x_train = [[1.0, *[feature_value(row, column, defaults) for column in feature_columns]] for row in train_rows]
        y_train = [float(row[target_column]) for row in train_rows]
        coefficients = solve_ridge_regression(x_train, y_train, ridge=1.0)
        train_residuals = [
            prediction_residual_for_row(row, feature_columns, defaults, coefficients, target_mode, model_key)
            for row in train_rows
        ]
        calibration_residuals = prior_validation_residuals or train_residuals
        residual_source = "prior_validation_residuals" if prior_validation_residuals else "training_window_in_sample_residuals"
        fold_residuals: list[float] = []
        for row in test_rows:
            raw_prediction = predict_linear_coefficients(row, feature_columns, defaults, coefficients)
            baseline = baseline_for_row(row, model_key) if target_mode == "market_residual" else 0.0
            actual_prediction = raw_prediction + baseline
            actual_target = float(row["Score"] if model_key == "total_score" else row["Home-Margin"])
            residual = actual_prediction - actual_target
            fold_residuals.append(residual)
            predictions.append(
                {
                    "fold_id": fold_id,
                    "train_rows": len(train_rows),
                    "test_rows": len(test_rows),
                    "calibration_residuals": list(calibration_residuals),
                    "calibration_residual_source": residual_source,
                    "row": row,
                    "prediction": actual_prediction,
                    "target": actual_target,
                    "residual": residual,
                    "raw_prediction": raw_prediction,
                }
            )
        prior_validation_residuals.extend(fold_residuals)
    return predictions


def prediction_residual_for_row(
    row: dict[str, Any],
    feature_columns: list[str],
    defaults: dict[str, float],
    coefficients: list[float],
    target_mode: str,
    model_key: str,
) -> float:
    raw_prediction = predict_linear_coefficients(row, feature_columns, defaults, coefficients)
    baseline = baseline_for_row(row, model_key) if target_mode == "market_residual" else 0.0
    actual_prediction = raw_prediction + baseline
    actual_target = float(row["Score"] if model_key == "total_score" else row["Home-Margin"])
    return actual_prediction - actual_target


def predict_linear_coefficients(
    row: dict[str, Any],
    feature_columns: list[str],
    defaults: dict[str, float],
    coefficients: list[float],
) -> float:
    features = [1.0, *[feature_value(row, column, defaults) for column in feature_columns]]
    return sum(weight * value for weight, value in zip(coefficients, features))


def baseline_for_row(row: dict[str, Any], model_key: str) -> float:
    key = "MARKET_TOTAL_CLOSE" if model_key == "total_score" else "MARKET_SPREAD_CLOSE"
    return float(row.get(key) or 0.0)


def calibration_report(predictions: dict[str, list[dict[str, Any]]], calibration: str) -> dict[str, Any]:
    return {
        "totals": calibration_section(
            predictions["total_score"],
            market_column="MARKET_TOTAL_CLOSE",
            outcome_column="Score",
            requested=calibration,
        ),
        "spreads": calibration_section(
            predictions["home_margin"],
            market_column="MARKET_SPREAD_CLOSE",
            outcome_column="Home-Margin",
            requested=calibration,
        ),
    }


def calibration_section(
    predictions: list[dict[str, Any]],
    market_column: str,
    outcome_column: str,
    requested: str,
) -> dict[str, Any]:
    events: list[CalibrationEvent] = []
    residual_sources: dict[str, int] = {}
    for item in predictions:
        row = item["row"]
        if not is_finite(row.get(market_column)):
            continue
        residuals = [float(value) for value in item.get("calibration_residuals", []) if is_finite(value)]
        if not residuals:
            continue
        edge = float(item["prediction"]) - float(row[market_column])
        outcome = 1 if float(row[outcome_column]) > float(row[market_column]) else 0
        events.append(CalibrationEvent(edge=edge, outcome=outcome, probability=empirical_probability(edge, residuals)))
        source = str(item.get("calibration_residual_source") or "unknown")
        residual_sources[source] = residual_sources.get(source, 0) + 1
    config = fit_probability_calibrator(events, requested)
    config["residual_source"] = residual_sources
    return config


def quantile_report(predictions: dict[str, list[dict[str, Any]]], quantiles: list[float]) -> dict[str, Any]:
    if not quantiles:
        return {}
    return {
        model_key: quantile_summary(
            [item["residual"] for item in items],
            [item["prediction"] for item in items],
            [item["target"] for item in items],
            quantiles,
        )
        for model_key, items in predictions.items()
    }


def signal_rows(predictions: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    by_date: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in predictions["total_score"]:
        row = item["row"]
        key = signal_key(row)
        signal = by_date.setdefault(key, {"date": row.get("Date"), "home_team": row.get("TEAM_NAME"), "away_team": row.get("TEAM_NAME.1")})
        if is_finite(row.get("MARKET_TOTAL_CLOSE")):
            signal["market_total"] = float(row["MARKET_TOTAL_CLOSE"])
            signal["total_edge"] = item["prediction"] - float(row["MARKET_TOTAL_CLOSE"])
        if is_finite(row.get("MARKET_TOTAL_MOVE")):
            signal["total_line_move"] = float(row["MARKET_TOTAL_MOVE"])
    for item in predictions["home_margin"]:
        row = item["row"]
        signal = by_date.setdefault(signal_key(row), {"date": row.get("Date"), "home_team": row.get("TEAM_NAME"), "away_team": row.get("TEAM_NAME.1")})
        if is_finite(row.get("MARKET_SPREAD_CLOSE")):
            signal["market_spread"] = float(row["MARKET_SPREAD_CLOSE"])
            signal["margin_edge"] = item["prediction"] - float(row["MARKET_SPREAD_CLOSE"])
        if is_finite(row.get("MARKET_SPREAD_MOVE")):
            signal["spread_line_move"] = float(row["MARKET_SPREAD_MOVE"])
    return list(by_date.values())


def signal_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (str(row.get("Date")), str(row.get("TEAM_NAME")), str(row.get("TEAM_NAME.1")))


def feature_value(row: dict[str, Any], column: str, defaults: dict[str, float]) -> float:
    value = row.get(column, defaults.get(column, 0.0))
    if not is_finite(value):
        value = defaults.get(column, 0.0)
    return float(value)


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
