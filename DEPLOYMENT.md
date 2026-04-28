# Deployment

This is the deployment reference for running Sports Projector as a local MCP server or as the minimal read-only web app. For the GHCR quick start and tool examples, see the [README](README.md).

Sports Projector is informational research tooling only. It uses public unauthenticated ESPN and Kalshi endpoints, plus optional local NBA historical artifacts supplied by the operator. It does not place trades, manage accounts, or provide betting advice.

## Docker

Build and run the web app from this repository:

```bash
docker build -t sports-projector:local .
docker run -d \
  --name sports-projector \
  -p 8080:8080 \
  -e PORT=8080 \
  sports-projector:local
```

The frontend and HTTP API are served from `http://localhost:8080`.

Release images are published to GitHub Container Registry when a GitHub release is created:

```bash
docker pull ghcr.io/magrhino/sports-projector:v1.0.0
docker run -d \
  --name sports-projector \
  -p 8080:8080 \
  -e PORT=8080 \
  ghcr.io/magrhino/sports-projector:v1.0.0
```

Use the exact `vX.Y.Z` release tag for reproducible production deploys. The image is also tagged with the bare SemVer version, major/minor, major, and `latest`.

For a quick GHCR-based run:

```bash
docker run --rm \
  -p 8080:8080 \
  -e PORT=8080 \
  ghcr.io/magrhino/sports-projector:latest
```

### Release automation

Releases are managed by GitHub Actions and release-please from Conventional Commit messages on `main`. The release workflow validates the candidate with the Node build, TypeScript tests, Python tests, and a Docker build before it can create a GitHub release or publish an image.

Configure the repository before enabling the workflow:

- Add a `RELEASE_PLEASE_TOKEN` repository secret. Use a fine-grained PAT or equivalent token that can read and write repository contents, create releases and tags, and create or update pull requests.
- In GitHub Actions settings, allow workflows to create pull requests so release-please can maintain the release PR.
- The first release is bootstrapped as `v1.0.0` until that tag exists. After `v1.0.0`, release-please follows normal SemVer from Conventional Commit names.

### Container state

The default image is suitable for the web app and live projection endpoints. If live tracking is enabled, mount persistent storage for the SQLite database:

```bash
docker run -d \
  --name sports-projector \
  -p 8080:8080 \
  -e PORT=8080 \
  -e SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED=true \
  -e SPORTS_PROJECTOR_LIVE_DB_PATH=/data/live-tracking/nba-live.sqlite \
  -v /path/to/sports-projector-data:/data \
  ghcr.io/magrhino/sports-projector:v1.0.0
```

Historical projection from Docker requires a mounted artifact directory. The stock Dockerfile includes Python and the projection package, but generated historical artifacts remain operator-managed state and must be mounted separately.

## Docker Compose

```yaml
services:
  sports-projector-web:
    build: .
    ports:
      - 8080:8080
    environment:
      PORT: "8080"
      SPORTS_PROJECTOR_HISTORICAL_ROOT: /app
      SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR: /data/historical
      SPORTS_PROJECTOR_HISTORICAL_PYTHON: python3
      SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED: "true"
      SPORTS_PROJECTOR_LIVE_DB_PATH: /data/live-tracking/nba-live.sqlite
    volumes:
      - ./data:/data
    restart: unless-stopped
```

Run it with:

```bash
docker compose up --build -d
```

## Node service

Install dependencies, build the server and frontend, then run the compiled web app:

```bash
npm install
npm run build
PORT=8080 npm run start:web
```

The built web server reads static files from `public/` by default. Override this only when you intentionally serve a different built asset directory:

```bash
SPORTS_PROJECTOR_PUBLIC_DIR=/srv/sports-projector/public PORT=8080 npm run start:web
```

For process managers such as systemd, PM2, or launchd, use `npm run start:web` after `npm run build`, set the environment variables below, and run from the project root unless you also set the historical root explicitly.

## MCP server

For local MCP usage over stdio:

```bash
npm install
npm run build
npm start
```

Register the repository with Codex from the project root:

```bash
codex mcp add sports-projector -- npm run mcp
```

