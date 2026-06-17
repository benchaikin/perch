# `dex spawn-all` unreliability — diagnosis & fix

Why "Spawn all ready" (`dex.spawn-all` → `runSpawnBatch`) was unreliable: some
tasks got marked in-progress with no agent running, some terminals opened and
others didn't, and some tasks ended in the wrong state. This documents the
root cause (with a reproduction), maps each symptom to its cause, and records
the fix that landed in this change.

## TL;DR

The batch fired `runSpawn` for **every** ready task at once via `Promise.all`
(`plugins/dex/src/spawn.ts`, old `runSpawnBatch`). Each `runSpawn` mutates three
pieces of shared, **unsynchronized** state, and all three race under concurrency:

1. **The per-repo `.dex` store.** `dex start` does a read-modify-**rewrite** of
   the whole JSONL store with **no lock**, so concurrent starts lose each other's
   `started_at` writes.
2. **The repo's git worktree metadata.** Concurrent `git worktree add` in one
   repo contend on `.git/worktrees` + `index.lock`; some fail.
3. **The terminal launcher.** Concurrent `osascript` → Terminal.app `do script`
   races and drops windows.

The fix: **serialize the batch** (run `runSpawn` one task at a time), plus a
pre-flight that refuses an already-existing worktree *before* the in-progress
mark, plus surfacing which tasks failed in the GUI.

## Reproduction (the smoking gun: cause #1)

The dex store write path (`@zeeg/dex@0.16.0`, `core/storage/jsonl-storage.js`):

```js
write(store) {
  this.ensureDirectory();
  const sortedTasks = [...store.tasks];
  this.sortTasksById(sortedTasks);
  const tempFile = `${this.tasksFile}.tmp`;
  fs.writeFileSync(tempFile, this.formatAsJsonl(sortedTasks), "utf-8");
  fs.renameSync(tempFile, this.tasksFile);   // atomic for ONE writer; no lock
}
```

`start` reads the whole store, sets `started_at` on one task, and writes the
whole store back. Two concurrent starts both read snapshot `S0`; the second to
finish writes `S0 + itsOwnTask`, clobbering the first's `started_at` (lost
update). Measured against an isolated store (create 9 tasks, then start all 9):

| run | `dex start` × 9 concurrently | `dex start` × 9 serially |
|-----|------------------------------|--------------------------|
| 1   | 8/9 marked                   | 9/9 marked               |
| 2   | 8/9 marked                   | 9/9 marked               |
| 3   | 9/9 marked                   | 9/9 marked               |

Against the real 446 KB `.dex/tasks.jsonl`, a single concurrent run lost **4 of
9** — the larger the store, the longer each write takes, the wider the race
window. Serial is 100% reliable every time.

## Symptom → cause mapping

### Symptom #1 — "marked in-progress, but no agent is running"

Two distinct mechanisms, both concurrency-driven:

