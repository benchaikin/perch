# Perch

Instructions for agents working in this repo. See `README.md` for architecture and core ideas.

## Code style

- **Let the code document itself.** Prefer clean structure, clear names, and small
  functions. Reach for a better name or a smaller function before reaching for a comment.
- **Comment only when it earns its place.** Add a comment when it conveys something the
  code cannot — WHY a non-obvious choice was made, a workaround, an invariant, a gotcha,
  or a link to context. Never write a comment that restates what the code already says.
- **Match the surrounding style when editing.** Don't add narration comments to existing
  code; follow the conventions of the file you're in.
- **Formatting and lint are handled for you.** prettier (`.prettierrc.json`) and eslint
  (`eslint.config.js`) own formatting and lint — don't hand-format or duplicate their work.

## UI feedback for async actions

- **Give in-UI feedback for the real duration of the effect, not just the request.**
  Any user action whose result isn't instantaneous (IPC round-trip, daemon reconcile,
  poll latency) must keep a visible signal alive until the effect is actually
  observable — not until the request resolves.
- **Reach for the established patterns.** The in-flight spinner + disabled control
  (`fa-circle-notch fa-spin`, e.g. `ServicesAutoToggle` / `ServiceActions` /
  `DexAutoSpawnToggle`) and the transient toast (`showNotice` / `Notice`).
- **Watch the request-vs-effect trap.** Feedback that ends when the *request* resolves
  while the *effect* lands a poll later leaves a dead window where the UI looks idle but
  isn't (e.g. flipping Services to Auto: the config write is fast, but the services it
  commands only surface as `starting` on the next poll). Carry the signal through to the
  effect — the daemon surfacing its reconcile-commanded services so the rows spin
  immediately is the fix for that case.
