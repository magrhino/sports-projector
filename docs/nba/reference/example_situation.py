state = LiveGameState(
    team_a_score=83,
    team_b_score=78,
    quarter=4,
    clock="9:25",
    live_total_line=203,

    # Use real values when available.
    # These are placeholders from the earlier discussion.
    pregame_total=203,
    series_totals=[205, 195],

    # If no recent scoring window is available, the model falls back
    # to full-game pace.
    recent_points=None,
    recent_minutes=None,

    team_a_fouls_period=None,
    team_b_fouls_period=None,

    is_playoffs=True,
)

result = project_live_total(state)
print(result)
