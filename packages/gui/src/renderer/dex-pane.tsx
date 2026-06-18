/**
 * The Dex pane as a React component tree — part (a) of the Dex port: the section
 * shell, the task tree (rows + collapse/expand), the click-to-copy id chip, and
 * the shared landable / live-agent markers. A behavioral port of the tree branch
 * of the imperative `dexSectionEl` in {@link ./dex.ts}, following the reference
 * shape of {@link ./prs.js#PrsPane}: data down as props (the pushed
 * {@link DexSection}), events up via the typed {@link useActions} surface.
 *
 * Interaction state that the old `dex.ts` held in module-global `Set`s/`let`s
 * (`collapsedDexIds`, `selectedDexId`) becomes explicit React state, lifted into
 * {@link DexContext} so the rest of the sub-epic (graph view, detail, actions,
 * drag-and-drop, composer — T8b–T8f) reads + extends one shared store rather than
 * re-introducing globals. The view-mode toggle, the detail view, the per-row
 * spawn/delete/worktree controls, and drag-and-drop deps are deliberately NOT
 * here yet — each is its own follow-on child; the seams are marked below.
 *
 * Class names are kept byte-equivalent to the DOM builders (`dex-row`, `dex-id`,
 * `dex-landable`, `dex-agent`, `dex-chevron`, the chip tones) so `renderer.css`
 * keeps applying unchanged.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { isOpenDexTask, type DexRow, type DexSection, type DexStatus } from "../dex-state.js";
import type { LandableState } from "../landable.js";
import type { AgentState, AgentSummary } from "../agents-state.js";
import type { DexEditRequest } from "../ipc.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import { useActions } from "./actions.js";
import { DEX_STATUS_LABEL, DexTaskDot } from "./dex-task-chip.js";

// ---------------------------------------------------------------------------
// Dex interaction state (replaces dex.ts's module globals)
// ---------------------------------------------------------------------------

/**
 * A dependency-edit drag in flight (the `draggingDex*` module globals of `dex.ts`,
 * lifted into the shared store). `id` is the dragged task — the blocker side of an
 * add (drop A onto B ⇒ B blocked-by A). `blockerId` is set only when the dragged
 * row is a *nested graph node*: it's the blocker that node sits under, so dropping
 * the node on the unblock zone removes exactly that edge. Tree rows and unblocked
 * roots leave it `undefined`, so the remove gesture stays inert for them.
 */
interface DexDragState {
  /** The dragged task's id (the blocker on an add edge). */
  id: string;
  /** The dragged task's project — a blocker edge can only link same-project tasks. */
  project: string | undefined;
  /** The blocker this nested node sits under, if any (the edge a drop on the unblock zone removes). */
  blockerId: string | undefined;
}

/**
 * The Dex pane's interaction state, shared with the children the sub-epic adds
 * (T8b–T8f read + extend this). It owns the collapsed-epic set, the selected task,
 * and the in-flight dependency-edit drag. `selectedId` is the `selectedDexId`
 * replacement — clicking a row sets it; the detail view that reads it lands in T8c.
 */
interface DexContextValue {
  /** Ids of collapsed epics (their descendants are hidden). */
  collapsed: ReadonlySet<string>;
  /** Toggle an epic's collapsed state. */
  toggleCollapsed(id: string): void;
  /** The task whose detail is open, if any (the `selectedDexId` replacement). */
  selectedId: string | undefined;
  /** Open a task's detail (or clear with `undefined`). */
  setSelectedId(id: string | undefined): void;
  /** The dependency-edit drag in flight, or `undefined` when nothing is dragging. */
  drag: DexDragState | undefined;
  /** Begin dragging a row (passing the blocker edge it's nested on, for graph nodes). */
  beginDrag(row: DexRow, blockerId?: string): void;
  /** End the in-flight drag (a drop fired, or the drag was cancelled). */
  endDrag(): void;
}

