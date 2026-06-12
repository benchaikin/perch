/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It receives a
 * fully-derived {@link PanelState} (all mapping done in the main process via
 * `buildPanelState`) and renders the grouped "My PRs" panel DOM. Bundled to
 * plain browser JS by esbuild.
 */
import type { GroupRow, PanelState, PrRow, RepoSection } from "../panel-state.js";
import type { ServiceRow, ServicesSection } from "../services-state.js";

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

  // Stacked PRs get a position number (1 = trunk-adjacent base); standalone a dot.
  // The marker is colored by the PR's health (green = clean, amber = comments to
  // address, red = blocking attention).
  const marker = document.createElement("span");
  if (pos !== undefined) {
    marker.className = `num ${row.health}`;
    marker.textContent = String(pos);
  } else {
    marker.className = `dot ${row.health}`;
    marker.textContent = "●";
  }
  el.append(marker);

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

  const dot = document.createElement("span");
  dot.className = `dot ${svc.health}`;
  dot.textContent = "●";
  el.append(dot);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = svc.name;
  el.append(name);

  const status = document.createElement("span");
  status.className = "service-status";
  status.textContent = svc.detail ? `${svc.statusLabel} · ${svc.detail}` : svc.statusLabel;
  el.append(status);

  return el;
}

/**
 * Build the "Services" section: a header + one row per process. Returns null
 * when the section is hidden (process-compose unreachable / no services), so the
 * panel is unchanged for users without process-compose.
 */
function servicesSectionEl(section: ServicesSection): HTMLElement | null {
  if (!section.visible) return null;
  const el = document.createElement("section");
  el.className = "repo-section services-section";

  const header = document.createElement("div");
  header.className = "repo-header";
  header.textContent = "Services";
  el.append(header);

  for (const svc of section.rows) el.append(serviceRowEl(svc));
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

/** Apply a {@link PanelState} to the DOM. */
function render(state: PanelState): void {
  syncAvailable = state.syncAvailable;
  syncingRepos = state.syncing;
  rowsEl.replaceChildren();

  if (state.status === "ok") {
    for (const repo of state.repos) rowsEl.append(repoSectionEl(repo));
  } else if (state.status === "loading") {
    rowsEl.append(loadingEl(state.message ?? "Loading…"));
  } else if (state.status === "empty" && state.services.visible) {
    // No PRs but process-compose is live: skip the "No open PRs" message so the
    // Services section (appended below) stands on its own.
  } else {
    const isError = state.status === "daemon-down" || state.status === "error";
    rowsEl.append(messageEl(state.message ?? "", isError));
  }

  // The Services section is self-hiding (omitted when process-compose is absent
  // or reports nothing) — so the My-PRs-only panel is unchanged for users
  // without process-compose. Appended after PRs regardless of PR status.
  const services = servicesSectionEl(state.services);
  if (services) rowsEl.append(services);

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
