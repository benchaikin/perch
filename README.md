# 🪶 Perch

**A personal, pluggable developer dashboard that lives pinned to your desktop.**

Perch is a glanceable command center for daily development. It sits in your menu
bar and as an always-on-top panel, surfacing the things you check constantly —
your PR stack and its CI status, and (over time) anything else worth a modular
widget. Everything it can show, it can also *do* and *expose to the command
line*, so the same capabilities are available to you and to your AI tools.

> **Status:** early — design complete, implementation not started. The full
> design lives in [`docs/v1-spec.md`](docs/v1-spec.md); this README is the
> overview.

---

## Why Perch

Modern development means juggling a lot of state at once — multiple branches,
stacked PRs, CI across all of them. Perch's job is to make that state
**glanceable and actionable** from one pinned surface, and to do it in a way
that's equally usable from a GUI, a terminal, and an AI agent.

It's built for one person first (me), but designed to be shareable with
teammates, and cross-platform-friendly.

---

## Core ideas

1. **Headless core, thin frontends.** All capability lives in a background
   daemon (`perchd`). The GUI, the CLI, and a future MCP server are just
   projections of it — so there's one source of truth, one cache, one poller.
2. **Define once, opt into surfaces.** A plugin declares a capability once; each
   surface is opt-in. Defaults: **CLI always on**, **GUI on if it has a view**,
   **MCP off by default**.
3. **CLI is the universal agent interface.** Shell-capable agents (Claude Code,
   Cursor) drive Perch — and underlying tools like `gh stack` — directly through
   the CLI. MCP is reserved for cases that genuinely need it, not bolted onto
   everything.
4. **Cross-platform via abstraction.** macOS first, Linux-friendly; credentials,
   paths, and autostart sit behind small platform shims.

---

## Architecture

```
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Electron app│   │  perch CLI  │   │ MCP server  │   ← thin clients
   │ (panel+menu)│   │  (you / LM) │   │ (deferred)  │
   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
          └─────────────────┼─────────────────┘
                            │  JSON-RPC over a Unix socket
                     ┌──────▼───────┐
                     │   perchd     │  registry · scheduler · cache ·
                     │ (headless)   │  credentials · event bus · plugin host
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │ stack plugin │   (more to come)
                     └──────────────┘
```

| Choice | Decision |
|---|---|
| Language | TypeScript end to end |
| GUI | Electron — menu-bar entry + pinned, always-on-top floating panel |
| Daemon transport | JSON-RPC 2.0 over a Unix socket (`vscode-jsonrpc`) |
| Config | a single `perch.json` (enabled plugins + GUI layout) |
| Credentials | reuses your `gh auth token`; pluggable store for future needs |
| Plugins | loaded from the local `plugins/` dir |

---

## Repo layout

```
perch/
  packages/
    core/    perchd: registry, scheduler, cache, credentials, RPC, event bus
    sdk/     definePlugin/read/action, schemas, shared types
    cli/     `perch …` — thin RPC client, commands generated from the registry
    mcp/     MCP server scaffold (built, mounts nothing in v1)
    gui/     Electron: main (RPC client) + renderer (panel/menu)
  plugins/
    stack/   the v1 plugin
  docs/
    v1-spec.md   ← the full specification
```

---

## Plugins

A plugin declares **capabilities** — `read`s (queries) and `action`s
(mutations) — and the core projects each onto the surfaces it opts into:

```ts
import { definePlugin, read, action, z } from "@perch/sdk";

export default definePlugin({
  id: "stack",
  capabilities: {
    "view": read({
      summary: "The current PR stack with per-layer CI & review status",
      refresh: { every: "60s", on: ["focus"] },
      run: ({ ctx }) => ctx.provider.view(),
      view: { kind: "graph", title: "Stack" },   // → GUI widget
    }),                                            // → `perch stack view --json`
    "sync": action({
      summary: "Cascading rebase of the whole stack onto trunk",
      run: ({ ctx }) => ctx.provider.sync(),
    }),
  },
});
```

### v1 plugin: Stack / PR

Built on GitHub's official [`gh stack`](https://github.com/github/gh-stack)
extension. It renders your stack as a vertical chain — branch, PR number, and
status chips (CI / review / mergeable) with a **needs-rebase** badge — and the
hero **Sync** button runs a cascading rebase of the whole stack. Stacks created
via `gh stack submit`/`link` are read as server-side GitHub objects (visible
across machines), with a base-ref reconstruction fallback for everything else.

---

## Roadmap (v1 milestones)

Tracked sequentially in [dex](https://github.com/zeeg/dex) (epic `ozii55kt`):

| # | Milestone |
|---|---|
| M0 | Scaffold monorepo |
| M1 | Daemon + RPC + registry |
| M2 | Plugin SDK |
| M3 | CLI |
| M4 | Stack provider + `view` read |
| M5 | GUI panel + menu bar |
| M6 | Stack actions + hero Sync |
| M7 | Cross-machine + base-ref fallback |
| M8 | Polish + autostart |

**Not in v1:** MCP mounting (scaffold only), a plugin registry/marketplace,
additional plugins, Windows support.

---

## Requirements

- Node.js + a recent `gh` CLI, authenticated (`gh auth status`)
- `gh stack` extension: `gh extension install github/gh-stack`
- macOS or Linux

---

## License

TBD.