const DexContext = createContext<DexContextValue | undefined>(undefined);

/** Read the Dex interaction state; throws if used outside {@link DexProvider}. */
function useDexContext(): DexContextValue {
  const ctx = useContext(DexContext);
  if (!ctx) throw new Error("useDexContext must be used within a DexProvider");
  return ctx;
}

/**
 * Hold the Dex pane's interaction state and expose it via {@link DexContext}.
 * Collapse is a fresh `Set` per toggle so React sees a new reference and
 * re-renders (the old `dex.ts` mutated a module-global `Set` + called
 * `requestRender()`; this is just component state).
 */
export function DexProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [drag, setDrag] = useState<DexDragState | undefined>(undefined);

  const value = useMemo<DexContextValue>(
    () => ({
      collapsed,
      toggleCollapsed(id) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      },
      selectedId,
      setSelectedId,
      drag,
      beginDrag(row, blockerId) {
        setDrag({ id: row.id, project: row.project, blockerId });
      },
      endDrag() {
        setDrag(undefined);
      },
    }),
    [collapsed, selectedId, drag],
  );

  return <DexContext.Provider value={value}>{children}</DexContext.Provider>;
}

// ---------------------------------------------------------------------------
// Status marker (the row's health-toned, status-shaped glyph)
// ---------------------------------------------------------------------------

/**
 * Status-specific marker glyphs for dex task rows. Distinct *shapes* (open
 * circle / spinner / no-entry / check) so status reads without relying on the
 * color a colorblind viewer can't separate; the health tone layers color.
 */
const DEX_STATUS_ICON: Record<DexStatus, string> = {
  ready: "circle",
  "in-progress": "spinner",
  blocked: "ban",
  done: "circle-check",
};

/**
 * Full class string for a task's status marker `<i>`: the health tone
 * (in-progress reads accent-blue "actively being worked" rather than its amber
 * health tone), the status-shaped Font Awesome glyph, and `fa-spin` for
 * in-progress. Keyed off `displayStatus` so a rolled-up epic gets the active
 * tone + spinner too.
 */
function dexMarkerClass(row: DexRow): string {
  const tone = row.displayStatus === "in-progress" ? "dex-active" : row.health;
  const spin = row.displayStatus === "in-progress" ? " fa-spin" : "";
  return `dot ${tone} fa-solid fa-${DEX_STATUS_ICON[row.displayStatus]}${spin}`;
}

// ---------------------------------------------------------------------------
// Chips (id / blocked / landable / agent)
// ---------------------------------------------------------------------------

/**
 * The task id as a monospace reference chip. Click to copy it to the clipboard
 * with a brief inline confirmation; `stopPropagation` so copying never opens the
 * row's detail. When `open` (unblocked + unfinished), the chip carries the task's
 * stable identity color as a faint backing tint via the `dex-open` class + the
 * `--task-color`/`--task-color-rgb` custom properties the CSS reads.
 */
function DexIdChip({ id, open = false }: { id: string; open?: boolean }): JSX.Element {
  const actions = useActions();
  const [copied, setCopied] = useState(false);

  // Revert the inline "copied ✓" confirmation after a moment; the cleanup clears
  // the timer if the chip unmounts (or is re-clicked) first, so no stray update.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(t);
  }, [copied]);

  let style: CSSProperties | undefined;
  if (open) {
    const color = dexTaskColor(id);
    style = {
      ["--task-color"]: color.hex,
      ["--task-color-rgb"]: `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`,
    } as CSSProperties;
  }

  return (
    <span
      className={`chip muted dex-id${open ? " dex-open" : ""}${copied ? " copied" : ""}`}
      title="Copy task id"
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        actions.copyText(id);
        setCopied(true);
      }}
    >
      {copied ? "copied ✓" : id}
    </span>
  );
}

