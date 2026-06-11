/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It receives a
 * fully-derived {@link PanelState} (all mapping done in the main process via
 * `buildPanelState`) and renders the grouped "My PRs" panel DOM. Bundled to
 * plain browser JS by esbuild.
 */
import type { GroupRow, PanelState, PrRow, RepoSection } from "../panel-state.js";

const rowsEl = byId("rows");
const refreshBtn = byId("refresh") as HTMLButtonElement;

let syncAvailable = false;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

/** Build a status chip element. */
function chipEl(label: string, tone: string, hint: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `chip ${tone}`;
  el.textContent = label;
  el.title = hint;
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

/** Build one PR row; clicking opens the PR in the browser. */
function prRowEl(row: PrRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.title = `${row.title} — #${row.number}`;
  el.addEventListener("click", () => window.perch.openPr(row.url));

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "●";
  el.append(dot);

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
  for (const c of row.chips) chips.append(chipEl(c.label, c.tone, c.hint));
  if (row.needsRebase) chips.append(badgeEl("rebase", "rb", "Needs rebase"));
  // A merge conflict is already shown by the `⚠ merge` mergeable chip
  // (mergeable === "CONFLICTING"); don't double-indicate it with a `cf` badge.
  el.append(chips);

  return el;
}

/** Build a nested stack group: a "stack of N" header + indented PR rows. */
function stackGroupEl(group: Extract<GroupRow, { kind: "stack" }>): HTMLElement {
  const el = document.createElement("div");
  el.className = "stack-group";

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
    sync.textContent = "Sync";
    sync.title = `Rebase this stack onto trunk (${group.repo})`;
    sync.addEventListener("click", () => window.perch.sync(group.repo));
    head.append(sync);
  }
  el.append(head);

  const layers = document.createElement("div");
  layers.className = "stack-layers";
  for (const row of group.rows) layers.append(prRowEl(row));
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

/** Render a centered message (loading / empty / daemon-down / error). */
function messageEl(text: string, isError: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = isError ? "message error" : "message";
  el.textContent = text;
  return el;
}

/** Apply a {@link PanelState} to the DOM. */
function render(state: PanelState): void {
  syncAvailable = state.syncAvailable;
  rowsEl.replaceChildren();

  if (state.status === "ok") {
    for (const repo of state.repos) rowsEl.append(repoSectionEl(repo));
  } else {
    const isError = state.status === "daemon-down" || state.status === "error";
    rowsEl.append(messageEl(state.message ?? "", isError));
  }

  refreshBtn.disabled = false;
}

refreshBtn.addEventListener("click", () => window.perch.refresh());

window.perch.onState(render);
