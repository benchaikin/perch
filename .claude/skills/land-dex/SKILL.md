---
name: land-dex
description: Reap merged dex worktrees — for dex/<id> worktrees whose PR is merged, do a guarded cleanup (remove the worktree + branch) and complete the dex task with PR-derived evidence. Use after PRs land to clean up and close out the tasks they implemented. The back-of-loop counterpart to dex-worktree (spawn).
---

# Land a dex task: reap its merged worktree

This is the back-of-loop counterpart to `dex-worktree`. That skill *spawns* an
isolated `dex/<id>-<slug>` worktree to work a task; this one *lands* it: once the
worktree's PR is merged, it removes the worktree + branch and completes the dex
task with evidence built from the PR.

Everything destructive is behind guards. A worktree is only reaped when its PR is
**merged** AND its tree is **clean**. Anything unsafe — no PR, an unmerged PR, or
a dirty/uncommitted tree — is **flagged and skipped**, never deleted.

## The LOCKED branch convention (must match the parser)

A worktree is a "dex worktree" when its branch encodes a task id per the shared
convention (`plugins/worktrees/src/parse.ts`, `parseDexTaskId`):

```
/^dex\/([a-z0-9]+)/
```

i.e. the literal `dex/` followed immediately by the **exact** dex task id (a run
of lowercase alphanumerics), optionally `-<slug>`. `dex/<id>` and
`dex/<id>-<slug>` both yield `<id>`. A worktree-local `perch.dexTask` git config,
when set, **wins** over the branch parse — so this skill checks that override
first, exactly as the plugin does.

## NO-CI repo caveat (boundary)

This skill keys off **PR-merged** state only (`gh pr view ... --json state`). For
repos **without CI**, a sibling skill adds a local-build gate before reaping (run
the build, only land if green). That build gate is **out of scope here** — do not
implement it in this skill. Merged-PR is the sole signal this skill uses.

## Steps

### 1. Enumerate dex worktrees

```bash
git worktree list --porcelain
```

Keep records whose branch matches `dex/<id>...` (parse the id with the
`/^dex\/([a-z0-9]+)/` rule above) **or** whose `git config --worktree perch.dexTask`
is set. Skip the **main** worktree (git lists it first) and detached/bare trees.

### 2. Detect merged PRs

For each candidate, with the worktree's repo as cwd, look up the branch's PR:

```bash
gh pr view <branch> --json state,mergedAt,mergeCommit,url,title,number
```

"Merged" = `state == MERGED` and `mergedAt` is present. No PR → flag and skip.

### 3. Guarded cleanup (only when MERGED **and** clean)

Confirm the tree is clean first — `git -C <path> status --porcelain` must be
empty. Then, and only then:

```bash
git worktree remove <path>
git branch -d <branch>     # -d (not -D): refuses if somehow not merged — a 2nd net
dex complete <id> --commit <mergeCommit-sha> --result "<PR-derived evidence>"
```

The evidence is built from the PR — title, number/URL, and merge SHA, e.g.
`Merged PR #123: <title> (<url>) — merge commit <sha>`. If `dex` isn't on PATH,
use `npx @zeeg/dex`.

### 4. Flag, never delete, anything unsafe

An unmerged PR, no PR at all, or a dirty/uncommitted worktree → report it clearly
and **SKIP**. No `git worktree remove`, no `git branch -d`, no `dex complete`.

### 5. Modes

- **Batch (default):** reap **all** merged dex worktrees in one pass.
- **Single:** pass a `<id>` to reap only that task's worktree.

## Helper script

The helper does the enumeration + per-worktree guarded logic and prints a summary
of what was reaped vs. flagged. Run it from the repo root:

```bash
# Batch — reap every merged dex worktree:
.claude/skills/land-dex/reap-dex-worktrees.sh

# Single task:
.claude/skills/land-dex/reap-dex-worktrees.sh <id>

# Report-only — show what WOULD be reaped vs. flagged, change nothing:
.claude/skills/land-dex/reap-dex-worktrees.sh --dry-run
```

Always prefer a `--dry-run` pass first to review the plan, then run for real.
Lines are tagged `REAP` (guards passed) or `FLAG` (skipped, with the reason),
and a `==== summary ====` block reports the counts.

## When NOT to use this

- The PR isn't merged yet — wait, or finish/merge it first (see `dex-worktree`).
- The worktree has uncommitted work — commit or stash it; this skill won't touch
  dirty trees.
- A repo without CI where you want a build gate — that's the sibling skill's job.
