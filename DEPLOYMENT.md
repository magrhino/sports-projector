# Deployment

This is the production reference for running Sports Projector as a local MCP server or as the minimal read-only web app. For local development and tool examples, see the [README](README.md).

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

## HTTP API

The web service exposes read-only endpoints:

```bash
curl "http://localhost:8080/api/games/search?team=Celtics&league=nba"
curl "http://localhost:8080/api/games/live?league=nba"
curl "http://localhost:8080/api/nba/projections?event_id=401000000&scope=live"
curl "http://localhost:8080/api/nba/live-tracking/status"
curl -X POST -H "X-Sports-Projector-Action: train-live-model" "http://localhost:8080/api/nba/live-model/train"
```

Use `scope=live` when the deployment does not have Python historical artifacts available. Use `scope=all` only when historical projection is configured.

## Historical artifacts

Historical projection reads local artifacts only. A production artifact directory must contain a valid `manifest.json`, model files, feature defaults, and any configured local team-stat data.

Build or validate artifacts from a source checkout:

```bash
PYTHONPATH=python python3 -m nba_historical_projection import-sportsdb --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection validate-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection inventory-artifacts --artifact-dir data/historical
PYTHONPATH=python python3 -m nba_historical_projection evaluate --artifact-dir data/historical
```

Optional calibrated historical artifacts are additive to the existing score and margin projections. When local market lines are available, enable calibrated probabilities, residual quantiles, market-derived team ratings, score-based team skills, and experimental market diagnostics during artifact refresh:

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

Configure the Node service to use the artifact directory:

```bash
SPORTS_PROJECTOR_HISTORICAL_ROOT=/srv/sports-projector \
SPORTS_PROJECTOR_HISTORICAL_ARTIFACT_DIR=/srv/sports-projector/data/historical \
SPORTS_PROJECTOR_HISTORICAL_PYTHON=python3 \
npm run start:web
```

The historical bridge runs `python -m nba_historical_projection predict` with JSON over stdin/stdout. It does not fetch network data during prediction.

## Live tracking

Live tracking is disabled by default. When enabled, the web app polls live NBA games, stores projection snapshots in SQLite, and can train a local correction model after finalized snapshots exist.

```bash
SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED=true \
SPORTS_PROJECTOR_LIVE_DB_PATH=data/live-tracking/nba-live.sqlite \
npm run start:web
```

Training can be triggered through the API from a loopback client:

```bash
curl -X POST -H "X-Sports-Projector-Action: train-live-model" "http://localhost:8080/api/nba/live-model/train"
```

For protected remote administration, set `SPORTS_PROJECTOR_LIVE_MODEL_TRAIN_TOKEN` and send the same value in `X-Sports-Projector-Admin-Token` through an authenticated proxy or admin client.

Back up `SPORTS_PROJECTOR_LIVE_DB_PATH` before moving or replacing a production deployment if you want to preserve collected snapshots and trained live models.

## Historical refresh

The web process refreshes SportsDB historical artifacts by default. Disable this if artifacts are managed by cron, systemd, or another operator workflow:

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
