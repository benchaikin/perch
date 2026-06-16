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
# Only then: `git worktree remove` + `git branch -d` (note -d, not -D, as a
# second merged-only safety net) + `dex complete --commit <mergeSha>`.
#
# NO-CI CAVEAT: this skill keys off PR-merged state only. For repos WITHOUT CI,
# a sibling skill adds a local-build gate before reaping; this script does NOT
# implement that build gate — merged-PR is the sole signal here.
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
  local pr_json state merged_at merge_sha pr_url pr_title pr_number
  if ! pr_json="$(gh pr view "$branch" --json state,mergedAt,mergeCommit,url,title,number 2>/dev/null)"; then
    note_flag "$id [$branch] @ $path — no PR found for branch (skipped)"
    return 0
  fi
  state="$(printf '%s' "$pr_json" | jq -r '.state // ""')"
  merged_at="$(printf '%s' "$pr_json" | jq -r '.mergedAt // ""')"
  merge_sha="$(printf '%s' "$pr_json" | jq -r '.mergeCommit.oid // ""')"
  pr_url="$(printf '%s' "$pr_json" | jq -r '.url // ""')"
  pr_title="$(printf '%s' "$pr_json" | jq -r '.title // ""')"
  pr_number="$(printf '%s' "$pr_json" | jq -r '.number // ""')"

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

  # All guards pass. Build PR-derived completion evidence.
  local evidence
  evidence="Merged PR #${pr_number}: ${pr_title} (${pr_url}) — merge commit ${merge_sha}"

  if [[ "$DRY_RUN" == 1 ]]; then
    note_reap "$id [$branch] @ $path — WOULD reap (merged, clean); complete with: $evidence"
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
