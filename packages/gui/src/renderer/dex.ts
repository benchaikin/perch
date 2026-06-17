/**
 * The Dex panel: the task tree, the dependency graph, the task detail view, and
 * the per-row / detail-page actions (spawn an agent, spawn all ready, delete).
 * {@link dexSectionEl} is the panel entry the top-level render calls.
 *
 * The panel owns its own interaction state (collapsed epics, the selected task,
 * the view mode, and the in-flight spawn/delete sets) as module-local `let`s and
 * `Set`s here, and redraws via {@link requestRender} — so a Dex feature touches
 * this file, not the shared entry. {@link dexTaskDotEl} and
 * {@link DEX_STATUS_LABEL} are exported for the Worktrees panel, which annotates
 * its rows with the linked task's identity color and status.
 */
import {
  deriveDexGraph,
  isOpenDexTask,
  type DexGraphNode,
  type DexRow,
  type DexSection,
  type DexStatus,
} from "../dex-state.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import type { LandableState } from "../landable.js";
import type { AgentState, AgentSummary } from "../agents-state.js";
import type { LinkedWorktree } from "../worktree-task-link.js";
import type { DexViewMode } from "../window-state.js";
import type { DexEditRequest } from "../ipc.js";
import { requestRender } from "./rerender.js";

/** Collapsed dex epic ids (their descendants are hidden); preserved across re-renders. */
const collapsedDexIds = new Set<string>();
/** The dex task whose detail view is open, if any (else the task list shows). */
let selectedDexId: string | undefined;
/**
 * How the Dex tab renders — `tree` (the hierarchical list) or `graph` (the
 * dependency graph). Seeded from the persisted mode on first render (undefined
 * until then), then the renderer owns the selection; mirrors the active tab.
 */
let dexViewMode: DexViewMode | undefined;
/**
 * Dex task ids whose start button has been clicked and whose spawn is still in
 * flight. Tracked here (not in pushed state) so the optimistic spinner survives
 * re-renders and the button stays disabled — no double-spawn from a double click.
 */
const spawningDexIds = new Set<string>();
/** True while the top-level "spawn all ready" launch is in flight (disables the button). */
let spawningAllDex = false;
/**
 * Whether the "New task from a description" composer is armed (the + control was
 * clicked) — an inline textarea the non-activating panel can rely on instead of a
 * `window.prompt` (the same reason the delete-confirm is in-renderer). Tracked at
 * module scope (not in pushed state) so the armed composer + its draft survive
 * re-renders (e.g. a background board poll mid-type).
 */
let composingNewTask = false;
/** The in-progress description text, preserved across re-renders so a poll can't wipe it. */
let newTaskDraft = "";
/** The selected target project (multi-repo only); undefined defaults to the first. */
let newTaskProject: string | undefined;
/** True while the author-agent launch is in flight (disables the composer, shows a spinner). */
let newTaskInFlight = false;
/**
 * Set when the composer is freshly armed so it grabs focus ONCE on the next render
 * — not on every render, so a background board poll mid-type doesn't steal focus
 * or reset the cursor.
 */
let newTaskJustArmed = false;
/**
 * Dex task ids whose trash control has been armed (a first click) and is awaiting
 * a confirm/cancel — an in-renderer confirmation affordance, since the
 * non-activating panel can't rely on a `window.confirm` dialog. Tracked here (not
 * in pushed state) so the armed state survives re-renders.
 */
const confirmingDeleteDexIds = new Set<string>();
/** Dex task ids whose delete has been confirmed and is still in flight (spinner). */
const deletingDexIds = new Set<string>();
/**
 * The dex task whose detail view is in inline-edit mode (name + description
 * inputs), if any. Tracked here (not in pushed state) so edit mode survives the
 * board's periodic re-render; only one task edits at a time (the detail view
 * shows a single task). Always equals {@link selectedDexId} while set.
 */
let editingDexId: string | undefined;
/**
 * The in-progress edit draft for the task in edit mode — seeded from the row on
 * entering edit mode and updated on each keystroke, so typed content survives a
 * background re-render (which rebuilds the detail from the row, not the live DOM
 * inputs). `undefined` when not editing.
 */
let dexEditDraft: { name: string; description: string } | undefined;
/** True after a save attempt with a blank name — flags the name input invalid
 *  (a task must keep a name) and keeps edit mode open. Cleared on the next edit. */
let dexEditNameInvalid = false;
/** True right after entering edit mode, so the name input grabs focus once. */
let dexEditJustOpened = false;
/** Dex task ids whose inline edit is being saved (in flight) — disables the
 *  Save/Cancel controls and shows a spinner. */
const savingDexIds = new Set<string>();
/**
 * The dex task being dragged to create a dependency edge (drag-and-drop), plus its
 * project — the source of "drop A onto B ⇒ B blocked-by A". Tracked at module scope
 * (not in pushed state) so the drop handler on the target row can read which task
 * was picked up, and so a cross-project drop is rejected before hitting the daemon.
 * `undefined` when no drag is in flight.
 */
let draggingDexId: string | undefined;
let draggingDexProject: string | undefined;
/**
 * When the dragged row is a *nested graph node* (a blocked task drawn under one
 * of its blockers), the id of that specific blocker — the other half of the edge
 * the node currently sits on. Dropping the node onto the "unblock" zone removes
 * exactly this `{ blockedId: draggingDexId, blockerId: draggingDexBlockerId }`
 * edge, leaving the task's other blockers intact. `undefined` when the dragged
 * row has no parent blocker (an unblocked root, or a tree-view row), so the
 * remove gesture stays inert there.
 */
let draggingDexBlockerId: string | undefined;

/**
 * Status-specific marker glyphs for dex task rows. Distinct *shapes* (open
 * circle / half-filled / no-entry / check) so status reads without relying on
 * the color a colorblind viewer can't separate; the health tone layers color.
 */
const DEX_STATUS_ICON: Record<DexStatus, string> = {
  ready: "circle",
  "in-progress": "spinner",
  blocked: "ban",
  done: "circle-check",
};
export const DEX_STATUS_LABEL: Record<DexStatus, string> = {
  ready: "Ready",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done",
};

/**
 * Marker tone (CSS class) for a task's status dot. In-progress reads accent-blue
 * ("actively being worked") rather than the amber its health tone would give;
 * everything else uses its health tone. Keyed off `displayStatus` so an epic
 * rolled up to in-progress (active descendant) gets the active tone too.
 */
function dexMarkerTone(row: DexRow): string {
  return row.displayStatus === "in-progress" ? "dex-active" : row.health;
}

/**
 * Whether a task is ready to hand to a fresh agent: it's an unblocked `ready`
 * row (no active blockers) that isn't already being worked — no live worktree
 * or agent. Such rows get a start button that runs `dex.spawn` (creates the
 * `dex/<id>-<slug>` worktree + seeds an agent). Exported for a unit test, since
 * the row DOM build itself has no jsdom harness.
 */
export function canSpawnDex(row: DexRow): boolean {
  return (
    row.status === "ready" &&
    row.blockedByCount === 0 &&
    row.worktree === undefined &&
    row.agent === undefined
  );
}

/**
 * Full class string for a task's status marker `<i>`: the health tone, the
 * status-shaped Font Awesome glyph, and `fa-spin` for in-progress (the spinner
 * actually spins). Shared by the list row and the detail header so they match.
 */
function dexMarkerClass(row: DexRow): string {
  const spin = row.displayStatus === "in-progress" ? " fa-spin" : "";
  return `dot ${dexMarkerTone(row)} fa-solid fa-${DEX_STATUS_ICON[row.displayStatus]}${spin}`;
}

/**
 * Glanceable spec for each "landable" state a finished work-item's PR can be in,
 * so a task list doubles as a review/merge queue. Each carries a short label, a
 * shared `.chip` tone, and a distinct Font Awesome *shape* (a non-color cue, so
 * the state reads without relying on the red/green hue a colorblind viewer can't
 * separate) — `ci-running` spins. `none` is intentionally absent: it renders no
 * chip. The renderer falls back to a neutral chip for any state not listed here,
 * so a landable state added upstream (e.g. `build-gated`) renders rather than
 * crashes (see {@link LANDABLE_FALLBACK} / {@link dexLandableChipEl}).
 */