For installed package usage, point the MCP client at the built package command or at `node dist/index.js` in the deployment directory.

To run MCP directly from the GHCR image:

```bash
codex mcp add sports-projector -- docker run -i --rm ghcr.io/magrhino/sports-projector:latest node dist/index.js
```

## HTTP API

The web service exposes projection/status endpoints plus protected local administration endpoints:

```bash
curl "http://localhost:8080/api/games/search?team=Celtics&league=nba"
curl "http://localhost:8080/api/games/live?league=nba"
curl "http://localhost:8080/api/nba/projections?event_id=401000000&scope=live"
curl "http://localhost:8080/api/nba/live-tracking/status"
curl "http://localhost:8080/api/nba/historical-refresh/status"
curl "http://localhost:8080/api/settings"
curl -X POST -H "X-Sports-Projector-Action: train-live-model" "http://localhost:8080/api/nba/live-model/train"
curl -X PATCH -H "Content-Type: application/json" -d '{"live_enhancements_enabled":false}' "http://localhost:8080/api/settings"
```

Use `scope=live` when the deployment does not have Python historical artifacts available. Use `scope=all` only when historical projection is configured.

## Historical artifacts

Historical projection reads local artifacts only. A production artifact directory must contain a valid `manifest.json`, model files, feature defaults, and any configured local team-stat data.

Build or validate artifacts from a source checkout:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical --write-state --log-run
PYTHONPATH=python python3 -m nba_historical_projection inventory-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection evaluate --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection predict --artifact-dir data/historical < request.json
```

The repository includes a tiny deterministic fixture artifact bundle at `fixtures/nba-historical-linear` for local validation. It uses `linear_json` models rather than generated XGBoost artifacts:

```bash
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir fixtures/nba-historical-linear
npm test -- tests/nba-historical.test.ts
```

The local generated state files are:

- `data/historical/artifact_manifest.json`: inventory of local model/team-stat artifacts, feature counts, file sizes, date-table ranges when SQLite team stats are configured, and validation status.
- `data/historical/artifact_import_log.jsonl`: append-only summaries for validation and training runs.

SportsDB v1 NBA import writes raw provider payloads, normalized SQLite training/team-stat snapshots, `linear_json` score models, `manifest.json`, `artifact_manifest.json`, and an import log entry. The default free SportsDB API key is `123`; override it with `--api-key` when using a private key. The importer defaults to NBA league id `4387`, the current NBA season plus the previous five seasons, and a 30 requests/minute limiter. The default season window is calendar-derived so stale SportsDB season-list samples do not cause old historical imports. Imports supplement season payloads with recent day events, upcoming day snapshots, and each team's latest event because some SportsDB season responses are capped or stale.

To force a known SportsDB event into the artifacts:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb \
  --artifact-dir data/historical \
  --event-id 2467180
```

To pin seasons explicitly:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb \
  --artifact-dir data/historical \
  --season 2024-2025 \
  --season 2025-2026
```

SportsDB import is intentionally present-day weighted by default. Use `--lookback-seasons` to widen or narrow the rolling history, and `--recent-days` / `--lookahead-days` to adjust the current refresh window. The importer uses only pregame features derived from prior completed games for each training row; future scheduled games can create prediction snapshot tables but are excluded from model targets until scores are available.

Optional local CSVs can enrich the offline artifacts without adding live network origins:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb \
  --artifact-dir data/historical \
  --market-lines-csv market_lines.csv \
  --availability-csv availability.csv \
  --model-kind auto \
  --validation-splits 3
```

`market_lines.csv` should include `game_date` or `date`, `home_team`, `away_team`, and any of `closing_total`, `closing_spread`, `opening_total`, or `opening_spread`. `availability.csv` should include `date`, `team`, and optional `unavailable_minutes` / `unavailable_value` aggregates. When closing market lines are present, training can select market-residual models and stores rolling-origin validation metrics plus calibrated 68/80/90 percent residual intervals in `manifest.json`.

