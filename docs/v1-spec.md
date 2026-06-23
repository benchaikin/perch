# Perch — v1 Specification

> A personal, pluggable developer dashboard that lives pinned to the desktop.
> v1 ships the **headless core + one plugin** (Stack/PR, built on `gh stack`),
> proving the architecture end to end.

---

## 1. Overview

Perch surfaces glanceable, actionable widgets for daily development. It targets
**macOS** primarily, stays **Linux-friendly** via abstractions, and treats the
**CLI as a first-class, agent-drivable interface** alongside the GUI.

v1 scope is deliberately narrow: the core runtime, the plugin SDK, the `perch`
CLI, the Electron GUI (panel + menu bar), and a single **Stack/PR plugin**.

---

## 2. Principles

1. **Headless core, thin frontends.** All capability lives in a background
   daemon; GUI / CLI / (future) MCP are projections of it.
2. **Define once, opt into surfaces.** A capability is declared once; each
   surface is opt-in. Defaults: **CLI always on**, **GUI on if a view is
   declared**, **MCP off by default**.
3. **CLI is the universal agent interface; MCP earns its place.** Shell-capable
   agents (Claude Code, Cursor) use the CLI and native tools (e.g. `gh stack`)
   directly. MCP is reserved for no-shell clients, zero-config typed discovery,
   or a unified cross-plugin surface — none required for v1.
4. **Cross-platform via abstraction.** Credentials, paths, and autostart sit
   behind small platform shims so the same plugin code runs on macOS and Linux.

---

## 3. Architecture

A long-running daemon (`perchd`) owns all state. The Electron app, the `perch`
CLI, and a future MCP server are **thin clients** over JSON-RPC on a local Unix
domain socket.

```
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Electron app│   │  perch CLI  │   │ MCP server  │   ← thin clients
   │ (panel+menu)│   │  (you / LM) │   │ (deferred)  │
   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
          └─────────────────┼─────────────────┘
                            │  JSON-RPC over Unix socket
                     ┌──────▼───────┐
                     │   perchd     │  registry · scheduler · cache ·
                     │ (headless)   │  credential store · event bus ·
                     └──────┬───────┘  plugin host
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                        ▼
   stack plugin                          (future plugins)
```

### Monorepo layout

```
perch/
  packages/
    core/      perchd: registry, scheduler, cache, credential store,
               plugin host, JSON-RPC server, event bus
    sdk/       definePlugin/read/action, schemas, shared types
    cli/       `perch …` — thin RPC client, commands generated from registry
    mcp/       MCP server scaffold (built, mounts nothing in v1)
    gui/       Electron: main (RPC client) + renderer (panel/menu)
  plugins/
    stack/     the v1 plugin
  docs/
    v1-spec.md (this file)
```

---

## 4. Process model

- `perchd` runs continuously; autostarts via **launchd** (macOS) / **systemd
  user unit** (Linux). A `perch daemon {start,stop,status}` command manages it.
- **Transport:** JSON-RPC 2.0 over the Unix socket via **`vscode-jsonrpc`** (the
  LSP library) — handles framing and, crucially, **server-initiated
  notifications** for pushing event-bus deltas to clients.
- Clients connect over the socket. Reads return **cached state instantly**, then
  refresh in the background; the **event bus** pushes deltas to live subscribers
  (GUI live-updates; CLI supports `--watch`).
- **Single source of truth:** one cache, one set of pollers — the GUI, CLI, and
  any agent see identical state and the GitHub API is hit once, not per client.

---

## 5. SDK / capability contract

A plugin declares **capabilities**, each a `read` (query) or `action`
(mutation). The optional `expose` block controls projection; defaults are
computed so it's rarely written by hand.

```ts
import { definePlugin, read, action, z } from "@perch/sdk";

export default definePlugin({
  id: "stack",
  config: z.object({ /* per-plugin config schema */ }),
  capabilities: {
    "view": read({
      summary: "The current PR stack with per-layer CI & review status",
      input:  z.object({ repo: z.string().optional() }),
      output: StackGraph,
      refresh: { every: "60s", on: ["focus"] },
      run: ({ input, ctx }) => ctx.provider.view(input.repo),
      view: { kind: "graph", title: "Stack", node: stackNode },
    }),
    // actions below …
  },
});
```

