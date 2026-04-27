from __future__ import annotations

import math
from dataclasses import dataclass


SKILL_FEATURE_COLUMNS = [
    "HOME_OFF_SKILL_MEAN",
    "HOME_OFF_SKILL_STD",
    "HOME_DEF_SKILL_MEAN",
    "HOME_DEF_SKILL_STD",
    "AWAY_OFF_SKILL_MEAN",
    "AWAY_OFF_SKILL_STD",
    "AWAY_DEF_SKILL_MEAN",
    "AWAY_DEF_SKILL_STD",
    "SKILL_MARGIN_PRIOR",
    "SKILL_TOTAL_PRIOR",
]

SKILL_SNAPSHOT_COLUMNS = [
    "OFF_SKILL_MEAN",
    "OFF_SKILL_STD",
    "DEF_SKILL_MEAN",
    "DEF_SKILL_STD",
]


@dataclass
class ScoreSkillState:
    games: int = 0
    off_mean: float = 110.0
    def_mean: float = 110.0
    off_var: float = 144.0
    def_var: float = 144.0


def score_skill_features(
    states: dict[str, ScoreSkillState],
    home_team: str,
    away_team: str,
) -> dict[str, float]:
    home_features = score_skill_snapshot_features(states, home_team)
    away_features = score_skill_snapshot_features(states, away_team)
    home_expected = (home_features["OFF_SKILL_MEAN"] + away_features["DEF_SKILL_MEAN"]) / 2.0
    away_expected = (away_features["OFF_SKILL_MEAN"] + home_features["DEF_SKILL_MEAN"]) / 2.0
    return {
        "HOME_OFF_SKILL_MEAN": home_features["OFF_SKILL_MEAN"],
        "HOME_OFF_SKILL_STD": home_features["OFF_SKILL_STD"],
        "HOME_DEF_SKILL_MEAN": home_features["DEF_SKILL_MEAN"],
        "HOME_DEF_SKILL_STD": home_features["DEF_SKILL_STD"],
        "AWAY_OFF_SKILL_MEAN": away_features["OFF_SKILL_MEAN"],
        "AWAY_OFF_SKILL_STD": away_features["OFF_SKILL_STD"],
        "AWAY_DEF_SKILL_MEAN": away_features["DEF_SKILL_MEAN"],
        "AWAY_DEF_SKILL_STD": away_features["DEF_SKILL_STD"],
        "SKILL_MARGIN_PRIOR": round(home_expected - away_expected, 6),
        "SKILL_TOTAL_PRIOR": round(home_expected + away_expected, 6),
    }


def score_skill_snapshot_features(
    states: dict[str, ScoreSkillState],
    team: str,
) -> dict[str, float]:
    state = states.setdefault(team, ScoreSkillState())
    return {
        "OFF_SKILL_MEAN": round(state.off_mean, 6),
        "OFF_SKILL_STD": round(math.sqrt(max(0.0, state.off_var)), 6),
        "DEF_SKILL_MEAN": round(state.def_mean, 6),
        "DEF_SKILL_STD": round(math.sqrt(max(0.0, state.def_var)), 6),
    }


def update_score_skills(
    states: dict[str, ScoreSkillState],
    home_team: str,
    away_team: str,
    home_score: float,
    away_score: float,
    learning_rate: float = 0.15,
    variance_decay: float = 0.94,
) -> None:
    home = states.setdefault(home_team, ScoreSkillState())
    away = states.setdefault(away_team, ScoreSkillState())
    update_one_team(home, float(home_score), float(away_score), learning_rate, variance_decay)
    update_one_team(away, float(away_score), float(home_score), learning_rate, variance_decay)


def update_one_team(
    state: ScoreSkillState,
    points_for: float,
    points_against: float,
    learning_rate: float,
    variance_decay: float,
) -> None:
    off_error = points_for - state.off_mean
    def_error = points_against - state.def_mean
    state.off_mean += learning_rate * off_error
    state.def_mean += learning_rate * def_error
    state.off_var = variance_decay * state.off_var + (1.0 - variance_decay) * off_error * off_error
    state.def_var = variance_decay * state.def_var + (1.0 - variance_decay) * def_error * def_error
    state.games += 1