const LANDABLE_CHIP: Partial<
  Record<LandableState, { label: string; tone: string; icon: string; spin?: boolean; hint: string }>
> = {
  "needs-review": {
    label: "needs review",
    tone: "warn",
    icon: "eye",
    hint: "CI passing — awaiting review",
  },
  "changes-requested": {
    label: "changes requested",
    tone: "bad",
    icon: "pen",
    hint: "A reviewer requested changes",
  },
  "ci-failed": { label: "CI failed", tone: "bad", icon: "circle-xmark", hint: "CI failed" },
  "ci-running": {
    label: "CI…",
    tone: "muted",
    icon: "arrows-spin",
    spin: true,
    hint: "CI in progress",
  },
  ready: {
    label: "ready to merge",
    tone: "ok",
    icon: "circle-check",
    hint: "CI passing and approved — ready to land",
  },
  merged: { label: "merged", tone: "muted", icon: "code-merge", hint: "Merged" },
};

/** Neutral fallback chip for an unmapped/unknown landable state — renders the
 *  raw state text rather than crashing, so a future state added upstream still
 *  shows up (just without a bespoke label/icon). */
const LANDABLE_FALLBACK = { tone: "muted", icon: "code-pull-request" } as const;

/**
 * Build the "landable" chip for a dex task row from its PR's merge-readiness
 * state, or null for `none` (nothing to land — no chip). Unknown states fall
 * back to a neutral chip labeled with the raw state. Non-interactive: the
 * landable map carries no PR URL, so the chip is glanceable only — clicking the
 * row still opens the task detail.
 */
function dexLandableChipEl(state: LandableState): HTMLElement | null {
  if (state === "none") return null;
  const spec = LANDABLE_CHIP[state];
  const tone = spec?.tone ?? LANDABLE_FALLBACK.tone;
  const chip = document.createElement("span");
  chip.className = `chip ${tone} dex-landable`;
  chip.title = spec?.hint ?? `Landable: ${state}`;
  const icon = document.createElement("i");
  icon.className = `fa-solid fa-${spec?.icon ?? LANDABLE_FALLBACK.icon}${spec?.spin ? " fa-spin" : ""}`;
  chip.append(icon, ` ${spec?.label ?? state}`);
  return chip;
}

/**
 * Glanceable spec for each live-agent lifecycle state, so a task row reads as a
 * fleet at-a-glance. Each carries a distinct Font Awesome *shape* (a non-color
 * cue — the state reads without relying on hue a colorblind viewer can't
 * separate) plus a `.chip` tone: `blocked` is the attention state (warn), `error`
 * is bad, `running` reads accent-blue ("actively working"), `idle`/`ended` are
 * muted. `running` spins. Sits alongside the landable chip on the same row, but
 * deliberately stays OUT of the tray-badge semantics — Vibe Island owns agent
 * attention; this is render-only.
 */
const AGENT_MARKER: Record<
  AgentState,
  { label: string; tone: string; icon: string; spin?: boolean; hint: string }
> = {
  running: {
    label: "running",
    tone: "dex-active",
    icon: "play",
    spin: true,
    hint: "Agent running",
  },
  blocked: {
    label: "blocked",
    tone: "warn",
    icon: "hand",
    hint: "Agent blocked — awaiting input",
  },
  idle: { label: "idle", tone: "muted", icon: "pause", hint: "Agent idle" },
  ended: { label: "done", tone: "muted", icon: "check", hint: "Agent session ended" },
  error: { label: "error", tone: "bad", icon: "triangle-exclamation", hint: "Agent errored" },
};

/**
 * Build the live-agent marker for a dex task row from its session's lifecycle
 * state: a compact `.chip` with a state-shaped icon (see {@link AGENT_MARKER}).
 * The agent's `message` (the latest notification, when present) enriches the
 * tooltip. Non-interactive — glanceable only; clicking the row still opens detail.
 */
function dexAgentMarkerEl(agent: AgentSummary): HTMLElement {
  const spec = AGENT_MARKER[agent.state];
  const chip = document.createElement("span");
  chip.className = `chip ${spec.tone} dex-agent`;
  chip.title = agent.message ? `${spec.hint}: ${agent.message}` : spec.hint;
  const icon = document.createElement("i");
  icon.className = `fa-solid fa-${spec.icon}${spec.spin ? " fa-spin" : ""}`;
  chip.append(icon, ` ${spec.label}`);
  return chip;
}

/** A small blocker-count chip ("blocked ×N"). */
function dexBlockedChip(count: number): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "chip bad";
  badge.title = `Blocked by ${count} task${count === 1 ? "" : "s"}`;
  badge.textContent = `blocked ×${count}`;
  return badge;
}

/**
 * A small SOLID dot in a dex task's stable identity color — the primary
 * at-a-glance cue that matches a task to its linked worktree / agent. Mirrors
 * the `.tab-dot` status dot's sizing, but tinted with the per-task
 * {@link dexTaskColor} (the same source the chip's faint fill uses) so a task
 * row and its worktree row visibly share one "team color". Rendered only for
 * open tasks, where that identity color is meaningful.
 */
export function dexTaskDotEl(id: string): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "dex-task-dot";
  dot.style.background = dexTaskColor(id).hex;
  return dot;
}

/**
 * The task id as a monospace reference chip (for `dex show`, commit messages,
 * etc.). Click to copy it to the clipboard with a brief inline confirmation;
 * `stopPropagation` so copying never opens the row's detail view.
 *
 * When `open` (the task is unblocked and unfinished — see {@link isOpenDexTask}),
 * the chip carries the task's stable identity color from the shared
 * {@link dexTaskColor}: a `dex-open` class plus the `--task-color`/`--task-color-rgb`
 * custom properties the CSS tints from. This is an identity ACCENT layered on the
 * neutral chip, distinct from the row's health marker — the id text stays legible
 * on both themes (the color rides the chip's border/tint, not the glyphs).
 */
function dexIdChipEl(id: string, open = false): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "chip muted dex-id";
  chip.title = "Copy task id";
  chip.textContent = id;
  if (open) {
    const color = dexTaskColor(id);
    chip.classList.add("dex-open");
    chip.style.setProperty("--task-color", color.hex);
    chip.style.setProperty("--task-color-rgb", `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`);
  }
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    window.perch.copyText(id);
    // Brief inline confirmation; reverts after a moment (a re-render would also
    // recreate the chip, which is fine — this closure just no-ops on the stale el).
    chip.textContent = "copied ✓";
    chip.classList.add("copied");
    setTimeout(() => {
      chip.textContent = id;
      chip.classList.remove("copied");
    }, 1000);
  });
  return chip;
}

/**
 * Build one dex task row: an expand/collapse chevron (epics) or aligning spacer
 * (leaves), a status-shaped marker, the name, and an optional blocker chip.
 * Clicking the row body opens the task's detail; clicking an epic's chevron
 * toggles its children (without opening detail).
 */
