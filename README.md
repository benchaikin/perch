# 🪶 Perch

**A personal, pluggable developer dashboard that lives pinned to your desktop.**

Perch is a glanceable command center for daily development. It sits in your menu
bar as an always-on-top panel, surfacing the things you check constantly — your
open PRs and their CI/review status across every repo, with stacked PRs grouped
together — and (over time) anything else worth a modular widget. Everything it
can show, it can also *do* and *expose to the command line and AI agents*, so the
same capabilities are available to you and to your tools.

> **Status:** working. The headless daemon, the CLI, the MCP server, the Electron
> app (packaged into a self-contained macOS `.app`), the Stack/PR plugin, desktop
> notifications, and a schema-driven Settings window are all built. The original
> design lives in [`docs/v1-spec.md`](docs/v1-spec.md).

---

## Quick start (macOS)

You need [**pnpm**](https://pnpm.io/installation) and **Node ≥ 22**. Then:

```bash
git clone git@github.com:benchaikin/perch.git && cd perch
pnpm run setup
```

That's the whole install. `pnpm run setup` checks your prerequisites, installs
the [`gh-stack`](https://github.com/github/gh-stack) extension if it's missing,
installs dependencies, **builds and packages the self-contained `Perch.app`**,
clears the Gatekeeper quarantine flag (the app is unsigned), and opens it — no
arch-specific paths and no right-click → Open dance. It takes a couple of minutes
the first time (mostly packaging).

> Perch reuses your **`gh auth token`** for PR data. If the GitHub CLI isn't
> authenticated, setup warns you and keeps going — just run `gh auth login`
> before (or after) opening the app.

Once it's open, the `.app` **self-starts its own background daemon**, so there's
nothing else to run. Look for the 🐦 in your menu bar; click it for the panel.

**First run:** the panel will be empty until you tell it which repos to watch.
Open the menu-bar menu → **Settings…** and add your local repo paths (each must be
a git repo with PRs you've opened). Your PRs appear within ~60s (or hit Refresh).

---

## Other ways to run

**Dev launch** (no packaging; hot to iterate on) — `setup --dev` does the
prereq/install/build steps and then dev-launches instead of packaging:

```bash
pnpm run setup --dev                 # or, by hand:
pnpm --filter @perch/gui build       # tsc + esbuild (also builds the daemon bundle)
pnpm --filter @perch/gui start       # launches the GUI; it self-starts the daemon
```

`pnpm run setup --no-open` does everything but the final launch.

**CLI** — put `perch` and `perchd` on your PATH (writes wrappers into
`~/.local/bin`; opt-in, edits no shell profile; override with `--dir`/`PERCH_BIN_DIR`):

```bash
pnpm bins:install                    # (pnpm bins:uninstall to remove)

perch app                            # open the packaged app (or dev-launch it), ensuring the daemon
perch config repo add ~/path/to/repo # manage watched repos from the terminal
perch config repo list
perch stack prs                      # your open PRs across all repos (--json / --watch)
perch stack view                     # a single repo's stack
perch daemon status                  # start / stop / restart / status
```

Config lives at `~/Library/Application Support/Perch/perch.json` (macOS) or
`${XDG_CONFIG_HOME:-~/.config}/perch/perch.json` (Linux). `perchd` hot-reloads it
on change, so edits from the Settings window, the `perch config` CLI, or by hand
take effect live.

**Shared repositories.** The repos Perch watches live in one place — `global.repos`,
a list of local repo paths shared by the **My PRs**, **Worktrees**, and **Dex**
panels (edit it on the Settings window's **General** tab, or by hand). Each plugin
is enabled by its (possibly empty) entry under `plugins`; `global.repos` then tells
all three which repos to watch:

```json
{
  "plugins": { "stack": {}, "worktrees": {}, "dex": {} },
  "global": {
    "repos": ["/Users/you/work-app", "/Users/you/perch"]
  }
}
```

A plugin's own repo key still **overrides** the shared list when set
(`plugins.stack.repos`, `plugins.worktrees.repoRoot`, `plugins.dex.dirs`) — so you
can, say, watch one set of repos for PRs and a different set for worktrees.
Precedence: per-plugin key → `global.repos` → the daemon's working directory.

---

## What it does

- **My PRs panel** — every open PR you've authored across all configured repos,
  with stacked PRs grouped into a numbered chain. CI / review / mergeable status
  as chips (a spinner while CI builds), a **needs-rebase** badge, and health-colored
  markers (green = clean, red = needs attention). Click a row to open the PR.
- **Hero Sync** — one button cascading-rebases a whole stack onto trunk
  (`gh stack sync`), with in-progress + outcome feedback.
- **Desktop notifications** — native macOS banners when a PR changes status
  (CI pass/fail, approved, changes requested, conflict, needs rebase, opened/closed);
  click to open the PR. The daemon watches even when the panel is closed.
- **Worktrees & Dex panels** — glance at every git worktree across your repos
  (branch, dirty state, ahead/behind) and your open [dex](https://github.com/zeeg/dex)
  tasks (epics → tasks → subtasks). When you run AI agents in parallel worktrees,
  Perch **links each worktree to the dex task it's working** (see below).
- **Settings window** — manage watched repos and per-plugin settings (e.g. stack
  order: base-at-top vs tip-at-top) through schema-driven controls.
- **Everywhere** — the same capabilities are available from the CLI and, for the
  high-value reads, as MCP tools for AI agents.

### Linking dex tasks to worktrees

When you work a dex task in its own git worktree (handy when several AI agents run
in parallel), Perch shows the association in both panels: the **Worktrees** panel
tags the worktree row with its task (`🗒 <id> · <name> · <status>`), and the
**Dex** panel shows the task's live worktree (branch + dirty/ahead-behind) with an
**open-in-terminal** button.

The link is by the worktree's **branch name** — name it `dex/<task-id>-<slug>`
(e.g. `dex/abc12345-fix-login`) and Perch parses the id back out. Already on a
differently-named branch? Set a worktree-local override instead:

```bash
git config extensions.worktreeConfig true   # once per repo
git config --worktree perch.dexTask <task-id>
```

The easiest path is the bundled **`dex-worktree`** skill, which creates a
correctly-named worktree for a dex task and launches an agent in it.

---

## Core ideas

1. **Headless core, thin frontends.** All capability lives in a background daemon
   (`perchd`). The GUI, the `perch` CLI, and the MCP server are just projections
   of it — one source of truth, one cache, one poller.
2. **Define once, opt into surfaces.** A plugin declares a capability once; each
   surface is opt-in. Defaults: **CLI always on**, **GUI on if it has a view**,
   **MCP off by default** (the stack plugin opts `stack.view` + `stack.prs` in).
3. **CLI is the universal agent interface.** Shell-capable agents (Claude Code,
   Cursor) drive Perch — and underlying tools like `gh stack` — directly through
   the CLI. MCP is reserved for reads that genuinely benefit from it.
4. **Cross-platform via abstraction.** macOS first, Linux-friendly; credentials,
   paths, and autostart sit behind small platform shims.

---

## Architecture

```
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Electron app│   │  perch CLI  │   │ MCP server  │   ← thin clients
   │ (panel+menu)│   │  (you / LM) │   │ (perch-mcp) │
   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
          └─────────────────┼─────────────────┘
                            │  JSON-RPC over a Unix socket
                     ┌──────▼───────┐
                     │   perchd     │  registry · scheduler · cache · config ·
                     │ (headless)   │  notifications · event bus · plugin host
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │ stack plugin │   (more to come)
                     └──────────────┘
```

| Choice | Decision |
|---|---|
| Language | TypeScript end to end |
| GUI | Electron — menu-bar entry + pinned, always-on-top panel; packaged via electron-builder |
| Daemon transport | JSON-RPC 2.0 over a Unix socket (`vscode-jsonrpc`) |
| Config | a single `perch.json` — shared `global.repos`, per-plugin settings, GUI layout; hot-reloaded |
| Credentials | reuses your `gh auth token` |
| Plugins | loaded from the local `plugins/` dir (dev) / statically bundled (packaged app) |

---

## Repo layout

```
perch/
  packages/
    core/    perchd: registry, scheduler, cache, config, notifications, RPC, event bus
    sdk/     definePlugin/read/action, settings descriptors, schemas, shared types
    cli/     `perch …` — thin RPC client; commands generated from the registry
    mcp/     `perch-mcp` — stdio MCP server; mounts capabilities that opt into MCP
    gui/     Electron app: bundled main (RPC client) + renderer (panel) + Settings window
  plugins/
    stack/   the Stack / PR plugin
  docs/
    v1-spec.md, prs-view.md   ← specs
```

---

## Plugins

A plugin declares **capabilities** — `read`s (queries) and `action`s (mutations) —
and optional user-facing **settings**; the core projects each onto the surfaces it
opts into:

```ts
import { definePlugin, read, action, z } from "@perch/sdk";

export default definePlugin({
  id: "stack",
  name: "Stack",
  settings: [
    { key: "stackDirection", type: "enum", label: "Stack order",
      default: "bottom-to-top",
      options: [{ value: "bottom-to-top", label: "Base at top" },
                { value: "top-to-bottom", label: "Tip at top" }] },
  ],
  capabilities: {
    prs: read({                                    // → `perch stack prs`, GUI panel, MCP tool
      summary: "Your open PRs across all repos, with stacks grouped",
      refresh: { every: "60s", on: ["focus"] },
      expose: { mcp: true },
      run: ({ ctx }) => buildPrOverview(ctx),
      notify: ({ prev, next }) => prNotifications(prev, next),   // → desktop notifications
    }),
    sync: action({                                 // → `perch stack sync`, GUI Sync button
      summary: "Cascading rebase of the whole stack onto trunk",
      run: ({ ctx }) => provider.sync(),
    }),
  },
});
```

### Stack / PR plugin

Built on GitHub's official [`gh stack`](https://github.com/github/gh-stack)
extension. The **My PRs** read (`stack.prs`) lists your open PRs across every
configured repo with stacked PRs grouped; a single-repo **stack view**
(`stack.view`) renders one stack as a chain. Stacks created via
`gh stack submit`/`link` are read as server-side GitHub objects (visible across
machines), with a base-ref reconstruction fallback for everything else.

---

## What's built

The v1 daemon/SDK/CLI/GUI and the Stack plugin, plus: the cross-repo **My PRs**
view, **MCP** surface (`stack.view` + `stack.prs`), per-repo targeting, dynamic
config reload, a **Settings window** with schema-driven per-plugin config,
**desktop notifications** on PR status changes, and **packaging** into a
self-contained, self-starting macOS `Perch.app`.

**Deferred / not yet:** a repo filter on the panel, per-event notification
toggles, a plugin registry/marketplace, additional plugins, Windows support, and
code-signing/notarization (the app is unsigned — intended for personal use).

---

## Development

```bash
pnpm install
pnpm build           # tsc -b across all packages (type-check + emit)
pnpm -r test         # unit tests (node:test + tsx)
pnpm lint            # eslint
pnpm format          # prettier
```

> The GUI is a build artifact: after any change under `packages/gui` (or the
> daemon/plugin it bundles), rebuild the app with `pnpm --filter @perch/gui dist`
> — that runs the full bundle (`main.js`, `perchd.cjs`) and repackages. Running
> `electron-builder` directly would package a stale `dist/`.

---

## License

[MIT](LICENSE) © Ben Chaikin
