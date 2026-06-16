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

## NO-CI repos: the local-build gate

This skill keys off **PR-merged** state (`gh pr view ... --json state,mergedAt`).
That's enough for repos with CI: a green CI was the gate before the merge. But a
repo **without CI** has no checks, so "merged" alone never proved the code builds
("if it builds, ship it"). For those repos the reaper adds one more guard before
anything destructive: it **runs the repo's build locally and only reaps if it
passes**.

A PR counts as **no-CI** when GitHub reports zero checks on its head
(`statusCheckRollup` is empty). For such a PR, the reaper infers the build command
from the repo's toolchain — first match wins:

| Toolchain marker (in the worktree root) | Inferred build command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm -r build` |
| `package.json` with a `"build"` script (+ `yarn.lock`) | `yarn build` |
| `package.json` with a `"build"` script (no `yarn.lock`) | `npm run build` |
| `Makefile` / `makefile` | `make` |
| `Cargo.toml` | `cargo build` |
| `go.mod` | `go build ./...` |

The build runs in the worktree. **Build passes → reap as normal. Build fails, or
no command could be inferred → FLAG + skip** (never delete). This is **in addition
to** the merged-PR and clean-tree guards. Repos that **have** CI skip this gate
entirely — their behavior is unchanged. In `--dry-run`, the reaper reports the
build command it *would* run without executing it.

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

### 3. No-CI build gate (only when the PR had no CI checks)

If the merged PR reported **zero** CI checks (`statusCheckRollup` empty), run the
inferred build (see table above) in the worktree. **Pass → proceed; fail or no
inferable command → FLAG + skip.** Repos with CI skip this step.

### 4. Guarded cleanup (only when MERGED, clean, **and** build-gate satisfied)

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

### 5. Flag, never delete, anything unsafe

An unmerged PR, no PR at all, a dirty/uncommitted worktree, or (for a no-CI repo)
a failed/uninferable build → report it clearly and **SKIP**. No `git worktree
remove`, no `git branch -d`, no `dex complete`.

### 6. Modes

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
- A no-CI repo whose build is currently broken — fix the build first; the build
  gate will FLAG + skip until it's green.