function dexRowEl(row: DexRow): HTMLElement {
  const el = document.createElement("div");
  el.className = `row dex-row${row.isEpic ? " dex-epic" : ""}`;
  // Indent by tree depth so epics → tasks → subtasks read as a hierarchy.
  el.style.paddingLeft = `${row.depth * 14}px`;
  const blockedHint = row.blockedByCount > 0 ? ` (blocked by ${row.blockedByCount})` : "";
  el.title = `${row.name} — ${DEX_STATUS_LABEL[row.status]}${blockedHint}`;

  if (row.isEpic) {
    const collapsed = collapsedDexIds.has(row.id);
    const chevron = document.createElement("button");
    chevron.className = "dex-chevron";
    chevron.title = collapsed ? "Expand" : "Collapse";
    chevron.setAttribute("aria-label", chevron.title);
    const ci = document.createElement("i");
    ci.className = `fa-solid fa-chevron-${collapsed ? "right" : "down"}`;
    chevron.append(ci);
    chevron.addEventListener("click", (e) => {
      // Toggle children without triggering the row's open-detail click.
      e.stopPropagation();
      if (collapsed) collapsedDexIds.delete(row.id);
      else collapsedDexIds.add(row.id);
      requestRender();
    });
    el.append(chevron);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "dex-chevron-spacer";
    el.append(spacer);
  }

  const marker = document.createElement("i");
  marker.className = dexMarkerClass(row);
  marker.title = DEX_STATUS_LABEL[row.displayStatus];
  el.append(marker);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = row.name;
  el.append(name);

  // The task id as a click-to-copy chip, matching the detail view; an open
  // (unblocked, unfinished) task leads with a solid identity-color dot, then the
  // chip (which carries the same color as a faint backing tint).
  if (isOpenDexTask(row)) el.append(dexTaskDotEl(row.id));
  el.append(dexIdChipEl(row.id, isOpenDexTask(row)));

  if (row.blockedByCount > 0) el.append(dexBlockedChip(row.blockedByCount));

  // When the task's worktree branch matches an open PR, surface that PR's
  // merge-readiness as a chip so the task list reads as a review/merge queue.
  if (row.landable) {
    const landable = dexLandableChipEl(row.landable);
    if (landable) el.append(landable);
  }

  // When a live Claude Code session is on this task, surface its lifecycle state
  // (running / blocked / done / error) so the list reads as a fleet at-a-glance.
  if (row.agent) el.append(dexAgentMarkerEl(row.agent));

  // When a live git worktree is linked to this task, surface it (branch + git
  // health) with an open-in-terminal affordance.
  if (row.worktree) el.append(dexWorktreeEl(row.worktree));

  // A ready, unblocked, unworked task gets a start button that spawns an agent.
  if (canSpawnDex(row)) el.append(dexSpawnBtnEl(row.id));

  // Every task gets a trash control (a confirmed delete), so a mistaken/duplicate
  // task can be cleared straight from the row.
  el.append(dexDeleteControlEl(row));

  // Drag this row onto another to wire a dependency (drop A onto B ⇒ B blocked-by A).
  makeDexRowDraggable(el, row);

  el.addEventListener("click", () => {
    selectedDexId = row.id;
    requestRender();
  });
  return el;
}

/** A pre-formatted, wrapping text block for the detail view (description / result). */
function dexBodyEl(text: string): HTMLElement {
  const body = document.createElement("pre");
  body.className = "dex-detail-body";
  body.textContent = text;
  return body;
}

/**
 * The launch control for the task detail view: a compact, labeled button that
 * runs `dex.spawn` (`window.perch.dexSpawn`) for the open task — the detail-page
 * twin of the per-row {@link dexSpawnBtnEl} play button, reusing the same bridge
 * path. Only built for {@link canSpawnDex} rows (ready, unblocked, unworked), so
 * a started task shows its agent/worktree status here instead.
 */
function dexDetailSpawnBtnEl(id: string): HTMLElement {
  const btn = document.createElement("button");
  // Labeled `.btn.btn-sm` (room to spell it out on the detail page) plus the
  // shared `dex-spawn` hook the row button uses.
  btn.className = "btn btn-sm dex-spawn dex-detail-spawn";
  const inFlight = spawningDexIds.has(id);
  btn.disabled = inFlight;
  btn.title = inFlight ? "Starting agent…" : "Start an agent for this task";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  // A spinner + "Starting…" while the worktree is created and the agent launches.
  i.className = inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-play";
  btn.append(i, inFlight ? " Starting…" : " Start agent");
  if (!inFlight) btn.addEventListener("click", () => void runDexSpawn(id));
  return btn;
}

/** Build the task detail view: a back affordance, the task header, meta chips, body + result. */
function dexDetailEl(row: DexRow): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dex-detail";

  // Edit mode swaps the name into a text input, the description into a textarea,
  // and the actions row into Save/Cancel (see dexEnterEdit / runDexEdit).
  const editing = editingDexId === row.id;

  const back = document.createElement("button");
  back.className = "btn btn-sm dex-back";
  const bi = document.createElement("i");
  bi.className = "fa-solid fa-arrow-left";
  back.append(bi, " Tasks");
  back.addEventListener("click", () => {
    // Leaving the detail also abandons any in-progress edit.
    dexExitEdit();
    selectedDexId = undefined;
    requestRender();
  });
  wrap.append(back);

  const head = document.createElement("div");
  head.className = "dex-detail-head";
  const marker = document.createElement("i");
  marker.className = dexMarkerClass(row);
  if (editing) {
    head.append(marker, dexNameInputEl(row));
  } else {
    const title = document.createElement("span");
    title.className = "dex-detail-title";
    title.textContent = row.name;
    head.append(marker, title);
  }
  wrap.append(head);

  const meta = document.createElement("div");
  meta.className = "dex-detail-meta";
  // The task id leads the meta row as a monospace reference (for `dex show`,
  // commit messages, etc.). Click to copy it to the clipboard.
  meta.append(dexIdChipEl(row.id));
  const status = document.createElement("span");
  status.className = `chip ${row.health}`;
  status.textContent = DEX_STATUS_LABEL[row.status];
  meta.append(status);
  if (row.project) {
    const proj = document.createElement("span");
    proj.className = "chip muted";
    proj.textContent = row.project;
    meta.append(proj);
  }
  if (row.blockedByCount > 0) meta.append(dexBlockedChip(row.blockedByCount));
  if (row.landable) {
    const landable = dexLandableChipEl(row.landable);
    if (landable) meta.append(landable);
  }
  if (row.agent) meta.append(dexAgentMarkerEl(row.agent));
  wrap.append(meta);

  // The actions row. In edit mode it's Save/Cancel; otherwise the spawn launch
  // (for a ready, unblocked, unworked task — canSpawnDex excludes live
  // agent/worktree tasks, so the agent marker above stands in then), the Edit
  // button, and the labeled delete control (twins of the per-row controls).
  const actions = document.createElement("div");
  actions.className = "dex-detail-actions";
  if (editing) {
    actions.append(dexEditSaveBtnEl(row), dexEditCancelBtnEl());
  } else {
    if (canSpawnDex(row)) actions.append(dexDetailSpawnBtnEl(row.id));
    actions.append(dexDetailEditBtnEl(row));
    actions.append(dexDeleteControlEl(row, true));
  }
  wrap.append(actions);

  if (editing) {
    // The description as a textarea, seeded from the draft — a multi-line editor
    // so the description's line breaks are preserved faithfully.
    wrap.append(dexDescriptionTextareaEl(row));
    return wrap;
  }

  if (row.description) wrap.append(dexBodyEl(row.description));
  if (row.result) {
    const label = document.createElement("div");
    label.className = "dex-detail-label";
    label.textContent = "Result";
    wrap.append(label, dexBodyEl(row.result));
  }
  return wrap;
}

/**
 * Enter inline-edit mode for the detail screen's task: seed the draft from the
 * row's current name/description and flag the name input to grab focus on the
 * next render. The draft (not the live DOM inputs) is the source of truth, so a
 * background board re-render rebuilds the editor without losing typed content.
 */
function dexEnterEdit(row: DexRow): void {
  editingDexId = row.id;
  dexEditDraft = { name: row.name, description: row.description };
  dexEditNameInvalid = false;
  dexEditJustOpened = true;
}

/** Leave inline-edit mode and drop the draft (cancel, save-complete, or navigate away). */
function dexExitEdit(): void {
  editingDexId = undefined;
  dexEditDraft = undefined;
  dexEditNameInvalid = false;
  dexEditJustOpened = false;
}

