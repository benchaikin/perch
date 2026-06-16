#!/usr/bin/env bash
# Spawn isolated git worktrees for READY (unblocked) dex tasks at the FRONT of
# the agent loop. For one task or the top N ready tasks, this creates a
# dex/<id>-<slug> worktree per task (reusing the dex-worktree skill's
# create-dex-worktree.sh — it is NOT duplicated here), optionally marks each
# task in-progress, and prints a machine-readable plan (one SPAWN line per task,
# with the worktree path + branch + id + name) so the orchestrating agent can
# launch a sub-agent against each path.
#
# It does NOT launch agents itself: agent spawning is the orchestrator's job
# (via the Agent tool, WITHOUT isolation — the worktree already exists). This is
# the front-of-loop counterpart to land-dex (the back-of-loop reaper).
#
# The branch convention is LOCKED: the worktrees plugin parses the id back out of
# a branch with /^dex\/([a-z0-9]+)/ (plugins/worktrees/src/parse.ts,
# parseDexTaskId), so <id> MUST be the exact lowercase-alphanumeric dex task id,
# first, immediately after the literal `dex/`. create-dex-worktree.sh enforces
# this; this wrapper just feeds it real ready-task ids + names.
#
# Usage:
#   spawn-dex-worktrees.sh <id> [more-ids...]   Spawn the named task(s).
#   spawn-dex-worktrees.sh --top N              Spawn the top N ready tasks.
#   spawn-dex-worktrees.sh --all                Spawn ALL ready tasks.
#   spawn-dex-worktrees.sh --dry-run ...        Show the plan; create nothing.
#   spawn-dex-worktrees.sh --no-start ...       Don't mark tasks in-progress.
#   spawn-dex-worktrees.sh --base <branch> ...  Base new worktrees on <branch>.
#
# "Ready" = `dex list --ready --json` (pending tasks with no incomplete
# blockers). On top of that, this script keeps only LEAF/actionable tasks: it
# SKIPS any task that has children (epics/parents), because an epic isn't a unit
# of work an agent should pick up — its leaves are. (In practice `--ready`
# already excludes parents with incomplete subtasks, since those count as
# blocked; the children filter is a defensive belt-and-braces guard and is what
# makes --top/--all select genuinely actionable work.) Tasks are ordered by
# priority (ascending — dex treats lower numbers as higher priority), then by
# creation time, matching dex's own ready ordering.
#
# Output: one `SPAWN  <id> [<branch>] @ <path> — <name>` line per spawned task on
# stderr (human log), plus a machine-readable plan on STDOUT, one tab-separated
# record per task:  <id>\t<branch>\t<path>\t<name>
# The orchestrator reads stdout to know which worktree to point each agent at.
# A `==== summary ====` block reports the counts on stderr.
set -euo pipefail

DRY_RUN=0
NO_START=0
BASE=""
TOP=""
ALL=0
IDS=()

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --all) ALL=1; shift ;;
    --top)
      TOP="${2:-}"
      if [[ -z "$TOP" || ! "$TOP" =~ ^[0-9]+$ ]]; then
        echo "error: --top requires a positive integer N" >&2
        exit 2
      fi
      shift 2
      ;;
    --base)
      BASE="${2:-}"
      if [[ -z "$BASE" ]]; then
        echo "error: --base requires a branch name" >&2
        exit 2
      fi
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 2
      ;;
    *)
      IDS+=("$1")
      shift
      ;;
  esac
done

