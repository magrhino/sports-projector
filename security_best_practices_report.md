# Security Best Practices Report

Date: 2026-04-28

## Executive Summary

No tracked `.env` files, private key files, token files, emails, or local `/Users/...` paths were found in the repository scan. Generated operator data is ignored by git and was not included in `npm pack --dry-run`; however, a local ignored SQLite database exists under `data/live-tracking/`.

The most important issue is a conditional secret disclosure path: if `SPORTS_PROJECTOR_SPORTSDB_API_KEY` is configured with a private key and a scheduled historical refresh fails, the key can be included in Python error text, stored by the Node scheduler, and exposed through the unauthenticated historical refresh status endpoint. The next priorities are reducing unauthenticated operational endpoints, removing absolute paths from public status responses, and adding basic security headers.

## Scope and Methodology

Reviewed the TypeScript/Node HTTP server and MCP tooling, Vite React frontend, Python historical artifact importer, Docker/deployment files, package manifest, public assets, and packaging output. Local guidance loaded for React/general frontend and Express-style JavaScript web server security. No Python-specific reference existed, so Python review used general secret handling, command execution, path, and network-safety checks.

Commands included targeted `rg` scans for secrets/personal identifiers and dangerous sinks, `git status --short --ignored`, `git ls-files`, `npm audit`, `npm audit --omit=dev`, `npm pack --dry-run --cache /tmp/sports-projector-npm-cache`, `npm ls --depth=0`, and focused source reads.

## Positive Observations

- `.gitignore` excludes `.env`, `.env.*`, `data/historical/`, and `data/live-tracking/` at `.gitignore:5-12`.
- No tracked secret-like filenames were found by `git ls-files`.
- `data/live-tracking/nba-live.sqlite` exists locally but is ignored and not tracked.
- `npm pack --dry-run` did not include `data/` or `.env` content.
- `npm audit` and `npm audit --omit=dev` both reported `found 0 vulnerabilities`.
- Server-side outbound HTTP is allowlisted to ESPN and Kalshi in `src/lib/http.ts:3-5` and enforced in `src/lib/http.ts:23-24`.
- User-provided team/event inputs are constrained with zod schemas in `src/lib/validation.ts:60-74`.
- The React app source did not use `dangerouslySetInnerHTML`, `eval`, `localStorage`, `sessionStorage`, or `postMessage`; team logo URLs are limited to `http:` and `https:` in `web/src/format.ts:85-97`.

## Critical / High Findings

### SP-SEC-001: Historical refresh failures can expose private SportsDB API keys

Rule ID: SECRET-001 / backend diagnostic redaction  
Severity: High, Critical if a private key is configured and the status endpoint is internet-reachable

Location:

- `src/nba/historical-refresh.ts:73-80`
- `src/nba/historical-refresh.ts:95-100`
- `src/nba/historical-refresh.ts:149-157`
- `src/nba/historical-refresh.ts:138-140`
- `src/http/historical-refresh.ts:19-22`
- `python/nba_historical_projection/providers/sportsdb.py:107-126`
- `python/nba_historical_projection/cli.py:216-218`

Evidence:

```ts
// src/nba/historical-refresh.ts:78-80
} catch (error) {
  this.lastError = error instanceof Error ? error.message : String(error);
  return false;
}
```

```ts
// src/nba/historical-refresh.ts:149-157
const args = [
  "-m",
  "nba_historical_projection",
  "import-sportsdb",
  "--artifact-dir",
  config.artifactDir,
  "--api-key",
  config.sportsDbApiKey,
```

```python
# python/nba_historical_projection/providers/sportsdb.py:118-126
raise SportsDbError(f"SportsDB request failed with HTTP {exc.code}: {url}") from exc
...
raise SportsDbError(f"SportsDB request failed: {url}: {exc}") from exc
...
raise SportsDbError(f"SportsDB request exhausted retries: {url}")
```

Impact: A remote unauthenticated user who can call `/api/nba/historical-refresh/status` could receive a private SportsDB key after a refresh error, because the key is embedded in the request URL, serialized to stderr by the Python CLI, copied into the Node error, stored as `last_error`, and returned by the status route.