/**
 * The detail screen's "Edit" button: switches the read-only detail into inline
 * edit mode (name input + description textarea), seeding the draft from the row.
 * Sits in the actions row alongside Spawn/Delete — closing the
 * create/spawn/delete/edit loop on the panel.
 */
function dexDetailEditBtnEl(row: DexRow): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "btn btn-sm dex-edit-btn";
  btn.title = "Edit this task's name and description";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  i.className = "fa-solid fa-pen";
  btn.append(i, " Edit");
  btn.addEventListener("click", () => {
    dexEnterEdit(row);
    requestRender();
  });
  return btn;
}

/**
 * The name text input for edit mode, seeded from the draft and bound to it on
 * input (so typing survives a re-render). Enter saves, Escape cancels. Flags
 * invalid (a blank name) after a rejected save. Grabs focus once on entering edit
 * mode. The `if (!dexEditDraft)` seed is a safety net — {@link dexEnterEdit}
 * normally seeds the draft before this renders.
 */
function dexNameInputEl(row: DexRow): HTMLInputElement {
  if (!dexEditDraft) dexEditDraft = { name: row.name, description: row.description };
  const input = document.createElement("input");
  input.type = "text";
  input.className = `dex-edit-name${dexEditNameInvalid ? " invalid" : ""}`;
  // Carries focus + caret across a board-poll re-render (see panel-focus.ts).
  input.setAttribute("data-focus-key", "dex-edit-name");
  input.value = dexEditDraft.name;
  input.placeholder = "Task name";
  input.setAttribute("aria-label", "Task name");
  if (dexEditNameInvalid) input.setAttribute("aria-invalid", "true");
  input.addEventListener("input", () => {
    if (dexEditDraft) dexEditDraft.name = input.value;
    if (dexEditNameInvalid && input.value.trim() !== "") {
      dexEditNameInvalid = false;
      input.classList.remove("invalid");
      input.removeAttribute("aria-invalid");
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dexExitEdit();
      requestRender();
    } else if (e.key === "Enter") {
      // Single-line name field: Enter commits (the textarea keeps Enter for newlines).
      e.preventDefault();
      void runDexEdit(row);
    }
  });
  // Focus + select once, when edit mode first opens.
  if (dexEditJustOpened) {
    dexEditJustOpened = false;
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
  return input;
}

/**
 * The description textarea for edit mode, seeded from the draft and bound to it on
 * input (so multi-line content survives a re-render). Escape cancels; Enter inserts
 * a newline as usual (only the name field commits on Enter). An empty value is a
 * legitimate clear.
 */
function dexDescriptionTextareaEl(row: DexRow): HTMLTextAreaElement {
  if (!dexEditDraft) dexEditDraft = { name: row.name, description: row.description };
  const area = document.createElement("textarea");
  area.className = "dex-edit-description";
  // Carries focus + caret across a board-poll re-render (see panel-focus.ts).
  area.setAttribute("data-focus-key", "dex-edit-description");
  area.value = dexEditDraft.description;
  area.placeholder = "Description (optional)";
  area.setAttribute("aria-label", "Task description");
  area.rows = 8;
  area.addEventListener("input", () => {
    if (dexEditDraft) dexEditDraft.description = area.value;
  });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dexExitEdit();
      requestRender();
    }
  });
  return area;
}

/**
 * The Save (✓) control for edit mode: commits the draft via {@link runDexEdit}.
 * Shows a spinner while the save is in flight.
 */
function dexEditSaveBtnEl(row: DexRow): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "btn btn-sm dex-edit-save";
  const inFlight = savingDexIds.has(row.id);
  btn.disabled = inFlight;
  btn.title = inFlight ? "Saving…" : "Save changes";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  i.className = inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-check";
  btn.append(i, inFlight ? " Saving…" : " Save");
  if (!inFlight) btn.addEventListener("click", () => void runDexEdit(row));
  return btn;
}

/** The Cancel (✗) control for edit mode: discards the draft and leaves edit mode. */
function dexEditCancelBtnEl(): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "btn btn-sm dex-edit-cancel";
  btn.title = "Cancel";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  i.className = "fa-solid fa-xmark";
  btn.append(i, " Cancel");
  btn.addEventListener("click", () => {
    dexExitEdit();
    requestRender();
  });
  return btn;
}

/**
 * Commit the inline edit: validate a non-blank name, compute which fields changed
 * vs the row (so unchanged fields aren't sent), and — if anything changed — save
 * via `window.perch.dexEdit`. A blank name flags the input invalid and stays in
 * edit mode; a no-op (nothing changed) just leaves edit mode without a call. While
 * the save is in flight the id sits in `savingDexIds` (spinner); on completion edit
 * mode closes and the board refresh (driven from main) reflects the change.
 */
async function runDexEdit(row: DexRow): Promise<void> {
  const id = row.id;
  if (savingDexIds.has(id) || !dexEditDraft) return;

  const name = dexEditDraft.name.trim();
  if (name === "") {
    // A task must keep a name — flag the field and stay in edit mode.
    dexEditNameInvalid = true;
    dexEditJustOpened = true; // re-focus the field
    requestRender();
    return;
  }

  // Only send the fields that actually changed (description compared verbatim so a
  // whitespace-only edit still counts; an empty description is a valid clear).
  const request: DexEditRequest = { id };
  if (name !== row.name) request.name = name;
  if (dexEditDraft.description !== row.description) request.description = dexEditDraft.description;

  if (request.name === undefined && request.description === undefined) {
    // No-op: nothing changed. Leave edit mode quietly without a daemon round-trip.
    dexExitEdit();
    requestRender();
    return;
  }

  savingDexIds.add(id);
  requestRender();
  try {
    await window.perch.dexEdit(request);
  } finally {
    savingDexIds.delete(id);
    // Leave edit mode on completion; the board refresh from main updates the row.
    dexExitEdit();
    requestRender();
  }
}

/** The mode shown after toggling away from `mode` — the two-state flip. */
function nextDexViewMode(mode: DexViewMode): DexViewMode {
  return mode === "tree" ? "graph" : "tree";
}

/**
 * Per-mode affordance for the view-mode toggle: the Font Awesome glyph for the
 * CURRENT mode and a label naming what a click switches TO, so the button reads
 * as "you're in tree view; click to see the graph" (and vice versa).
 */
const DEX_VIEW_MODE_BTN: Record<DexViewMode, { icon: string; switchLabel: string }> = {
  tree: { icon: "sitemap", switchLabel: "Switch to graph view" },
  graph: { icon: "diagram-project", switchLabel: "Switch to tree view" },
};

/**
 * Build the view-mode toggle: an icon-only button reflecting the CURRENT mode
 * (tree → sitemap, graph → diagram). Clicking flips the mode, persists it
 * (mirroring tab selection), and re-renders the Dex section from the last state.
 */
function dexViewToggleEl(mode: DexViewMode): HTMLElement {
  const { icon, switchLabel } = DEX_VIEW_MODE_BTN[mode];
  const btn = document.createElement("button");
  // Same subtle borderless icon-button style as the collapse-all control.
  btn.className = "icon-btn dex-view-toggle";
  btn.title = switchLabel;
  btn.setAttribute("aria-label", switchLabel);
  const i = document.createElement("i");
  i.className = `fa-solid fa-${icon}`;
  btn.append(i);
  btn.addEventListener("click", () => {
    const next = nextDexViewMode(mode);
    dexViewMode = next;
    window.perch.setDexViewMode(next); // persist so it's restored next open
    requestRender();
  });
  return btn;
}

/**
 * The top-level "spawn all ready" control for the Dex section: one click runs
 * `dex.spawn-all` (`window.perch.dexSpawnReady`) to create a worktree + seeded
 * agent for every ready task at once — the fleet counterpart of the per-row
 * {@link dexSpawnBtnEl}. The label carries the ready `count` so it reads as
 * "spawn agents for N ready tasks"; only rendered when `count > 0`.
 */
