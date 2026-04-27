from __future__ import annotations

import math
from typing import Any


def market_decorrelation_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"enabled": True, "rows": 0, "warnings": ["No out-of-fold signal rows were available."]}
    total_rows = [row for row in rows if finite(row.get("total_edge")) and finite(row.get("market_total"))]
    spread_rows = [row for row in rows if finite(row.get("margin_edge")) and finite(row.get("market_spread"))]
    report: dict[str, Any] = {
        "enabled": True,
        "rows": len(rows),
        "totals": signal_metrics(total_rows, "total_edge", "market_total", "total_line_move"),
        "spreads": signal_metrics(spread_rows, "margin_edge", "market_spread", "spread_line_move"),
        "warnings": [
            "ROI-style diagnostics require realistic payout data and are intentionally not used for default model selection."
        ],
    }
    return report


def signal_metrics(rows: list[dict[str, Any]], edge_key: str, market_key: str, move_key: str) -> dict[str, Any]:
    if not rows:
        return {"rows": 0}
    edge = [float(row[edge_key]) for row in rows]
    market = [float(row[market_key]) for row in rows]
    moves = [float(row[move_key]) for row in rows if finite(row.get(move_key))]
    return {
        "rows": len(rows),
        "edge_market_correlation": round(correlation(edge, market), 6),
        "avg_abs_edge": round(sum(abs(value) for value in edge) / len(edge), 6),
        "closing_line_value_proxy": round(sum(moves) / len(moves), 6) if moves else None,
    }


def correlation(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or len(left) < 2:
        return 0.0
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    left_var = sum((a - left_mean) ** 2 for a in left)
    right_var = sum((b - right_mean) ** 2 for b in right)
    denominator = math.sqrt(left_var * right_var)
    if denominator == 0:
        return 0.0
    return numerator / denominator


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False