Optional calibrated historical artifacts are additive to the existing score and margin projections. Scheduled web refreshes enable calibrated probabilities, residual quantiles, market-derived team ratings, score-based team skills, and experimental market diagnostics by default through the server settings file. When running the importer manually with local market lines, use:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb \
  --artifact-dir data/historical \
  --market-lines-csv market_lines.csv \
  --model-kind auto \
  --calibration auto \
  --quantiles 0.05,0.10,0.25,0.50,0.75,0.90,0.95 \
  --rating-features market \
  --rating-line-source close \
  --skill-features score-based \
  --experimental-market-decorrelation
```

The deployed prediction bridge automatically reads these sections from `manifest.json` when present. Requests that include `market_total` or `market_spread` can return calibrated over/under and cover probabilities, ordered total and margin quantiles, median fields, and market-comparison diagnostics. Treat these outputs as uncertainty summaries for research, not guaranteed outcomes or betting advice.

Calibration uses rolling-origin out-of-fold predictions to report Brier score, log-loss, expected calibration error, and reliability bins for totals and spreads. Prediction output includes bounded probabilities such as over/under market total, home/away cover, and home win when enough artifact metadata or residual uncertainty is available.

Quantile artifacts use empirical rolling-origin residual quantiles by default, so they do not require extra Python dependencies. Prediction output can include ordered total and home-margin quantiles plus median fields. Treat the intervals and probabilities as uncertainty summaries, not guaranteed outcomes or betting advice.

Market-rating features derive prior team-strength signals from available opening or closing market lines. Score-skill features derive prior offensive and defensive strength from completed scores. Both are computed online before each training row is emitted, then updated only after the game result is consumed.

Use `evaluate` to compare before/after runs from the same rolling-origin split. Trust calibration metrics, interval coverage, and pinball loss alongside RMSE/MAE; market-decorrelation and closing-line-value diagnostics are experimental and are not default selection criteria.

Training historical XGBoost regressors from a prepared SQLite dataset requires Python packages from the adapted historical stack, including `pandas`, `numpy`, and `xgboost`:

```bash
PYTHONPATH=python python3 -m nba_historical_projection train \
  --dataset Data/dataset.sqlite \
  --table dataset_2012-26 \
  --artifact-dir data/historical \
  --season 2012-13 \
  --season 2025-26 \
  --model-kind auto \
  --early-stopping-rounds 25 \
  --validation-splits 3