function dexSpawnReadyBtnEl(count: number): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn dex-spawn-all";
  btn.disabled = spawningAllDex;
  const label = spawningAllDex
    ? `Spawning ${count} ready task${count === 1 ? "" : "s"}…`
    : `Spawn agents for ${count} ready task${count === 1 ? "" : "s"}`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  const i = document.createElement("i");
  // A spinner while every ready task's worktree + agent terminal is launched.
  i.className = spawningAllDex ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-rocket";
  btn.append(i);
  if (!spawningAllDex) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void runDexSpawnReady();
    });
  }
  return btn;
}

/**
 * Drive the "spawn all ready" button's optimistic-spawn flow: mark the fleet
 * launch in flight so the next render disables the button and shows a spinner,
 * kick it off, then clear the mark when it resolves (or fails) — re-rendering at
 * each step. Guards against a second launch while one is in flight. The
 * "Spawned N of M" summary notice is pushed from main via panel state.
 */
async function runDexSpawnReady(): Promise<void> {
  if (spawningAllDex) return;
  spawningAllDex = true;
  requestRender();
  try {
    await window.perch.dexSpawnReady();
  } finally {
    spawningAllDex = false;
    requestRender();
  }
}

/**
 * The distinct project labels present on the board, in first-seen order — the
 * targets the New-task composer offers when more than one dex repo has tasks
 * (so the author agent's `dex create` lands in an unambiguous store). Tasks from
 * the daemon's own cwd store carry no project, so a single-store board yields `[]`
 * (the composer then needs no selector — the daemon resolves the sole repo).
 */
function dexProjects(section: DexSection): string[] {
  const seen = new Set<string>();
  for (const row of section.rows) {
    if (row.project) seen.add(row.project);
  }
  return [...seen];
}

/**
 * The project the New-task composer submits, given the board's distinct projects:
 * none when there are zero (single store — the daemon resolves the sole repo), the
 * lone project when there's exactly one (unambiguous, so no selector is shown), or
 * the user's pick (defaulting to the first) when several repos have tasks.
 */
function newTaskTargetProject(projects: string[]): string | undefined {
  if (projects.length === 0) return undefined;
  if (projects.length === 1) return projects[0];
  return newTaskProject ?? projects[0];
}

/**
 * The "New task from a description" control: a + button that arms the inline
 * composer (toggling it closed if already open). The create-a-task counterpart to
 * the per-row spawn play button — that spawns an agent FOR a task; this spawns one
 * to AUTHOR a task. Click doesn't bubble to the section/row open-detail.
 */
function dexNewBtnEl(): HTMLElement {
  const btn = document.createElement("button");
  btn.className = `icon-btn dex-new${composingNewTask ? " dex-new-active" : ""}`;
  btn.title = "New task from a description";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  i.className = "fa-solid fa-plus";
  btn.append(i);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    composingNewTask = !composingNewTask;
    if (composingNewTask) {
      newTaskJustArmed = true; // focus the textarea once, on the next render
    } else {
      // Closing via the toggle discards the draft (matching the ✗ cancel).
      newTaskDraft = "";
      newTaskProject = undefined;
    }
    requestRender();
  });
  return btn;
}

/**
 * Build the armed New-task composer: an inline textarea (an affordance the
 * non-activating panel can rely on, unlike `window.prompt`), an optional project
 * selector (only when several repos have tasks, so the target store is
 * unambiguous), and submit (✓) / cancel (✗) controls. Enter submits, Shift+Enter
 * inserts a newline, Esc cancels; an empty/whitespace description disables submit;
 * an in-flight launch shows a spinner and disables the controls. The draft text is
 * mirrored into module state on every keystroke so a background board poll's
 * re-render can't wipe it.
 */
