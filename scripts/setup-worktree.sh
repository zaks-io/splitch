#!/usr/bin/env bash
# Make the current Git worktree ready for an agent: dependencies, git hooks, and
# the gitignored local config a fresh checkout does not have.
#
# Run from inside the new worktree. Safe to re-run: existing local files are
# never overwritten, and `pnpm install` is a no-op when nothing changed.
set -euo pipefail

here="$(git rev-parse --show-toplevel)"
echo "setup-worktree: starting setup in $here"
# The first entry of `git worktree list` is always the main checkout, the one
# place a human has filled in local env.
main="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"

# Optional copy, not a symlink, so a worktree cannot rewrite the main checkout's env.
if [ "$here" != "$main" ] && [ -e "$main/.env.local" ] && [ ! -e "$here/.env.local" ]; then
  if cp -p "$main/.env.local" "$here/.env.local"; then
    echo "setup-worktree: copied .env.local from the main checkout"
  else
    echo "setup-worktree: warning: could not copy optional .env.local; continuing setup" >&2
  fi
fi

cd "$here"
echo "setup-worktree: installing dependencies"
pnpm install --frozen-lockfile
# pnpm skips lifecycle scripts when dependencies are already up to date.
echo "setup-worktree: installing git hooks"
pnpm run prepare
echo "setup-worktree: setup complete"
