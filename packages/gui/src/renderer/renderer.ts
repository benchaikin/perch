/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It receives a
 * fully-derived {@link PanelState} (all mapping done in the main process via
 * `buildPanelState`) and renders the grouped "My PRs" panel DOM. Bundled to
 * plain browser JS by esbuild.
 */
import type {
  GroupRow,
  Health,
  PanelState,
  PanelTab,
  PrRow,
  RepoSection,
  TabBadge,
} from "../panel-state.js";
import { SERVICES_TAB_ID } from "../panel-state.js";
import {
  DEX_TASKS_ID,
  deriveDexGraph,
  dexHealth,
  isOpenDexTask,
  type DexGraphNode,
  type DexRow,
  type DexSection,
  type DexStatus,
} from "../dex-state.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import type { LandableState } from "../landable.js";
import type { AgentState, AgentSummary } from "../agents-state.js";
import {
  WORKTREES_LIST_ID,
  type WorktreeRow,
  type WorktreesSection,
  type WorktreeRepoGroup,
} from "../worktrees-state.js";
import type { LinkedTask, LinkedWorktree } from "../worktree-task-link.js";
import type { DexViewMode } from "../window-state.js";
import type {
  ServiceAction,
  ServiceHealth,
  ServicesBulkAction,
  ServiceRow,
  ServicesControl,
  ServicesSection,
} from "../services-state.js";

/**
 * The health marker is a distinct Font Awesome *shape* per state (not just a
 * color), so it's legible without relying on the red/green hue a colorblind
 * viewer can't separate: a check, a warning triangle, and an x.
 */
const HEALTH_ICON: Record<Health, string> = {
  ok: "circle-check",
  warn: "triangle-exclamation",
  bad: "circle-xmark",
};
const HEALTH_LABEL: Record<Health, string> = {
  ok: "Clean",
  warn: "Review comments to address",
  bad: "Needs attention",
};

/**
 * Service markers carry a fourth state — `muted` (stopped) — on top of the
 * PR health trio. Reuse the same shapes for the overlapping states so PR and
 * service dots read consistently, and give "stopped" a plain neutral circle.
 */
const SERVICE_HEALTH_ICON: Record<ServiceHealth, string> = {
  ok: HEALTH_ICON.ok,
  warn: HEALTH_ICON.warn,
  bad: HEALTH_ICON.bad,
  muted: "circle",
};

/**
 * Each service action renders as a Font Awesome icon button tinted by function.
 * Like the health marker, the distinct icon *shape* (play / stop / rotate) is
 * the primary signal so it reads without relying on the red/green hue a
 * colorblind viewer can't separate; the `tint` CSS class layers color on top.
 * `start` = green go, `stop` = red halt, `restart` = neutral/amber reload.
 */
const SERVICE_ACTION_ICON: Record<ServiceAction, { icon: string; tint: string }> = {
  start: { icon: "play", tint: "start" },
  stop: { icon: "stop", tint: "stop" },
  restart: { icon: "arrows-rotate", tint: "restart" },
};

/** Icon + tint for the top-level (whole-stack) Services header controls. */
const SERVICE_BULK_ICON: Record<ServicesBulkAction, { icon: string; tint: string }> = {
  startAll: { icon: "play", tint: "start" },
  stopAll: { icon: "stop", tint: "stop" },
  restartAll: { icon: "arrows-rotate", tint: "restart" },
};

const tabsEl = byId("tabs");
const rowsEl = byId("rows");
const refreshBtn = byId("refresh") as HTMLButtonElement;
const refreshIcon = refreshBtn.querySelector("i");
const noticeEl = byId("notice");

/** Spin (or stop spinning) the refresh icon while a refresh is in flight. */
function setRefreshSpinning(on: boolean): void {
  refreshIcon?.classList.toggle("fa-spin", on);
}

let syncAvailable = false;
/** Repos with a sync in flight — their Sync button shows progress. */
let syncingRepos: string[] = [];
/**
 * The selected plugin tab's id, preserved across re-renders while that tab still
 * exists (else it falls back to the first tab — e.g. Services going away returns
 * focus to PRs). Undefined until the first state arrives.
 */
