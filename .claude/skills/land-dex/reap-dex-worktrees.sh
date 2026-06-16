#!/usr/bin/env bash
# Reap merged dex worktrees: for each git worktree whose branch encodes a dex
# task id (dex/<id>...), if its PR is MERGED and the tree is clean, remove the
# worktree + branch and complete the dex task with PR-derived evidence. Anything
# unsafe (no PR, unmerged PR, dirty tree) is FLAGGED and skipped — never deleted.
#
# This mirrors the worktree<->task convention enforced by the worktrees plugin:
# the id is parsed back out of the branch with /^dex\/([a-z0-9]+)/ (see
# plugins/worktrees/src/parse.ts, parseDexTaskId), and a worktree-local
# `perch.dexTask` git config wins over the branch parse. This script honours both.
#
# Usage:
#   reap-dex-worktrees.sh [--dry-run] [<id>]
#
#     <id>        Reap only the worktree for this dex task id. Omit to reap ALL
#                 merged dex worktrees (batch mode, the default).
#     --dry-run   Report what WOULD be reaped vs. flagged; make no changes.
#
# Guards (ALL must hold before anything destructive happens):
#   1. The worktree's branch parses to a dex id (or has perch.dexTask set).
#   2. The branch has a PR and that PR is MERGED (state == MERGED, mergedAt set).
#   3. The worktree tree is clean (`git status --porcelain` is empty).
#   4. NO-CI BUILD GATE: if the PR's merged commit had NO CI checks at all, the
#      repo's build must pass locally before reaping. Repos that HAVE CI skip
#      this (CI was already the gate). A build that can't be inferred, or that
#      fails, is FLAGGED + skipped — never reaped.
# Only then: `git worktree remove` + `git branch -d` (note -d, not -D, as a
# second merged-only safety net) + `dex complete --commit <mergeSha>`.
#
# NO-CI BUILD GATE: for a merged PR whose head reported NO CI checks (an empty
# statusCheckRollup), CI never gated the merge, so before reaping we run the
# repo's own build (inferred from its toolchain — see infer_build_command) in the
# worktree and only proceed if it passes. Repos WITH CI are unchanged.
set -euo pipefail

DRY_RUN=0
ONLY_ID=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [[ -n "$ONLY_ID" ]]; then
        echo "error: at most one <id> may be given" >&2
        exit 2
      fi
      ONLY_ID="$arg"
      ;;
  esac
done

# dex launcher: prefer a real `dex` on PATH, else npx @zeeg/dex.
dex() {
  if command -v dex >/dev/null 2>&1; then
    command dex "$@"
  else
    npx @zeeg/dex "$@"
  fi
}