function dexNewComposerEl(projects: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dex-new-composer";
  // Clicks inside the composer must never bubble to a row/section open-detail.
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const canSubmit = (): boolean => !newTaskInFlight && newTaskDraft.trim().length > 0;

  // Build the submit button first so the textarea's input handler can toggle its
  // disabled state directly (no full re-render — that would steal focus mid-type).
  const submit = document.createElement("button");
  submit.className = "icon-btn dex-new-submit";
  submit.disabled = !canSubmit();
  submit.title = newTaskInFlight ? "Spawning the author agent…" : "Create task (Enter)";
  submit.setAttribute("aria-label", submit.title);
  const si = document.createElement("i");
  si.className = newTaskInFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-check";
  submit.append(si);
  submit.addEventListener("click", () => void runDexNew(projects));

  const textarea = document.createElement("textarea");
  textarea.className = "dex-new-input";
  // Lets render() carry focus + caret onto the rebuilt node across a board poll
  // (see panel-focus.ts), so typing isn't interrupted every ~5s.
  textarea.setAttribute("data-focus-key", "dex-new-input");
  textarea.placeholder =
    "Describe the task you want — an agent will read the code and author it.";
  textarea.rows = 3;
  textarea.value = newTaskDraft;
  textarea.disabled = newTaskInFlight;
  textarea.addEventListener("input", () => {
    newTaskDraft = textarea.value;
    submit.disabled = !canSubmit();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // Enter submits; Shift+Enter falls through to a newline.
      void runDexNew(projects);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelDexNew();
    }
  });
  wrap.append(textarea);

  const controls = document.createElement("div");
  controls.className = "dex-new-controls";

  // A project selector only when several repos' tasks share the board, so the
  // target store is unambiguous; one (or zero) project needs no choice.
  if (projects.length > 1) {
    const select = document.createElement("select");
    select.className = "dex-new-project";
    select.disabled = newTaskInFlight;
    select.title = "Target repository";
    const selected = newTaskProject ?? projects[0];
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      if (p === selected) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      newTaskProject = select.value;
    });
    controls.append(select);
  }

  const cancel = document.createElement("button");
  cancel.className = "icon-btn dex-new-cancel";
  cancel.disabled = newTaskInFlight;
  cancel.title = "Cancel (Esc)";
  cancel.setAttribute("aria-label", cancel.title);
  const xi = document.createElement("i");
  xi.className = "fa-solid fa-xmark";
  cancel.append(xi);
  cancel.addEventListener("click", () => cancelDexNew());

  controls.append(submit, cancel);
  wrap.append(controls);

  // Grab focus once, when the composer is freshly armed (queued so the element is
  // in the DOM first). Not on every render, so a board poll mid-type can't steal it.
  if (newTaskJustArmed) {
    newTaskJustArmed = false;
    queueMicrotask(() => {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }

  return wrap;
}

/**
 * Drive the New-task composer's submit: launch the author agent for the trimmed
 * draft (with the resolved target project), mark it in flight so the next render
 * shows a spinner + disables the controls, then on completion close the composer
 * and clear the draft (re-rendering at each step). Guards against a second launch
 * while one is in flight, and against an empty description. The success/error
 * notice is pushed from main via panel state.
 */
async function runDexNew(projects: string[]): Promise<void> {
  const description = newTaskDraft.trim();
  if (!description || newTaskInFlight) return;
  newTaskInFlight = true;
  requestRender();
  try {
    await window.perch.dexNew({ description, project: newTaskTargetProject(projects) });
    // The launch resolved (the agent is authoring the task) — close + reset.
    composingNewTask = false;
    newTaskDraft = "";
    newTaskProject = undefined;
  } finally {
    newTaskInFlight = false;
    requestRender();
  }
}

/** Close the New-task composer and discard its draft (the ✗ cancel / Esc). */
function cancelDexNew(): void {
  composingNewTask = false;
  newTaskDraft = "";
  newTaskProject = undefined;
  requestRender();
}

/**
 * Build the Dex section header: the tree/graph view-mode toggle, a top-level
 * "spawn all ready" button when any tasks are ready, plus — when there are
 * epics — an expand/collapse-all toggle over them.
 */
function dexHeaderEl(epicIds: string[], mode: DexViewMode, readyCount: number): HTMLElement {
  const header = document.createElement("div");
  header.className = "repo-header dex-header";

  header.append(dexViewToggleEl(mode));

  // "New task from a description": arms an inline composer that spawns an agent to
  // author a task. Sits by the spawn-all rocket — the create-a-task counterpart to
  // spawn (which spawns an agent FOR an existing task).
  header.append(dexNewBtnEl());

  // Fleet launch: spawn an agent for every ready task at once. Hidden when
  // nothing is ready (no-op would just toast "no ready tasks").
  if (readyCount > 0) header.append(dexSpawnReadyBtnEl(readyCount));

  // Collapse-all only applies to the tree's epics — skip it in graph mode and
  // when there are no epics to fold.
  if (mode === "tree" && epicIds.length > 0) {
    const allCollapsed = epicIds.every((id) => collapsedDexIds.has(id));
    const btn = document.createElement("button");
    // Icon-only, minimalist — reuse the header's subtle borderless icon-button style.
    btn.className = "icon-btn dex-toggle-all";
    const label = allCollapsed ? "Expand all" : "Collapse all";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    const icon = document.createElement("i");
    icon.className = `fa-solid fa-${allCollapsed ? "angles-down" : "angles-up"}`;
    btn.append(icon);
    btn.addEventListener("click", () => {
      if (allCollapsed) collapsedDexIds.clear();
      else for (const id of epicIds) collapsedDexIds.add(id);
      requestRender();
    });
    header.append(btn);
  }

  return header;
}

/**
 * Build the "Dex" section. With a task selected it shows that task's detail;
 * otherwise the tree: an expand/collapse-all header (when there are epics) and
 * the pre-ordered rows, skipping any hidden beneath a collapsed ancestor.
 * Returns null when hidden (no dex plugin / no tasks).
 *
 * The view mode is seeded from `savedMode` on first render (mirroring the active
 * tab), then this panel owns the selection — so the saved mode shows immediately
 * on open with no flash of the wrong view.
 */
export function dexSectionEl(
  section: DexSection,
  savedMode: DexViewMode | undefined,
): HTMLElement | null {
  if (!section.visible) return null;
  const mode = dexViewMode ?? savedMode ?? "tree";
  dexViewMode = mode;
  const el = document.createElement("section");
  el.className = "repo-section dex-section";

  // Detail view takes over the pane when a (still-present) task is selected.
  if (selectedDexId !== undefined) {
    const selected = section.rows.find((r) => r.id === selectedDexId);
    if (selected) {
      el.append(dexDetailEl(selected));
      return el;
    }
    selectedDexId = undefined; // selection went away (task completed/removed)
    dexExitEdit(); // drop any in-progress edit for the now-gone task
  }

  // Plugin present but nothing open (e.g. everything's completed) — show an
  // empty state rather than a blank pane, so the tab still reads as "Dex". The
  // header (and its New-task composer) still render, so the first task can be
  // authored from an empty board.
  if (section.rows.length === 0) {
    el.append(dexHeaderEl([], mode, 0));
    if (composingNewTask) el.append(dexNewComposerEl([]));
    const empty = document.createElement("div");
    empty.className = "message";
    empty.textContent = "No open tasks";
    el.append(empty);
    return el;
  }

  // The header carries the tree/graph toggle (always) plus, in tree mode, the
  // collapse-all control over any epics.
  const epicIds = section.rows.filter((r) => r.isEpic).map((r) => r.id);
  const readyCount = section.rows.filter(canSpawnDex).length;
  el.append(dexHeaderEl(epicIds, mode, readyCount));

  // The armed New-task composer sits between the header and the rows, full-width.
  // Its project selector offers the distinct projects on the board (so a
  // multi-repo target is unambiguous).
  if (composingNewTask) el.append(dexNewComposerEl(dexProjects(section)));

  // Graph mode walks the blocker edges (`blockedBy`) instead of the task tree;
  // tree mode is the original pre-ordered render, completely unchanged.
  if (mode === "graph") dexGraphRows(el, section);
  else dexTreeRows(el, section);
  return el;
}

/**
 * Append the dependency-graph forest to `el`: the unblocked tasks as roots, each
 * blocked task nested under every blocker it waits on (so it can repeat when
 * several tasks gate it). Derivation lives in `deriveDexGraph` (pure, tested);
 * here we just walk it depth-first, indenting children to show the nesting.
 */
function dexGraphRows(el: HTMLElement, section: DexSection): void {
  // The "drop here to unblock" target, revealed only while a nested node is
  // dragged. Sits above the rows so a dragged-out node lands on it naturally.
  el.append(dexUnblockZoneEl());
  // `blockerId` is the id of the node this row is nested under — i.e. the blocker
  // on the edge it sits on, so dropping it on the unblock zone removes that one
  // edge. Roots (no parent) pass `undefined`; their dependents pass the parent's id.
  const walk = (node: DexGraphNode, depth: number, blockerId: string | undefined): void => {
    el.append(dexGraphRowEl(node.row, depth, blockerId));
    for (const child of node.children) walk(child, depth + 1, node.row.id);
  };
  for (const root of deriveDexGraph(section.rows)) walk(root, 0, undefined);
}

/**
 * One dependency-graph node row. Mirrors {@link dexRowEl} (status marker, name,
 * blocker/landable/worktree chips, click-to-open-detail) but indents by *graph*
 * depth rather than tree depth, and carries no expand/collapse chevron — the
 * graph has no collapsible epics. A `dex-graph-row` class tags it for the bundle
 * test and any graph-specific styling; the `.bad`/blocked vs ready/muted marker
 * tone (from the shared {@link dexMarkerClass}) distinguishes blocked nodes from
 * unblocked roots.
 */
function dexGraphRowEl(row: DexRow, depth: number, blockerId?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `row dex-row dex-graph-row${depth > 0 ? " dex-graph-nested" : ""}`;
  // Indent by blocker-nesting depth so dependents read as nested under blockers.
  el.style.paddingLeft = `${depth * 14}px`;
  const blockedHint = row.blockedByCount > 0 ? ` (blocked by ${row.blockedByCount})` : "";
  el.title = `${row.name} — ${DEX_STATUS_LABEL[row.status]}${blockedHint}`;

  // Aligning spacer where the tree's chevron sits, so markers line up with the
  // tree view's columns.
  const spacer = document.createElement("span");
  spacer.className = "dex-chevron-spacer";
  el.append(spacer);

  const marker = document.createElement("i");
  marker.className = dexMarkerClass(row);
  marker.title = DEX_STATUS_LABEL[row.displayStatus];
  el.append(marker);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = row.name;
  el.append(name);

  // The task id as a click-to-copy chip, matching the detail view; an open
  // (unblocked, unfinished) task leads with a solid identity-color dot, then the
  // chip (which carries the same color as a faint backing tint).
  if (isOpenDexTask(row)) el.append(dexTaskDotEl(row.id));
  el.append(dexIdChipEl(row.id, isOpenDexTask(row)));

  if (row.blockedByCount > 0) el.append(dexBlockedChip(row.blockedByCount));
  if (row.landable) {
    const landable = dexLandableChipEl(row.landable);
    if (landable) el.append(landable);
  }
  if (row.agent) el.append(dexAgentMarkerEl(row.agent));
  if (row.worktree) el.append(dexWorktreeEl(row.worktree));
  if (canSpawnDex(row)) el.append(dexSpawnBtnEl(row.id));
  el.append(dexDeleteControlEl(row));

  // Drag this node onto another to wire a dependency — the graph view is the natural
  // surface for editing blocker edges (drop A onto B ⇒ B blocked-by A). A nested
  // node also carries the blocker it sits under, so dragging it onto the unblock
  // zone removes that one edge.
  makeDexRowDraggable(el, row, blockerId);

  el.addEventListener("click", () => {
    selectedDexId = row.id;
    requestRender();
  });
  return el;
}

/**
 * Append the dex task tree's rows to `el`: the pre-ordered rows, skipping
 * anything deeper than a collapsed ancestor. On a row at or above the collapse
 * threshold, reset it, then re-arm if this row is a collapsed epic (handles
 * nested collapses).
 */
function dexTreeRows(el: HTMLElement, section: DexSection): void {
  let collapseDepth = Infinity;
  for (const row of section.rows) {
    if (row.depth > collapseDepth) continue;
    collapseDepth = Infinity;
    el.append(dexRowEl(row));
    if (row.isEpic && collapsedDexIds.has(row.id)) collapseDepth = row.depth;
  }
}

/**
 * The start control for a ready dex row: a compact play button that runs
 * `dex.spawn` (`window.perch.dexSpawn`) to create the task's worktree and launch
 * a seeded agent in the user's terminal. Fire-and-forget; the click doesn't
 * bubble to the row's open-detail. Only rendered for {@link canSpawnDex} rows.
 */
function dexSpawnBtnEl(id: string): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn dex-spawn";
  const inFlight = spawningDexIds.has(id);
  btn.disabled = inFlight;
  btn.title = inFlight ? "Starting agent…" : "Start an agent for this task";
  btn.setAttribute("aria-label", btn.title);
  const i = document.createElement("i");
  // A spinner while the worktree is created and the agent terminal launches.
  i.className = inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-play";
  btn.append(i);
  if (!inFlight) {
    btn.addEventListener("click", (e) => {
      // Don't open the task detail; just spawn the agent.
      e.stopPropagation();
      void runDexSpawn(id);
    });
  }
  return btn;
}