let activeTabId: string | undefined;
/**
 * How the Dex tab renders — `tree` (the hierarchical list) or `graph` (the
 * dependency graph). Seeded from the persisted mode on first render (undefined
 * until then), then the renderer owns the selection; mirrors {@link activeTabId}.
 */
let dexViewMode: DexViewMode | undefined;
/** Collapsed dex epic ids (their descendants are hidden); preserved across re-renders. */
const collapsedDexIds = new Set<string>();
/** Collapsed worktree repo ids (their rows are hidden); preserved across re-renders. */
const collapsedWorktreeRepos = new Set<string>();
/** The dex task whose detail view is open, if any (else the task list shows). */
let selectedDexId: string | undefined;
/** The last rendered state, replayed when the active tab changes (a click). */
let lastState: PanelState | undefined;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

/** Build a status chip element, optionally led by a (spinning) Font Awesome icon. */
function chipEl(chip: {
  label: string;
  tone: string;
  hint: string;
  icon?: string;
  spin?: boolean;
}): HTMLElement {
  const el = document.createElement("span");
  el.className = `chip ${chip.tone}`;
  el.title = chip.hint;
  if (chip.icon) {
    const i = document.createElement("i");
    i.className = `fa-solid fa-${chip.icon}${chip.spin ? " fa-spin" : ""}`;
    el.append(i, ` ${chip.label}`);
  } else {
    el.textContent = chip.label;
  }
  return el;
}

/** Build a badge element (needs-rebase / conflict). */
function badgeEl(kind: "rebase" | "conflict", label: string, hint: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `badge ${kind}`;
  el.textContent = label;
  el.title = hint;
  return el;
}

/**
 * Build the "review comments to address" badge: a Font Awesome comment icon +
 * the count. Caller only appends it when `count > 0`; it's emphasized (the
 * `many` modifier) when `count > 1`, where there's usually real work to do.
 */
function reviewCommentBadgeEl(count: number): HTMLElement {
  const el = document.createElement("span");
  el.className = `badge reviewcomments${count > 1 ? " many" : ""}`;
  el.title = `${count} review comment${count === 1 ? "" : "s"} to address`;
  const icon = document.createElement("i");
  icon.className = "fa-regular fa-comment";
  el.append(icon, ` ${count}`);
  return el;
}

/**
 * Build one PR row; clicking opens the PR in the browser. When `pos` is given
 * (a stacked PR), it shows the layer's position number instead of a dot.
 */
function prRowEl(row: PrRow, pos?: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.title = `${row.title} — #${row.number}`;
  el.addEventListener("click", () => window.perch.openPr(row.url));

  // Stacked PRs get a position number (1 = trunk-adjacent base); standalone PRs
  // get a health-shaped icon (check / triangle / x) — a non-color cue so health
  // never depends on the red/green hue alone. Both are tinted by health too.
  if (pos !== undefined) {
    const marker = document.createElement("span");
    marker.className = `num ${row.health}`;
    marker.textContent = String(pos);
    el.append(marker);
  } else {
    const marker = document.createElement("i");
    marker.className = `dot ${row.health} fa-solid fa-${HEALTH_ICON[row.health]}`;
    marker.title = HEALTH_LABEL[row.health];
    el.append(marker);
  }

  const title = document.createElement("span");
  title.className = "branch";
  title.textContent = row.title;
  el.append(title);

  const pr = document.createElement("span");
  pr.className = "pr";
  pr.textContent = `#${row.number}`;
  el.append(pr);

  const chips = document.createElement("span");
  chips.className = "chips";
  for (const c of row.chips) chips.append(chipEl(c));
  if (row.humanReviewCommentCount > 0) {
    chips.append(reviewCommentBadgeEl(row.humanReviewCommentCount));
  }
  if (row.needsRebase) chips.append(badgeEl("rebase", "rb", "Needs rebase"));
  // A merge conflict is already shown by the `⚠ merge` mergeable chip
  // (mergeable === "CONFLICTING"); don't double-indicate it with a `cf` badge.
  el.append(chips);

  return el;
}

