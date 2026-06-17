/**
 * The tab strip (which doubles as the panel header): one button per plugin tab
 * with an icon, label, and optional status badge. Owns the active-tab selection
 * — seeded from the persisted tab, then this module owns it — exposed to the
 * top-level render via {@link resolveActiveTabId}.
 */
import type { PanelTab, TabBadge } from "../panel-state.js";
import { requestRender } from "./rerender.js";

/**
 * The selected plugin tab's id, preserved across re-renders while that tab still
 * exists (else it falls back to the first tab — e.g. Services going away returns
 * focus to PRs). Undefined until the first state arrives.
 */
let activeTabId: string | undefined;

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

/**
 * Resolve and adopt the active tab for this render: seed from the persisted tab
 * on first render (activeTabId undefined), then this module owns the selection.
 * Returns the active id for the entry to switch the rendered pane on.
 */
export function resolveActiveTabId(
  tabs: PanelTab[],
  savedActiveTab: string | undefined,
): string | undefined {
  const activeId = resolveActiveTab(tabs, activeTabId ?? savedActiveTab);
  activeTabId = activeId;
  return activeId;
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
export function tabEl(tab: PanelTab, active: boolean): HTMLElement {
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
      requestRender();
    });
  }
  return btn;
}
