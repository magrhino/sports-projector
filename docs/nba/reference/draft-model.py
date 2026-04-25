from dataclasses import dataclass
from typing import Optional, List, Dict, Any
from statistics import mean
from math import erf, sqrt


@dataclass
class LiveGameState:
    team_a_score: int
    team_b_score: int

    # 1-4 = regulation quarters.
    # 5 = first overtime, 6 = second overtime, etc.
    quarter: int

    # Time remaining in current period, formatted as "MM:SS".
    # Example: "9:25"
    clock: str

    # Live total line.
    # Example: 203 or 203.5
    live_total_line: float

    # Optional historical anchors.
    pregame_total: Optional[float] = None
    last_10_totals: Optional[List[float]] = None
    series_totals: Optional[List[float]] = None

    # Optional recent scoring window.
    # Example: if 17 points were scored in the last 4.0 game minutes,
    # recent_points=17, recent_minutes=4.0
    recent_points: Optional[float] = None
    recent_minutes: Optional[float] = None

    # Period team fouls. These are important late because fouls-to-give
    # can delay free throws during intentional foul situations.
    team_a_fouls_period: Optional[int] = None
    team_b_fouls_period: Optional[int] = None

    # Playoff games tend to stay extended slightly longer than regular season blowouts.
    is_playoffs: bool = True


def parse_clock_minutes(clock: str) -> float:
    """
    Converts "MM:SS" into decimal minutes.
    Example: "9:25" -> 9.4167
    """
    minutes, seconds = clock.strip().split(":")
    return int(minutes) + int(seconds) / 60.0


def game_time(quarter: int, clock: str) -> Dict[str, float]:
    """
    Returns elapsed and remaining game time.

    NBA regulation:
    - 4 quarters
    - 12 minutes each
    - 48 regulation minutes

    NBA overtime:
    - 5 minutes each
    """
    period_left = parse_clock_minutes(clock)

    if quarter <= 4:
        elapsed = (quarter - 1) * 12 + (12 - period_left)
        remaining = (4 - quarter) * 12 + period_left
        period_length = 12
    else:
        elapsed = 48 + (quarter - 5) * 5 + (5 - period_left)
        remaining = period_left
        period_length = 5

    return {
        "elapsed": elapsed,
        "remaining": remaining,
        "period_left": period_left,
        "period_length": period_length,
    }


def safe_mean(values: Optional[List[float]]) -> Optional[float]:
    if not values:
        return None
    return mean(values)


def baseline_total(state: LiveGameState) -> float:
    """
    Creates a historical scoring anchor.

    Recommended weighting:
    - pregame total: useful market baseline
    - last 10 totals: team-form baseline
    - series totals: matchup-specific baseline

    If none are available, use the live line only as a fallback.
    """
    parts = []

    if state.pregame_total is not None:
        parts.append((state.pregame_total, 0.35))

    if state.last_10_totals:
        parts.append((safe_mean(state.last_10_totals), 0.45))

    if state.series_totals:
        parts.append((safe_mean(state.series_totals), 0.20))

    if not parts:
        return state.live_total_line

    total_weight = sum(weight for _, weight in parts)
    return sum(value * weight for value, weight in parts) / total_weight


def dynamic_rate_weights(minutes_left: float) -> tuple[float, float, float]:
    """
    Returns weights for:
    - prior_rate
    - full_game_rate
    - recent_rate

    The later the game gets, the more recent pace matters.
    """
    if minutes_left > 24:
        return 0.50, 0.35, 0.15

    if minutes_left > 12:
        return 0.35, 0.40, 0.25

    if minutes_left > 6:
        return 0.30, 0.30, 0.40

    if minutes_left > 2:
        return 0.25, 0.25, 0.50

    return 0.20, 0.20, 0.60