/** Build a nested stack group: a "stack of N" header + indented PR rows. */
function stackGroupEl(group: Extract<GroupRow, { kind: "stack" }>): HTMLElement {
  const el = document.createElement("div");
  // The linking bar is colored by whole-stack health (green = clean, amber =
  // comments to address, red = blocking attention).
  el.className = `stack-group ${group.health}`;

  const head = document.createElement("div");
  head.className = "stack-head";

  const label = document.createElement("span");
  label.className = "stack-label";
  label.textContent = `stack of ${group.rows.length}`;
  if (group.needsRebase) label.append(badgeEl("rebase", "rb", "Stack needs rebase"));
  head.append(label);

  // Sync shows only on a gh-stack-tracked stack and when the action exists.
  if (group.tracked && syncAvailable) {
    const sync = document.createElement("button");
    sync.className = "btn btn-primary btn-sm";
    const inFlight = syncingRepos.includes(group.repo);
    sync.disabled = inFlight;
    sync.title = `Rebase this stack onto trunk (${group.repo})`;
    if (inFlight) {
      // A spinner while the cascading rebase runs (it can take a few seconds).
      const spinner = document.createElement("i");
      spinner.className = "fa-solid fa-circle-notch fa-spin";
      sync.append(spinner, " Syncing…");
    } else {
      sync.textContent = "Sync";
      sync.addEventListener("click", () => window.perch.sync(group.repo));
    }
    head.append(sync);
  }
  el.append(head);

  const layers = document.createElement("div");
  layers.className = "stack-layers";
  // Rows are base-first; number 1..N from the base (which reads at the top).
  group.rows.forEach((row, i) => layers.append(prRowEl(row, i + 1)));
  el.append(layers);

  return el;
}

/** Build one group (standalone PR or nested stack). */
function groupEl(group: GroupRow): HTMLElement {
  return group.kind === "pr" ? prRowEl(group.pr) : stackGroupEl(group);
}

/** Build one repo section: a header, an optional error note, then its groups. */
function repoSectionEl(repo: RepoSection): HTMLElement {
  const el = document.createElement("section");
  el.className = "repo-section";

  const header = document.createElement("div");
  header.className = "repo-header";
  header.textContent = repo.name;
  el.append(header);

  if (repo.error) {
    const note = document.createElement("div");
    note.className = "repo-error";
    note.textContent = repo.error;
    note.title = repo.error;
    el.append(note);
  }

  for (const group of repo.groups) el.append(groupEl(group));
  return el;
}

/** Build one service row: a health-colored dot, the name, and an optional detail. */
function serviceRowEl(svc: ServiceRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row service-row";
  el.title = `${svc.name} — ${svc.statusLabel}${svc.detail ? ` (${svc.detail})` : ""}`;

  const dot = document.createElement("i");
  dot.className = `dot ${svc.health} fa-solid fa-${SERVICE_HEALTH_ICON[svc.health]}`;
  dot.title = svc.statusLabel;
  el.append(dot);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = svc.name;
  el.append(name);

  const status = document.createElement("span");
  status.className = "service-status";
  status.textContent = svc.detail ? `${svc.statusLabel} · ${svc.detail}` : svc.statusLabel;
  el.append(status);

  el.append(serviceActionsEl(svc));
  return el;
}

/**
 * Build the action-button cluster for a service row. Renders the
 * status-appropriate lifecycle buttons (Restart always; Stop xor Start, M2),
 * plus a fire-and-forget **Logs** button (M3) that opens a terminal tailing this
 * process. While a lifecycle action is in flight for the service, those buttons
 * disable and the first shows a spinner — mirroring the Sync button's
 * `fa-circle-notch fa-spin` pattern. Logs stays enabled (it doesn't mutate
 * lifecycle state).
 */
