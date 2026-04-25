# Sports Projector

Local MCP server for public ESPN sports data, public Kalshi market research, and optional local NBA historical score projection artifacts.

This project is informational research tooling only. It is not betting advice. The ESPN/Kalshi tools use public unauthenticated data. The historical NBA projection tool uses local model artifacts supplied by the operator and does not place orders or manage accounts.

## Install

```bash
npm install
```

Run locally over stdio:

```bash
npm run mcp
```

Build and run compiled output:

```bash
npm run build
npm start
```

## Codex MCP Setup

From this repository:

```bash
codex mcp add sports-projector -- npm run mcp
```

If you want to reference the package from another directory after building or packaging, use the command/path appropriate for your local setup.

## Project Layout

- `src/clients`, `src/tools`, and `src/lib`: general ESPN, Kalshi, calculation, validation, and response helpers.
- `src/nba`: NBA-specific MCP bridge code for local historical score projection.
- `python/nba_historical_projection`: NBA historical projection artifact CLI, feature, model, dataset, and training code.
- `docs/nba/reference`: scratch/reference notes for NBA live-total projection ideas that are not part of the runtime path.

## Tools

### ESPN Public Sports Data

- `get_scoreboard`: fetch ESPN scoreboard data for `nba`, `nfl`, `mlb`, or `nhl`.
- `get_game_summary`: fetch ESPN game summary data by `event_id`.
- `get_team_schedule`: resolve a team name/abbreviation/id and fetch its ESPN schedule.
- `get_standings`: fetch ESPN standings when the public endpoint is available.

Returned ESPN data is normalized to include status, period/quarter/inning, clock, teams, score, linescore where available, venue, broadcasts, source URL, cache status, and caveats.

### Kalshi Public Market Data

- `search_kalshi_markets`: list/search public Kalshi markets.
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

### NBA Historical Projection

- `project_nba_historical_score`: project an NBA matchup score from local historical model artifacts.

The historical projection bridge runs `python -m nba_historical_projection predict` through a safe `execFile` wrapper and passes JSON over stdin/stdout. It expects an artifact directory with `manifest.json`, model files, feature columns, and local team-stat artifacts. Large SQLite/model files are intentionally not included in the npm package.

The first integration is projection-only. It does not expose EV, Kelly sizing, stake sizing, or action recommendations. Live in-game projection is separate future work.

## Example Prompts

- "Use `get_scoreboard` for NBA today and summarize live scores with period and clock."
- "Use `get_game_summary` for this ESPN event id and extract venue, score, and linescore."
- "Find public Kalshi markets about NBA using `search_kalshi_markets`, then inspect one orderbook."
- "Use `get_kalshi_orderbook` and explain the YES bid, implied YES ask, and spread."
- "Estimate the final total from the current score and elapsed game time, showing the formula and caveats."
- "Compare this projection to a market total without giving betting advice."

## Configuration

All configuration is optional.

| Env var | Default | Notes |
| --- | ---: | --- |
| `SPORTS_KALSHI_HTTP_TIMEOUT_MS` | `10000` | Clamped from 1000 to 30000 ms |
| `SPORTS_KALSHI_ESPN_SCOREBOARD_TTL_SECONDS` | `20` | Clamped from 0 to 30 seconds |
| `SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS` | `30` | Clamped from 0 to 60 seconds |
| `SPORTS_KALSHI_KALSHI_TTL_SECONDS` | `10` | Clamped from 0 to 15 seconds |
| `SPORTS_PROJECTOR_HISTORICAL_PYTHON` | `python3` | Python executable used for the historical projection bridge |
| `SPORTS_PROJECTOR_HISTORICAL_ROOT` | current working directory | Project root used to set `PYTHONPATH` for `python/nba_historical_projection` |
| `SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR` | `data/historical` under the root | Local artifact directory containing `manifest.json` and model files |
| `SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS` | `30000` | Clamped from 1000 to 120000 ms |

Historical artifact commands:

```bash
PYTHONPATH=python python3 -m nba_historical_projection inventory-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical --write-state --log-run
PYTHONPATH=python python3 -m nba_historical_projection predict --artifact-dir data/historical < request.json
```

