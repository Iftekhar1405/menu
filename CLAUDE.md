# CLAUDE.md

Project memory for this repo. Rules here are binding on every agent and every
session — they are not suggestions.

## Git and commit protocol

**This section is a hard rule. It has been restated by the user more than once
because agents keep dropping it. Follow it exactly.**

### Branching

- Never commit directly to the default branch. If you are on it, branch first.
- Never create or switch branches when a task has already placed you on one.
- Never `git push` unless the user asks for it in so many words. "Commit" does
  not mean "push".
- Never force-push, rebase shared history, or amend a commit that is already
  pushed.

### Committing

- Commit only when the user asks, or when the task you were dispatched with
  tells you to. Do not leave finished, sound work uncommitted across a long
  verification run — commit as soon as it is sound.
- Stage deliberately: name the paths you mean (`git add <path> ...`). Never
  `git add -A` or `git add .` — this repo carries untracked scratch output and
  a `.superpowers/` planning tree that must not be swept into a commit by
  accident.
- One commit per coherent change. Do not bundle unrelated fixes.

### Commit message format

**Primary rule, binding on every agent working in this repo — including the
primary agent, from the start of its work: keep commit messages simple and
small, and never add a `Co-Authored-By` trailer.**

A conventional-commit subject line is normally the whole message. Match the
existing history — read `git log` before writing one.

```
<type>(<scope>): <imperative, lowercase, no trailing period>
```

- `type` is one of `feat`, `fix`, `test`, `docs`, `chore`, `refactor`.
- `scope` is the area touched: `db`, `api`, `web`, `shared`, `kitchen`.
- The subject is a sentence about behaviour, not a label. Prefer
  "a new round no longer resets the whole order" over "update order logic".
- Add a body only when the subject genuinely cannot carry the reason, and
  keep it to a sentence or two. Not a prose essay.
- **No `Co-Authored-By` trailer, and no other trailer.** Commits made before
  this rule carry one; leave them alone rather than rewriting history.

### Pull requests

- Open a PR only when asked.
- End every PR body with:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

### Never

- `git commit --no-verify` to get past a failing hook. Fix the failure.
- `git checkout -- <path>` / `git restore` / `git reset --hard` over work you
  did not write. Ask before discarding anything.
- Interactive git (`rebase -i`, `add -i`) — unsupported in this environment.
- Committing secrets. `.env` and `apps/api/.env` hold live credentials and
  stay untracked.

## Toolchain

- Node >= 22, pnpm 10.33.2. **Never `npm`, never `yarn`** — not even for a
  one-off install.
- After editing `packages/shared`, run `pnpm --filter @menu/shared build`
  before typechecking or testing anything that imports it.

## Database

- `apps/api/.env` and the root `.env` point every database URL at a **shared
  remote Supabase**. Migrations run there affect everyone.
- For local work use Docker Postgres on port 5433: `pnpm db:up`, then source
  the local overrides before any Prisma or vitest command. A bare
  `prisma migrate dev` would hit the shared remote.
- Prefer `prisma migrate deploy` over `migrate dev` — the latter's auto-seed
  step has hung in this repo, and it can offer to reset on drift.
- Never `prisma migrate reset` against a remote URL.

## Environment

- macOS has no `timeout(1)`. Bound a long command with
  `perl -e 'alarm 600; exec @ARGV' -- <command>`.
