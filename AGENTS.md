# AGENTS.md

## Scope

Repo-local routing/context only. Do not repeat global Codex instructions. Global instructions control default behavior, commits, security, validation, and final response format unless this file gives a more specific repo-local rule.

## Init protocol

When asked to initialize, `/init`, personalize, or complete this file:

- Inspect the repo only enough to replace `TODO_INIT` values below.
- Prefer targeted commands: `pwd`, `git status --short`, `find`/`ls`, `rg --files`, package/config manifests, README, CONTRIBUTING, existing tests, and nearest examples.
- Do not read vendored deps, generated output, build artifacts, coverage, caches, binary assets, lockfiles, snapshots, or large data files unless required to identify commands.
- Do not duplicate global policies on commits, security, validation, or final response format.
- Preserve this file as a compact routing index, not a prose guide.
- Replace every `TODO_INIT` with repo-specific facts.
- Delete sections that do not apply.
- Keep `Path map` and `Repo commands` accurate over exhaustive.
- Keep each local summary under 40 words.
- Keep this file preferably under 12 KiB; hard max 24 KiB.
- If deeper context is useful, create or reference small files under `docs/agents/` instead of expanding this file.
- After updating, report:
  - files inspected
  - sections changed
  - unknowns left as `TODO_INIT`
  - suggested nested `AGENTS.md` files, if any

Recommended init discovery order:

1. Identify project root and package/build manifests.
2. Identify major source, test, config, docs, scripts, and generated paths.
3. Identify install, lint, typecheck, test, build, and targeted-test commands from manifests/docs.
4. Identify framework/language conventions from nearby files.
5. Fill path map, task routing, invariants, commands, validation selection, and summaries.
6. Remove this sentence after successful initialization: `TODO_INIT: file has not been personalized yet`.

TODO_INIT: file has not been personalized yet.

## Context budget

- Start with `Path map`; read only rows relevant to the task.
- Prefer `rg`, targeted file reads, manifest reads, and nearby examples.
- Open linked files under `docs/agents/` only when the task matches their trigger.
- If editing a path with a nested `AGENTS.md`, read that file before editing.
- Avoid broad tree reads.

## Path map

| Path | Purpose | Read first | Edit notes | Avoid unless required |
|---|---|---|---|---|
| `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` |
| `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` |
| `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` | `TODO_INIT` |

## Task routing

- API/server behavior: inspect `TODO_INIT`, called service/module, validation/schema, and matching tests.
- UI/client behavior: inspect `TODO_INIT`, nearest component, direct caller/callee if needed, style pattern, and matching tests/stories.
- DB/data behavior: inspect `TODO_INIT`, query/model, callers, migration policy, and focused tests.
- CLI/script behavior: inspect `TODO_INIT`, entrypoint, caller, README/docs reference, and tests.
- Config/build/CI behavior: inspect exact changed config plus command/workflow that consumes it.
- Test-only work: inspect target behavior and nearest existing test style; avoid production edits unless needed.
- Docs-only work: inspect relevant doc plus source only if verifying behavior.
- Bug fix: inspect reproduction path, failing or missing test, owning module, and nearby similar fixes.

## Key invariants

- `TODO_INIT`
- `TODO_INIT`
- `TODO_INIT`

## Repo commands

Fill exact commands from manifests/docs. Use package manager already used by repo.

| Purpose | Command |
|---|---|
| install | `TODO_INIT` |
| lint | `TODO_INIT` |
| typecheck | `TODO_INIT` |
| unit tests | `TODO_INIT` |
| targeted test | `TODO_INIT` |
| build | `TODO_INIT` |
| format check | `TODO_INIT` |

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

- `TODO_INIT`: `TODO_INIT`
- `TODO_INIT`: `TODO_INIT`
- `TODO_INIT`: `TODO_INIT`

## Deferred context files

Create these only if useful. Open only when trigger matches.

| Trigger | File |
|---|---|
| architecture or cross-module design | `docs/agents/architecture.md` |
| testing strategy, fixtures, or flaky tests | `docs/agents/testing.md` |
| debugging production-like failures | `docs/agents/debugging.md` |
| release, versioning, changelog, packaging | `docs/agents/release.md` |
| security-sensitive code paths | `docs/agents/security.md` |

## Generated/low-value paths

Do not read or edit unless directly required.

- `TODO_INIT`
- `TODO_INIT`
- `TODO_INIT`

## Nested AGENTS suggestions

During initialization, add suggested nested files here if local rules would materially reduce context.

| Path | Why nested guidance may help |
|---|---|
| `TODO_INIT` | `TODO_INIT` |

## Edit discipline

- Identify owning path from `Path map` before editing.
- Read nearest implementation and test examples first.
- Make the smallest correct change.
- Do not normalize formatting outside touched lines.
- Do not move code across directories unless requested.
- If multiple areas are touched, re-check whether nested `AGENTS.md` files apply.