The repository includes a tiny deterministic fixture artifact bundle at
`fixtures/nba-historical-linear` for local validation. It uses `linear_json`
models rather than generated XGBoost artifacts:

```bash
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir fixtures/nba-historical-linear
npm test -- tests/nba-historical.test.ts
```

The local generated state files are:

- `data/historical/artifact_manifest.json`: inventory of local model/team-stat artifacts, feature counts, file sizes, date-table ranges when SQLite team stats are configured, and validation status.
- `data/historical/artifact_import_log.jsonl`: append-only summaries for validation and training runs.

Raw historical NBA backfill is intentionally delegated to the source data project. In `magrhino/NBA-Machine-Learning-Sports-Betting`, use its README-guided commands:

```bash
cd src/Process-Data
python -m Get_Data --backfill
python -m Get_Odds_Data --backfill
python -m Create_Games
```

For a single season:

```bash
cd src/Process-Data
python -m Get_Data --backfill --season 2025-26
python -m Get_Odds_Data --backfill --season 2025-26
python -m Create_Games
```

Current-season refresh in the source project uses the same modules without `--backfill`. `Create_Games` replaces its configured dataset table, so validate the upstream SQLite artifacts before retraining local models from that dataset.

Training historical XGBoost regressors from a prepared SQLite dataset requires Python packages from the adapted historical stack, including `pandas`, `numpy`, and `xgboost`:

```bash
PYTHONPATH=python python3 -m nba_historical_projection train \
  --dataset Data/dataset.sqlite \
  --table dataset_2012-26 \
  --artifact-dir data/historical \
  --season 2012-13 \
  --season 2025-26
```

The training dataset must include numeric `Score` and `Home-Margin` targets. Feature snapshots should contain only information available before game start.

Training writes `manifest.json`, refreshes `artifact_manifest.json`, and appends a `train` event to `artifact_import_log.jsonl`.

## Data Sources and Safety

Allowed network origins:

- `https://site.api.espn.com`
- `https://api.elections.kalshi.com`

v1 builds URLs from known path segments and validated query/path parameters only. User input is not treated as a URL.

Kalshi public endpoints used:

- `https://api.elections.kalshi.com/trade-api/v2/markets`
- `https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}`
- `https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}/orderbook`
- `https://api.elections.kalshi.com/trade-api/v2/markets/trades`

ESPN public endpoints are unofficial and undocumented. They can change or become unavailable without notice.

The historical projection bridge does not fetch network data during MCP prediction. It reads local artifacts only.

## Explicitly Out of Scope for v1

- Kalshi API keys, private keys, OAuth, login cookies, WebSockets, authenticated REST calls, trading, order placement, order cancellation, account balances, portfolio, fills, or positions.
- ESPN auth cookies.
- The Odds API, Sportradar, RapidAPI, or any paid/provider key.
- Automated betting, bet ranking, wager recommendations, dashboards, PostgreSQL, Prisma, background sync jobs, user portfolio concepts, or bet tracking.
- Player props unless they are present in public unauthenticated ESPN/Kalshi data returned by the supported endpoints.

Provider-specific historical backfills are delegated to the source data project. This repo inventories, validates, trains, and serves local historical projection artifacts.

## Development

```bash
npm run build
npm test
PYTHONPATH=python python3 -m unittest discover -s python/tests
```

### Live Public Endpoint Tests

Live ESPN and Kalshi smoke tests are skipped by default so normal CI does not depend on external network availability. To run them explicitly from a network-enabled environment:

```bash
SPORTS_PROJECTOR_LIVE_TESTS=1 npm test -- tests/live-public-endpoints.test.ts
```

These tests make one unauthenticated public request to ESPN and one to Kalshi. They validate client routing, source URLs, and response shape only; they do not assert volatile scores, schedules, prices, or market counts.

## Reference Notes

BetTrack was used only as idea/reference material for prompt style and sports MCP ergonomics. This server does not copy BetTrack architecture and does not include its dashboard, database, odds provider integration, bet tracking, or portfolio concepts.