function serviceActionsEl(svc: ServiceRow): HTMLElement {
  const actions = document.createElement("span");
  actions.className = "service-actions";
  svc.buttons.forEach((button, i) => {
    const { icon, tint } = SERVICE_ACTION_ICON[button.action];
    const btn = document.createElement("button");
    // The visible label is gone, so the former text moves to title + aria-label.
    const label = `${button.label} ${svc.name}`;
    btn.className = `btn btn-sm service-btn tint-${tint}`;
    btn.disabled = svc.inFlight;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    const glyph = document.createElement("i");
    if (svc.inFlight && i === 0) {
      // The acting button (always first) shows the spinner; no click handler
      // while in flight (the cluster is disabled anyway).
      glyph.className = "fa-solid fa-circle-notch fa-spin";
      btn.append(glyph);
    } else {
      glyph.className = `fa-solid fa-${icon}`;
      btn.append(glyph);
      btn.addEventListener("click", (e) => {
        // The row itself isn't clickable, but stop propagation defensively.
        e.stopPropagation();
        window.perch.serviceAction({ name: svc.name, action: button.action });
      });
    }
    actions.append(btn);
  });

  // Logs button: present on every row, independent of lifecycle state. Rendered
  // as a muted icon button for consistency with the lifecycle actions.
  if (svc.logs) {
    const logs = document.createElement("button");
    logs.className = "btn btn-sm service-btn service-logs tint-logs";
    const logsLabel = `Open logs for ${svc.name}`;
    logs.title = logsLabel;
    logs.setAttribute("aria-label", logsLabel);
    const glyph = document.createElement("i");
    glyph.className = "fa-solid fa-file-lines";
    logs.append(glyph);
    logs.addEventListener("click", (e) => {
      e.stopPropagation();
      window.perch.serviceLogs(svc.name);
    });
    actions.append(logs);
  }

  return actions;
}

/**
 * Build one top-level (whole-stack) control button for the Services header.
 * Mirrors the per-row action buttons: an icon-only tinted button that disables
 * while any bulk action is in flight, with the active one showing a spinner.
 */
function servicesControlEl(control: ServicesControl, bulkActing?: ServicesBulkAction): HTMLElement {
  const { icon, tint } = SERVICE_BULK_ICON[control.action];
  const btn = document.createElement("button");
  btn.className = `btn btn-sm service-btn service-bulk-btn tint-${tint}`;
  btn.title = control.label;
  btn.setAttribute("aria-label", control.label);
  btn.disabled = bulkActing !== undefined;

  const glyph = document.createElement("i");
  if (bulkActing === control.action) {
    glyph.className = "fa-solid fa-circle-notch fa-spin";
    btn.append(glyph, ` ${control.label}`);
  } else {
    glyph.className = `fa-solid fa-${icon}`;
    btn.append(glyph, ` ${control.label}`);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.perch.servicesBulk(control.action);
    });
  }
  return btn;
}

/**
 * Build the "Services" section: a header (title + whole-stack controls) and one
 * row per process. Returns null when the section is hidden (no services live and
 * none configured), so the panel is unchanged for users without process-compose.
 * When process-compose is down but procs are configured, rows show as stopped
 * and the header's **Start all** brings the stack up.
 *
 * `showTitle` is false when this section is the active full-tab pane: the panel
 * header title already names "Services", so the section's own title would
 * duplicate it — we drop the label and keep the header as a (right-aligned)
 * controls toolbar above the rows.
 */
function servicesSectionEl(section: ServicesSection, showTitle = true): HTMLElement | null {
  if (!section.visible) return null;
  const el = document.createElement("section");
  el.className = "repo-section services-section";

  const header = document.createElement("div");
  header.className = "repo-header services-header";
  if (showTitle) {
    const title = document.createElement("span");
    title.textContent = "Services";
    header.append(title);
  }

  if (section.controls.length > 0) {
    const controls = document.createElement("span");
    controls.className = "services-controls";
    for (const control of section.controls) {
      controls.append(servicesControlEl(control, section.bulkActing));
    }
    header.append(controls);
  }
  // Only emit the header when it carries something (a title and/or controls);
  // with `showTitle` false and no controls it would be an empty bar.
  if (header.childElementCount > 0) el.append(header);

  for (const svc of section.rows) el.append(serviceRowEl(svc));
  return el;
}

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
const DEX_STATUS_LABEL: Record<DexStatus, string> = {
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
  running: { label: "running", tone: "dex-active", icon: "play", spin: true, hint: "Agent running" },
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
      if (lastState) render(lastState);
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
  // (unblocked, unfinished) task's chip carries its stable identity color.
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

  el.addEventListener("click", () => {
    selectedDexId = row.id;
    if (lastState) render(lastState);
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
  btn.title = "Start an agent for this task";
  btn.setAttribute("aria-label", "Start an agent for this task");
  const i = document.createElement("i");
  i.className = "fa-solid fa-play";
  btn.append(i, " Start agent");
  btn.addEventListener("click", () => window.perch.dexSpawn(id));
  return btn;
}

/** Build the task detail view: a back affordance, the task header, meta chips, body + result. */
function dexDetailEl(row: DexRow): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dex-detail";

  const back = document.createElement("button");
  back.className = "btn btn-sm dex-back";
  const bi = document.createElement("i");
  bi.className = "fa-solid fa-arrow-left";
  back.append(bi, " Tasks");
  back.addEventListener("click", () => {
    selectedDexId = undefined;
    if (lastState) render(lastState);
  });
  wrap.append(back);

  const head = document.createElement("div");
  head.className = "dex-detail-head";
  const marker = document.createElement("i");
  marker.className = dexMarkerClass(row);
  const title = document.createElement("span");
  title.className = "dex-detail-title";
  title.textContent = row.name;
  head.append(marker, title);
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

  // A ready, unblocked, unworked task gets a launch button right here — the
  // detail-page twin of the per-row start button. canSpawnDex already excludes
  // tasks with a live agent/worktree, so the agent marker above stands in then.
  if (canSpawnDex(row)) wrap.append(dexDetailSpawnBtnEl(row.id));

  if (row.description) wrap.append(dexBodyEl(row.description));
  if (row.result) {
    const label = document.createElement("div");
    label.className = "dex-detail-label";
    label.textContent = "Result";
    wrap.append(label, dexBodyEl(row.result));
  }
  return wrap;
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
    if (lastState) render(lastState);
  });
  return btn;
}

