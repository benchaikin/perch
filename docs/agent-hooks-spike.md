# Agent-session hooks spike — making Perch aware of live Claude Code agents

Research spike: how Perch can know which Claude Code agent is running in which
`dex/<id>` worktree and its state (running / blocked-awaiting-input / done /
error), via Claude Code hooks, to feed a future `agents` plugin + fleet view.

The findings below are backed by a minimal hook that actually fired (see
"Prototype: what fired").

## TL;DR recommendation

1. **Hooks to use:** `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
   `Notification` (the key one), `Stop`, `SessionEnd`. Each runs one cheap
   command that pipes the hook's stdin JSON to `perch agents report`.
2. **Attribution:** the hook payload carries `cwd` and `session_id`. Map
   `cwd` → git branch (`git -C <cwd> branch --show-current`, or the worktree
   path) → `parseDexTaskId` → dex task id. Key the agent record on `session_id`.
3. **State model:** a small per-session state machine driven by event +
   `notification_type`. `Notification{permission_prompt|elicitation_dialog}`
   SETS `blocked`; the *next* `UserPromptSubmit` / `PreToolUse` / `Stop` CLEARS
   it (agent resumed). `Stop` → `idle/done`, `SessionEnd` → `ended`.
4. **Ingestion:** `perch agents report --json -` (reads the payload on stdin),
   one daemon-side store, read by the `agents` plugin.

## 1. Hook events and payloads

From the Claude Code hooks reference (code.claude.com/docs/en/hooks) plus a live
run. Every payload includes these common fields:

```
session_id        stable UUID for the session (the agent's identity key)
transcript_path   absolute path to the session .jsonl transcript
cwd               the directory Claude is running in  ← attribution anchor
hook_event_name   "SessionStart" | "Stop" | "Notification" | ...
permission_mode   present on UserPromptSubmit/PreToolUse/PostToolUse/Stop
```

Event-specific fields we care about:

| Event              | When it fires                                  | Extra fields |
| ------------------ | ---------------------------------------------- | ------------ |
| `SessionStart`     | session starts or resumes                      | `source` = startup\|resume\|clear\|compact; `model`, `agent_type`, `session_title` (optional) |
| `UserPromptSubmit` | user submits a prompt (before Claude runs)     | `prompt` |
| `PreToolUse`       | before a tool call (Claude is actively working)| `tool_name`, `tool_input` |
| `PostToolUse`      | after a tool call succeeds                     | `tool_name`, `tool_input`, `tool_response` |
| `Notification`     | Claude sends a notification (attention/idle)   | `message`, `notification_type` |
| `Stop`             | Claude finishes responding                     | `stop_hook_active`, `effort` |
| `SubagentStop`     | a Task subagent finishes                       | `agent_id`, `agent_type` |
| `SessionEnd`       | session terminates                             | — |

**Environment variables** available to hook commands: `CLAUDE_PROJECT_DIR`,
`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_ENV_FILE`, `CLAUDE_EFFORT`,
`CLAUDE_CODE_REMOTE`. Note `CLAUDE_PROJECT_DIR` is the *project root*, which is
the worktree root — also usable for attribution, but the stdin `cwd` is more
precise and always present, so prefer it.

## 2. Attribution: session → worktree → dex task

The hook payload's **`cwd`** is the attribution anchor. It is the agent's
working directory, which for a dex worktree is the `dex-<id>-<slug>` worktree
path on branch `dex/<id>-<slug>`. Two routes, both already supported by
`plugins/worktrees/src/parse.ts`:

- **Branch route (canonical):** `git -C <cwd> branch --show-current` →
  `parseDexTaskId(branch)` (regex `/^dex\/([a-z0-9]+)/`). Honors the
  `perch.dexTask` git-config override the worktrees plugin already reads.
- **Path route (fallback):** parse the worktree dir basename.

The daemon already enumerates worktrees and computes `taskId` per worktree path
(`worktrees.list`). The `agents` plugin can therefore join purely on `cwd`:
agent.cwd === worktree.path → worktree.taskId, with no new git calls in the
hook itself. **Keep attribution out of the hook** — the hook just forwards
`session_id` + `cwd`; the daemon resolves the task id (it already has the
worktree board).

Confirmed live: a session run from `…/dex-ab12-test-slug` (branch
`dex/ab12-test-slug`) reported `cwd` = that path, and `parseDexTaskId` returned
`ab12`.

## 3. State model + transitions

Per-session state, keyed by `session_id`:

```
running   — actively working (UserPromptSubmit seen, no Stop yet; PreToolUse ticks activity)
blocked   — waiting on the human (a permission/elicitation Notification)
idle      — finished a turn, waiting for the next prompt (Stop, or idle_prompt)
ended     — session terminated (SessionEnd)
error     — see limitations; not a first-class hook signal
```

Transitions (event → new state):

| Trigger                                            | New state |
| -------------------------------------------------- | --------- |
| `SessionStart`                                     | `idle` (or `running` if a prompt follows) |
| `UserPromptSubmit`                                 | `running` (also CLEARS `blocked`) |
| `PreToolUse` / `PostToolUse`                       | `running` (activity heartbeat; CLEARS `blocked`) |
| `Notification` + `notification_type=permission_prompt` | **`blocked`** (needs approval) |
| `Notification` + `notification_type=elicitation_dialog` | **`blocked`** (MCP form open) |
| `Notification` + `notification_type=idle_prompt`   | `idle` (done, awaiting next prompt) |
| `Notification` + `notification_type=elicitation_complete` | CLEARS `blocked` → `running` |
| `Stop`                                             | `idle` (CLEARS `blocked`) |
| `SessionEnd`                                        | `ended` |

**The crucial bit — how "blocked" is set and cleared.** The `Notification` hook
carries a `notification_type`; its values are
`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
`elicitation_complete`, `elicitation_response` (from the hooks guide's matcher
table). `permission_prompt` / `elicitation_dialog` SET `blocked`. There is **no
dedicated "user-responded" event**; instead the resumption is implied — the very
next `PreToolUse`, `UserPromptSubmit`, or `Stop` for that `session_id` means the
agent moved on, so any of those CLEARS `blocked`. `idle_prompt` is the "done,
your turn" signal and maps to `idle`, not `blocked`. This means the daemon
should treat `blocked` as a latch cleared by the next activity event for the
same session, not something the hook explicitly resets.

## 4. Ingestion path

Keep the hook trivial — one command, no logic, stdin pass-through:

`perch agents report` verb shape (a new capability on the future `agents`
plugin, `expose.cli = true`):

```
perch agents report --json -      # read the raw hook JSON payload from stdin
```

The daemon:
1. Parses the payload (`session_id`, `cwd`, `hook_event_name`,
   `notification_type`, `transcript_path`, `tool_name`, `source`).
2. Resolves `cwd` → worktree → `taskId` (reuse the worktrees board / `parseDexTaskId`).
3. Applies the state transition above into a per-session store
   (`Map<session_id, AgentSession>`), with `lastEventAt` for staleness/GC.
4. The `agents` plugin's `agents.list` read renders the fleet view and can
   `notify` on newly-`blocked` agents (mirroring `dex.tasks`/`worktrees.list`).

This matches Perch's existing patterns: a thin CLI verb feeding a daemon store
that a read renders, exposed on MCP so an agent can ask "which of my agents are
blocked?".

### settings.json hooks snippet

User-level (`~/.claude/settings.json`) so it covers every worktree session.
`-` makes `perch agents report` read the payload from stdin:

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ],
    "PreToolUse":       [ { "matcher": "*", "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ],
    "Notification":     [ { "matcher": "*", "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "perch agents report --json -" } ] } ]
  }
}
```

(Drop `PreToolUse` if the activity heartbeat is too chatty; `Stop`/`Notification`
alone give the blocked/idle/done states. `PostToolUse` is optional and noisy.)

## Prototype: what fired

A minimal `report.sh` (reads stdin JSON, `jq`-extracts the fields, appends one
NDJSON line) was wired to the six events above in a **scratch** settings file and
attached to a real `claude -p` run via `--settings <file>` — so the real
`~/.claude/settings.json` was never modified. Run from a fake worktree on branch
`dex/ab12-test-slug`:

```
$ claude -p 'Reply with exactly the word: pong...' \
    --settings /tmp/perch-hooks-spike/.claude/settings.json
pong
```

Recorded events (abridged):

```json
{"event":"SessionStart","session_id":"cac4bf80-…","cwd":"/private/tmp/…/dex-ab12-test-slug","transcript_path":"/Users/…/cac4bf80-….jsonl","source":"startup"}
{"event":"UserPromptSubmit","session_id":"cac4bf80-…","cwd":"/private/tmp/…/dex-ab12-test-slug"}
{"event":"Stop","session_id":"cac4bf80-…","cwd":"/private/tmp/…/dex-ab12-test-slug"}
{"event":"SessionEnd","session_id":"cac4bf80-…","cwd":"/private/tmp/…/dex-ab12-test-slug"}
```

Proven end-to-end:
- Hooks fire and the command receives the full payload on stdin.
- `session_id`, `cwd`, and `transcript_path` are all present and stable across a
  session's events — enough to identify the agent and map it to its worktree.
- `cwd` is the dex worktree path; `parseDexTaskId("dex/ab12-test-slug")` → `ab12`.
- Hooks even fire on a failed/aborted run (the not-logged-in attempt still
  emitted SessionStart/UserPromptSubmit/SessionEnd) — useful, but see error caveat.

(The trivial `pong` prompt used no tools and never blocked, so `PreToolUse` and
`Notification` didn't fire in this run; their payload shapes are taken from the
hooks reference and the `notification_type` matcher table.)

## Limitations & risks

- **No explicit "blocked cleared" event.** `blocked` is a latch cleared by the
  next activity event for the same `session_id`. If a user cancels a permission
  prompt without the agent doing anything else, the latch could go stale —
  mitigate with a `lastEventAt` timeout that downgrades stale `blocked` to
  `idle`.
- **`error` is not a first-class hook signal.** There's no "agent errored" hook.
  A crash/abort surfaces only as `SessionEnd` without a preceding `Stop`, or as
  no further events (stale). Derive `error`/`stale` heuristically from
  `lastEventAt` + missing-`Stop`-before-`SessionEnd`; don't expect a clean flag.
- **Interactive vs `-p`.** This was validated with `claude -p`. Interactive TUI
  sessions fire the same hooks, but `Notification{permission_prompt}` only
  occurs when a tool actually needs approval — under `--dangerously-skip-
  permissions` or full auto-approve it won't fire, so `blocked` would never set.
- **Hook cost / failure isolation.** Each event shells one command; make
  `perch agents report` fast and non-blocking (it must tolerate the daemon being
  down — exit 0 regardless, like the existing vibe-island hooks do, so a stopped
  daemon never stalls the agent).
- **Multiple repos / same branch name.** Attribution keys on `cwd`/worktree
  path, not branch text, so two repos with a `dex/ab12` branch stay distinct.
- **Subagents.** `SubagentStop` (`agent_id`, `agent_type`) shares the parent's
  `cwd`. The fleet view should key on `session_id` and treat subagents as
  children of their session rather than separate worktree rows.