```

The training dataset must include numeric `Score` and `Home-Margin` targets. Market-residual training, calibration, and market comparisons require market total/spread columns such as `MARKET_TOTAL_CLOSE`, `MARKET_SPREAD_CLOSE`, opening lines, and line moves. Feature snapshots should contain only information available before game start. Closing lines are appropriate only for a closing-line pregame prediction scenario; otherwise use opening lines or caller-provided market inputs.

Training writes `manifest.json` with numeric median feature defaults, refreshes `artifact_manifest.json`, and appends a `train` event to `artifact_import_log.jsonl`.

Research-paper mapping:

- Walsh/Joshi: calibration-first reliability metrics and probability outputs.
- Hubacek/Sir: explicit, opt-in market-decorrelation/value-signal diagnostics.
- Dmochowski: quantile summaries and uncertainty-aware edge status.
- Wunderlich/Memmert: market-implied team rating features from prior odds/lines.
- Guo/Sanner/Graepel/Buntine: online score-based offensive and defensive skill features.

Configure the Node service to use the artifact directory:

```bash
SPORTS_PROJECTOR_HISTORICAL_ROOT=/srv/sports-projector \
SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR=/srv/sports-projector/data/historical \
SPORTS_PROJECTOR_HISTORICAL_PYTHON=python3 \
npm run start:web
```

The historical bridge runs `python -m nba_historical_projection predict` with JSON over stdin/stdout. It does not fetch network data during prediction.

## Live tracking

Live tracking is disabled by default. When enabled, the web app polls live NBA games, stores projection snapshots in SQLite, and automatically trains a local correction model after enough finalized snapshots exist. Auto-training runs at startup and then on the configured interval, skipping runs when the latest model already covers the available trainable snapshots.

```bash
SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED=true \
SPORTS_PROJECTOR_LIVE_DB_PATH=data/live-tracking/nba-live.sqlite \
npm run start:web
```

Training can also be triggered through the API from a loopback client:

```bash
curl -X POST -H "X-Sports-Projector-Action: train-live-model" "http://localhost:8080/api/nba/live-model/train"
```

Train the local live correction model from a source checkout after enough finalized snapshots have been collected:

```bash
npm run train:live
```

For protected remote administration, set `SPORTS_PROJECTOR_LIVE_MODEL_TRAIN_TOKEN` and send the same value in `X-Sports-Projector-Admin-Token` through an authenticated proxy or admin client.

Back up `SPORTS_PROJECTOR_LIVE_DB_PATH` before moving or replacing a production deployment if you want to preserve collected snapshots and trained live models.

## Historical refresh

The web process refreshes SportsDB historical artifacts by default. Enhanced historical snapshots are enabled by default in `data/settings.json`; disable that setting through the web settings view or `PATCH /api/settings` if you need the simpler baseline importer flags. Disable the scheduler itself if artifacts are managed by cron, systemd, or another operator workflow:

```bash
SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED=false \
npm run start:web
```

The scheduler runs `python -m nba_historical_projection import-sportsdb`, skips overlapping runs, and exposes status at:

```bash
curl "http://localhost:8080/api/nba/historical-refresh/status"
```

For external scheduling, disable the in-process scheduler and run `PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb --artifact-dir data/historical` from cron or systemd on the desired interval.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP web app port |
| `SPORTS_PROJECTOR_PUBLIC_DIR` | `public` | Static asset directory for the web server |
| `SPORTS_PROJECTOR_SETTINGS_PATH` | `data/settings.json` under the root | JSON settings file for enhancement toggles and live auto-training interval |
| `SPORTS_KALSHI_HTTP_TIMEOUT_MS` | `10000` | Public HTTP request timeout, clamped from 1000 to 30000 ms |
| `SPORTS_KALSHI_ESPN_SCOREBOARD_TTL_SECONDS` | `20` | ESPN scoreboard cache TTL, clamped from 0 to 30 seconds |
| `SPORTS_KALSHI_ESPN_DETAIL_TTL_SECONDS` | `30` | ESPN detail cache TTL, clamped from 0 to 60 seconds |
| `SPORTS_KALSHI_KALSHI_TTL_SECONDS` | `10` | Kalshi public API cache TTL, clamped from 0 to 15 seconds |
| `SPORTS_PROJECTOR_HISTORICAL_PYTHON` | `python3` | Python executable used by the historical projection bridge |
| `SPORTS_PROJECTOR_HISTORICAL_ROOT` | current working directory | Project root used to set `PYTHONPATH` for historical projection |
| `SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR` | `data/historical` under the root | Artifact directory containing `manifest.json` and model files |
| `SPORTS_PROJECTOR_HISTORICAL_TIMEOUT_MS` | `30000` | Historical command timeout, clamped from 1000 to 120000 ms |
| `SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED` | `true` | Enables scheduled SportsDB historical artifact refreshes |
| `SPORTS_PROJECTOR_HISTORICAL_REFRESH_INTERVAL_SECONDS` | `3600` | Historical refresh interval, clamped from 60 to 86400 seconds |
| `SPORTS_PROJECTOR_HISTORICAL_REFRESH_RECENT_DAYS` | `3` | Past day window included in scheduled imports |
| `SPORTS_PROJECTOR_HISTORICAL_REFRESH_LOOKAHEAD_DAYS` | `2` | Future day window included for prediction snapshots |
| `SPORTS_PROJECTOR_HISTORICAL_REFRESH_EVENT_IDS` | empty | Comma-separated SportsDB event IDs to force into scheduled imports |
| `SPORTS_PROJECTOR_SPORTSDB_API_KEY` | `123` | SportsDB API key for scheduled historical refreshes |
| `SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED` | `false` | Enables NBA live-game polling and snapshot persistence |
| `SPORTS_PROJECTOR_LIVE_DB_PATH` | `data/live-tracking/nba-live.sqlite` | SQLite path for live snapshots and trained models |
| `SPORTS_PROJECTOR_LIVE_TRACKING_INTERVAL_SECONDS` | `30` | Tracker polling interval, clamped from 5 to 300 seconds |
| `SPORTS_PROJECTOR_LIVE_TRACKING_CONCURRENCY` | `2` | Concurrent live event projections, clamped from 1 to 8 |
| `SPORTS_PROJECTOR_LIVE_MODEL_MIN_SNAPSHOTS` | `50` | Minimum finalized snapshots required to train the live correction model |
| `SPORTS_PROJECTOR_LIVE_MODEL_TRAIN_TOKEN` | empty | Optional admin token for protected remote live-model training requests |

## Network access

Production deployments should allow outbound HTTPS to:

| Origin | Used for |
|--------|----------|
| `https://site.api.espn.com` | Public scoreboard, schedule, summary, and standings data |
| `https://api.elections.kalshi.com` | Public Kalshi market, orderbook, trade, event, milestone, and live-data endpoints |
| `https://www.thesportsdb.com` | Historical import command and default scheduled historical refresh |

