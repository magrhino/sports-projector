# Sports Projector

Read-only sports projection and public market research tooling for ESPN sports data, public Kalshi markets, and optional local NBA projection artifacts.

Sports Projector is informational research tooling only. It is not betting advice. The ESPN/Kalshi tools use public unauthenticated data, and the projection paths do not place orders or manage accounts.

## Quick Start

Run the published web app image from GitHub Container Registry:

```bash
docker run --rm \
  -p 8080:8080 \
  -e PORT=8080 \
  ghcr.io/magrhino/sports-projector:latest
```

Open `http://localhost:8080` and search for a team such as `Celtics` with league `NBA`.

For reproducible deployments, use a release tag instead of `latest`:

```bash
docker pull ghcr.io/magrhino/sports-projector:v1.0.0
docker run --rm \
  -p 8080:8080 \
  -e PORT=8080 \
  ghcr.io/magrhino/sports-projector:v1.0.0
```

The HTTP API is also available directly:

```bash
curl "http://localhost:8080/api/games/search?team=Celtics&league=nba"
curl "http://localhost:8080/api/games/live?league=nba"
curl "http://localhost:8080/api/nba/projections?event_id=401000000&scope=live"
```

For live tracking or historical artifacts, mount persistent state and configure the container as described in [DEPLOYMENT.md](DEPLOYMENT.md).

## Codex MCP Setup

Run the MCP server over stdio from the same GHCR image:

```bash
codex mcp add sports-projector -- docker run -i --rm ghcr.io/magrhino/sports-projector:latest node dist/index.js
```

If you need local historical artifacts inside the MCP container, mount them and set the historical environment variables documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Tools

### ESPN Public Sports Data

- `get_scoreboard`: fetch ESPN scoreboard data for `nba`, `nfl`, `mlb`, or `nhl`.
- `get_game_summary`: fetch ESPN game summary data by `event_id`.
- `get_team_schedule`: resolve a team name/abbreviation/id and fetch its ESPN schedule.
- `get_standings`: fetch ESPN standings when the public endpoint is available.

Returned ESPN data is normalized to include status, period/quarter/inning, clock, teams, score, linescore where available, venue, broadcasts, source URL, cache status, and caveats.

### Kalshi Public Market Data

- `search_kalshi_markets`: list/search public Kalshi markets, including optional explicit ticker filters.
- `get_kalshi_market`: fetch one public Kalshi market by ticker.
- `get_kalshi_orderbook`: fetch one public Kalshi orderbook by ticker.
- `get_kalshi_trades`: fetch public Kalshi trades.

Kalshi orderbooks return YES bids and NO bids, not conventional asks. This server derives an implied YES ask as `100 - best_no_bid` when a NO bid exists, then derives the spread from that implied ask and the best YES bid.

### Calculation Helpers

- `calculate_implied_probability_from_price`
- `calculate_binary_market_spread`
- `estimate_total_score_projection`
- `compare_projection_to_market`

These tools use transparent formulas and return assumptions/caveats. They do not rank bets, recommend wagers, automate decisions, or place trades.

### NBA Projections

- `project_nba_historical_score`: project an NBA matchup score from local historical model artifacts.
- `project_nba_live_score`: project the most likely NBA final score for an ESPN event id using public ESPN live state and public Kalshi total-market/live-data endpoints when available.

Historical projection reads local artifacts only. Live projection degrades to ESPN score/pace projection with caveats when Kalshi context is unavailable.

## Example Prompts

- "Use `get_scoreboard` for NBA today and summarize live scores with period and clock."
- "Use `get_game_summary` for this ESPN event id and extract venue, score, and linescore."
- "Find public Kalshi markets about NBA using `search_kalshi_markets`, then inspect one orderbook."
- "Use `get_kalshi_orderbook` and explain the YES bid, implied YES ask, and spread."
- "Estimate the final total from the current score and elapsed game time, showing the formula and caveats."
- "Compare this projection to a market total without giving betting advice."
- "Use `project_nba_live_score` for ESPN event 401000000 and include a Kalshi market ticker if one is known."

## More Information

- [DEPLOYMENT.md](DEPLOYMENT.md): Docker tags, state mounts, environment variables, HTTP API, source builds, MCP source setup, historical artifacts, live tracking, upgrades, and validation.
- `src/clients`, `src/tools`, and `src/lib`: ESPN, Kalshi, calculation, validation, and response helpers.
- `src/nba`: NBA-specific MCP bridge code for historical and live score projection.
- `python/nba_historical_projection`: NBA historical projection artifact CLI and model code.
- `docs/nba/reference`: scratch/reference notes and examples for NBA live-total projection ideas.
