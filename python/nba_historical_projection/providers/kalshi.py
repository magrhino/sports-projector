from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol


KALSHI_ORIGIN = "https://api.elections.kalshi.com"
KALSHI_TOTALS_SERIES = "KXNBATOTAL"
DEFAULT_MARKET_PAGE_LIMIT = 100
DEFAULT_MARKET_LINES_MAX_PAGES = 10


class KalshiError(RuntimeError):
    """Raised when public Kalshi market data cannot be fetched."""


class KalshiMarketClient(Protocol):
    def fetch_current_markets(
        self,
        series_ticker: str,
        cursor: str | None = None,
        limit: int = DEFAULT_MARKET_PAGE_LIMIT,
    ) -> dict[str, Any]:
        ...

    def fetch_historical_markets(
        self,
        series_ticker: str,
        cursor: str | None = None,
        limit: int = DEFAULT_MARKET_PAGE_LIMIT,
    ) -> dict[str, Any]:
        ...


class PublicKalshiMarketClient:
    def __init__(
        self,
        opener=None,
        timeout_seconds: float = 30.0,
    ):
        self.opener = opener or self._open
        self.timeout_seconds = timeout_seconds

    def fetch_current_markets(
        self,
        series_ticker: str,
        cursor: str | None = None,
        limit: int = DEFAULT_MARKET_PAGE_LIMIT,
    ) -> dict[str, Any]:
        return self.fetch_json(
            ["trade-api", "v2", "markets"],
            {
                "series_ticker": series_ticker,
                "limit": str(limit),
                **({"cursor": cursor} if cursor else {}),
            },
        )

    def fetch_historical_markets(
        self,
        series_ticker: str,
        cursor: str | None = None,
        limit: int = DEFAULT_MARKET_PAGE_LIMIT,
    ) -> dict[str, Any]:
        return self.fetch_json(
            ["trade-api", "v2", "historical", "markets"],
            {
                "series_ticker": series_ticker,
                "limit": str(limit),
                **({"cursor": cursor} if cursor else {}),
            },
        )

    def fetch_json(self, path_segments: list[str], query: dict[str, str]) -> dict[str, Any]:
        url = build_kalshi_url(path_segments, query)
        try:
            with self.opener(url, self.timeout_seconds) as response:
                data = response.read().decode("utf-8")
            parsed = json.loads(data)
        except urllib.error.HTTPError as exc:
            raise KalshiError(f"Kalshi request failed with HTTP {exc.code}: {url}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise KalshiError(f"Kalshi request failed: {url}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise KalshiError(f"Kalshi returned invalid JSON: {url}: {exc}") from exc
        if not isinstance(parsed, dict):
            raise KalshiError(f"Kalshi response must be a JSON object: {url}")
        return parsed

    @staticmethod
    def _open(url: str, timeout_seconds: float):
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        return urllib.request.urlopen(request, timeout=timeout_seconds)


def build_kalshi_url(path_segments: list[str], query: dict[str, str]) -> str:
    path = "/".join(urllib.parse.quote(segment, safe="") for segment in path_segments)
    encoded_query = urllib.parse.urlencode(query)
    return f"{KALSHI_ORIGIN}/{path}?{encoded_query}"


def fetch_total_markets(
    client: KalshiMarketClient | None = None,
    max_pages: int = DEFAULT_MARKET_LINES_MAX_PAGES,
    series_ticker: str = KALSHI_TOTALS_SERIES,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    provider = client or PublicKalshiMarketClient()
    page_limit = DEFAULT_MARKET_PAGE_LIMIT
    safe_max_pages = max(0, int(max_pages))
    markets: list[dict[str, Any]] = []
    summary = {
        "enabled": True,
        "series_ticker": series_ticker,
        "max_pages": safe_max_pages,
        "sources": {
            "kalshi_current": {"pages": 0, "markets": 0, "truncated": False},
            "kalshi_historical": {"pages": 0, "markets": 0, "truncated": False},
        },
        "errors": [],
    }

    markets.extend(
        fetch_market_pages(
            provider.fetch_current_markets,
            series_ticker,
            "kalshi_current",
            safe_max_pages,
            page_limit,
            summary,
        )
    )
    markets.extend(
        fetch_market_pages(
            provider.fetch_historical_markets,
            series_ticker,
            "kalshi_historical",
            safe_max_pages,
            page_limit,
            summary,
        )
    )
    return markets, summary


def fetch_market_pages(
    fetcher,
    series_ticker: str,
    source: str,
    max_pages: int,
    page_limit: int,
    summary: dict[str, Any],
) -> list[dict[str, Any]]:
    markets: list[dict[str, Any]] = []
    cursor: str | None = None
    for _page in range(max_pages):
        try:
            payload = fetcher(series_ticker, cursor=cursor, limit=page_limit)
        except Exception as exc:
            summary["errors"].append({"source": source, "message": str(exc)})
            break

        page_markets = payload.get("markets")
        if not isinstance(page_markets, list):
            break
        summary["sources"][source]["pages"] += 1
        summary["sources"][source]["markets"] += len(page_markets)
        for market in page_markets:
            if isinstance(market, dict):
                markets.append({**market, "_sports_projector_source": source})

        next_cursor = payload.get("cursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    else:
        summary["sources"][source]["truncated"] = True

    return markets