def fouls_to_give_before_penalty(
    team_fouls_period: Optional[int],
    quarter: int,
    period_left: float,
) -> Optional[int]:
    """
    Estimates how many non-penalty team fouls the trailing team can use
    before the opponent shoots free throws.

    This matters most in the final 1-2 minutes.
    """
    if team_fouls_period is None:
        return None

    if quarter <= 4:
        if period_left <= 2:
            # In the last two minutes, if a team was not already at the quota,
            # it generally has one non-penalty foul available.
            return 1 if team_fouls_period < 4 else 0

        return max(0, 4 - team_fouls_period)

    # Overtime has a lower team-foul quota.
    if period_left <= 2:
        return 1 if team_fouls_period < 3 else 0

    return max(0, 3 - team_fouls_period)


def late_game_foul_bonus(
    minutes_left: float,
    margin: int,
    trailing_fouls_to_give: Optional[int],
) -> float:
    """
    Adds points above normal pace due to late intentional fouling,
    bonus free throws, clock stoppages, and quick possessions.

    This is the key correction versus a simple linear pace model.

    Interpretation:
    - This is not total expected scoring from fouls.
    - This is extra scoring above what the blended pace already expects.
    """
    bonus = 0.0

    if minutes_left <= 1.0:
        if margin == 0:
            bonus = 0.5
        elif margin <= 3:
            bonus = 1.5
        elif margin <= 8:
            bonus = 5.5
        elif margin <= 12:
            bonus = 3.0
        else:
            bonus = 0.0

    elif minutes_left <= 2.0:
        if margin == 0:
            bonus = 1.0
        elif margin <= 3:
            bonus = 2.0
        elif margin <= 6:
            bonus = 4.0
        elif margin <= 10:
            bonus = 2.0
        else:
            bonus = 0.0

    elif minutes_left <= 5.0:
        if margin <= 3:
            bonus = 2.0
        elif margin <= 6:
            bonus = 1.5
        elif margin <= 10:
            bonus = 0.5

    elif minutes_left <= 10.0:
        if margin <= 6:
            bonus = 1.0
        elif margin <= 10:
            bonus = 0.25

    # Adjust based on whether the trailing team has fouls to give.
    # If it has fouls to give, intentional fouling may stop the clock
    # without creating immediate free throws.
    if trailing_fouls_to_give is not None and minutes_left <= 2.0:
        if trailing_fouls_to_give == 0:
            bonus *= 1.15
        elif trailing_fouls_to_give == 1:
            bonus *= 0.80
        else:
            bonus *= 0.65

    return max(-1.0, bonus)


def overtime_probability(minutes_left: float, margin: int) -> float:
    """
    Heuristic overtime probability.

    This does not need to be perfect.
    The main purpose is to avoid treating a tie or one-possession game
    as if regulation is the only possible scoring window.
    """
    if minutes_left <= 1.0:
        if margin == 0:
            return 0.22
        if margin == 1:
            return 0.16
        if margin == 2:
            return 0.10
        if margin == 3:
            return 0.07
        if margin <= 5:
            return 0.02
        return 0.003

    if minutes_left <= 2.0:
        if margin == 0:
            return 0.18
        if margin == 1:
            return 0.12
        if margin == 2:
            return 0.08
        if margin == 3:
            return 0.06
        if margin <= 5:
            return 0.025
        return 0.005

    if minutes_left <= 5.0:
        if margin <= 1:
            return 0.07
        if margin <= 3:
            return 0.04
        if margin <= 6:
            return 0.02
        return 0.003

    if minutes_left <= 10.0:
        if margin <= 3:
            return 0.02
        if margin <= 6:
            return 0.01

    return 0.0


def blowout_drag(minutes_left: float, margin: int, is_playoffs: bool) -> float:
    """
    Subtracts a small amount when the margin is too large for meaningful
    late-game extension.

    Playoff games get a smaller drag because teams are more likely to keep
    competing longer.
    """
    playoff_offset = 0.5 if is_playoffs else 0.0

    if minutes_left <= 2 and margin >= 12:
        return -2.0 + playoff_offset

    if minutes_left <= 5 and margin >= 14:
        return -1.5 + playoff_offset

    if minutes_left <= 10 and margin >= 18:
        return -1.0 + playoff_offset

    return 0.0


