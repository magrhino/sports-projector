# Global Codex Instructions

## Default behavior

- Make the smallest correct change that satisfies the request.
- Prefer targeted fixes over broad rewrites.
- Do not refactor unrelated code unless explicitly asked.
- Do not format, rename, or reorganize unrelated files.
- Preserve existing behavior unless the task explicitly asks to change it.
- Before changing code, inspect the relevant files and existing patterns.

## Instruction precedence

- Follow instruction precedence in this order:
  1. Explicit user request for the current task.
  2. The closest applicable `AGENTS.md` / `AGENTS.override.md` instructions.
  3. Broader repo-level `AGENTS.md` instructions.
  4. Repo `CONTRIBUTING.md`, README, and other project docs.
  5. Existing code style and nearby implementation patterns.
- When files in multiple directories are changed, check for applicable nested `AGENTS.md` files in each affected path.
- If instructions conflict, follow the more specific applicable instruction unless it conflicts with the explicit user request or safety requirements.

## Context usage

- Read only the files needed to understand and complete the task.
- Prefer targeted searches such as `rg`, file-specific reads, and focused snippets over dumping large files.
- Do not read generated files, vendored dependencies, build outputs, lockfiles, or large data files unless directly relevant.
- When context is ambiguous, inspect nearby examples before inventing new patterns.
- Keep summaries concise: report findings and decisions, not raw file contents.

## Commit message hard requirement

- Do not create, amend, squash, rebase, or otherwise modify commits unless explicitly asked.
- If creating, amending, squashing, rebasing, or proposing commits, every commit subject MUST follow Conventional Commits.

Format:

```text
<type>(optional-scope): <imperative summary>
```

Allowed types:

```text
feat, fix, docs, test, refactor, chore, ci, build, perf, style, revert
```

Scope rules:

- Choose the scope from the main component, package, directory, feature, or concern changed.
- Do NOT reuse one example scope such as `abs` for unrelated changes.
- Omit the scope if no single clear scope applies.
- Prefer short lowercase scopes.

Examples of possible scopes:

```text
api, db, ui, auth, import, rollback, metadata, ci, docs, docker, tests, deps
```

Good examples:

```text
fix(import): retry only transient transport errors
fix(metadata): log json encoding failures
test(rollback): cover interrupted run resume order
docs(deploy): document migration and env requirements
ci: normalize go setup version
refactor(api): extract shared request validation
chore(deps): update frontend lockfile
```

Bad examples:

```text
Fix ABS import retry and metadata encoding
fix(abs): update ci workflow
fix(abs): edit deployment docs
fix(abs): change frontend table layout
```

Before running any command that creates or rewrites commits, verify the final commit subject matches this regex:

```text
^(feat|fix|docs|test|refactor|chore|ci|build|perf|style|revert)(\([a-z0-9._-]+\))?!?: .+
```

## Code quality

- Preserve existing behavior unless the task explicitly asks to change it.
- Add or update focused tests for behavior changes.
- Avoid silent failures; surface errors clearly through logs, returned errors, or test failures.
- Avoid unbounded memory growth, unnecessary full-table scans, and repeated expensive work inside loops.
- Avoid adding new dependencies unless clearly justified.
- Do not change public APIs, database schema, migrations, CI versions, or configuration formats unless required by the task.

## Security and secrets

- Never commit secrets, API keys, tokens, private service URLs, `.env` files, or private credentials.
- Use placeholders for sensitive values and clearly mark example-only values.
- Treat user-provided URLs, headers, paths, and API keys as untrusted input.
- Avoid SSRF, path traversal, shell injection, SQL injection, and unsafe deserialization patterns.

## Validation

- Run the most relevant targeted tests first.
- If practical, run broader tests before finishing.
- Report the exact commands run and whether they passed or failed.
- Do not claim tests, builds, or checks passed unless they were actually run.
- If a command fails, report the failure and the most relevant error.
- If tests cannot be run, explain why and identify the best next validation command.

## Final response format

End with:

- Summary of changes
- Tests run
- Risks or follow-ups
- Final or draft commit message: include the exact Conventional Commit subject used, proposed, or that would be used if a commit were requested; if no commit is relevant, say "Not applicable".