# Exactly one selection mode: explicit ids, OR --top N, OR --all.
modes=0
[[ ${#IDS[@]} -gt 0 ]] && modes=$((modes + 1))
[[ -n "$TOP" ]] && modes=$((modes + 1))
[[ "$ALL" == 1 ]] && modes=$((modes + 1))
if [[ "$modes" -eq 0 ]]; then
  echo "error: nothing to spawn — give <id...>, --top N, or --all" >&2
  usage >&2
  exit 2
fi
if [[ "$modes" -gt 1 ]]; then
  echo "error: choose ONE of: explicit <id...>, --top N, or --all" >&2
  exit 2
fi

# Locate this skill's dir so we can call the dex-worktree helper relative to it,
# regardless of the caller's cwd.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE_HELPER="$SKILL_DIR/../dex-worktree/create-dex-worktree.sh"
if [[ ! -f "$CREATE_HELPER" ]]; then
  echo "error: cannot find create-dex-worktree.sh at $CREATE_HELPER" >&2
  exit 1
fi

# dex launcher: prefer a real `dex` on PATH, else npx @zeeg/dex.
dex() {
  if command -v dex >/dev/null 2>&1; then
    command dex "$@"
  else
    npx @zeeg/dex "$@"
  fi
}

# Resolve the list of (id, name) pairs to spawn, as tab-separated lines on
# stdout. Selection:
#   - explicit ids: look each up via `dex show <id> --json`, keep its id+name.
#   - --top N / --all: read `dex list --ready --json`, drop tasks WITH children
#     (epics/parents — not actionable leaves), order by priority then created_at,
#     and (for --top) take the first N.
select_tasks() {
  if [[ ${#IDS[@]} -gt 0 ]]; then
    # `dex show` accepts multiple ids; --json yields an array (or object for one).
    dex show "${IDS[@]}" --json 2>/dev/null \
      | jq -r 'if type=="array" then .[] else . end | [.id, .name] | @tsv'
    return 0
  fi

  # Ready leaf tasks, ordered, optionally truncated to N.
  local jq_filter
  jq_filter='map(select((.children // []) | length == 0))
    | sort_by(.priority, .created_at)'
  if [[ -n "$TOP" ]]; then
    jq_filter="$jq_filter | .[0:$TOP]"
  fi
  jq_filter="$jq_filter | .[] | [.id, .name] | @tsv"
  dex list --ready --json 2>/dev/null | jq -r "$jq_filter"
}

spawned=()
skipped=()

note_spawn() { spawned+=("$1"); echo "SPAWN $1" >&2; }
note_skip() { skipped+=("$1"); echo "SKIP  $1" >&2; }

# Re-derive the same kebab slug create-dex-worktree.sh derives, so --dry-run can
# report the exact branch/path the real run would produce. Kept in sync with the
# helper's slug logic (lowercase, non-alnum -> hyphen, trim, first 5 words).
derive_slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -d- -f1-5 \
    | sed -E 's/-+$//'
}

repo_root="$(git rev-parse --show-toplevel)"
worktrees_dir="$(dirname "$repo_root")/$(basename "$repo_root")-worktrees"

# Walk the selected tasks and spawn (or, in dry-run, plan) a worktree per task.
while IFS=$'\t' read -r id name; do
  [[ -z "$id" ]] && continue

  if [[ ! "$id" =~ ^[a-z0-9]+$ ]]; then
    note_skip "$id — id is not lowercase-alphanumeric; parser would not match it"
    continue
  fi

  slug="$(derive_slug "$name")"
  if [[ -n "$slug" ]]; then
    branch="dex/${id}-${slug}"
    path="${worktrees_dir}/${id}-${slug}"
  else
    branch="dex/${id}"
    path="${worktrees_dir}/${id}-task"
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    start_note=""
    [[ "$NO_START" == 0 ]] && start_note=" (+ mark in_progress)"
    note_spawn "$id [$branch] @ $path — WOULD create worktree${start_note}: $name"
    printf '%s\t%s\t%s\t%s\n' "$id" "$branch" "$path" "$name"
    continue
  fi

  if [[ -e "$path" ]]; then
    note_skip "$id [$branch] @ $path — worktree path already exists (skipped)"
    continue
  fi

  # Create the worktree via the dex-worktree helper (reused, not duplicated). It
  # prints the created path as its last stdout line; capture it as the truth.
  created_path=""
  if [[ -n "$BASE" ]]; then
    created_path="$(bash "$CREATE_HELPER" "$id" "$name" "$BASE")" || {
      note_skip "$id [$branch] — create-dex-worktree.sh failed (skipped)"
      continue
    }
  else
    created_path="$(bash "$CREATE_HELPER" "$id" "$name")" || {
      note_skip "$id [$branch] — create-dex-worktree.sh failed (skipped)"
      continue
    }
  fi

  # Optionally mark the task in-progress; degrade gracefully if dex can't.
  if [[ "$NO_START" == 0 ]]; then
    if ! dex start "$id" >&2 2>&1; then
      echo "      note: could not mark $id in_progress (continuing)" >&2
    fi
  fi

  note_spawn "$id [$branch] @ $created_path — worktree created: $name"
  printf '%s\t%s\t%s\t%s\n' "$id" "$branch" "$created_path" "$name"
done < <(select_tasks)

echo "" >&2
echo "==== summary ====" >&2
echo "spawned: ${#spawned[@]}" >&2
echo "skipped: ${#skipped[@]}" >&2
if [[ "$DRY_RUN" == 1 ]]; then
  echo "(dry-run: no worktrees were created, no tasks were started)" >&2
fi