Fix: Redact key-bearing URL path segments and secret-like fields before storing or returning diagnostics. Prefer passing the API key through an environment variable or stdin instead of a command-line argument. Return a generic public error from the status endpoint and keep full sanitized details in server logs only.

Mitigation: Until fixed, set `SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED=false` on any public deployment, or restrict `/api/nba/historical-refresh/status` behind local-only/proxy-auth access.

False positive notes: The default SportsDB key is the public free key `123`; the issue becomes a secret leak when an operator sets `SPORTS_PROJECTOR_SPORTSDB_API_KEY` to a private key.

## Medium Findings

### SP-SEC-002: Status endpoints expose local filesystem paths and operator metadata

Rule ID: INFOLEAK-001  
Severity: Medium

Location:

- `src/nba/live-tracking-store.ts:302-305`
- `src/http/live-tracking.ts:40-49`
- `src/nba/historical-refresh.ts:87-100`
- `python/nba_historical_projection/sportsdb_import.py:346-375`
- `web/src/hooks.ts:324-335`

Evidence:

```ts
// src/nba/live-tracking-store.ts:302-305
return {
  enabled,
  db_path: this.dbPath,
```

```ts
// src/nba/historical-refresh.ts:87-100
return {
  enabled: this.config.enabled,
  ...
  artifact_dir: this.config.artifactDir,
  ...
  last_error: this.lastError,
  last_result: this.lastResult
};
```

```python
# python/nba_historical_projection/sportsdb_import.py:358-375
"dataset": str(dataset_path),
"team_stats": str(team_stats_path),
...
"artifact_dir": str(root),
```

Impact: Public status responses can reveal absolute paths, deployment layout, local usernames if paths are under a home directory, and generated artifact file locations. This is personal/operational metadata leakage even when no credential is present.

Fix: Remove `db_path`, `artifact_dir`, `dataset`, and `team_stats` from public HTTP status bodies. Return coarse statuses such as `configured: true`, `storage: "configured"`, counts, timestamps, and sanitized error codes. Keep exact paths in local CLI output or authenticated admin-only diagnostics.

Mitigation: Bind the service to localhost or require proxy authentication for status routes on deployments where exact paths are considered sensitive.

False positive notes: Docker examples use `/app` and `/data`, which are less personal than `/Users/...`; the code still supports absolute operator-supplied paths.

### SP-SEC-003: Unauthenticated POST endpoint can retrain the live model

Rule ID: STATE-CHANGE-001  
Severity: Medium

Location:

- `src/http/index.ts:69-70`
- `src/http/index.ts:198-210`
- `src/http/live-tracking.ts:52-66`
- `web/src/api.ts:26-30`
- `DEPLOYMENT.md:124-134`

Evidence:

```ts
// src/http/index.ts:69-70
if (url.pathname === "/api/nba/live-model/train") {
  await handleLiveModelTrain(request, response, liveContext);
```

```ts
// src/http/live-tracking.ts:62-66
return {
  status: 200,
  body: context.store.trainLatestModel(context.config.minSnapshots)
};
```

Impact: Anyone who can reach the web app can trigger local model training. Because the endpoint has no authentication, CSRF protection, rate limiting, or operator confirmation, it can be abused for repeated CPU/disk work and can update the locally stored latest model.

Fix: Make training a local CLI/admin-only operation, or require an explicit admin token/proxy-auth guard for this route. Add rate limiting or a simple in-process cooldown. If cookie authentication is later added, add CSRF protection for this POST.

Mitigation: Keep the web service behind localhost/VPN/proxy auth when live tracking is enabled. Disable live tracking on public deployments unless this endpoint is protected.

False positive notes: Risk is much lower if the service is only used locally and never exposed beyond trusted users.

## Low / Hardening Findings

### SP-SEC-004: HTTP server does not set browser security headers

Rule ID: HEADERS-001  
Severity: Low to Medium depending on deployment

Location:

