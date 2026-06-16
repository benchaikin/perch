#!/usr/bin/env bash
# Create an isolated git worktree for a dex task on a branch that encodes the
# task id per the LOCKED convention: dex/<id>-<slug>. The worktrees plugin parses
# the id back out with /^dex\/([a-z0-9]+)/ (see plugins/worktrees/src/parse.ts),
# so <id> MUST be the exact lowercase-alphanumeric dex task id and MUST come
# first, immediately after the literal `dex/`.
#
# Usage: create-dex-worktree.sh <dex-id> <task-name> [base-branch]
#
# Prints the created worktree path on stdout (last line). Branch is dex/<id>-<slug>.
set -euo pipefail

id="${1:-}"
name="${2:-}"
base="${3:-}"

if [[ -z "$id" || -z "$name" ]]; then
  echo "usage: create-dex-worktree.sh <dex-id> <task-name> [base-branch]" >&2
  exit 2
fi

# The id must be lowercase alphanumeric — otherwise the plugin parser won't
# recover it from the branch name, breaking the worktree<->task association.
if [[ ! "$id" =~ ^[a-z0-9]+$ ]]; then
  echo "error: dex id '$id' is not lowercase-alphanumeric; parser would not match it" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"

# Derive a short kebab slug from the task name: lowercase, non-alnum -> hyphen,
# collapse/trim hyphens, keep the first few words for a readable branch.
slug="$(printf '%s' "$name" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -d- -f1-5 \
  | sed -E 's/-+$//')"

if [[ -n "$slug" ]]; then
  branch="dex/${id}-${slug}"
else
  branch="dex/${id}"
fi

# Default base = the repo's default branch (origin/HEAD), falling back to main.
if [[ -z "$base" ]]; then
  base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
  base="${base:-main}"
fi

# Worktree path: a sibling of the repo root, named after the task, so multiple
# dex worktrees don't collide and are easy to spot.
worktrees_dir="$(dirname "$repo_root")/$(basename "$repo_root")-worktrees"
mkdir -p "$worktrees_dir"
path="${worktrees_dir}/${id}-${slug:-task}"

if [[ -e "$path" ]]; then
  echo "error: worktree path already exists: $path" >&2
  exit 1
fi

# Create the worktree on a NEW branch ourselves so the branch matches the
# convention. (The Agent tool's isolation:worktree auto-names worktree-agent-<hex>,
# which would NOT match — so we never rely on that here.)
git worktree add -b "$branch" "$path" "$base" >&2

echo "branch=$branch" >&2
echo "base=$base" >&2
echo "path=$path" >&2
# Last line: the path, for the caller to capture.
printf '%s\n' "$path"