/** A small blocker-count chip ("blocked ×N"). */
function DexBlockedChip({ count }: { count: number }): JSX.Element {
  return (
    <span className="chip bad" title={`Blocked by ${count} task${count === 1 ? "" : "s"}`}>
      {`blocked ×${count}`}
    </span>
  );
}

/**
 * Glanceable spec for each "landable" state a finished work-item's PR can be in,
 * so the task list doubles as a review/merge queue. Each carries a short label, a
 * `.chip` tone, and a distinct Font Awesome *shape* (a non-color cue); `ci-running`
 * spins. `none` is intentionally absent — it renders no chip. Unmapped states fall
 * back to a neutral chip labeled with the raw state, so a state added upstream
 * renders rather than crashes (see {@link LANDABLE_FALLBACK} / {@link LandableChip}).
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

/** Neutral fallback for an unmapped/unknown landable state — renders the raw
 *  state rather than crashing, so a future upstream state still shows up. */
const LANDABLE_FALLBACK = { tone: "muted", icon: "code-pull-request" } as const;

/**
 * The "landable" chip for a task row from its PR's merge-readiness state, or null
 * for `none` (nothing to land). Non-interactive — glanceable only; clicking the
 * row still opens the task detail.
 */
function LandableChip({ state }: { state: LandableState }): JSX.Element | null {
  if (state === "none") return null;
  const spec = LANDABLE_CHIP[state];
  const tone = spec?.tone ?? LANDABLE_FALLBACK.tone;
  return (
    <span className={`chip ${tone} dex-landable`} title={spec?.hint ?? `Landable: ${state}`}>
      <i
        className={`fa-solid fa-${spec?.icon ?? LANDABLE_FALLBACK.icon}${spec?.spin ? " fa-spin" : ""}`}
      />
      {` ${spec?.label ?? state}`}
    </span>
  );
}

/**
 * Glanceable spec for each live-agent lifecycle state, so a task row reads as a
 * fleet at-a-glance. Each carries a distinct Font Awesome *shape* (a non-color
 * cue) plus a `.chip` tone: `blocked` is the attention state (warn), `error` is
 * bad, `running` reads accent-blue ("actively working"), `idle`/`ended` muted.
 * `running` spins. Render-only — deliberately OUT of the tray-badge semantics.
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
  blocked: { label: "blocked", tone: "warn", icon: "hand", hint: "Agent blocked — awaiting input" },
  idle: { label: "idle", tone: "muted", icon: "pause", hint: "Agent idle" },
  ended: { label: "done", tone: "muted", icon: "check", hint: "Agent session ended" },
  error: { label: "error", tone: "bad", icon: "triangle-exclamation", hint: "Agent errored" },
};

/**
 * The live-agent marker for a task row from its session's lifecycle state: a
 * compact `.chip` with a state-shaped icon. The agent's latest `message` (when
 * present) enriches the tooltip. Non-interactive — glanceable only.
 */
