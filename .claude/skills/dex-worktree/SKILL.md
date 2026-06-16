---
name: dex-worktree
description: Spawn an isolated git worktree and sub-agent for a dex task, on a branch that encodes the task id (dex/<id>-<slug>) so perch automatically links the worktree to the task. Use when picking up a dex task to work it in its own worktree.
---

# Spawn a dex-task worktree + agent

Given a dex task id, create an isolated git worktree on a branch named
`dex/<id>-<slug>` and launch a sub-agent there. Because the branch encodes the
task id, perch's worktrees panel associates the worktree with the dex task
automatically — no extra wiring needed.

## The LOCKED branch convention

perch parses the dex task id back out of a worktree's branch with this regex
(`plugins/worktrees/src/parse.ts`, `parseDexTaskId`):

```
/^dex\/([a-z0-9]+)/
```

So the branch you create **MUST**:

- start with the literal `dex/`,
- be immediately followed by the **exact** dex task id, which is a run of
  lowercase alphanumerics (`[a-z0-9]`),
- optionally followed by `-<slug>` for readability.

`dex/<id>` and `dex/<id>-<slug>` both work; `dex/<id>` is the minimum. Anything
else (uppercase, a slug before the id, a different prefix) will NOT be matched
and the worktree will show up unassociated.

Do **not** rely on the Agent tool's `isolation: worktree`: it auto-names its
branch `worktree-agent-<hex>`, which does not match the convention. This skill
creates the worktree and branch itself, then runs the sub-agent against that
existing path.

## Steps

### 1. Resolve the task

Take the dex id as the argument. Fetch its details so you have a name (for the
slug) and full context to seed the sub-agent:

```bash
dex show <id> --full
```

If `dex` isn't on PATH, use `npx @zeeg/dex` instead.

### 2. Create the worktree + branch

Use the helper script, which derives a kebab slug from the task name, picks a
base branch (defaults to the repo's default branch via `origin/HEAD`, falling
back to `main`), and creates the worktree on a new `dex/<id>-<slug>` branch:

```bash
.claude/skills/dex-worktree/create-dex-worktree.sh <id> "<task name>" [base-branch]
```

The script prints the created worktree path as its last stdout line; capture it
as `WT`. It places worktrees in a sibling `../<repo>-worktrees/<id>-<slug>`
directory so they don't collide.

Doing it by hand instead is fine — just keep the branch matching the convention:

```bash
git worktree add -b dex/<id>-<slug> <path> <base>
```

### 3. (Optional) Harden with a worktree-local git config

The branch name already carries the signal, so this is optional. The
`perch.dexTask` config **wins** over the branch parse, so it's useful if you
ever rename the branch off-convention. `git config --worktree` errors unless
`extensions.worktreeConfig` is enabled, so enable it first:

```bash
git -C <WT> config extensions.worktreeConfig true
git -C <WT> config --worktree perch.dexTask <id>
```

### 4. (Optional) Mark the task in progress

```bash
dex update <id> --status in_progress   # or: dex start <id>
```

### 5. Launch the sub-agent

Spawn a sub-agent with the Agent tool, **without** `isolation` (the worktree
already exists). In its prompt:

- instruct it to work in the worktree path `<WT>` (all file/bash ops use that
  absolute path; bash cwd resets between calls, so always use absolute paths),
- paste the `dex show <id> --full` output as context (the what / why / how),
- tell it to commit on the `dex/<id>-<slug>` branch and **not** reference the
  dex id in commit messages or PRs (dex ids are ephemeral).

### 6. On completion (only after the work is verified)

Mirror the repo's standard merge + cleanup flow:

```bash
# from the main worktree / repo root, on the default branch:
git checkout main
git pull
git merge --no-ff dex/<id>-<slug>
git worktree remove <WT>
git branch -d dex/<id>-<slug>
```

Then complete the dex task with verification evidence:

```bash
dex complete <id> --result "..." --commit <sha>
```

## Fallback: an existing worktree that lacks the convention

If a worktree was already created (e.g. by the Agent tool's auto-naming) and
isn't being picked up, associate it without recreating it — either rename its
branch or set the config override:

```bash
# Rename the branch to match (from inside that worktree):
git -C <WT> branch -m dex/<id>-<slug>

# OR set the override config (wins over the branch parse):
git -C <WT> config extensions.worktreeConfig true
git -C <WT> config --worktree perch.dexTask <id>
```

perch will then show the worktree↔task association on its next refresh.