/**
 * Drive a dex start button's optimistic-spawn flow: mark the id in flight so the
 * next render disables the button and shows a spinner, kick off the spawn, then
 * clear the mark when it resolves (or fails) — re-rendering at each step. Guards
 * against a second spawn while one is already in flight (no double-spawn). The
 * success/error notice itself is pushed from main via panel state.
 */
async function runDexSpawn(id: string): Promise<void> {
  if (spawningDexIds.has(id)) return;
  spawningDexIds.add(id);
  requestRender();
  try {
    await window.perch.dexSpawn(id);
  } finally {
    spawningDexIds.delete(id);
    requestRender();
  }
}

/**
 * The extra warning a delete confirmation carries when removing the task would
 * leave something behind the daemon board can't clean up: a live worktree/agent
 * (which `dex delete` doesn't touch — deleting the task would orphan it) and/or
 * subtasks (a `--force` delete cascades to them). Returns `undefined` for a plain
 * leaf task with no live work, so its confirmation stays unadorned.
 */
function dexDeleteWarning(row: DexRow): string | undefined {
  const parts: string[] = [];
  if (row.worktree || row.agent) {
    parts.push("it has a live worktree/agent that won't be removed");
  }
  if (row.isEpic) parts.push("its subtasks will also be deleted");
  return parts.length > 0 ? `Warning: ${parts.join("; ")}.` : undefined;
}

/**
 * The delete control for a dex task: a trash button that arms an in-renderer
 * confirmation (a confirm ✓ + cancel ✗ pair) rather than a `window.confirm`
 * dialog the non-activating panel can't rely on. While the delete is in flight the
 * control shows a spinner. The confirm step's tooltip surfaces
 * {@link dexDeleteWarning} so a worktree/agent or cascading subtasks are flagged
 * before the (irreversible) delete — never a silent orphan. `labeled` spells the
 * actions out for the roomier detail page; the compact row uses icon-only buttons.
 * Clicks never bubble to the row's open-detail.
 */
function dexDeleteControlEl(row: DexRow, labeled = false): HTMLElement {
  const id = row.id;
  const wrap = document.createElement("span");
  // In a compact row the control hugs the trailing edge. When a spawn button or
  // worktree indicator precedes it, their own `margin-left:auto` already pushes the
  // trailing cluster right; otherwise the control itself anchors that push.
  const anchor = !labeled && !canSpawnDex(row) && row.worktree === undefined;
  wrap.className = `chips dex-delete${anchor ? " dex-delete-anchor" : ""}`;

  if (deletingDexIds.has(id)) {
    const btn = document.createElement("button");
    btn.className = labeled ? "btn btn-sm dex-delete-btn" : "icon-btn dex-delete-btn";
    btn.disabled = true;
    btn.title = "Deleting…";
    btn.setAttribute("aria-label", btn.title);
    const i = document.createElement("i");
    i.className = "fa-solid fa-circle-notch fa-spin";
    btn.append(i, ...(labeled ? [" Deleting…"] : []));
    wrap.append(btn);
    return wrap;
  }

  if (!confirmingDeleteDexIds.has(id)) {
    const btn = document.createElement("button");
    btn.className = labeled ? "btn btn-sm dex-delete-btn" : "icon-btn dex-delete-btn";
    btn.title = "Delete task";
    btn.setAttribute("aria-label", btn.title);
    const i = document.createElement("i");
    i.className = "fa-solid fa-trash-can";
    btn.append(i, ...(labeled ? [" Delete"] : []));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmingDeleteDexIds.add(id);
      requestRender();
    });
    wrap.append(btn);
    return wrap;
  }

  // Armed: a confirm + cancel pair. The confirm tooltip flags any worktree/agent
  // or cascading subtasks; the destructive `bad` tint marks it as the live action.
  const warning = dexDeleteWarning(row);
  const confirm = document.createElement("button");
  confirm.className = labeled ? "btn btn-sm dex-delete-confirm" : "icon-btn dex-delete-confirm";
  confirm.title = warning ? `Confirm delete — ${warning}` : "Confirm delete (irreversible)";
  confirm.setAttribute("aria-label", confirm.title);
  const ci = document.createElement("i");
  ci.className = "fa-solid fa-check";
  confirm.append(ci, ...(labeled ? [" Confirm"] : []));
  confirm.addEventListener("click", (e) => {
    e.stopPropagation();
    void runDexDelete(id);
  });

  const cancel = document.createElement("button");
  cancel.className = labeled ? "btn btn-sm dex-delete-cancel" : "icon-btn dex-delete-cancel";
  cancel.title = "Cancel";
  cancel.setAttribute("aria-label", cancel.title);
  const xi = document.createElement("i");
  xi.className = "fa-solid fa-xmark";
  cancel.append(xi, ...(labeled ? [" Cancel"] : []));
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    confirmingDeleteDexIds.delete(id);
    requestRender();
  });

  // An inline warning glyph next to the confirm pair, so the caveat reads without
  // hovering for the tooltip.
  if (warning) {
    const warn = document.createElement("i");
    warn.className = "fa-solid fa-triangle-exclamation dex-delete-warn";
    warn.title = warning;
    wrap.append(warn);
  }
  wrap.append(confirm, cancel);
  return wrap;
}

/**
 * Drive a confirmed dex delete: clear the armed-confirm state, mark the id
 * in-flight so the next render shows a spinner, run the delete, then clear the
 * in-flight mark (re-rendering at each step). The board refresh + success/error
 * notice are driven from main via panel state once the delete resolves.
 */
async function runDexDelete(id: string): Promise<void> {
  if (deletingDexIds.has(id)) return;
  confirmingDeleteDexIds.delete(id);
  deletingDexIds.add(id);
  requestRender();
  try {
    await window.perch.dexDelete(id);
  } finally {
    deletingDexIds.delete(id);
    requestRender();
  }
}

/**
 * Whether `target` is a valid drop target for the in-flight dependency drag: there
 * is a drag, it isn't a self-drop (A onto A is a no-op), and source + target share
 * a project — a blocker edge can only link tasks in the same store, so a
 * cross-project drop is rejected before it reaches the daemon. Cycles aren't checked
 * here; dex itself rejects them and the daemon surfaces that as a clear notice.
 */
function isValidDexDropTarget(target: DexRow): boolean {
  if (draggingDexId === undefined || draggingDexId === target.id) return false;
  return target.project === draggingDexProject;
}

/** Strip the transient drop-target highlight from every dex row (drag end / drop). */
function clearDexDropHighlights(): void {
  for (const el of document.querySelectorAll(".dex-drop-target")) {
    el.classList.remove("dex-drop-target");
  }
}

