"""Historical NBA projection package.

This package adapts the historical feature/artifact pattern from
magrhino/NBA-Machine-Learning-Sports-Betting into a local projection layer.
Runtime prediction is artifact-driven and does not fetch provider data.
"""

from .models import derive_team_scores, predict_from_artifacts

__all__ = ["derive_team_scores", "predict_from_artifacts"]
