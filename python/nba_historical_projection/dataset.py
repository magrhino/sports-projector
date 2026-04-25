from __future__ import annotations

from typing import Any


def build_game_record(
    home_stats: dict[str, Any],
    away_stats: dict[str, Any],
    game_result: dict[str, Any],
) -> dict[str, Any]:
    """Build one historical training row from matchup features and a final result.

    This keeps the magrhino two-team feature shape, preserving home columns as-is
    and suffixing away columns with `.1`, while adding numeric score-regression
    targets needed by this project.
    """

    points = float(required_number(game_result, "Points"))
    home_margin = float(required_number(game_result, "Win_Margin"))
    ou_value = game_result.get("OU")

    record: dict[str, Any] = dict(home_stats)
    record.update({f"{key}.1": value for key, value in away_stats.items()})
    record["Score"] = points
    record["Home-Margin"] = home_margin
    record["Home-Team-Win"] = 1 if home_margin > 0 else 0

    if ou_value is not None:
        ou_number = float(ou_value)
        record["OU"] = ou_number
        if points < ou_number:
            record["OU-Cover"] = 0
        elif points > ou_number:
            record["OU-Cover"] = 1
        else:
            record["OU-Cover"] = 2

    if game_result.get("Days_Rest_Home") is not None:
        record["Days-Rest-Home"] = float(game_result["Days_Rest_Home"])
    if game_result.get("Days_Rest_Away") is not None:
        record["Days-Rest-Away"] = float(game_result["Days_Rest_Away"])

    return record


def required_number(values: dict[str, Any], key: str) -> float:
    if key not in values:
        raise ValueError(f"Missing required historical result field: {key}")
    try:
        return float(values[key])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Historical result field must be numeric: {key}") from exc
