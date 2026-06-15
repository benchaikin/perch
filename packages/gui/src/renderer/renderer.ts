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
import { DEX_TASKS_ID, type DexRow, type DexSection, type DexStatus } from "../dex-state.js";
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
/** Collapsed dex epic ids (their descendants are hidden); preserved across re-renders. */
const collapsedDexIds = new Set<string>();
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
  "in-progress": "circle-half-stroke",
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
 * everything else uses its health tone.
 */
function dexMarkerTone(row: DexRow): string {
  return row.status === "in-progress" ? "dex-active" : row.health;
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
  marker.className = `dot ${dexMarkerTone(row)} fa-solid fa-${DEX_STATUS_ICON[row.status]}`;
  marker.title = DEX_STATUS_LABEL[row.status];
  el.append(marker);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = row.name;
  el.append(name);

  if (row.blockedByCount > 0) el.append(dexBlockedChip(row.blockedByCount));

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
  marker.className = `dot ${dexMarkerTone(row)} fa-solid fa-${DEX_STATUS_ICON[row.status]}`;
  const title = document.createElement("span");
  title.className = "dex-detail-title";
  title.textContent = row.name;
  head.append(marker, title);
  wrap.append(head);

  const meta = document.createElement("div");
  meta.className = "dex-detail-meta";
  // The task id leads the meta row as a monospace reference (for `dex show`,
  // commit messages, etc.). Click to copy it to the clipboard.
  const idChip = document.createElement("span");
  idChip.className = "chip muted dex-id";
  idChip.title = "Copy task id";
  idChip.textContent = row.id;
  idChip.addEventListener("click", () => {
    window.perch.copyText(row.id);
    // Brief inline confirmation; reverts after a moment (a re-render would also
    // recreate the chip, which is fine — this closure just no-ops on the stale el).
    idChip.textContent = "copied ✓";
    idChip.classList.add("copied");
    setTimeout(() => {
      idChip.textContent = row.id;
      idChip.classList.remove("copied");
    }, 1000);
  });
  meta.append(idChip);
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
  wrap.append(meta);

  if (row.description) wrap.append(dexBodyEl(row.description));
  if (row.result) {
    const label = document.createElement("div");
    label.className = "dex-detail-label";
    label.textContent = "Result";
    wrap.append(label, dexBodyEl(row.result));
  }
  return wrap;
}

/** Build the Dex section header: an expand/collapse-all toggle over the epics. */
function dexHeaderEl(epicIds: string[]): HTMLElement {
  const header = document.createElement("div");
  header.className = "repo-header dex-header";
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
  return header;
}

/**
 * Build the "Dex" section. With a task selected it shows that task's detail;
 * otherwise the tree: an expand/collapse-all header (when there are epics) and
 * the pre-ordered rows, skipping any hidden beneath a collapsed ancestor.
 * Returns null when hidden (no dex plugin / no tasks).
 */
function dexSectionEl(section: DexSection): HTMLElement | null {
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

  const epicIds = section.rows.filter((r) => r.isEpic).map((r) => r.id);
  if (epicIds.length > 0) el.append(dexHeaderEl(epicIds));

  // Pre-ordered rows: skip anything deeper than a collapsed ancestor. On a row
  // at or above the collapse threshold, reset it, then re-arm if this row is a
  // collapsed epic (handles nested collapses).
  let collapseDepth = Infinity;
  for (const row of section.rows) {
    if (row.depth > collapseDepth) continue;
    collapseDepth = Infinity;
    el.append(dexRowEl(row));
    if (row.isEpic && collapsedDexIds.has(row.id)) collapseDepth = row.depth;
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
    const dex = dexSectionEl(state.dex);
    if (dex) rowsEl.append(dex);
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
