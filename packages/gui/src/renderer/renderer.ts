/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It receives a
 * fully-derived {@link PanelState} (all mapping done in the main process via
 * `buildPanelState`) and wires the top-level {@link render}: the tab strip plus
 * the active plugin's pane. Each pane lives in its own module (`prs`, `services`,
 * `dex`, `worktrees`, `tabs`) so a feature touching one panel edits one file and
 * parallel work rarely collides; the shared primitives live in `common`, and the
 * panels' redraw hook in `rerender`. Bundled to plain browser JS by esbuild.
 */
import type { PanelState } from "../panel-state.js";
import { SERVICES_TAB_ID } from "../panel-state.js";
import { DEX_TASKS_ID } from "../dex-state.js";
import { WORKTREES_LIST_ID } from "../worktrees-state.js";
import { byId } from "./common.js";
import { setLastState, setRenderer } from "./rerender.js";
import { resolveActiveTabId, tabEl } from "./tabs.js";
import { renderPrsPane } from "./prs.js";
import { servicesSectionEl } from "./services.js";
import { dexSectionEl } from "./dex.js";
import { worktreesSectionEl } from "./worktrees.js";

const tabsEl = byId("tabs");
const rowsEl = byId("rows");
const refreshBtn = byId("refresh") as HTMLButtonElement;
const refreshIcon = refreshBtn.querySelector("i");
const noticeEl = byId("notice");

/** Spin (or stop spinning) the refresh icon while a refresh is in flight. */
function setRefreshSpinning(on: boolean): void {
  refreshIcon?.classList.toggle("fa-spin", on);
}

/** Apply a {@link PanelState} to the DOM. */
function render(state: PanelState): void {
  setLastState(state);

  // Seed from the persisted tab on first render, then the tabs module owns the
  // selection. resolveActiveTabId falls back to the first tab if the saved id no
  // longer exists (e.g. that plugin was disabled).
  const activeId = resolveActiveTabId(state.tabs, state.savedActiveTab);

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
    const dex = dexSectionEl(state.dex, state.savedDexViewMode);
    if (dex) rowsEl.append(dex);
  } else if (activeId === WORKTREES_LIST_ID) {
    const worktrees = worktreesSectionEl(state.worktrees);
    if (worktrees) rowsEl.append(worktrees);
  } else {
    renderPrsPane(rowsEl, state);
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

// Register render so the panels' requestRender() can replay the last state.
setRenderer(render);

refreshBtn.addEventListener("click", () => {
  setRefreshSpinning(true);
  window.perch.refresh();
});

window.perch.onState(render);