function AgentMarker({ agent }: { agent: AgentSummary }): JSX.Element {
  const spec = AGENT_MARKER[agent.state];
  return (
    <span
      className={`chip ${spec.tone} dex-agent`}
      title={agent.message ? `${spec.hint}: ${agent.message}` : spec.hint}
    >
      <i className={`fa-solid fa-${spec.icon}${spec.spin ? " fa-spin" : ""}`} />
      {` ${spec.label}`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Drag-and-drop dependency wiring (the `dex.ts` makeDexRowDraggable port)
// ---------------------------------------------------------------------------

/**
 * Whether `target` is a valid drop target for the in-flight dependency drag: there
 * is a drag, it isn't a self-drop (A onto A is a no-op), and source + target share
 * a project — a blocker edge can only link tasks in the same store, so a
 * cross-project drop is rejected before it reaches the daemon. Cycles aren't
 * checked here; dex itself rejects them and the daemon surfaces a clear notice.
 */
export function isValidDexDropTarget(drag: DexDragState | undefined, target: DexRow): boolean {
  if (drag === undefined || drag.id === target.id) return false;
  return target.project === drag.project;
}

/** The drag-and-drop props + derived class a draggable row spreads onto its element. */
interface DexRowDrag {
  /** Spread onto the row element (`draggable` + the HTML5 drag handlers). */
  props: {
    draggable: true;
    onDragStart(e: React.DragEvent): void;
    onDragEnd(): void;
    onDragOver(e: React.DragEvent): void;
    onDragLeave(): void;
    onDrop(e: React.DragEvent): void;
  };
  /** The drag-state class suffix to append to the row's `className`. */
  className: string;
}

/**
 * Drag-and-drop dependency editing for one dex task row. The row becomes a drag
 * source; dropping ANOTHER row onto it makes THIS row blocked-by the dragged task
 * (drop A onto B ⇒ B blocked-by A, via {@link PerchActions.dexAddBlocker}). A valid
 * target (different task, same project) lights up while hovered. Shared by the tree
 * row and the graph node so both surfaces edit dependencies identically.
 *
 * `blockerId` (graph nested nodes only) is the blocker this row sits under; passing
 * it lets a drop on the {@link DexUnblockZone} remove exactly that edge. Tree rows
 * and unblocked roots omit it and only add. The optimistic drop-target highlight is
 * local component state; the dragged-row identity lives in the shared {@link drag}
 * store so the target's drop handler can read it. The actual edge change comes back
 * via the next pushed PanelState — a drag and a click stay distinct gestures, so
 * the row's click-to-open-detail is untouched.
 */
export function useDexRowDrag(row: DexRow, blockerId?: string): DexRowDrag {
  const actions = useActions();
  const { drag, beginDrag, endDrag } = useDexContext();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const isDragging = drag?.id === row.id;

  return {
    props: {
      draggable: true,
      onDragStart(e) {
        beginDrag(row, blockerId);
        if (e.dataTransfer) {
          // A nested node drops two ways — onto a row to ADD a blocker (`link`) or
          // onto the unblock zone to REMOVE one (`move`) — so allow both; a row with
          // no parent blocker only adds, so it stays `link`.
          e.dataTransfer.effectAllowed = blockerId !== undefined ? "all" : "link";
          // Carry the id too, so a drop still resolves if the store is ever lost.
          e.dataTransfer.setData("text/plain", row.id);
        }
      },
      onDragEnd() {
        endDrag();
        setIsDropTarget(false);
      },
      onDragOver(e) {
        if (!isValidDexDropTarget(drag, row)) return;
        // preventDefault marks this a valid drop zone (and lets the drop fire).
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "link";
        setIsDropTarget(true);
      },
      onDragLeave() {
        setIsDropTarget(false);
      },
      onDrop(e) {
        e.preventDefault();
        setIsDropTarget(false);
        const sourceId = drag?.id ?? e.dataTransfer?.getData("text/plain") ?? undefined;
        if (!sourceId || !isValidDexDropTarget(drag, row)) return;
        // Drop source onto this row ⇒ this row (the target) becomes blocked by source.
        void actions.dexAddBlocker({ blockedId: row.id, blockerId: sourceId });
      },
    },
    className: `${isDragging ? " dex-dragging" : ""}${isDropTarget ? " dex-drop-target" : ""}`,
  };
}

/**
 * The graph view's "drop here to unblock" zone: a drop target, hidden until a
 * nested node is dragged (`armed`), that removes the dragged node's blocker edge —
 * the inverse of dropping one row onto another. Dropping a node nested under blocker
 * B fires `dexRemoveBlocker({ blockedId: node, blockerId: B })`, removing exactly
 * that edge and leaving the task's other blockers intact; main refreshes the board
 * and toasts the outcome. Inert unless the in-flight drag carries a parent blocker,
 * so an unblocked-root / tree-row drag can't trip it. Class + label are kept
 * byte-equivalent to `dex.ts` so `renderer.css` keeps applying. Exported for the
 * graph view (T8b) — the only surface with nested nodes to drag out.
 */
export function DexUnblockZone(): JSX.Element {
  const actions = useActions();
  const { drag } = useDexContext();
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Revealed only while a node sitting on a removable blocker edge is dragged.
  const armed = drag?.blockerId !== undefined;

  return (
    <div
      className={`dex-unblock-zone${armed ? " armed" : ""}${isDropTarget ? " dex-drop-target" : ""}`}
      onDragOver={(e) => {
        if (!armed) return;
        // preventDefault marks this a valid drop zone (and lets the drop fire).
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setIsDropTarget(true);
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDropTarget(false);
        // Both halves of the edge come from the in-flight drag: the dragged node is
        // the blocked task, and it carries the specific blocker it was nested under.
        if (drag?.id === undefined || drag?.blockerId === undefined) return;
        void actions.dexRemoveBlocker({ blockedId: drag.id, blockerId: drag.blockerId });
      }}
    >
      <i className="fa-solid fa-link-slash" />
      <span>Drop here to remove this blocker</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows + tree
// ---------------------------------------------------------------------------

/**
 * One dex task row: an expand/collapse chevron (epics) or aligning spacer
 * (leaves), the status marker, the name, the identity dot + click-to-copy id
 * chip, and the optional blocker / landable / live-agent chips. Clicking the row
 * body opens the task's detail (sets the selection); clicking an epic's chevron
 * toggles its children without opening detail.
 *
 * The per-row spawn/delete/worktree controls are NOT here yet — T8d (actions)
 * adds them; this is the row's identity + status skeleton they hang off. The row
 * is a drag source + drop target for dependency editing (drop A onto B ⇒ B
 * blocked-by A), via {@link useDexRowDrag}.
 */
function DexTaskRow({ row }: { row: DexRow }): JSX.Element {
  const { collapsed, toggleCollapsed, setSelectedId } = useDexContext();
  const open = isOpenDexTask(row);
  const isCollapsed = collapsed.has(row.id);
  const blockedHint = row.blockedByCount > 0 ? ` (blocked by ${row.blockedByCount})` : "";
  // Drag this row onto another to wire a dependency (drop A onto B ⇒ B blocked-by A).
  const drag = useDexRowDrag(row);

  return (
    <div
      className={`row dex-row${row.isEpic ? " dex-epic" : ""}${drag.className}`}
      // Indent by tree depth so epics → tasks → subtasks read as a hierarchy.
      style={{ paddingLeft: `${row.depth * 14}px` }}
      title={`${row.name} — ${DEX_STATUS_LABEL[row.status]}${blockedHint}`}
      onClick={() => setSelectedId(row.id)}
      {...drag.props}
    >
      {row.isEpic ? (
        <button
          className="dex-chevron"
          title={isCollapsed ? "Expand" : "Collapse"}
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            // Toggle children without triggering the row's open-detail click.
            e.stopPropagation();
            toggleCollapsed(row.id);
          }}
        >
          <i className={`fa-solid fa-chevron-${isCollapsed ? "right" : "down"}`} />
        </button>
      ) : (
        <span className="dex-chevron-spacer" />
      )}

      <i className={dexMarkerClass(row)} title={DEX_STATUS_LABEL[row.displayStatus]} />

      <span className="branch">{row.name}</span>

      {/* An open (unblocked, unfinished) task leads with a solid identity-color
          dot, then the id chip (which carries the same color as a faint tint). */}
      {open && <DexTaskDot id={row.id} />}
      <DexIdChip id={row.id} open={open} />

      {row.blockedByCount > 0 && <DexBlockedChip count={row.blockedByCount} />}
      {row.landable && <LandableChip state={row.landable} />}
      {row.agent && <AgentMarker agent={row.agent} />}
    </div>
  );
}

/**
 * The rows visible in the tree: the pre-ordered rows, skipping anything deeper
 * than a collapsed ancestor. On a row at or above the collapse threshold, reset
 * it, then re-arm if this row is itself a collapsed epic (handles nested
 * collapses). A 1:1 port of `dex.ts`'s `dexTreeRows` walk.
 */
function visibleTreeRows(rows: readonly DexRow[], collapsed: ReadonlySet<string>): DexRow[] {
  const visible: DexRow[] = [];
  let collapseDepth = Infinity;
  for (const row of rows) {
    if (row.depth > collapseDepth) continue;
    collapseDepth = Infinity;
    visible.push(row);
    if (row.isEpic && collapsed.has(row.id)) collapseDepth = row.depth;
  }
  return visible;
}

/**
 * The Dex section header — for T8a, just the expand/collapse-all toggle over the
 * tree's epics (rendered only when there are epics to fold). The view-mode toggle
 * (T8b), the New-task composer control (T8f), and the spawn-all-ready button
 * (T8d) land alongside this in their own children.
 */
function DexHeader({ epicIds }: { epicIds: string[] }): JSX.Element {
  const { collapsed, toggleCollapsed } = useDexContext();
  const allCollapsed = epicIds.every((id) => collapsed.has(id));
  return (
    <div className="repo-header dex-header">
      <button
        className="icon-btn dex-toggle-all"
        title={allCollapsed ? "Expand all" : "Collapse all"}
        aria-label={allCollapsed ? "Expand all" : "Collapse all"}
        onClick={() => {
          // Collapse-all collapses any still-open epic; expand-all (when every
          // epic is already collapsed) reopens them. Toggle only the epics whose
          // state needs flipping so the result is uniform either way.
          for (const id of epicIds) {
            if (allCollapsed === collapsed.has(id)) toggleCollapsed(id);
          }
        }}
      >
        <i className={`fa-solid fa-${allCollapsed ? "angles-down" : "angles-up"}`} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task detail view + inline editor
// ---------------------------------------------------------------------------

/**
 * Whether a task is ready to hand to a fresh agent: an unblocked `ready` row with
 * no live worktree or agent (so a started task shows its status instead of a
 * start button). A 1:1 port of the old `dex.ts#canSpawnDex`; the per-row spawn
 * controls T8d adds reuse it.
 */
function canSpawnDex(row: DexRow): boolean {
  return (
    row.status === "ready" &&
    row.blockedByCount === 0 &&
    row.worktree === undefined &&
    row.agent === undefined
  );
}

/** A pre-formatted, wrapping text block for the detail view (description / result). */
function DexBody({ text }: { text: string }): JSX.Element {
  return <pre className="dex-detail-body">{text}</pre>;
}

/**
 * The detail view's meta row: the click-to-copy id chip, the status chip, the
 * project chip (multi-repo only), and the blocker / landable / live-agent
 * markers. Shared by the read-only detail and the inline editor so the two read
 * identically while editing.
 */
function DexMeta({ row }: { row: DexRow }): JSX.Element {
  return (
    <div className="dex-detail-meta">
      <DexIdChip id={row.id} />
      <span className={`chip ${row.health}`}>{DEX_STATUS_LABEL[row.status]}</span>
      {row.project && <span className="chip muted">{row.project}</span>}
      {row.blockedByCount > 0 && <DexBlockedChip count={row.blockedByCount} />}
      {row.landable && <LandableChip state={row.landable} />}
      {row.agent && <AgentMarker agent={row.agent} />}
    </div>
  );
}

/**
 * The detail-page launch control: a labeled button that starts an agent for a
 * ready task via `dex.spawn`. The detail-page twin of the per-row spawn button,
 * carrying the shared `dex-spawn` hook plus the detail-specific `dex-detail-spawn`
 * class. Only rendered for {@link canSpawnDex} rows. (T8d folds spawn into the
 * shared optimistic in-flight state alongside the per-row buttons; here it fires
 * the bridge action directly.)
 */
function DexDetailSpawnButton({ id }: { id: string }): JSX.Element {
  const actions = useActions();
  return (
    <button
      className="btn btn-sm dex-spawn dex-detail-spawn"
      title="Start an agent for this task"
      aria-label="Start an agent for this task"
      onClick={() => void actions.dexSpawn(id)}
    >
      <i className="fa-solid fa-play" />
      {" Start agent"}
    </button>
  );
}

/**
 * The inline name/description editor behind the detail view's Edit button: a name
 * input, a description textarea, and Save / Cancel. Save persists the changed
 * fields via `window.perch.dexEdit` (only the fields that actually differ from the
 * row are sent; an empty description is a deliberate clear, a blank name is
 * rejected with an inline invalid flag).
 *
 * The draft (name + description) is local component state, seeded ONCE from the
 * row on mount and deliberately never resynced from `row` — so a background
 * PanelState push that re-renders the detail with a fresh `row` can't clobber what
 * the user has typed (the draft is the source of truth until Save).
 *
 * HEADLINE: the inputs keep focus + caret while typing across a background push.
 * Achieved the React way — this component stays mounted with stable identity while
 * editing, so its `<input>`/`<textarea>` are reconciled in place rather than
 * rebuilt, preserving focus + selection. No `data-focus-key` hack (that imperative
 * focus-restore path is deleted wholesale in T10).
 */
function DexEditor({ row, onClose }: { row: DexRow; onClose: () => void }): JSX.Element {
  const actions = useActions();
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus + select the name field once, when the editor opens.
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  async function save(): Promise<void> {
    if (saving) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      // A task must keep a name — flag the field and stay in edit mode.
      setNameInvalid(true);
      nameRef.current?.focus();
      return;
    }

    // Only send the fields that actually changed (description compared verbatim so
    // a whitespace-only edit still counts; an empty description is a valid clear).
    const request: DexEditRequest = { id: row.id };
    if (trimmed !== row.name) request.name = trimmed;
    if (description !== row.description) request.description = description;

    if (request.name === undefined && request.description === undefined) {
      onClose(); // no-op: nothing changed, leave edit mode without a daemon round-trip
      return;
    }

    setSaving(true);
    try {
      await actions.dexEdit(request);
    } finally {
      // Leave edit mode on completion; the board refresh from main updates the row.
      onClose();
    }
  }

  return (
    <>
      <div className="dex-detail-head">
        <i className={dexMarkerClass(row)} title={DEX_STATUS_LABEL[row.displayStatus]} />
        <input
          ref={nameRef}
          type="text"
          className={`dex-edit-name${nameInvalid ? " invalid" : ""}`}
          value={name}
          placeholder="Task name"
          aria-label="Task name"
          aria-invalid={nameInvalid ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (nameInvalid && e.target.value.trim() !== "") setNameInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              // Single-line name field: Enter commits (the textarea keeps Enter for newlines).
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>

      <DexMeta row={row} />

      <div className="dex-detail-actions">
        <button
          className="btn btn-sm dex-edit-save"
          disabled={saving}
          title={saving ? "Saving…" : "Save changes"}
          aria-label={saving ? "Saving…" : "Save changes"}
          onClick={() => void save()}
        >
          <i className={saving ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-check"} />
          {saving ? " Saving…" : " Save"}
        </button>
        <button
          className="btn btn-sm dex-edit-cancel"
          title="Cancel"
          aria-label="Cancel"
          onClick={onClose}
        >
          <i className="fa-solid fa-xmark" />
          {" Cancel"}
        </button>
      </div>

      <textarea
        className="dex-edit-description"
        value={description}
        placeholder="Description (optional)"
        aria-label="Task description"
        rows={8}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
    </>
  );
}

/**
 * The task detail view (the `selectedDexId` detail screen): a back affordance, the
 * task header + meta, the read-only description / result, and the actions row (a
 * spawn launch for a ready task, plus the Edit button). The Edit button flips the
 * view into the inline {@link DexEditor}.
 *
 * Edit mode is component state here — NOT a module global like the old
 * `editingDexId`. Navigating back clears the selection, which unmounts this
 * component and so drops any in-progress edit (matching the old
 * `dexExitEdit`-on-back); a background push that re-renders the detail while
 * editing keeps the editor mounted, so the draft + focus survive.
 */
function DexDetail({ row }: { row: DexRow }): JSX.Element {
  const { setSelectedId } = useDexContext();
  const [editing, setEditing] = useState(false);

  return (
    <div className="dex-detail">
      <button className="btn btn-sm dex-back" onClick={() => setSelectedId(undefined)}>
        <i className="fa-solid fa-arrow-left" />
        {" Tasks"}
      </button>

      {editing ? (
        <DexEditor row={row} onClose={() => setEditing(false)} />
      ) : (
        <>
          <div className="dex-detail-head">
            <i className={dexMarkerClass(row)} title={DEX_STATUS_LABEL[row.displayStatus]} />
            <span className="dex-detail-title">{row.name}</span>
          </div>

          <DexMeta row={row} />

          <div className="dex-detail-actions">
            {canSpawnDex(row) && <DexDetailSpawnButton id={row.id} />}
            <button
              className="btn btn-sm dex-edit-btn"
              title="Edit this task's name and description"
              aria-label="Edit this task's name and description"
              onClick={() => setEditing(true)}
            >
              <i className="fa-solid fa-pen" />
              {" Edit"}
            </button>
          </div>

          {row.description && <DexBody text={row.description} />}
          {row.result && (
            <>
              <div className="dex-detail-label">Result</div>
              <DexBody text={row.result} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Dex section body, inside the {@link DexProvider} (so it can read the
 * collapse + selection state). With a still-present task selected it shows that
 * task's detail ({@link DexDetail}); otherwise the tree: the collapse-all header (when
 * there are epics) and the visible rows. An installed-but-empty board shows an
 * empty state rather than a blank pane.
 */
function DexSectionBody({ section }: { section: DexSection }): JSX.Element {
  const { collapsed, selectedId, setSelectedId } = useDexContext();

  // Detail view takes over the pane when a (still-present) task is selected. A
  // selection whose task went away (completed/removed) falls back to the tree.
  const selected =
    selectedId !== undefined ? section.rows.find((r) => r.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId !== undefined && !selected) setSelectedId(undefined);
  }, [selectedId, selected, setSelectedId]);
  if (selected) return <DexDetail row={selected} />;

  // Plugin present but nothing open — an empty state, so the tab still reads as
  // "Dex". (The header's New-task composer that authors the first task is T8f.)
  if (section.rows.length === 0) {
    return <div className="message">No open tasks</div>;
  }

  const epicIds = section.rows.filter((r) => r.isEpic).map((r) => r.id);
  const rows = visibleTreeRows(section.rows, collapsed);
  return (
    <>
      {epicIds.length > 0 && <DexHeader epicIds={epicIds} />}
      {rows.map((row) => (
        <DexTaskRow key={row.id} row={row} />
      ))}
    </>
  );
}

/**
 * The Dex pane: the section shell wrapping the {@link DexProvider} + tree. Hidden
 * (renders nothing) when the dex plugin is absent, matching `dexSectionEl`'s null
 * return. The pane reads the main-process-derived {@link DexSection} as a prop —
 * no derivation here, same data-down contract as the rest of the renderer port.
 */
export function DexPane({ section }: { section: DexSection }): JSX.Element | null {
  if (!section.visible) return null;
  return (
    <section className="repo-section dex-section">
      <DexProvider>
        <DexSectionBody section={section} />
      </DexProvider>
    </section>
  );
}