```ts
type Expose = {
  cli?: boolean;   // default: true
  gui?: boolean;   // default: true IFF a view/button is declared
  mcp?: boolean;   // default: false
};
```

**Resolution & mounting** (core, per capability at load):

| Surface | Default | Mount result |
|---|---|---|
| CLI | `true` | `perch <plugin> <cap> [--json] [--watch]` |
| GUI | `true` if `view`/button declared | widget / button |
| MCP | `false` | typed tool (nothing mounts in v1) |

```
registry.register(cap)
  ├─ cli.mount(cap)  if expose.cli
  ├─ gui.mount(cap)  if expose.gui
  └─ mcp.mount(cap)  if expose.mcp   // dark in v1
```

`ctx` provides: resolved config, credential store, a logger, the event-bus
emitter, and plugin-supplied services (e.g. the stack `provider`).

---

## 6. Config & layout

- **State dir:** `~/Library/Application Support/Perch` (macOS),
  `${XDG_CONFIG_HOME:-~/.config}/perch` (Linux), behind a `paths` shim.
- **Single config file — `perch.yaml`** holds both enabled plugins (+ their
  config) and the GUI widget layout, so the GUI can read/write the whole thing
  as the user rearranges widgets:

  ```yaml
  global:
    repos: [~/ashby, ~/perch]
  plugins:
    stack:
      repos: [ashby/main]
  layout:
    widgets:
      - { id: stack, x: 0, y: 0 }
  ```

  YAML (a JSON superset) so users can comment and hand-edit comfortably. Each
  plugin's section is validated against its `config` zod schema at load.
- **Shared `global` section.** Cross-plugin settings live under `global`, handed
  to every capability as `ctx.global`. `global.repos` is the shared list of local
  repository paths the PRs, Worktrees, and Dex plugins watch; each plugin's own
  repo key (`stack.repos`, `worktrees.repoRoot`, `dex.dirs`) still **overrides**
  the shared list when set. Precedence: per-plugin key → `global.repos` →
  cwd/empty fallback. (`global` also carries the shared terminal preference.)
- **Plugin discovery:** loaded from the local `plugins/` dir (no registry/
  marketplace in v1).

---

## 7. Credentials

- GitHub auth: shell out to **`gh auth token`** — no PATs managed by Perch.
- Wrap secret access behind a `CredentialStore` interface (Keychain / Secret
  Service impls) so future plugins needing their own secrets have a home. Not
  exercised beyond `gh` in v1.

---

## 8. Stack/PR plugin

### 8.1 Provider adapter

All stack operations sit behind one swappable interface (insulates us from
`gh stack` being **private preview**, and enables Graphite/`ghstack` later):

```ts
interface StackProvider {
  view(repo?): Promise<StackGraph>;
  sync(repo?): Promise<SyncResult>;     // may report conflict / needs-resolution
  submit(repo?): Promise<void>;
  push(repo?): Promise<void>;
  add(name?): Promise<void>;
  merge(opts): Promise<void>;           // bottom-up; multi-layer when green
  checkout(ref: string | number): Promise<void>;  // hydrates from GitHub by PR #
  link(refs: (string | number)[]): Promise<void>;  // server-side stack, no local tracking
  unstack(): Promise<void>;
  version(): Promise<string>;           // record gh-stack version (v0.0.5 at spec time)
}
```

> Verified against gh-stack **v0.0.5**: `gh stack view --json` exists (also
> `--short`), and the view computes a **"⚠ Needs rebase"** state itself — so
> `needsRebase` is likely read straight from the JSON, not recomputed by us
> (confirm the exact JSON shape in M4 against a real stack). The full command
> set also includes `modify` (interactive restructure — a future action, not v1)
> and `link` (below).

- **Primary impl — `ghStackProvider`:** wraps `gh stack <cmd>`; `view` composes
  `gh stack view --json` + `gh pr list --json
  number,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName`,
  joined by branch.
- **Cross-machine stacks:** a stack created by `submit` *or* `link` lives as a
  **server-side stack object on GitHub**, so it's visible beyond the machine
  that created it (`.git/gh-stack` local tracking is just a cache). Primary
  cross-machine path: hydrate from GitHub via `gh stack checkout <PR#>` / `view`.
- **Fallback — `baseRefProvider`:** for stacks never submitted/linked as GitHub
  stacks at all, reconstruct the graph by chaining open PRs via
  `base.ref → head.ref` from the GitHub API. Recovers structure without status
  niceties; demoted to secondary now that GitHub holds a server-side object.

