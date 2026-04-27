from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


MARKET_RATING_COLUMNS = [
    "HOME_MARKET_RATING",
    "AWAY_MARKET_RATING",
    "MARKET_RATING_DIFF",
    "HOME_MARKET_RATING_PREV_N_AVG",
    "AWAY_MARKET_RATING_PREV_N_AVG",
    "MARKET_TOTAL_TEAM_ENVIRONMENT_PRIOR",
    "MARKET_SPREAD_PRIOR_RESIDUAL_FORM",
]

MARKET_RATING_SNAPSHOT_COLUMNS = [
    "MARKET_RATING",
    "MARKET_RATING_PREV_N_AVG",
    "MARKET_TOTAL_ENVIRONMENT_PRIOR",
    "MARKET_SPREAD_RESIDUAL_FORM",
]


@dataclass
class MarketRatingState:
    rating: float = 0.0
    environment: float = 220.0
    spread_residuals: list[float] = field(default_factory=list)
    recent_ratings: list[float] = field(default_factory=list)


def market_rating_features(
    states: dict[str, MarketRatingState],
    home_team: str,
    away_team: str,
) -> dict[str, float]:
    home_features = market_rating_snapshot_features(states, home_team)
    away_features = market_rating_snapshot_features(states, away_team)
    return {
        "HOME_MARKET_RATING": home_features["MARKET_RATING"],
        "AWAY_MARKET_RATING": away_features["MARKET_RATING"],
        "MARKET_RATING_DIFF": round(home_features["MARKET_RATING"] - away_features["MARKET_RATING"], 6),
        "HOME_MARKET_RATING_PREV_N_AVG": home_features["MARKET_RATING_PREV_N_AVG"],
        "AWAY_MARKET_RATING_PREV_N_AVG": away_features["MARKET_RATING_PREV_N_AVG"],
        "MARKET_TOTAL_TEAM_ENVIRONMENT_PRIOR": round(
            (home_features["MARKET_TOTAL_ENVIRONMENT_PRIOR"] + away_features["MARKET_TOTAL_ENVIRONMENT_PRIOR"]) / 2.0,
            6,
        ),
        "MARKET_SPREAD_PRIOR_RESIDUAL_FORM": round(
            home_features["MARKET_SPREAD_RESIDUAL_FORM"] - away_features["MARKET_SPREAD_RESIDUAL_FORM"],
            6,
        ),
    }


def market_rating_snapshot_features(
    states: dict[str, MarketRatingState],
    team: str,
) -> dict[str, float]:
    state = states.setdefault(team, MarketRatingState())
    return {
        "MARKET_RATING": round(state.rating, 6),
        "MARKET_RATING_PREV_N_AVG": round(average(state.recent_ratings, state.rating), 6),
        "MARKET_TOTAL_ENVIRONMENT_PRIOR": round(state.environment, 6),
        "MARKET_SPREAD_RESIDUAL_FORM": round(average(state.spread_residuals, 0.0), 6),
    }


def update_market_ratings(
    states: dict[str, MarketRatingState],
    home_team: str,
    away_team: str,
    home_margin: float,
    total_score: float,
    market_spread: float | None,
    market_total: float | None,
    learning_rate: float = 0.12,
) -> None:
    home = states.setdefault(home_team, MarketRatingState())
    away = states.setdefault(away_team, MarketRatingState())
    observed_spread = market_spread if market_spread is not None else home_margin
    spread_error = float(home_margin) - float(observed_spread)
    implied_diff = float(observed_spread)
    current_diff = home.rating - away.rating
    adjustment = learning_rate * (implied_diff - current_diff)
    home.rating += adjustment / 2.0
    away.rating -= adjustment / 2.0
    home.recent_ratings = [*home.recent_ratings, home.rating][-5:]
    away.recent_ratings = [*away.recent_ratings, away.rating][-5:]
    home.spread_residuals = [*home.spread_residuals, spread_error][-5:]
    away.spread_residuals = [*away.spread_residuals, -spread_error][-5:]
    if market_total is not None:
        environment = float(market_total)
    else:
        environment = float(total_score)
    home.environment = (1.0 - learning_rate) * home.environment + learning_rate * environment
    away.environment = (1.0 - learning_rate) * away.environment + learning_rate * environment


def market_line_value(market_line: Any, line_source: str, field: str) -> float | None:
    if market_line is None:
        return None
    if line_source not in {"open", "close", "provided"}:
        raise ValueError("rating-line-source must be open, close, or provided")
    if line_source == "open":
        return getattr(market_line, f"opening_{field}", None)
    return getattr(market_line, f"closing_{field}", None)


def average(values: list[float], default: float) -> float:
    if not values:
        return default
    return sum(values) / len(values)
