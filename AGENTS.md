# AGENTS.md

## Scope

Repo-local routing/context only. Do not repeat global Codex instructions. Global instructions control default behavior, commits, security, validation, and final response format unless this file gives a more specific repo-local rule.

## Init protocol

When asked to initialize, `/init`, personalize, or complete this file:

- Inspect the repo only enough to replace initialization placeholders below.
- Prefer targeted commands: `pwd`, `git status --short`, `find`/`ls`, `rg --files`, package/config manifests, README, CONTRIBUTING, existing tests, and nearest examples.
- Do not read vendored deps, generated output, build artifacts, coverage, caches, binary assets, lockfiles, snapshots, or large data files unless required to identify commands.
- Do not duplicate global policies on commits, security, validation, or final response format.
- Preserve this file as a compact routing index, not a prose guide.
- Replace every initialization placeholder with repo-specific facts.
- Delete sections that do not apply.
- Keep `Path map` and `Repo commands` accurate over exhaustive.
- Keep each local summary under 40 words.
- Keep this file preferably under 12 KiB; hard max 24 KiB.
- If deeper context is useful, create or reference small files under `docs/agents/` instead of expanding this file.
- After updating, report:
  - files inspected
  - sections changed
  - unknowns left as placeholders
  - suggested nested `AGENTS.md` files, if any

Recommended init discovery order:

1. Identify project root and package/build manifests.
2. Identify major source, test, config, docs, scripts, and generated paths.
3. Identify install, lint, typecheck, test, build, and targeted-test commands from manifests/docs.
4. Identify framework/language conventions from nearby files.
5. Fill path map, task routing, invariants, commands, validation selection, and summaries.
6. Confirm no initialization placeholders remain.

## Context budget

- Start with `Path map`; read only rows relevant to the task.
- Prefer `rg`, targeted file reads, manifest reads, and nearby examples.
- Open linked files under `docs/agents/` only when the task matches their trigger.
- If editing a path with a nested `AGENTS.md`, read that file before editing.
- Avoid broad tree reads.

## Path map

| Path | Purpose | Read first | Edit notes | Avoid unless required |
|---|---|---|---|---|
| `src/index.ts`, `src/mcp/` | MCP stdio entrypoint and tool registration | `src/mcp/server.ts`, `tests/mcp-server-tools.test.ts` | Keep documented tool names aligned with README/tests. | `dist/` |
| `src/clients/` | Public ESPN and Kalshi HTTP clients | Client file, `src/lib/http.ts`, URL validation tests | Build URLs from validated path/query parts only. | Live network tests unless requested |
| `src/tools/` | General MCP tools for ESPN, Kalshi, and calculations | Owning tool file plus matching `tests/*.test.ts` | Preserve read-only research semantics and caveats. | Unrelated tool families |
| `src/nba/` | NBA live and historical TypeScript bridge/tools | Owning `src/nba/*.ts`, relevant NBA tests | Historical bridge shells to Python via configured executable. | Local operator artifacts |
| `src/http/` | Minimal HTTP API and static web app server | Owning handler plus `tests/http-*.test.ts` or route-specific tests | Keep API routes read-only and static file path safety intact. | Live public endpoint tests unless requested |
| `web/`, `public/` | Vite React frontend source and generated static assets | `web/src/App.tsx`, route API contract, `web/vite.config.ts` | Build output writes to `public/`; avoid hand-editing generated asset files. | `public/assets/` unless debugging deploy output |
| `src/lib/` | Shared cache, HTTP, response, validation helpers | Owning helper and direct callers | Shared behavior; run focused tests for consumers. | Broad rewrites |
| `python/nba_historical_projection/` | Historical projection artifact CLI, dataset, features, models, training | Owning module and `python/tests/test_nba_historical_projection.py` | Use `PYTHONPATH=python`; generated state belongs in artifact dirs. | External source datasets |
| `tests/`, `python/tests/` | Vitest and unittest coverage | Nearest matching test | Prefer focused additions for changed behavior. | Snapshots/fixtures unrelated to change |
| `fixtures/nba-historical-linear/` | Tiny deterministic historical model fixture | `manifest.json` only if fixture behavior changes | Keep fixture small and packageable. | Large model/data artifacts |
| `README.md`, `docs/nba/reference/` | User docs and NBA reference notes | Relevant section only | README documents public tool contract and commands. | Reference scratch files unless task matches |
| `Dockerfile`, `docker-compose.yml`, `DEPLOYMENT.md` | Web app container and deployment documentation | Exact deploy surface being changed | Docker image runs `npm run start:web` on `PORT`; document state mounts explicitly. | Registry/release assumptions not present in repo |
| `package.json`, `tsconfig.json`, `.gitignore` | Node package, TypeScript build, ignored/generated paths | Exact config being changed | Package uses npm, NodeNext ESM, Node >=18.17. | Lockfile unless dependency work requires it |

## Task routing