User input is validated as path/query data, not treated as arbitrary URLs.

Kalshi public endpoints used:

- `https://api.elections.kalshi.com/trade-api/v2/markets`
- `https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}`
- `https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}/orderbook`
- `https://api.elections.kalshi.com/trade-api/v2/markets/trades`
- `https://api.elections.kalshi.com/trade-api/v2/events/{event_ticker}`
- `https://api.elections.kalshi.com/trade-api/v2/milestones`
- `https://api.elections.kalshi.com/trade-api/v2/live_data/milestone/{milestone_id}`
- `https://api.elections.kalshi.com/trade-api/v2/live_data/milestone/{milestone_id}/game_stats`

ESPN public endpoints are unofficial and undocumented. They can change or become unavailable without notice.

The historical projection bridge does not fetch network data during MCP prediction. It reads local artifacts only.

## Scope boundaries

Explicitly out of scope for v1:

- Kalshi API keys, private keys, OAuth, login cookies, WebSockets, authenticated REST calls, trading, order placement, order cancellation, account balances, portfolio, fills, or positions.
- ESPN auth cookies.
- The Odds API, Sportradar, RapidAPI, or any paid/provider key.
- Automated betting, bet ranking, wager recommendations, dashboards, PostgreSQL, Prisma, background sync jobs, user portfolio concepts, or bet tracking.
- Player props unless they are present in public unauthenticated ESPN/Kalshi data returned by the supported endpoints.

Provider-specific historical backfills are delegated to the source data project. This repo inventories, validates, trains, and serves local historical projection artifacts.

## Upgrading

For source deployments:

```bash
git pull
npm install
npm run build
npm test
PYTHONPATH=python python3 -m unittest discover -s python/tests
```

Then restart the MCP or web process.

For Docker deployments, rebuild and restart:

```bash
docker compose up --build -d
```

Preserve mounted `data/` directories when upgrading. Generated historical artifacts under `data/historical/` and live tracking state under `data/live-tracking/` are operator-managed and should not be committed.

## Validation

After deployment, check the web app:

```bash
curl "http://localhost:8080/api/games/search?team=Celtics&league=nba"
curl "http://localhost:8080/api/nba/live-tracking/status"
```

If historical artifacts are configured:

```bash
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical
```

For a full local verification before release:

```bash
npm run build
npm test
PYTHONPATH=python python3 -m unittest discover -s python/tests
```

Live ESPN and Kalshi smoke tests are skipped by default so normal CI does not depend on external network availability. To run them explicitly from a network-enabled environment:

```bash
SPORTS_PROJECTOR_LIVE_TESTS=1 npm test -- tests/live-public-endpoints.test.ts
```

These tests make unauthenticated public requests to a small ESPN endpoint matrix for supported NBA/NFL/MLB/NHL scoreboard, teams, and specific-team endpoints, plus one Kalshi markets request. They validate endpoint health, client routing, source URLs, and stable top-level response shape only; they do not assert volatile scores, schedules, prices, or market counts.

## Reference notes

BetTrack was used only as idea/reference material for prompt style and sports MCP ergonomics. This server does not copy BetTrack architecture and does not include its dashboard, database, odds provider integration, bet tracking, or portfolio concepts.
