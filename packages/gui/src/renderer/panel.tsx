/**
 * The Panel shell as a React component tree: the tab strip (which doubles as the
 * header), the refresh icon-button, the body slot, and the notice toast — all
 * driven by the {@link usePanelState} store. This is the top-level frame every
 * pane renders into; it replaces the imperative top-level render in the old
 * `renderer.ts` and the selection logic in `tabs.ts`.
 *
 * Every pane is now a real React component ({@link PrsPane}, {@link ServicesPane},
 * {@link DexPane}, {@link WorktreesPane}), so the body (`<PaneBody>`) just swaps
 * between them on a tab switch. The pre-React DOM bridge this shell once used to
 * mount the not-yet-ported panes is gone — React keeps each pane's focused input
 * mounted across re-renders, so the old focus-preservation dance is unnecessary.
 */
import { useEffect, useState } from "react";
import type { PanelState, PanelTab, TabBadge as TabBadgeData } from "../panel-state.js";
import { SERVICES_TAB_ID, DASHBOARD_TAB_ID } from "../panel-state.js";
import { DEX_TASKS_ID } from "../dex-state.js";
import { WORKTREES_LIST_ID } from "../worktrees-state.js";
import { useActions } from "./actions.js";
import { usePanelState } from "./store.js";
import { PrsPane } from "./prs.js";
import { ServicesPane } from "./services.js";
import { WorktreesPane } from "./worktrees.js";
import { DexPane } from "./dex-pane.js";
import { DashboardPane } from "./dashboard.js";

/**
 * Resolve which tab should be active: keep the current selection when it still
 * exists (tabs come and go as plugins appear/disappear), else fall back to the
 * first tab. Undefined only when there are no tabs at all. A 1:1 port of
 * `tabs.ts`'s `resolveActiveTab`.
 */
function resolveActiveTab(tabs: PanelTab[], current: string | undefined): string | undefined {
  if (tabs.length === 0) return undefined;
  if (current !== undefined && tabs.some((t) => t.id === current)) return current;
  return tabs[0]!.id;
}

/**
 * Own the active-tab selection with the same seed-then-own semantics as
 * `tabs.ts`: seed from the persisted `savedActiveTab` on first render (component
 * state still undefined), then this component owns it — with the first-tab
 * fallback when the selected/saved id no longer exists (e.g. a disabled plugin).
 * Returns the resolved id plus a setter the tab click drives.
 */
function useActiveTab(
  tabs: PanelTab[],
  savedActiveTab: string | undefined,
): [string | undefined, (id: string) => void] {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const activeId = resolveActiveTab(tabs, selected ?? savedActiveTab);
  return [activeId, setSelected];
}

/** A tab's status badge: a count pill when `count` is set, else a bare dot. */
function TabBadge({ badge }: { badge: TabBadgeData }): JSX.Element {
  if (badge.count !== undefined) {
    return <span className={`tab-badge ${badge.tone}`}>{badge.count}</span>;
  }
  return <span className={`tab-dot ${badge.tone}`} />;
}

/**
 * One tab button: a Font Awesome icon, the plugin name, then an optional status
 * badge (icon → label → badge). The active tab carries no click handler (it's
 * already selected), mirroring `tabs.ts`.
 */
function Tab({
  tab,
  active,
  onSelect,
}: {
  tab: PanelTab;
  active: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <button
      className={`tab${active ? " tab-active" : ""}`}
      title={tab.label}
      aria-label={tab.label}
      onClick={active ? undefined : () => onSelect(tab.id)}
    >
      <i className={`fa-solid fa-${tab.icon}`} />
      <span className="tab-label">{tab.label}</span>
      {tab.badge && <TabBadge badge={tab.badge} />}
    </button>
  );
}

/** The tab strip: one {@link Tab} per plugin tab, in display order. */
function Tabs({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: PanelTab[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <>
      {tabs.map((tab) => (
        <Tab key={tab.id} tab={tab} active={tab.id === activeId} onSelect={onSelect} />
      ))}
    </>
  );
}

/** The transient status toast (e.g. a Sync outcome); hidden when absent. */
function Notice({ notice }: { notice: PanelState["notice"] }): JSX.Element {
  if (!notice) return <div id="notice" className="notice" hidden />;
  return (
    <div id="notice" className={`notice ${notice.tone}`}>
      {notice.text}
    </div>
  );
}

/**
 * The panel body slot: React's `<main id="rows">`, holding the active pane. Every
 * pane is a real React subtree now ({@link PrsPane}, {@link ServicesPane},
 * {@link DexPane}, {@link WorktreesPane}); React swaps between them on a tab
 * switch, tearing down the previous pane's DOM cleanly. The Services pane is the
 * active full-tab view, so its own title is suppressed (`showTitle=false`) — the
 * panel header already names "Services".
 */
function PaneBody({
  activeId,
  state,
}: {
  activeId: string | undefined;
  state: PanelState | undefined;
}): JSX.Element {
  return (
    <main id="rows" className="rows">
      {state &&
        (activeId === DASHBOARD_TAB_ID ? (
          <DashboardPane />
        ) : activeId === SERVICES_TAB_ID ? (
          <ServicesPane section={state.services} showTitle={false} />
        ) : activeId === WORKTREES_LIST_ID ? (
          <WorktreesPane section={state.worktrees} />
        ) : activeId === DEX_TASKS_ID ? (
          <DexPane
            section={state.dex}
            savedViewMode={state.savedDexViewMode}
            savedDialogSize={state.savedNewTaskDialogSize}
          />
        ) : (
          <PrsPane state={state} />
        ))}
    </main>
  );
}

/**
 * The panel shell: reads the pushed {@link PanelState}, owns the active-tab
 * selection and the refresh-in-flight spinner, and lays out the header (tab strip
 * + refresh), the body slot, and the notice toast. Ids/classes match the static
 * markup so `renderer.css` keeps applying.
 */
export function Panel(): JSX.Element {
  const state = usePanelState();
  const actions = useActions();
  const tabs = state?.tabs ?? [];
  const [activeId, setActiveId] = useActiveTab(tabs, state?.savedActiveTab);

  // The refresh spinner is a transient that the button raises on click and the
  // next state push lowers — model it as component state cleared whenever a new
  // state lands (the store hands back a fresh reference per push).
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setRefreshing(false);
  }, [state]);

  function selectTab(id: string): void {
    setActiveId(id);
    actions.setActiveTab(id); // persist so it's restored next open
  }

  return (
    <>
      <header className="header">
        <nav id="tabs" className="tabs">
          <Tabs tabs={tabs} activeId={activeId} onSelect={selectTab} />
        </nav>
        <button
          id="refresh"
          className="icon-btn"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            setRefreshing(true);
            actions.refresh();
          }}
        >
          <i className={`fa-solid fa-arrows-rotate${refreshing ? " fa-spin" : ""}`} />
        </button>
      </header>
      <hr className="rule" />
      <PaneBody activeId={activeId} state={state} />
      <Notice notice={state?.notice} />
    </>
  );
}

/** The renderer's root component (createRoot target); renders the {@link Panel}. */
export function App(): JSX.Element {
  return <Panel />;
}
