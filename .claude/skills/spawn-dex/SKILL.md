---
name: spawn-dex
description: Spawn agents from READY (unblocked) dex tasks at the front of the loop — one-click for a single task, or batch the top N ready tasks. Each gets a correctly-named dex/<id>-<slug> worktree (so perch links it to the task) and a sub-agent seeded from the task. Use to turn ready dex work into running agents. The front-of-loop counterpart to land-dex (the reaper).
---

# Spawn agents from ready dex tasks

This is the ergonomic, batch-capable front of the agent loop. Where `dex-worktree`
spawns ONE worktree by hand, this skill turns ready (unblocked) dex tasks into
running agents with one step — single task or the top N at once — and is the
direct counterpart to `land-dex`, which reaps them once their PRs merge.

It reuses the exact `dex-worktree` mechanics and convention: it does **not**
duplicate worktree creation — it calls `dex-worktree`'s `create-dex-worktree.sh`
per task. And it does **not** rely on the Agent tool's `isolation: worktree`
(that auto-names `worktree-agent-<hex>`, which the parser would NOT link to a
task) — it creates the `dex/<id>-<slug>` worktree itself, then you point a
sub-agent at that existing path.

## The LOCKED branch convention

perch parses the dex id back out of a worktree's branch
(`plugins/worktrees/src/parse.ts`, `parseDexTaskId`):

```
/^dex\/([a-z0-9]+)/
```

So every branch is `dex/<id>` or `dex/<id>-<slug>` where `<id>` is the **exact**
lowercase-alphanumeric dex task id, first, immediately after `dex/`. The helper
(and `create-dex-worktree.sh`) enforce this, so a spawned worktree always shows
its task association in perch.

## What counts as "ready" and "spawnable"

- **Ready** = `dex list --ready --json` — pending tasks with no incomplete
  blockers.
- **Spawnable (leaf/actionable)** = a ready task with **no children**. The
  helper SKIPS tasks that have children (epics/parents): an epic isn't a unit of
  work an agent picks up — its leaves are. In practice `dex --ready` already
  excludes parents with incomplete subtasks (those count as blocked), so this is
  a defensive guard; it's also what makes `--top N`/`--all` select genuinely
  actionable work.
- Ordering is `priority` ascending (dex treats lower numbers as higher
  priority), then `created_at` — so `--top N` takes the N highest-priority,
  oldest ready leaves.

## Steps (orchestrator: ready tasks → N worktrees → N agents)

### 1. (Recommended) Dry-run the plan first

See exactly what would be spawned — tasks, branch names, and worktree paths —
without creating anything:

```bash
.claude/skills/spawn-dex/spawn-dex-worktrees.sh --dry-run --top 3
# or for one task:   ... --dry-run <id>
# or everything:     ... --dry-run --all
```

Each `SPAWN` line shows `<id> [<branch>] @ <path>`. Review, then run for real.

### 2. Create the worktree(s)

Drop `--dry-run`. The helper creates a `dex/<id>-<slug>` worktree per task (via
`create-dex-worktree.sh`), marks each task in-progress (`dex start`, unless
`--no-start`), and prints a machine-readable plan on **stdout** — one
tab-separated record per spawned task:

```
<id>\t<branch>\t<path>\t<name>
```

```bash
# One ready task, one click:
.claude/skills/spawn-dex/spawn-dex-worktrees.sh <id>

# Batch the top N ready leaf tasks:
.claude/skills/spawn-dex/spawn-dex-worktrees.sh --top 3

# Or every ready leaf task:
.claude/skills/spawn-dex/spawn-dex-worktrees.sh --all
```

Useful flags: `--no-start` (don't mark in-progress), `--base <branch>` (base the
new worktrees on something other than the repo's default branch).

Capture stdout: each record's `<path>` is where that task's agent will run, and
`<id>` is the task to seed it from.

### 3. Launch a sub-agent per worktree

For **each** stdout record, before spawning, fetch the task's full context to
seed the agent:

```bash
dex show <id> --full
```

(If `dex` isn't on PATH, use `npx @zeeg/dex`.) Then spawn a sub-agent with the
Agent tool, **without** `isolation` (the worktree already exists). In its prompt:

- tell it to work in the worktree path `<path>` (cwd resets between bash calls,
  so it must use that absolute path for all file/bash ops),
- paste the `dex show <id> --full` output as the what / why / how,
- tell it to commit on the `dex/<id>-<slug>` branch and **not** reference the dex
  id in commit messages or PRs (dex ids are ephemeral).

When batching, launch the per-worktree sub-agents in parallel (independent work,
isolated worktrees) — one Agent call per record.

### 4. Close out when the work lands

Once an agent's PR merges, use the **`land-dex`** skill (the back-of-loop
counterpart) to reap the worktree + branch and complete the dex task with
PR-derived evidence. Don't hand-clean spawned worktrees — `land-dex` does it
behind merged-PR + clean-tree guards.

## Verifying a branch links correctly

A spawned branch satisfies the parser iff `dex/<id>-<slug>` yields `<id>`:

```bash
# round-trips to the id:
printf 'dex/%s-%s' "$id" "$slug" | sed -E 's@^dex/([a-z0-9]+).*@\1@'
```

## When NOT to use this

- The task is blocked — it won't appear in `--ready`; finish its blockers first.
- The task is an epic/parent — spawn its leaf subtasks instead (the helper skips
  parents automatically).
- A worktree for the task already exists — the helper skips it rather than
  clobbering; reuse it or land it via `land-dex`.