### 8.2 The read: `stack.view`

Returns a `StackGraph`: ordered layers, each with branch, PR number, CI rollup,
review decision, mergeable, and **computed** `needsRebase` (base advanced past
this layer) and `conflict` flags. Refreshes every 60s and on panel focus.

### 8.3 Actions

| Capability | Wraps | Notes |
|---|---|---|
| `stack.sync` ⭐ | `gh stack sync` | **Hero action.** Cascading rebase + `git rerere`. Must surface conflict / needs-manual-resolution state — never assume success; stream progress. |
| `stack.submit` | `gh stack submit` | push + create/link PRs |
| `stack.push` | `gh stack push` | lighter than submit |
| `stack.add` | `gh stack add` | new top layer |
| `stack.merge` | `gh stack merge` | bottom-up; multi-layer when CI green |
| `stack.checkout` | `gh stack checkout <n>` | by branch or PR number; hydrates local tracking from GitHub |
| `stack.link` | `gh stack link <refs…>` | create/update a server-side stack without local tracking (external-tool branches) |
| `stack.unstack` | `gh stack unstack` | delete the stack locally and on GitHub |

All actions: CLI + GUI button. **No MCP** in v1 — agents use `gh stack`
directly (it ships its own agent skill) and read enriched state via
`perch stack view --json`.

### 8.4 GUI widget

A vertical **stack graph**: one node per layer (bottom = trunk-adjacent),
showing branch, PR #, and status chips (CI / review / mergeable), with badges
for `needsRebase` and `conflict`. Node actions: open PR, checkout, merge. A
panel-level **Sync** button is the hero control. Keyboard nav maps to
`up`/`down`/`top`/`bottom`.

**Rendering:** hand-rolled. A stack is an ordered linear chain, not an arbitrary
DAG, so we render a vertical list of nodes with simple connectors in React — no
graph-layout library (react-flow/elkjs/d3). Revisit only if non-linear
structures are ever supported.

---

## 9. GUI (Electron)

- **Form factor:** menu-bar (tray) entry that toggles a **pinned, always-on-top
  floating panel**; panel can be torn off and repositioned.
- Renderer subscribes to capability reads via RPC and live-updates from the
  event bus. Layout persisted to `layout.json`.
- Graph rendering library: TBD (open question).

---

## 10. Non-goals (v1)

- MCP **mounting** (server scaffolded, but no capability opts in).
- Plugin registry / marketplace / `perch plugin add`.
- Additional plugins (worktrees, CI, review inbox, etc.).
- Windows support (keep shims clean; don't test).
- Multi-machine sync of local `.git/gh-stack` metadata.

---

## 11. Build milestones

| # | Milestone | Outcome |
|---|---|---|
| M0 | Monorepo scaffold | packages + tooling build |
| M1 | Daemon + RPC + registry | `perchd` runs; clients connect; capabilities register |
| M2 | SDK | `definePlugin`/`read`/`action` + `expose` resolution |
| M3 | CLI | commands auto-generated from registry; `--json`, `--watch` |
| M4 | Stack provider + `view` | `ghStackProvider` + join; `perch stack view --json` works |
| M5 | GUI panel + menu bar | pinned panel renders the stack graph live |
| M6 | Stack actions + Sync | action wrappers; hero Sync with conflict surfacing |
| M7 | Fallback reconstructor | `baseRefProvider` for non-local stacks |
| M8 | Polish + autostart | launchd/systemd; `perch daemon` mgmt; layout persistence |

---

## 12. Resolved decisions

1. **Config format** → single **`perch.yaml`** (plugins + layout in one file;
   GUI owns writes). See §6.
2. **`gh stack` access** → installed **v0.0.5**, publicly available; `repo`
   scope sufficient; `view --json` confirmed. See §8.
3. **Graph rendering** → hand-rolled vertical chain, no layout lib. See §8.4.
4. **Daemon transport** → JSON-RPC 2.0 over Unix socket via **`vscode-jsonrpc`**
   (supports server-initiated notifications). See §4.

### Carried-forward notes

- Capture the exact `gh stack view --json` shape in M4 against a real stack, and
  confirm `needsRebase` is provided rather than computed by us.
- `modify` (interactive restructure) and richer `link` flows are post-v1.
