/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It receives a
 * fully-derived {@link PanelState} (all mapping done in the main process via
 * `buildPanelState`) and renders the panel DOM. Bundled to plain browser JS by
 * esbuild.
 */
import type { LayerRow, PanelState } from "../panel-state.js";

const repoEl = byId("repo");
const repoSwitcher = byId("repo-switcher") as HTMLSelectElement;
const rowsEl = byId("rows");
const syncBtn = byId("sync") as HTMLButtonElement;
const refreshBtn = byId("refresh") as HTMLButtonElement;

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

/** Build one stack row. */
function rowEl(row: LayerRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "●";
  el.append(dot);

  const branch = document.createElement("span");
  branch.className = "branch";
  branch.textContent = row.branch;
  branch.title = row.title ?? row.branch;
  el.append(branch);

  if (row.prNumber !== undefined) {
    const pr = document.createElement("span");
    pr.className = "pr";
    pr.textContent = `#${row.prNumber}`;
    el.append(pr);
  }

  const chips = document.createElement("span");
  chips.className = "chips";
  for (const c of row.chips) chips.append(chipEl(c.label, c.tone, c.hint));
  if (row.needsRebase) chips.append(badgeEl("rebase", "rb", "Needs rebase"));
  if (row.conflict) chips.append(badgeEl("conflict", "cf", "Merge conflict"));
  el.append(chips);

  return el;
}

/** Render a centered message (loading / empty / daemon-down / error). */
function messageEl(text: string, isError: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = isError ? "message error" : "message";
  el.textContent = text;
  return el;
}

/**
 * Render the repo-switcher dropdown. Shown only when more than one repo is
 * configured; otherwise hidden (single/no repo needs no chooser). Rebuilt from
 * state each push so it tracks config hot-reloads and the active selection.
 */
function renderSwitcher(repos: string[], selected: string | undefined): void {
  const show = repos.length > 1;
  repoSwitcher.hidden = !show;
  if (!show) {
    repoSwitcher.replaceChildren();
    return;
  }
  repoSwitcher.replaceChildren();
  for (const name of repos) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    repoSwitcher.append(opt);
  }
}

/** Apply a {@link PanelState} to the DOM. */
function render(state: PanelState): void {
  const hasSwitcher = state.repos.length > 1;
  // The dropdown names the repo when present; otherwise fall back to the static
  // label (selected repo, else the graph's resolved repo).
  const label = state.selectedRepo ?? state.repo;
  repoEl.textContent = !hasSwitcher && label ? `Stack: ${label}` : "";
  renderSwitcher(state.repos, state.selectedRepo);
  rowsEl.replaceChildren();

  if (state.status === "ok") {
    for (const row of state.rows) rowsEl.append(rowEl(row));
  } else {
    const isError = state.status === "daemon-down" || state.status === "error";
    rowsEl.append(messageEl(state.message ?? "", isError));
  }

  syncBtn.disabled = !state.syncAvailable;
  refreshBtn.disabled = false;
}

syncBtn.addEventListener("click", () => window.perch.sync());
refreshBtn.addEventListener("click", () => window.perch.refresh());
repoSwitcher.addEventListener("change", () => window.perch.selectRepo(repoSwitcher.value));

window.perch.onState(render);