# Parse the dex id out of a branch name, matching parseDexTaskId exactly:
# /^dex\/([a-z0-9]+)/ — lowercase alphanumerics immediately after `dex/`.
parse_dex_id() {
  local branch="${1:-}"
  if [[ "$branch" =~ ^dex/([a-z0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
  return 0
}

# Infer the build command for a repo from its toolchain, checking in priority
# order and picking the FIRST that matches. Prints the command to stdout (empty
# if none can be inferred). Rules (dir = repo/worktree root):
#   pnpm        pnpm-lock.yaml present                  -> pnpm -r build
#   npm/yarn    package.json with a "build" script      -> npm run build / yarn build
#   make        Makefile / makefile present             -> make
#   cargo       Cargo.toml present                       -> cargo build
#   go          go.mod present                           -> go build ./...
# pnpm is checked before plain npm/yarn so a pnpm monorepo builds recursively.
infer_build_command() {
  local dir="$1"
  if [[ -f "$dir/pnpm-lock.yaml" ]]; then
    printf 'pnpm -r build'
    return 0
  fi
  if [[ -f "$dir/package.json" ]] && grep -Eq '"build"[[:space:]]*:' "$dir/package.json"; then
    if [[ -f "$dir/yarn.lock" ]]; then
      printf 'yarn build'
    else
      printf 'npm run build'
    fi
    return 0
  fi
  if [[ -f "$dir/Makefile" || -f "$dir/makefile" ]]; then
    printf 'make'
    return 0
  fi
  if [[ -f "$dir/Cargo.toml" ]]; then
    printf 'cargo build'
    return 0
  fi
  if [[ -f "$dir/go.mod" ]]; then
    printf 'go build ./...'
    return 0
  fi
  return 0 # nothing inferred -> empty
}

reaped=()
flagged=()

note_flag() { flagged+=("$1"); echo "FLAG  $1" >&2; }
note_reap() { reaped+=("$1"); echo "REAP  $1" >&2; }

# Enumerate worktrees from porcelain output: emit "<path>\t<branch>" pairs,
# skipping the main worktree (the first record) and detached/bare ones.
main_path=""
cur_path=""
cur_branch=""
is_first=1

process_record() {
  local path="$1" branch="$2"
  [[ -z "$path" ]] && return 0

  # The first record git emits is the main worktree — never touch it.
  if [[ "$is_first" == 1 ]]; then
    main_path="$path"
    is_first=0
    return 0
  fi
  [[ "$path" == "$main_path" ]] && return 0
  [[ -z "$branch" ]] && return 0 # detached / no branch

  # Resolve the dex id: worktree-local perch.dexTask config wins, else branch parse.
  local id=""
  id="$(git -C "$path" config --worktree perch.dexTask 2>/dev/null || true)"
  if [[ -z "$id" ]]; then
    id="$(parse_dex_id "$branch")"
  fi
  [[ -z "$id" ]] && return 0 # not a dex worktree — silently ignore non-dex trees

  # If a single id was requested, skip the others.
  if [[ -n "$ONLY_ID" && "$id" != "$ONLY_ID" ]]; then
    return 0
  fi

  # --- Guard: PR must be MERGED ---
  local pr_json state merged_at merge_sha pr_url pr_title pr_number check_count
  if ! pr_json="$(gh pr view "$branch" --json state,mergedAt,mergeCommit,url,title,number,statusCheckRollup 2>/dev/null)"; then
    note_flag "$id [$branch] @ $path — no PR found for branch (skipped)"
    return 0
  fi
  state="$(printf '%s' "$pr_json" | jq -r '.state // ""')"
  merged_at="$(printf '%s' "$pr_json" | jq -r '.mergedAt // ""')"
  merge_sha="$(printf '%s' "$pr_json" | jq -r '.mergeCommit.oid // ""')"
  pr_url="$(printf '%s' "$pr_json" | jq -r '.url // ""')"
  pr_title="$(printf '%s' "$pr_json" | jq -r '.title // ""')"
  pr_number="$(printf '%s' "$pr_json" | jq -r '.number // ""')"
  # Number of CI checks GitHub reported on the head. 0 == this is a NO-CI repo
  # (no checks ever gated the merge), which triggers the local build gate below.
  check_count="$(printf '%s' "$pr_json" | jq -r '(.statusCheckRollup // []) | length')"

  if [[ "$state" != "MERGED" || -z "$merged_at" ]]; then
    note_flag "$id [$branch] @ $path — PR not merged (state=$state, ${pr_url:-no url}) (skipped)"
    return 0
  fi

  # --- Guard: worktree tree must be clean ---
  local dirt
  dirt="$(git -C "$path" status --porcelain 2>/dev/null || echo "ERR")"
  if [[ "$dirt" == "ERR" ]]; then
    note_flag "$id [$branch] @ $path — could not read worktree status (skipped)"
    return 0
  fi
  if [[ -n "$dirt" ]]; then
    note_flag "$id [$branch] @ $path — worktree is DIRTY/uncommitted (skipped)"
    return 0
  fi

  # --- Guard: NO-CI build gate ---
  # If the PR reported NO CI checks, CI never gated the merge, so the build must
  # pass locally before we reap. Repos WITH CI skip this (CI was the gate).
  local build_cmd=""
  if [[ "$check_count" == "0" ]]; then
    build_cmd="$(infer_build_command "$path")"
    if [[ -z "$build_cmd" ]]; then
      note_flag "$id [$branch] @ $path — no CI and no build command could be inferred (skipped)"
      return 0
    fi
    if [[ "$DRY_RUN" == 1 ]]; then
      # Don't run the build in dry-run; just report the plan.
      echo "      (no CI: would gate on build \`$build_cmd\` in $path before reaping)" >&2
    else
      echo "      no CI: running build gate \`$build_cmd\` in $path …" >&2
      if ! ( cd "$path" && eval "$build_cmd" ) >&2; then
        note_flag "$id [$branch] @ $path — no CI and build failed (\`$build_cmd\`) (skipped)"
        return 0
      fi
    fi
  fi

  # All guards pass. Build PR-derived completion evidence.
  local evidence
  evidence="Merged PR #${pr_number}: ${pr_title} (${pr_url}) — merge commit ${merge_sha}"

  if [[ "$DRY_RUN" == 1 ]]; then
    local gate_note=""
    [[ -n "$build_cmd" ]] && gate_note=" [no-CI build gate: $build_cmd]"
    note_reap "$id [$branch] @ $path — WOULD reap (merged, clean)${gate_note}; complete with: $evidence"
    return 0
  fi

  # --- Destructive, guarded ---
  # Remove the worktree first, then delete the branch with -d (refuses if git
  # thinks it isn't merged — a belt-and-braces second net).
  git worktree remove "$path"
  git branch -d "$branch"
  dex complete "$id" --commit "$merge_sha" --result "$evidence"
  note_reap "$id [$branch] @ $path — reaped (worktree+branch removed, task completed)"
}

while IFS= read -r line; do
  if [[ "$line" == worktree\ * ]]; then
    process_record "$cur_path" "$cur_branch"
    cur_path="${line#worktree }"
    cur_branch=""
  elif [[ "$line" == branch\ * ]]; then
    cur_branch="${line#branch }"
    cur_branch="${cur_branch#refs/heads/}"
  fi
done < <(git worktree list --porcelain)
# Flush the final record.
process_record "$cur_path" "$cur_branch"

echo "" >&2
echo "==== summary ====" >&2
echo "reaped:  ${#reaped[@]}" >&2
echo "flagged: ${#flagged[@]}" >&2
if [[ "$DRY_RUN" == 1 ]]; then
  echo "(dry-run: no changes were made)" >&2
fi