/**
 * Show or hide the graph's "drop here to unblock" zone. Revealed (`armed`) only
 * while a *nested* graph node is being dragged — a node that sits on a removable
 * blocker edge — so the remove affordance can't be mistaken for the add gesture
 * (which is a plain row-onto-row drop) when there's no edge to remove.
 */
function setDexUnblockZoneArmed(armed: boolean): void {
  const zone = document.querySelector(".dex-unblock-zone");
  if (!zone) return;
  zone.classList.toggle("armed", armed);
  if (!armed) zone.classList.remove("dex-drop-target");
}

/**
 * The graph view's "drop here to unblock" zone: a drop target, hidden until a
 * nested node is dragged, that removes the dragged node's blocker edge — the
 * inverse of dropping one row onto another. Dropping a node nested under blocker
 * B fires `dexRemoveBlocker({ blockedId: node, blockerId: B })`, removing exactly
 * that edge and leaving the task's other blockers intact; main refreshes the
 * board and toasts the outcome (and the task flips to ready if B was its last
 * active blocker). Inert unless the drag carries a parent blocker
 * (`draggingDexBlockerId`), so an unblocked-root drag can't trip it.
 */
function dexUnblockZoneEl(): HTMLElement {
  const zone = document.createElement("div");
  zone.className = "dex-unblock-zone";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-link-slash";
  const label = document.createElement("span");
  label.textContent = "Drop here to remove this blocker";
  zone.append(icon, label);

  zone.addEventListener("dragover", (e) => {
    if (draggingDexBlockerId === undefined) return;
    // preventDefault marks this a valid drop zone (and lets the drop fire).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    zone.classList.add("dex-drop-target");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dex-drop-target");
  });

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dex-drop-target");
    // Both halves of the edge come from the in-flight drag: the dragged node is
    // the blocked task, and it carries the specific blocker it was nested under.
    if (draggingDexId === undefined || draggingDexBlockerId === undefined) return;
    void window.perch.dexRemoveBlocker({
      blockedId: draggingDexId,
      blockerId: draggingDexBlockerId,
    });
  });
  return zone;
}

/**
 * Wire drag-and-drop dependency editing onto a dex task row. The row becomes
 * draggable; dropping the dragged task onto ANOTHER row makes the drop target
 * blocked-by the dragged task (drop A onto B ⇒ B blocked-by A). A valid target
 * (different task, same project) lights up while hovered; the drop fires
 * `dexAddBlocker` and the board refreshes (with a success/error toast) from main.
 *
 * Shared by the tree and graph row builders so both surfaces edit dependencies
 * identically. The drag gesture doesn't open the row's detail — HTML5 drag suppresses
 * the trailing click — so the existing click-to-open behavior is untouched.
 *
 * `blockerId` (graph view only) is the blocker this row is nested under; passing
 * it arms the "drop here to unblock" zone for the drag, so dropping the node there
 * removes exactly that edge. Rows with no parent blocker omit it and only add.
 */
function makeDexRowDraggable(el: HTMLElement, row: DexRow, blockerId?: string): void {
  el.draggable = true;

  el.addEventListener("dragstart", (e) => {
    draggingDexId = row.id;
    draggingDexProject = row.project;
    draggingDexBlockerId = blockerId;
    el.classList.add("dex-dragging");
    // A node sitting on a blocker edge can be dragged out to remove it — reveal
    // the unblock drop zone for the duration of this drag.
    if (blockerId !== undefined) setDexUnblockZoneArmed(true);
    if (e.dataTransfer) {
      // A nested node can be dropped two ways — onto a row to ADD a blocker
      // (`link`) or onto the unblock zone to REMOVE one (`move`) — so allow both;
      // a row with no parent blocker only adds, so it stays `link`.
      e.dataTransfer.effectAllowed = blockerId !== undefined ? "all" : "link";
      // Carry the id too, so a drop still resolves if module state is ever lost.
      e.dataTransfer.setData("text/plain", row.id);
    }
  });

  el.addEventListener("dragend", () => {
    draggingDexId = undefined;
    draggingDexProject = undefined;
    draggingDexBlockerId = undefined;
    el.classList.remove("dex-dragging");
    setDexUnblockZoneArmed(false);
    clearDexDropHighlights();
  });

  el.addEventListener("dragover", (e) => {
    if (!isValidDexDropTarget(row)) return;
    // Calling preventDefault marks this a valid drop zone (and lets the drop fire).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "link";
    el.classList.add("dex-drop-target");
  });

  el.addEventListener("dragleave", () => {
    el.classList.remove("dex-drop-target");
  });

  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dex-drop-target");
    const sourceId = draggingDexId ?? e.dataTransfer?.getData("text/plain") ?? undefined;
    if (!sourceId || !isValidDexDropTarget(row)) return;
    // Drop source onto this row ⇒ this row (the target) becomes blocked by source.
    void window.perch.dexAddBlocker({ blockedId: row.id, blockerId: sourceId });
  });
}

/**
 * The linked-worktree indicator for a dex task row: the branch (prefixed with
 * its repo when known) plus the shared dirty / ahead-behind health markers, and
 * an "open terminal here" button that drops the user into the worktree via the
 * same `worktrees.open` plumbing (`window.perch.worktreeOpen`) the Worktrees
 * panel uses. Fire-and-forget; clicks don't bubble to the row's open-detail.
 */
function dexWorktreeEl(wt: LinkedWorktree): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "chips dex-worktree";
  const label =
    wt.repo && wt.branch ? `${wt.repo}/${wt.branch}` : (wt.branch ?? wt.repo ?? wt.path);

  const branch = document.createElement("span");
  branch.className = "chip muted dex-worktree-branch";
  branch.title = `Worktree: ${wt.path}`;
  const bi = document.createElement("i");
  bi.className = "fa-solid fa-code-branch";
  branch.append(bi, ` ${label}`);
  wrap.append(branch);

  appendWorktreeHealthChips(wrap, wt);

  const open = document.createElement("button");
  open.className = "icon-btn dex-worktree-open";
  open.title = "Open terminal here";
  open.setAttribute("aria-label", "Open terminal in worktree");
  const oi = document.createElement("i");
  oi.className = "fa-solid fa-terminal";
  open.append(oi);
  open.addEventListener("click", (e) => {
    // Don't open the task detail; just launch the terminal in the worktree.
    e.stopPropagation();
    window.perch.worktreeOpen(wt.path);
  });
  wrap.append(open);
  return wrap;
}

/**
 * The git-health facets a dex task's linked worktree carries — enough to render
 * the dirty / ahead-behind markers exactly as the Worktrees panel does.
 */
interface WorktreeHealthFacet {
  dirty: boolean;
  dirtyCount: number;
  ahead?: number;
  behind?: number;
}

/**
 * Append the dirty + ahead/behind health chips to `chips`, mirroring the markers
 * `worktreeRowEl` draws. Used by the dex row's linked-worktree indicator so a
 * task's worktree reads the same as it does in the Worktrees panel.
 */
function appendWorktreeHealthChips(chips: HTMLElement, w: WorktreeHealthFacet): void {
  if (w.dirty) {
    const d = document.createElement("span");
    d.className = "chip warn";
    d.title = `${w.dirtyCount} uncommitted change${w.dirtyCount === 1 ? "" : "s"}`;
    d.textContent = `●${w.dirtyCount}`;
    chips.append(d);
  }
  if ((w.ahead ?? 0) > 0 || (w.behind ?? 0) > 0) {
    const ab = document.createElement("span");
    ab.className = `chip ${(w.ahead ?? 0) > 0 && (w.behind ?? 0) > 0 ? "warn" : "muted"}`;
    ab.title = `${w.ahead ?? 0} ahead, ${w.behind ?? 0} behind upstream`;
    ab.textContent = `↑${w.ahead ?? 0} ↓${w.behind ?? 0}`;
    chips.append(ab);
  }
}
