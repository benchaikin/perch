/**
 * The Panel shell as a React component tree: the tab strip (which doubles as the
 * header), the refresh icon-button, the body slot, and the notice toast — all
 * driven by the {@link usePanelState} store. This is the top-level frame every
 * pane renders into; it replaces the imperative top-level render in the old
 * `renderer.ts` and the selection logic in `tabs.ts`.
 *
 * The body (`<PaneBody>`) is the one spot still bridged to the pre-React DOM
 * builders: until each pane is ported (T5–T8), it mounts the remaining `dex`
 * section builder into `#rows` so the panel keeps working at every merge (the
 * PRs, Services, and Worktrees panes are real React components now). That bridge
 * — and the `rerender`/`panel-focus` machinery it leans on — is deleted in T10
 * once every pane is a real React component (React then keeps the focused input
 * mounted, so the focus dance and the manual replay hook both go away).
 */
import { useEffect, useRef, useState } from "react";
import type { PanelState, PanelTab, TabBadge as TabBadgeData } from "../panel-state.js";
import { SERVICES_TAB_ID } from "../panel-state.js";
import { DEX_TASKS_ID } from "../dex-state.js";
import { WORKTREES_LIST_ID } from "../worktrees-state.js";
import { useActions } from "./actions.js";
import { usePanelState } from "./store.js";
import { captureFieldFocus, restoreFieldFocus } from "./panel-focus.js";
import { setLastState, setRenderer } from "./rerender.js";
import { PrsPane } from "./prs.js";
import { ServicesPane } from "./services.js";
import { WorktreesPane } from "./worktrees.js";
import { dexSectionEl } from "./dex.js";

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

/** Whether `activeId` is a pane still rendered by the pre-React DOM builders. */
function isLegacyPane(activeId: string | undefined): boolean {
  return activeId === DEX_TASKS_ID;
}

/**
 * Mount one not-yet-ported pane's legacy DOM into `host`, preserving any focused
 * in-panel field across the rebuild. A trimmed lift of the old `renderer.ts`
 * render body — only Dex, since the PRs, Services, and Worktrees panes are now
 * real React components (see {@link PrsPane}, {@link ServicesPane},
 * {@link WorktreesPane}). Interim: each pane drops out of here as T8 lands, and
 * T10 deletes the bridge entirely.
 */
function mountLegacyPane(host: HTMLElement, activeId: string | undefined, state: PanelState): void {
  // A periodic board poll re-renders mid-type; capture the focused field before
  // replaceChildren throws it away, restore it after (no-op unless the panel
  // already owns focus). Removed in T10 — React panes keep the input mounted.
  const preservedFocus = captureFieldFocus(document.activeElement, host);
  host.replaceChildren();
  if (activeId === DEX_TASKS_ID) {
    const dex = dexSectionEl(state.dex, state.savedDexViewMode);
    if (dex) host.append(dex);
  }
  restoreFieldFocus(preservedFocus, host);
}

/**
 * The bridge to the pre-React DOM builders for the not-yet-ported panes. React
 * owns this `display: contents` host element (so its imperative children lay out
 * as direct flex items of `#rows`) but not its children: an effect mounts the
 * active legacy pane into it on every state push, and registers a replay so a
 * pane's own `requestRender()` (a chevron toggle, an optimistic spawn) re-mounts
 * it. Rendered only while a legacy pane is active — the PRs pane is real React —
 * so React cleanly tears the host (and its legacy DOM) down on a switch to PRs.
 * T6–T8 swap each remaining pane for a React subtree; T10 deletes this.
 */
function LegacyPaneHost({
  activeId,
  state,
}: {
  activeId: string | undefined;
  state: PanelState;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest activeId for the requestRender replay closure below, which
  // must re-mount whichever legacy pane is currently active.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // Record the state + how to replay it, so a legacy pane's requestRender()
    // re-mounts the active pane.
    setLastState(state);
    setRenderer((replayed) => {
      if (ref.current) mountLegacyPane(ref.current, activeIdRef.current, replayed);
    });
    mountLegacyPane(host, activeId, state);
  }, [activeId, state]);

  // `display: contents` keeps the legacy sections as direct flex children of
  // `.rows` (the host box vanishes), so the layout matches the pre-React DOM.
  return <div ref={ref} style={{ display: "contents" }} />;
}

/**
 * The panel body slot: React's `<main id="rows">`, holding the active pane. The
 * PRs, Services, and Worktrees panes are real React subtrees ({@link PrsPane},
 * {@link ServicesPane}, {@link WorktreesPane}); the not-yet-ported Dex pane still
 * renders through the {@link LegacyPaneHost} bridge. React swaps between them on a
 * tab switch, so a switch into a React pane tears the legacy DOM down cleanly. The
 * Services pane is the active full-tab view, so its own title is suppressed
 * (`showTitle=false`) — the panel header already names "Services".
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
        (activeId === SERVICES_TAB_ID ? (
          <ServicesPane section={state.services} showTitle={false} />
        ) : activeId === WORKTREES_LIST_ID ? (
          <WorktreesPane section={state.worktrees} />
        ) : isLegacyPane(activeId) ? (
          <LegacyPaneHost activeId={activeId} state={state} />
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