/**
 * Build the Dex section header: the tree/graph view-mode toggle plus, when
 * there are epics, an expand/collapse-all toggle over them.
 */
function dexHeaderEl(epicIds: string[], mode: DexViewMode): HTMLElement {
  const header = document.createElement("div");
  header.className = "repo-header dex-header";

  header.append(dexViewToggleEl(mode));

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
      if (lastState) render(lastState);
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
 */
function dexSectionEl(section: DexSection, mode: DexViewMode): HTMLElement | null {
  if (!section.visible) return null;
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
  }

  // Plugin present but nothing open (e.g. everything's completed) — show an
  // empty state rather than a blank pane, so the tab still reads as "Dex".
  if (section.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message";
    empty.textContent = "No open tasks";
    el.append(empty);
    return el;
  }

  // The header carries the tree/graph toggle (always) plus, in tree mode, the
  // collapse-all control over any epics.
  const epicIds = section.rows.filter((r) => r.isEpic).map((r) => r.id);
  el.append(dexHeaderEl(epicIds, mode));

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
  const walk = (node: DexGraphNode, depth: number): void => {
    el.append(dexGraphRowEl(node.row, depth));
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of deriveDexGraph(section.rows)) walk(root, 0);
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
function dexGraphRowEl(row: DexRow, depth: number): HTMLElement {
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
  // (unblocked, unfinished) task's chip carries its stable identity color.
  el.append(dexIdChipEl(row.id, isOpenDexTask(row)));

  if (row.blockedByCount > 0) el.append(dexBlockedChip(row.blockedByCount));
  if (row.landable) {
    const landable = dexLandableChipEl(row.landable);
    if (landable) el.append(landable);
  }
  if (row.agent) el.append(dexAgentMarkerEl(row.agent));
  if (row.worktree) el.append(dexWorktreeEl(row.worktree));
  if (canSpawnDex(row)) el.append(dexSpawnBtnEl(row.id));

  el.addEventListener("click", () => {
    selectedDexId = row.id;
    if (lastState) render(lastState);
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
 * Build a collapsible worktree repo header: a chevron, health dot, count,
 * and optional dirty/conflict indicators. Clicking toggles the repo's children.
 */
function worktreeRepoHeaderEl(group: WorktreeRepoGroup, collapsed: boolean): HTMLElement {
  const el = document.createElement("button");
  el.className = "worktree-repo-header-btn";
  const rowCount = group.count;
  const detail = [
    `${rowCount} worktree${rowCount !== 1 ? "s" : ""}`,
    group.dirtyCount > 0 ? `${group.dirtyCount} dirty` : "",
    group.hasConflict ? "conflict" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  el.title = `${group.repo} — ${detail}`;

  const chevron = document.createElement("i");
  chevron.className = `fa-solid fa-chevron-${collapsed ? "right" : "down"}`;
  el.append(chevron);

  const dot = document.createElement("i");
  dot.className = `dot ${group.health} fa-solid fa-code-branch`;
  el.append(dot);

  const name = document.createElement("span");
  name.className = "branch worktree-repo-name";
  name.textContent = group.repo;
  el.append(name);

  const indicators = document.createElement("span");
  indicators.className = "worktree-repo-indicators";

  const count = document.createElement("span");
  count.className = "chip muted worktree-repo-count";
  count.textContent = String(rowCount);
  indicators.append(count);

  if (group.dirtyCount > 0) {
    const dirty = document.createElement("span");
    dirty.className = "chip warn";
    dirty.title = `${group.dirtyCount} uncommitted change${group.dirtyCount === 1 ? "" : "s"}`;
    dirty.textContent = `●${group.dirtyCount}`;
    indicators.append(dirty);
  }

  if (group.hasConflict) {
    const conflict = document.createElement("span");
    conflict.className = "chip bad";
    conflict.textContent = "conflict";
    indicators.append(conflict);
  }

  el.append(indicators);

  el.addEventListener("click", (e) => {
    // Toggle the repo's children without propagating.
    e.stopPropagation();
    if (collapsed) collapsedWorktreeRepos.delete(group.repo);
    else collapsedWorktreeRepos.add(group.repo);
    if (lastState) render(lastState);
  });

  return el;
}

/**
 * Build the chip annotating a worktree row with the dex task it was created for.
 * The branch label (`dex/<id>-<slug>`) already supplies the row's identity — the
 * task id and a slug of its name — so the chip doesn't repeat them; it carries the
 * one thing the branch can't: the task's live status (`🗒 <status>`), toned the
 * same way the dex board's status chip is (`dexHealth` — blocked=red, in-progress/
 * done/ready). The full id + real name + status live in the hover tooltip.
 * Non-interactive (clicking the row still opens the worktree dir).
 *
 * When the linked task is open (unblocked, unfinished — see {@link isOpenDexTask}),
 * the chip also carries the task's stable identity color via the same
 * `dex-open`/`--task-color` accent its dex row uses, so a worktree reads as the
 * same "team color" as its task across the fleet. A blocked/done task's chip
 * keeps its plain status tone.
 */
function worktreeTaskChipEl(task: LinkedTask): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `chip ${dexHealth(task.status)} worktree-task`;
  chip.title = `${task.id} · ${task.name} — ${DEX_STATUS_LABEL[task.status]}`;
  if (isOpenDexTask(task)) {
    const color = dexTaskColor(task.id);
    chip.classList.add("dex-open");
    chip.style.setProperty("--task-color", color.hex);
    chip.style.setProperty("--task-color-rgb", `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`);
  }
  chip.append(`🗒 ${DEX_STATUS_LABEL[task.status]}`);
  return chip;
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

/**
 * The start control for a ready dex row: a compact play button that runs
 * `dex.spawn` (`window.perch.dexSpawn`) to create the task's worktree and launch
 * a seeded agent in the user's terminal. Fire-and-forget; the click doesn't
 * bubble to the row's open-detail. Only rendered for {@link canSpawnDex} rows.
 */
function dexSpawnBtnEl(id: string): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn dex-spawn";
  btn.title = "Start an agent for this task";
  btn.setAttribute("aria-label", "Start an agent for this task");
  const i = document.createElement("i");
  i.className = "fa-solid fa-play";
  btn.append(i);
  btn.addEventListener("click", (e) => {
    // Don't open the task detail; just spawn the agent.
    e.stopPropagation();
    window.perch.dexSpawn(id);
  });
  return btn;
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

/** Build one worktree row: a health dot, branch/name (main tagged), and state chips. */
function worktreeRowEl(row: WorktreeRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row worktree-row";
  const detail = [
    row.branch ?? "(detached)",
    row.dirty ? `${row.dirtyCount} uncommitted` : "clean",
    row.conflict ? "conflict" : "",
    row.prunable ? "prunable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  el.title = `${row.name} — ${detail}`;

  const dot = document.createElement("i");
  dot.className = `dot ${row.health} fa-solid fa-${row.conflict ? "code-merge" : "code-branch"}`;
  el.append(dot);

  // Branch is the primary label (what an agent is working on); the worktree
  // directory name follows, muted, when it differs.
  const branch = document.createElement("span");
  branch.className = "branch";
  branch.textContent = row.branch ?? "(detached)";
  el.append(branch);

  if (row.main) {
    const tag = document.createElement("span");
    tag.className = "chip muted";
    tag.textContent = "main";
    el.append(tag);
  }

  const chips = document.createElement("span");
  chips.className = "chips";
  // The linked dex task leads the chips so the row reads "what this is for".
  if (row.task) chips.append(worktreeTaskChipEl(row.task));
  if (row.dirty) {
    const d = document.createElement("span");
    d.className = "chip warn";
    d.title = `${row.dirtyCount} uncommitted change${row.dirtyCount === 1 ? "" : "s"}`;
    d.textContent = `●${row.dirtyCount}`;
    chips.append(d);
  }
  if (row.conflict) {
    const c = document.createElement("span");
    c.className = "chip bad";
    c.textContent = "conflict";
    chips.append(c);
  }
  if ((row.ahead ?? 0) > 0 || (row.behind ?? 0) > 0) {
    const ab = document.createElement("span");
    ab.className = `chip ${(row.ahead ?? 0) > 0 && (row.behind ?? 0) > 0 ? "warn" : "muted"}`;
    ab.title = `${row.ahead ?? 0} ahead, ${row.behind ?? 0} behind upstream`;
    ab.textContent = `↑${row.ahead ?? 0} ↓${row.behind ?? 0}`;
    chips.append(ab);
  }
  if (row.prunable) {
    const p = document.createElement("span");
    p.className = "chip bad";
    p.textContent = "prunable";
    chips.append(p);
  }
  el.append(chips);

  // Click opens the worktree directory via the configured command.
  el.addEventListener("click", () => window.perch.worktreeOpen(row.path));
  return el;
}

/**
 * Build the "Worktrees" section: one row per worktree (main first). Returns null
 * when hidden (no worktrees plugin / none). When multiRepo is true, rows are
 * grouped under collapsible repo headers with aggregate indicators; otherwise
 * a flat list of rows. No section title — the active "Worktrees" tab already
 * names it.
 */
function worktreesSectionEl(section: WorktreesSection): HTMLElement | null {
  if (!section.visible) return null;
  const el = document.createElement("section");
  el.className = "repo-section worktrees-section";

  if (section.multiRepo && section.repoGroups.length > 0) {
    // Grouped render: collapsible per-repo sections with aggregate indicators.
    for (const group of section.repoGroups) {
      const collapsed = collapsedWorktreeRepos.has(group.repo);
      el.append(worktreeRepoHeaderEl(group, collapsed));
      if (!collapsed) {
        for (const row of group.rows) {
          el.append(worktreeRowEl(row));
        }
      }
    }
  } else {
    // Flat render: single repo or empty group list.
    for (const row of section.rows) {
      el.append(worktreeRowEl(row));
    }
  }

  return el;
}

/** Render a centered message (empty / daemon-down / error). */
function messageEl(text: string, isError: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = isError ? "message error" : "message";
  el.textContent = text;
  return el;
}

/** Render the initial loading state: a spinner alongside the message. */
function loadingEl(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "message";
  const spinner = document.createElement("i");
  spinner.className = "fa-solid fa-circle-notch fa-spin";
  el.append(spinner, ` ${text}`);
  return el;
}

/**
 * Resolve which tab should be active: keep the current selection when it still
 * exists (tabs come and go as plugins appear/disappear), else fall back to the
 * first tab. Undefined only when there are no tabs at all. Mirrors the Settings
 * window's `resolveActiveTab`.
 */
function resolveActiveTab(tabs: PanelTab[], current: string | undefined): string | undefined {
  if (tabs.length === 0) return undefined;
  if (current !== undefined && tabs.some((t) => t.id === current)) return current;
  return tabs[0]!.id;
}

/** Build a tab's status badge: a count pill when `count` is set, else a bare dot. */
function tabBadgeEl(badge: TabBadge): HTMLElement {
  if (badge.count !== undefined) {
    const pill = document.createElement("span");
    pill.className = `tab-badge ${badge.tone}`;
    pill.textContent = String(badge.count);
    return pill;
  }
  const dot = document.createElement("span");
  dot.className = `tab-dot ${badge.tone}`;
  return dot;
}

/**
 * Build one tab button: a Font Awesome icon, the plugin name, then an optional
 * status badge (icon → label → badge). The label sits in the tab itself (the
 * icon alone isn't self-evident), so there's no separate panel title. Clicking a
 * non-active tab selects it and re-renders from the last state.
 */
function tabEl(tab: PanelTab, active: boolean): HTMLElement {
  const btn = document.createElement("button");
  btn.className = `tab${active ? " tab-active" : ""}`;
  btn.title = tab.label;
  btn.setAttribute("aria-label", tab.label);

  const icon = document.createElement("i");
  icon.className = `fa-solid fa-${tab.icon}`;
  btn.append(icon);

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.label;
  btn.append(label);

  if (tab.badge) btn.append(tabBadgeEl(tab.badge));

  if (!active) {
    btn.addEventListener("click", () => {
      activeTabId = tab.id;
      window.perch.setActiveTab(tab.id); // persist so it's restored next open
      if (lastState) render(lastState);
    });
  }
  return btn;
}

/** Render the PRs pane (stack plugin) into `rowsEl` per the panel status. */
function renderPrsPane(state: PanelState): void {
  if (state.status === "ok") {
    for (const repo of state.repos) rowsEl.append(repoSectionEl(repo));
  } else if (state.status === "loading") {
    rowsEl.append(loadingEl(state.message ?? "Loading…"));
  } else {
    // empty / daemon-down / error → a centered message in the PRs pane.
    const isError = state.status === "daemon-down" || state.status === "error";
    rowsEl.append(messageEl(state.message ?? "", isError));
  }
}

/** Apply a {@link PanelState} to the DOM. */
function render(state: PanelState): void {
  lastState = state;
  syncAvailable = state.syncAvailable;
  syncingRepos = state.syncing;

  // Seed from the persisted tab on first render (activeTabId undefined), then
  // the renderer owns the selection. resolveActiveTab falls back to the first
  // tab if the saved id no longer exists (e.g. that plugin was disabled).
  const activeId = resolveActiveTab(state.tabs, activeTabId ?? state.savedActiveTab);
  activeTabId = activeId;

  // Seed the Dex view mode from the persisted choice on first render (undefined
  // until then), then the renderer owns it — same pattern as the active tab, so
  // the saved mode shows immediately on open with no flash of the wrong view.
  const dexMode = dexViewMode ?? state.savedDexViewMode ?? "tree";
  dexViewMode = dexMode;

  // The tab strip (icon + name + badge per plugin) doubles as the panel header,
  // so it always renders — even a lone PRs tab labels the view.
  tabsEl.replaceChildren();
  for (const tab of state.tabs) tabsEl.append(tabEl(tab, tab.id === activeId));

  // Render only the active plugin's content. Services has its own self-contained
  // section (header + controls + rows); everything else falls through to PRs.
  rowsEl.replaceChildren();
  if (activeId === SERVICES_TAB_ID) {
    // Full-tab pane: the panel title already says "Services", so suppress the
    // section's own title (keep its controls toolbar).
    const services = servicesSectionEl(state.services, false);
    if (services) rowsEl.append(services);
  } else if (activeId === DEX_TASKS_ID) {
    const dex = dexSectionEl(state.dex, dexMode);
    if (dex) rowsEl.append(dex);
  } else if (activeId === WORKTREES_LIST_ID) {
    const worktrees = worktreesSectionEl(state.worktrees);
    if (worktrees) rowsEl.append(worktrees);
  } else {
    renderPrsPane(state);
  }

  // A refresh started by the button stops spinning once the new state lands.
  setRefreshSpinning(false);

  // Transient status toast (e.g. Sync outcome).
  if (state.notice) {
    noticeEl.textContent = state.notice.text;
    noticeEl.className = `notice ${state.notice.tone}`;
    noticeEl.hidden = false;
  } else {
    noticeEl.hidden = true;
  }

  refreshBtn.disabled = false;
}

refreshBtn.addEventListener("click", () => {
  setRefreshSpinning(true);
  window.perch.refresh();
});

window.perch.onState(render);