- MCP server/tool registration: inspect `src/mcp/server.ts`, the owning `src/tools/` or `src/nba/` module, README tool docs, and `tests/mcp-server-tools.test.ts`.
- ESPN/Kalshi behavior: inspect the owning `src/clients/` file, related `src/tools/` wrapper, `src/lib/validation.ts`, and focused tests.
- Calculation behavior: inspect `src/tools/calculations.ts` and `tests/calculations.test.ts`.
- NBA live projection: inspect `src/nba/live-projection.ts`, `src/nba/live-tool.ts`, ESPN/Kalshi clients if touched, and `tests/nba-live-projection.test.ts`.
- NBA historical TypeScript bridge: inspect `src/nba/historical-client.ts`, `src/nba/historical-tool.ts`, fixture manifest, and `tests/nba-historical.test.ts`.
- Python historical CLI/model behavior: inspect owning `python/nba_historical_projection/` module and `python/tests/test_nba_historical_projection.py`.
- HTTP API/web deployment: inspect `src/http/index.ts`, route owner, `web/` if UI behavior changes, Docker files if container behavior changes, and focused `tests/http-*.test.ts`.
- Config/build/CI behavior: inspect exact changed config plus command/workflow that consumes it.
- Test-only work: inspect target behavior and nearest existing test style; avoid production edits unless needed.
- Docs-only work: inspect relevant doc plus source only if verifying behavior.
- Bug fix: inspect reproduction path, failing or missing test, owning module, and nearby similar fixes.

## Key invariants

- MCP tools are read-only informational research; do not add trading, auth, portfolio, bet ranking, or betting advice behavior.
- Public network access is limited to ESPN and Kalshi public unauthenticated endpoints assembled from validated components.
- Historical NBA prediction reads local artifact directories only; generated `data/historical/` state is operator-managed and not packaged.
- TypeScript is strict NodeNext ESM; source imports use `.js` extensions for emitted runtime paths.

## Repo commands

| Purpose | Command |
|---|---|
| install | `npm install` |
| lint | Not defined in `package.json` |
| typecheck | `npm run build` |
| unit tests | `npm test` |
| targeted TS test | `npm test -- tests/<name>.test.ts` |
| targeted Python test | `PYTHONPATH=python python3 -m unittest python.tests.test_nba_historical_projection` |
| Python test suite | `PYTHONPATH=python python3 -m unittest discover -s python/tests` |
| MCP dev server | `npm run mcp` |
| web dev server | `npm run web` |
| web Docker run | `docker compose up --build` |
| build | `npm run build` |
| format check | Not defined in `package.json` |

## Validation selection

- Source change: run targeted test first, then lint/typecheck/build if practical.
- UI change: run targeted component/UI test if present; otherwise lint/typecheck.
- Server/API change: run targeted unit/integration test covering changed route/service.
- Data/query change: run focused data/model/query tests; avoid schema changes unless requested.
- Config/CI change: run smallest command validating changed config.
- Docs-only change: no tests required unless docs are generated or validated.
- Unknown command: inspect manifests/docs; do not invent commands.

## Local summaries

Keep each under 40 words. Summaries are for routing, not documentation.

- `src/clients`: Public ESPN/Kalshi HTTP clients with TTL/cache and URL safety helpers.
- `src/tools`: MCP tool wrappers for ESPN, Kalshi, and transparent calculation helpers.
- `src/nba`: NBA-specific live projection logic and Python historical bridge.
- `src/http`: Read-only HTTP API, NBA projection endpoints, live tracking status/training endpoints, and static asset serving.
- `web`: Vite React frontend for searching games and viewing projections; builds static output into `public/`.
- `src/lib`: Shared cache, HTTP, response, and validation utilities.
- `tests`: Vitest coverage for TypeScript tools, clients, normalization, cache, validation, and projections.
- `python/nba_historical_projection`: Python CLI and model/artifact code for local NBA historical projections.
- `python/tests`: unittest coverage for Python artifact validation, CLI, dataset, and prediction contracts.
- `fixtures/nba-historical-linear`: Small linear-model fixture used by historical projection tests.

## Generated/low-value paths

Do not read or edit unless directly required.

- `node_modules/`
- `dist/`
- `coverage/`
- `.env`, `.env.*`
- `__pycache__/`, `*.py[cod]`
- `data/historical/`
- `package-lock.json` unless dependency changes require it

## Nested AGENTS suggestions

During initialization, add suggested nested files here if local rules would materially reduce context.

| Path | Why nested guidance may help |
|---|---|
| `src/nba/` | Add only if live and historical projection rules diverge enough to need local guidance. |
| `python/nba_historical_projection/` | Add only if Python artifact/training workflows grow more specialized. |

## Edit discipline

- Identify owning path from `Path map` before editing.
- Read nearest implementation and test examples first.
- Make the smallest correct change.
- Do not normalize formatting outside touched lines.
- Do not move code across directories unless requested.
- If multiple areas are touched, re-check whether nested `AGENTS.md` files apply.