- `src/http/index.ts:246-254`
- `src/http/index.ts:281-290`
- `public/index.html:3-18`

Evidence:

```ts
// src/http/index.ts:281-290
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
```

Impact: There is no app-visible CSP, clickjacking defense, `X-Content-Type-Options`, or referrer policy. The current React source avoids obvious XSS sinks, so this is defense-in-depth rather than an active exploit, but it leaves the app more exposed if a future frontend change introduces a sink.

Fix: Add a common response-header helper for static and API responses. Suggested baseline: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` or `same-origin`, `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'`, and a CSP such as `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'`.

Mitigation: If a reverse proxy/CDN sets these headers, document that and verify with runtime header checks.

False positive notes: Security headers may be managed outside this repository; no such configuration was visible here.

### SP-SEC-005: Runtime Docker image runs as root

Rule ID: CONTAINER-001  
Severity: Low

Location:

- `Dockerfile:13-31`

Evidence:

```dockerfile
FROM node:20-alpine
...
CMD ["npm", "run", "start:web"]
```

Impact: If the app or a dependency is compromised, the process has root privileges inside the container, increasing impact on mounted state under `/data` and any writable container paths.

Fix: Create or use a non-root user in the runtime stage, set ownership on `/app` and mounted data expectations, and add `USER node` or a dedicated app user before `CMD`.

Mitigation: Run the container with a non-root user via orchestrator/runtime flags and mount state with least-privilege permissions.

False positive notes: Container root is not the same as host root, but non-root containers are still a standard hardening control.

### SP-SEC-006: npm package includes server source maps

Rule ID: SOURCEMAP-001  
Severity: Low / Informational

Location:

- `package.json:11-17`
- `tsconfig.json:10-14`

Evidence:

```json
// package.json:11-17
"files": [
  "dist",
  "public",
  ...
]
```

```json
// tsconfig.json:10-14
"outDir": "dist",
"declaration": true,
"sourceMap": true,
```

`npm pack --dry-run --cache /tmp/sports-projector-npm-cache` showed `dist/**/*.js.map` files in the tarball. A scan of `dist/**/*.map` did not find local `/Users/...` paths or secret-like strings.

Impact: Source maps publish source context with the package. If the repository/package is meant to be public, this may be acceptable; if not, source maps can expose implementation details and comments.

Fix: Exclude `dist/**/*.map` from published packages or disable server source maps for release builds if source distribution is not intended.

Mitigation: Continue scanning built artifacts before publishing and avoid writing secrets in source comments.

False positive notes: No private values were found in current source maps.

## Personal / Private Information Scan Results

- No tracked email addresses were found.
- No tracked `/Users/...` or `ryanjones` paths were found.
- No tracked `.env`, `.pem`, `.key`, SQLite, database, token, credential, or password files were found.
- Public project identity strings such as `magrhino` appear in `package.json`, `DEPLOYMENT.md`, fixture metadata, and Python defaults. These appear to be repository/source attribution rather than credentials. If that handle is personal and should not be public, scrub it from package metadata and docs.
- Test files intentionally include fake secret strings to verify redaction behavior; these were treated as test sentinels, not real leaks.
- Ignored local generated state exists under `data/` and should not be copied into public artifacts outside git/npm flows.

## Recommended Fix Order

1. Fix `SP-SEC-001` first: redact historical refresh errors and stop passing private API keys via command-line arguments.
2. Fix `SP-SEC-002` with a public-safe status DTO for live tracking and historical refresh endpoints.
3. Protect or remove `POST /api/nba/live-model/train` for public deployments.
4. Add common browser security headers.
5. Harden Docker with a non-root runtime user.
6. Decide whether published npm packages should include server source maps.

## Validation Notes

- `npm audit --omit=dev`: passed, `found 0 vulnerabilities`.
- `npm audit`: passed, `found 0 vulnerabilities`.
- `npm pack --dry-run --cache /tmp/sports-projector-npm-cache`: passed; package excludes ignored `data/` and includes `dist/**/*.js.map`.
- No application tests were run because this was a review/report task and no production code was changed.