def normal_cdf(x: float) -> float:
    return 0.5 * (1 + erf(x / sqrt(2)))


def residual_sigma(minutes_left: float) -> float:
    """
    Approximate projection uncertainty.

    The less time remaining, the lower the uncertainty.
    But it never gets too low because final-minute fouls and overtime
    create high variance.
    """
    if minutes_left > 12:
        return 11.0

    if minutes_left > 6:
        return 8.0

    if minutes_left > 2:
        return 5.5

    return 4.0


def project_live_total(state: LiveGameState) -> Dict[str, Any]:
    current_total = state.team_a_score + state.team_b_score
    margin = abs(state.team_a_score - state.team_b_score)

    timing = game_time(state.quarter, state.clock)
    elapsed = timing["elapsed"]
    minutes_left = timing["remaining"]
    period_left = timing["period_left"]

    if elapsed <= 0:
        raise ValueError("Elapsed time must be positive.")

    full_game_rate = current_total / elapsed

    historical_baseline = baseline_total(state)
    prior_rate = historical_baseline / 48.0

    if (
        state.recent_points is not None
        and state.recent_minutes is not None
        and state.recent_minutes > 0
    ):
        recent_rate = state.recent_points / state.recent_minutes
    else:
        recent_rate = full_game_rate

    w_prior, w_full, w_recent = dynamic_rate_weights(minutes_left)

    blended_rate = (
        w_prior * prior_rate
        + w_full * full_game_rate
        + w_recent * recent_rate
    )

    # Identify the trailing team's fouls.
    # That team is the one most likely to foul intentionally late.
    if state.team_a_score < state.team_b_score:
        trailing_fouls = state.team_a_fouls_period
    elif state.team_b_score < state.team_a_score:
        trailing_fouls = state.team_b_fouls_period
    else:
        trailing_fouls = None

    trailing_fouls_to_give = fouls_to_give_before_penalty(
        trailing_fouls,
        state.quarter,
        period_left,
    )

    foul_bonus = late_game_foul_bonus(
        minutes_left=minutes_left,
        margin=margin,
        trailing_fouls_to_give=trailing_fouls_to_give,
    )

    ot_prob = overtime_probability(
        minutes_left=minutes_left,
        margin=margin,
    )

    # Expected OT points: 5 minutes times blended pace,
    # bounded to avoid extreme values.
    ot_expected_points = max(18.0, min(26.0, blended_rate * 5.0))
    ot_bonus = ot_prob * ot_expected_points

    drag = blowout_drag(
        minutes_left=minutes_left,
        margin=margin,
        is_playoffs=state.is_playoffs,
    )

    projected_total = (
        current_total
        + blended_rate * minutes_left
        + foul_bonus
        + ot_bonus
        + drag
    )

    edge = projected_total - state.live_total_line

    sigma = residual_sigma(minutes_left)

    p_over = 1 - normal_cdf(
        (state.live_total_line - projected_total) / sigma
    )

    if edge >= 4.0 and p_over >= 0.57:
        lean = "OVER"
    elif edge <= -4.0 and p_over <= 0.43:
        lean = "UNDER"
    else:
        lean = "PASS"

    return {
        "current_total": current_total,
        "elapsed_minutes": round(elapsed, 2),
        "minutes_left": round(minutes_left, 2),
        "margin": margin,

        "historical_baseline_total": round(historical_baseline, 2),
        "full_game_rate": round(full_game_rate, 3),
        "prior_rate": round(prior_rate, 3),
        "recent_rate": round(recent_rate, 3),
        "blended_rate": round(blended_rate, 3),

        "trailing_fouls_to_give": trailing_fouls_to_give,
        "foul_bonus": round(foul_bonus, 2),

        "overtime_probability": round(ot_prob, 3),
        "overtime_bonus": round(ot_bonus, 2),

        "blowout_drag": round(drag, 2),

        "projected_total": round(projected_total, 1),
        "edge_vs_line": round(edge, 1),
        "p_over": round(p_over, 3),
        "lean": lean,
    }
