from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


DEFAULT_SPORTSDB_API_KEY = "123"
SPORTSDB_ORIGIN = "https://www.thesportsdb.com"
DEFAULT_RATE_LIMIT_PER_MINUTE = 30


@dataclass(frozen=True)
class SportsDbSportConfig:
    sport: str
    league_name: str
    league_id: str
    default_lookback_seasons: int


SPORT_CONFIGS = {
    "nba": SportsDbSportConfig(
        sport="nba",
        league_name="NBA",
        league_id="4387",
        default_lookback_seasons=6,
    ),
}


class SportsDbError(RuntimeError):
    """Raised when SportsDB data cannot be fetched or normalized."""


class SportsDbRateLimiter:
    def __init__(
        self,
        requests_per_minute: int = DEFAULT_RATE_LIMIT_PER_MINUTE,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ):
        if requests_per_minute < 1:
            raise ValueError("requests_per_minute must be at least 1")
        self.interval_seconds = 60.0 / requests_per_minute
        self.clock = clock or time.monotonic
        self.sleep = sleep or time.sleep
        self.last_request_at: float | None = None

    def wait(self) -> None:
        now = self.clock()
        if self.last_request_at is not None:
            elapsed = now - self.last_request_at
            remaining = self.interval_seconds - elapsed
            if remaining > 0:
                self.sleep(remaining)
                now = self.clock()
        self.last_request_at = now

    def wait_after_429(self) -> None:
        self.sleep(65.0)
        self.last_request_at = self.clock()


class SportsDbClient:
    def __init__(
        self,
        api_key: str = DEFAULT_SPORTSDB_API_KEY,
        rate_limit_per_minute: int = DEFAULT_RATE_LIMIT_PER_MINUTE,
        opener: Callable[[str, float], Any] | None = None,
        timeout_seconds: float = 30.0,
        limiter: SportsDbRateLimiter | None = None,
    ):
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.opener = opener or self._open
        self.limiter = limiter or SportsDbRateLimiter(rate_limit_per_minute)

    def fetch_all_seasons(self, league_id: str) -> dict[str, Any]:
        return self.fetch_json("search_all_seasons.php", {"id": league_id})

    def fetch_all_teams(self, league_name: str) -> dict[str, Any]:
        return self.fetch_json("search_all_teams.php", {"l": league_name})

    def fetch_season_events(self, league_id: str, season: str) -> dict[str, Any]:
        return self.fetch_json("eventsseason.php", {"id": league_id, "s": season})

    def fetch_json(
        self,
        endpoint: str,
        query: dict[str, str],
        max_attempts: int = 4,
    ) -> dict[str, Any]:
        url = build_sportsdb_url(self.api_key, endpoint, query)
        for attempt in range(1, max_attempts + 1):
            self.limiter.wait()
            try:
                with self.opener(url, self.timeout_seconds) as response:
                    data = response.read().decode("utf-8")
                parsed = json.loads(data)
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt < max_attempts:
                    self.limiter.wait_after_429()
                    continue
                raise SportsDbError(f"SportsDB request failed with HTTP {exc.code}: {url}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                raise SportsDbError(f"SportsDB request failed: {url}: {exc}") from exc
            except json.JSONDecodeError as exc:
                raise SportsDbError(f"SportsDB returned invalid JSON: {url}: {exc}") from exc
            if not isinstance(parsed, dict):
                raise SportsDbError(f"SportsDB response must be a JSON object: {url}")
            return parsed
        raise SportsDbError(f"SportsDB request exhausted retries: {url}")

    @staticmethod
    def _open(url: str, timeout_seconds: float):
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        return urllib.request.urlopen(request, timeout=timeout_seconds)


def build_sportsdb_url(api_key: str, endpoint: str, query: dict[str, str]) -> str:
    if not endpoint.endswith(".php") or "/" in endpoint:
        raise ValueError("SportsDB endpoint must be a local .php endpoint name")
    encoded_query = urllib.parse.urlencode(query)
    return f"{SPORTSDB_ORIGIN}/api/v1/json/{urllib.parse.quote(api_key)}/{endpoint}?{encoded_query}"


def write_raw_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")