- **Mark survived, downstream step failed (no rollback).** `runSpawn` marks the
  task in-progress *first* (`spawn.ts`, `dex.start` before `git worktree add` +
  `spawnInTerminal`). Under concurrency the worktree-add (cause #2) or terminal
  launch (cause #3) could fail *after* the mark. `runSpawn` returns
  `{ ok:false }`, but the task is left `started_at`-set, and **dex has no
  `unstart`** (`dex --help`: only `start`/`start --force`; `dex edit` can't clear
  `started_at`) — so the mark can't be rolled back. `normalize.ts` `deriveStatus`
  keys in-progress purely off `started_at`, so it reads as in-progress forever.
  → Leading hypothesis 1: **confirmed.**

### Symptom #2 — "some terminals opened, some didn't"

- **Terminal launcher race (cause #3).** `spawnInTerminal`
  (`packages/sdk/src/terminal.ts`) shells `osascript -e 'tell application
  "Terminal" to do script …'` with no throttle. Firing N of these at once races
  Terminal.app's scripting bridge and drops/merges windows.
- **Worktree-add failures (cause #2) cut some tasks off before they reach the
  terminal step at all.**
- **Refuted: writeScript clobber (hypothesis 2b).** `defaultWriteScript` keys the
  temp script by `label`, which is `dex <id>` — **unique per task**
  (`/tmp/perch-terminal/dex_<id>.sh`). Distinct tasks never share a script path,
  so concurrent spawns don't clobber each other's launch scripts.

### Symptom #3 — "tasks ended in the wrong state afterward"

Wrong state in **both** directions, which is what made it so confusing:

- **Lost `started_at` (cause #1):** a task that *did* get a worktree + agent
  still reads as `ready` because its `dex start` write was clobbered.
- **Orphaned in-progress (symptom #1):** a task marked in-progress whose spawn
  then failed reads as in-progress with no agent.

## Hypotheses verdict

- **H1 — no rollback after mark-first ⇒ orphan in-progress:** confirmed as the
  mechanism that turns a transient failure into persistent wrong state. A true
  rollback isn't available (no dex `unstart`); mitigated below.
- **H2 — unbounded concurrency:** the **master root cause.** 2a (terminal race)
  and 2c (git contention) confirmed; **2d (dex store race) confirmed and is the
  dominant one** (reproduced above). 2b (writeScript clobber) **refuted**.
- **H3 — readiness gate ignores existing worktrees/agents:** partially. The GUI's
  `canSpawnDex` (`packages/gui/src/renderer/dex.ts`) *does* exclude tasks with a
  live `worktree`/`agent`, so the button rarely offers them. But the daemon's
  `isReadyToSpawn` does **not**, so the CLI/MCP `perch dex spawn-all` path could
  re-mark + fail a task that already had a worktree. Addressed by the pre-flight.

### Is `sh76eayu` obsolete?

No. `sh76eayu` ("make marking in-progress non-optional") correctly fixed the
*opposite* bug — agents spawned on tasks that were never marked. The mark-first
ordering it introduced is preserved here; this change fixes the *concurrency*
that made the post-mark steps fail (and a pre-flight for the one orphan case the
mark-first ordering can't itself prevent). The two are complementary.

## The fix (this change)

All in `plugins/dex/src/spawn.ts`:

1. **Serialize the batch (the decisive fix).** `runSpawnBatch` now runs
   `runSpawn` in a sequential `for` loop instead of `Promise.all`. This removes
   the dex-store write race, the git `index.lock` contention, and the
   Terminal.app `osascript` race in one stroke — each step sees the prior task's
   committed effect. Cost: a little latency, paid once per fleet launch (spawns
   are interactive and rare; each agent runs detached, so we don't wait on it).
2. **Pre-flight before the mark (addresses H1 + H3).** `runSpawn` now checks
   `fs.exists(worktreePath)` *before* `dex start`. An already-spawned task fails
   cleanly without being (re-)marked in-progress — the closest thing to rollback
   given there's no `unstart`.
3. **Surface failures in the GUI (deliverable d).** `runSpawnBatch`'s summary now
   names the failed task ids (`… (2 failed: abc12, def34).`), which flows
   straight into the GUI toast (it only renders the rolled-up `message`).

### Quick wins vs. larger follow-ups

- **Quick wins (done here):** serialize the batch; pre-flight worktree check;
  name failed ids in the summary.
- **Residual / follow-ups (not done):**
  - **True rollback** needs an `unstart` (or a `started_at`-clearing edit) in the
    `dex` CLI. The one orphan the pre-flight can't catch is `dex start` succeeding
    then `git worktree add` failing for a *non-path* reason (e.g. a stale
    registered branch whose dir was deleted). Propose: file upstream / add a small
    daemon-side store edit.
  - **Daemon-side worktree/agent awareness:** teach `isReadyToSpawn` (or
    `runSpawnBatch`) to consult live worktrees (as `land.ts` already enumerates
    them via `parseWorktreeList`) so the CLI/MCP path matches the GUI's
    `canSpawnDex` gate.
  - **Bounded concurrency instead of fully serial:** if batch latency ever
    matters, a small pool that serializes only the store-write + worktree-add +
    terminal-open steps while overlapping the rest would recover some parallelism.
    Serial is simpler and was chosen first; revisit only if needed.
