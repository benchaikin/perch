/**
 * The Dex pane as a React component tree: the section shell, the task tree (rows +
 * collapse/expand), the click-to-copy id chip, the shared landable / live-agent
 * markers, and the New-task-from-description composer. A behavioral port of the
 * tree branch of the imperative `dexSectionEl` in {@link ./dex.ts}, following the
 * reference shape of {@link ./prs.js#PrsPane}: data down as props (the pushed
 * {@link DexSection}), events up via the typed {@link useActions} surface.
 *
 * Interaction state that the old `dex.ts` held in module-global `Set`s/`let`s
 * (`collapsedDexIds`, `selectedDexId`, `composingNewTask`) becomes explicit React
 * state, lifted into {@link DexContext} so the rest of the sub-epic (graph view,
 * detail, actions, drag-and-drop — T8b–T8e) reads + extends one shared store
 * rather than re-introducing globals. The view-mode toggle, the detail view, the
 * per-row spawn/delete/worktree controls, and drag-and-drop deps are deliberately
 * NOT here yet — each is its own follow-on child; the seams are marked below.
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
import {
  deriveDexGraph,
  isOpenDexTask,
  type DexGraphNode,
  type DexRepoGroup,
  type DexRow,
  type DexSection,
  type DexStatus,
} from "../dex-state.js";
import type { LandableState } from "../landable.js";
import type { AgentState, AgentSummary } from "../agents-state.js";
import type { DexEditRequest } from "../ipc.js";
// Type-only: `window-state.ts` reads/writes files (`node:fs`), so it must never
// reach the browser bundle. The default mode is the `"tree"` literal below,
// mirroring `dex.ts` — pulling in `DEFAULT_DEX_VIEW_MODE` as a value would bundle
// the whole module (and its `node:fs` import) into the renderer.
import type { DexViewMode } from "../window-state.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import { useActions } from "./actions.js";
import { DEX_STATUS_LABEL, DexTaskDot } from "./dex-task-chip.js";

// ---------------------------------------------------------------------------
// Dex interaction state (replaces dex.ts's module globals)
// ---------------------------------------------------------------------------

/**
 * The composer/launch scope for the single-repo (pane-level) board, which has no
 * specific `project` to key on. The leading-space prefix keeps it from colliding
 * with any real repo basename, so the same identifier can key the armed composer
 * and the in-flight fleet launch in both the single- and multi-repo paths.
 */
const PANE_SCOPE = " :pane";

/**
 * The composer-armed prefix marking a SUB-TASK scope: the armed value is
 * `task:<parentId>`, distinct from a repo `project` basename or the
 * {@link PANE_SCOPE} sentinel. Keeps the single `composing` state (no parallel
 * field, no persistence) while letting it mean "create a child of <parentId>".
 */
const SUBTASK_SCOPE_PREFIX = "task:";

/** The composer-arm scope that authors a sub-task of `parentId`. */
function subtaskScope(parentId: string): string {
  return `${SUBTASK_SCOPE_PREFIX}${parentId}`;
}

/** The parent task id a {@link subtaskScope} encodes, or `undefined` when `scope`
 *  is a project / pane scope rather than a sub-task scope. */
function subtaskParentId(scope: string | undefined): string | undefined {
  return scope?.startsWith(SUBTASK_SCOPE_PREFIX)
    ? scope.slice(SUBTASK_SCOPE_PREFIX.length)
    : undefined;
}

/** The repo-group collapse key for a project, namespaced so it never collides
 *  with a bare epic id in the shared collapse set. */
function repoCollapseKey(project: string): string {
  return `repo:${project}`;
}

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
 * The Dex pane's interaction state, shared across the pane's children. It owns the
 * collapsed-epic set, the selected task, the tree/graph view mode, whether the
 * New-task composer is armed, the in-flight dependency-edit drag, and the optimistic
 * in-flight sets for the spawn / spawn-all / delete actions (the `spawningDexIds` /
 * `spawningAllDex` / `deletingDexIds` module globals from {@link ./dex.ts}, now
 * component state). `selectedId` is the `selectedDexId` replacement — clicking a
 * row sets it; the detail view reads it. `composing` is the `composingNewTask`
 * replacement — the header's "+" arms it; the composer below the header reads it
 * (its own draft is local state, so a background push can't wipe a half-typed
 * description).
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
  /**
   * The scope the New-task composer is armed for (the `composingNewTask`
   * replacement, now per-repo): a repo `project` on a multi-repo board, the
   * {@link PANE_SCOPE} sentinel on a single-repo board, a {@link subtaskScope}
   * (`task:<id>`) to author a child of that task, or `undefined` when no composer
   * is open. Per-scope so arming one site's composer leaves the others (and their
   * half-typed drafts) untouched.
   */
  composing: string | undefined;
  /** Arm the New-task composer for a scope, or close it with `undefined`. */
  setComposing(scope: string | undefined): void;
  /**
   * The scope whose fleet-launch (rocket) button is currently hovered, so the
   * board can preview which rows that button would spawn: a repo `project` on a
   * multi-repo board, the {@link PANE_SCOPE} sentinel on a single-repo board, or
   * `undefined` when no rocket is hovered. Transient hover-only UI state, modeled
   * exactly like {@link composing} — no persistence, no main-process round trip.
   */
  previewScope: string | undefined;
  /** Arm the spawn-all preview for a scope, or clear it with `undefined`. */
  setPreviewScope(scope: string | undefined): void;
  /** The dependency-edit drag in flight, or `undefined` when nothing is dragging. */
  drag: DexDragState | undefined;
  /** Begin dragging a row (passing the blocker edge it's nested on, for graph nodes). */
  beginDrag(row: DexRow, blockerId?: string): void;
  /** End the in-flight drag (a drop fired, or the drag was cancelled). */
  endDrag(): void;
  /** Ids whose per-task spawn is in flight (optimistic spinner + disabled). */
  spawning: ReadonlySet<string>;
  /** Optimistically spawn an agent for a task (the `dex.spawn` bridge call). */
  spawnDex(id: string): void;
  /**
   * The scopes whose "spawn all ready" launch is in flight (optimistic spinner +
   * disabled): a repo `project` per multi-repo launch, or {@link PANE_SCOPE} for
   * the single-repo board's launch. Per-scope so each repo's launch button spins
   * independently (and a repo can't double-launch while one is in flight).
   */
  spawningAll: ReadonlySet<string>;
  /**
   * Optimistically spawn an agent for every ready task (`dex.spawn-all`),
   * optionally scoped to one repo's `project` (the per-repo launch). Omitted (the
   * single-repo board) launches the sole store's ready tasks, as before.
   */
  spawnAllReady(project?: string): void;
  /** Ids whose delete is in flight (optimistic spinner + disabled). */
  deleting: ReadonlySet<string>;
  /** Optimistically delete a task (main raises the confirm dialog first). */
  deleteDex(row: DexRow): void;
  /** How the pane renders: the `tree` list or the dependency `graph`. */
  viewMode: DexViewMode;
  /** Switch the view mode (the renderer-owned half of seed-then-own). */
  setViewMode(mode: DexViewMode): void;
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
 * re-renders, rather than mutating a shared `Set` in place.
 *
 * The view mode seeds-then-owns like the active tab (T4): component state starts
 * undefined and falls back to the pushed `savedViewMode` (then the persisted
 * default), so the saved mode shows immediately on open; the first toggle sets
 * the component state, and from then on this owns the selection. Persistence is
 * the toggle's job (it calls `setDexViewMode`), mirroring `tabs.ts`'s split.
 */
export function DexProvider({
  savedViewMode,
  children,
}: {
  savedViewMode?: DexViewMode;
  children: React.ReactNode;
}): JSX.Element {
  const actions = useActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [composing, setComposing] = useState<string | undefined>(undefined);
  const [previewScope, setPreviewScope] = useState<string | undefined>(undefined);
  const [drag, setDrag] = useState<DexDragState | undefined>(undefined);
  // The optimistic in-flight sets (the `spawningDexIds` / `deletingDexIds` module
  // globals from dex.ts) + the per-scope spawn-all set — now component state, so a
  // fresh reference per change re-renders the affected button.
  const [spawning, setSpawning] = useState<ReadonlySet<string>>(() => new Set());
  const [spawningAll, setSpawningAll] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const [ownedViewMode, setViewMode] = useState<DexViewMode | undefined>(undefined);
  // `"tree"` is `DEFAULT_DEX_VIEW_MODE` — inlined to keep `window-state.ts` (and its
  // `node:fs` import) out of the browser bundle, matching `dex.ts`.
  const viewMode = ownedViewMode ?? savedViewMode ?? "tree";

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
      composing,
      setComposing,
      previewScope,
      setPreviewScope,
      drag,
      beginDrag(row, blockerId) {
        setDrag({ id: row.id, project: row.project, blockerId });
      },
      endDrag() {
        setDrag(undefined);
      },
      spawning,
      // Mark the id in flight (optimistic spinner + disabled, so a double-click
      // can't double-spawn), fire the spawn, and clear the mark when it resolves
      // or fails. The board refresh + any notice are pushed from main; once the
      // spawn lands the row gains a worktree/agent and stops being spawnable.
      spawnDex(id) {
        if (spawning.has(id)) return;
        setSpawning((prev) => new Set(prev).add(id));
        void (async () => {
          try {
            await actions.dexSpawn(id);
          } finally {
            setSpawning((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        })();
      },
      spawningAll,
      // The fleet launch: optimistically mark the scope in flight (disable + spin),
      // run dex.spawn-all (scoped to the project, or unscoped for the single-repo
      // board), clear when it resolves. Guarded per scope so a repo can't
      // double-launch while its own launch is in flight — but two different repos
      // can launch concurrently (separate stores, no shared state to race).
      spawnAllReady(project) {
        const scope = project ?? PANE_SCOPE;
        if (spawningAll.has(scope)) return;
        setSpawningAll((prev) => new Set(prev).add(scope));
        void (async () => {
          try {
            await actions.dexSpawnReady(project);
          } finally {
            setSpawningAll((prev) => {
              const next = new Set(prev);
              next.delete(scope);
              return next;
            });
          }
        })();
      },
      deleting,
      // Hand the task (id, name, computed warning) to main, which raises the
      // native confirm dialog and only deletes on confirm; the renderer just fires
      // and shows the optimistic spinner until main resolves (confirm, decline, or
      // error all clear it). The confirmation stays in main — no renderer prompt.
      deleteDex(row) {
        if (deleting.has(row.id)) return;
        setDeleting((prev) => new Set(prev).add(row.id));
        void (async () => {
          try {
            await actions.dexDelete({ id: row.id, name: row.name, warning: dexDeleteWarning(row) });
          } finally {
            setDeleting((prev) => {
              const next = new Set(prev);
              next.delete(row.id);
              return next;
            });
          }
        })();
      },
      viewMode,
      setViewMode,
    }),
    [
      actions,
      collapsed,
      selectedId,
      composing,
      previewScope,
      drag,
      spawning,
      spawningAll,
      deleting,
      viewMode,
    ],
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
// New-task-from-description composer
// ---------------------------------------------------------------------------

/**
 * The distinct project labels present on the board, in first-seen order — the
 * targets the New-task composer offers when more than one dex repo has tasks (so
 * the author agent's `dex create` lands in an unambiguous store). Tasks from the
 * daemon's own cwd store carry no project, so a single-store board yields `[]`
 * (the composer then needs no selector — the daemon resolves the sole repo). A
 * 1:1 port of `dex.ts`'s `dexProjects`.
 */
function dexProjects(section: DexSection): string[] {
  const seen = new Set<string>();
  for (const row of section.rows) {
    if (row.project) seen.add(row.project);
  }
  return [...seen];
}

/**
 * The project the composer submits, given the board's distinct projects and the
 * user's pick: none when there are zero (single store — the daemon resolves the
 * sole repo), the lone project when there's exactly one (unambiguous, so no
 * selector is shown), or the pick (defaulting to the first) when several repos
 * have tasks. A 1:1 port of `dex.ts`'s `newTaskTargetProject`.
 */
function newTaskTargetProject(projects: string[], picked: string | undefined): string | undefined {
  if (projects.length === 0) return undefined;
  if (projects.length === 1) return projects[0];
  return picked ?? projects[0];
}

/**
 * The "New task from a description" control: a "+" button that arms the New-task
 * dialog for `scope` (toggling it closed if already armed for that scope). The
 * create-a-task counterpart to the per-row spawn play button — that spawns an
 * agent FOR a task; this spawns one to AUTHOR a task. `scope` is the repo
 * `project` on a multi-repo board (so the new task lands in that repo's store) or
 * {@link PANE_SCOPE} on a single-repo board. The click is stopped from bubbling
 * to the section/row open-detail handler.
 */
function DexNewButton({ scope }: { scope: string }): JSX.Element {
  const { composing, setComposing } = useDexContext();
  const active = composing === scope;
  return (
    <button
      className={`icon-btn dex-new${active ? " dex-new-active" : ""}`}
      title="New task from a description"
      aria-label="New task from a description"
      onClick={(e) => {
        e.stopPropagation();
        setComposing(active ? undefined : scope);
      }}
    >
      <i className="fa-solid fa-plus" />
    </button>
  );
}

/**
 * The per-row "new sub-task" control: a small trailing button that arms the
 * New-task dialog scoped to THIS row as parent (toggling closed if already armed
 * for it), so a child task is authored in the parent's store via `dex create
 * --parent`. The board-level {@link DexNewButton} arms a *project* scope; this arms
 * a {@link subtaskScope}. A distinct glyph (a node sprouting a child) keeps it
 * legible apart from the spawn-play and delete controls it sits beside. The click
 * is stopped from bubbling so it never opens the row's detail (matching the other
 * trailing controls).
 */
function DexSubtaskButton({ parentId }: { parentId: string }): JSX.Element {
  const { composing, setComposing } = useDexContext();
  const scope = subtaskScope(parentId);
  const active = composing === scope;
  return (
    <button
      className={`icon-btn dex-new-subtask${active ? " dex-new-active" : ""}`}
      title="New sub-task from a description"
      aria-label="New sub-task from a description"
      onClick={(e) => {
        e.stopPropagation();
        setComposing(active ? undefined : scope);
      }}
    >
      <i className="fa-solid fa-diagram-next" />
    </button>
  );
}

/**
 * The existing-task parent the New-task dialog authors a child of (a
 * {@link subtaskScope} arm), resolved from the parent row so the dialog can name it
 * and pin the child to its store. `project` is the parent's repo (`undefined` on a
 * single cwd store — the daemon resolves it).
 */
interface DexNewParent {
  id: string;
  name: string;
  project: string | undefined;
}

/**
 * The armed New-task dialog: a centered modal (backdrop + panel) holding a corner
 * close (✗) in the header, a textarea (an affordance the non-activating panel can
 * rely on, unlike `window.prompt`), an optional project selector (only when several
 * repos have tasks, so the target store is unambiguous), and two labeled footer
 * actions — "Add task" (the default, what Enter triggers) and "Add task and start
 * immediately" (authors AND kicks off a worker agent on the new task). Enter triggers
 * the plain "Add task" path, Shift+Enter inserts a newline, Esc cancels, a backdrop
 * click cancels (parity with Esc); an empty/whitespace description disables both
 * actions; an in-flight launch shows a spinner on the active action and disables the
 * controls. Rendered once at the top of the board (keyed only by the armed
 * `composing` scope), so it overlays the list rather than shifting it down.
 *
 * Focus continuity is free here: draft + in-flight are component state and the
 * textarea is a stable, controlled node, so a background board push re-renders
 * WITHOUT remounting it — focus, caret, and the half-typed draft all survive
 * untouched, with no focus-restoration hack. The dialog's mount is keyed only by
 * whether it is open (the armed scope), never by board data, so a push can't
 * remount it. The mount effect focuses the textarea ONCE when the dialog opens (not
 * per render), so the same push can't steal focus mid-type either.
 *
 * When armed for a `parent` (a {@link subtaskScope}) the dialog authors a CHILD of
 * that task: the header names the parent instead of a repo, the project selector is
 * suppressed (a sub-task MUST land in its parent's store), and submit passes the
 * parent's id + project through so `dex.new` runs `dex create --parent <id>` there.
 */
function DexNewDialog({
  projects,
  parent,
}: {
  projects: string[];
  parent?: DexNewParent;
}): JSX.Element {
  const actions = useActions();
  const { setComposing } = useDexContext();
  const [draft, setDraft] = useState("");
  const [project, setProject] = useState<string | undefined>(undefined);
  // Which action is launching (so only that button spins), or undefined when idle.
  const [pending, setPending] = useState<"add" | "start" | undefined>(undefined);
  const inFlight = pending !== undefined;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grab focus once, when the dialog opens (this runs on mount only — the dialog
  // mounts when armed and unmounts when closed). Not on every render, so a
  // background board poll mid-type can't steal focus or reset the caret.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const canSubmit = !inFlight && draft.trim().length > 0;

  // Name the repo the new task will land in, derived from the SAME resolution
  // submit() uses so the header and the actual target can never disagree, and
  // from the live `project` so it follows the select on a multi-repo board. On a
  // single-store board the name is unknown (the daemon resolves the sole repo),
  // so degrade to a plain label rather than "Add a task to undefined repository".
  const targetProject = newTaskTargetProject(projects, project);
  const header = parent ? (
    <>
      Add a sub-task to <span className="dex-new-header-repo">{parent.name}</span>
    </>
  ) : targetProject ? (
    <>
      Add a task to <span className="dex-new-header-repo">{targetProject}</span> repository
    </>
  ) : (
    "Add a task"
  );

  // Launch the author agent for the trimmed draft (with the resolved target
  // project), marking the chosen action in flight so the controls disable + that
  // action's button shows a spinner. With `start`, the author agent also spawns a
  // worker on the new task once authored. For a sub-task the parent pins the store
  // (its project) and threads `parentId`, so `dex create --parent` lands the child
  // there. On success close the dialog — its unmount drops the local draft, so
  // there's nothing to reset; on failure re-enable so the user can retry (the
  // success/error notice itself is pushed from main via panel state). Guards against
  // a second launch in flight and against an empty description.
  async function submit(start = false): Promise<void> {
    const description = draft.trim();
    if (!description || inFlight) return;
    setPending(start ? "start" : "add");
    try {
      // A sub-task pins the store to its parent's project and threads `parentId`; a
      // top-level task omits `parentId` entirely, so its payload is unchanged.
      await actions.dexNew(
        parent
          ? { description, project: parent.project, start, parentId: parent.id }
          : { description, project: newTaskTargetProject(projects, project), start },
      );
      setComposing(undefined);
    } catch {
      setPending(undefined);
    }
  }

  return (
    // The backdrop dims the board and closes the dialog on an outside click (parity
    // with Esc) — but never while a launch is in flight, so a stray click can't drop
    // an in-progress submit.
    <div
      className="dex-new-backdrop"
      onClick={() => {
        if (!inFlight) setComposing(undefined);
      }}
    >
      {/* Clicks inside the dialog must neither close it (don't reach the backdrop)
          nor bubble to a row/section open-detail handler. */}
      <div
        className="dex-new-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dex-new-header"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dex-new-header-row">
          <div id="dex-new-header" className="dex-new-header">
            {header}
          </div>
          {/* The conventional modal dismiss, in the upper-right corner. Disabled
              mid-launch so it can't drop an in-flight submit (parity with Esc/backdrop). */}
          <button
            className="icon-btn dex-new-cancel"
            disabled={inFlight}
            title="Close (Esc)"
            aria-label="Close"
            onClick={() => setComposing(undefined)}
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="dex-new-input"
          placeholder="Describe the task you want — an agent will read the code and author it."
          rows={3}
          value={draft}
          disabled={inFlight}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault(); // Enter submits; Shift+Enter falls through to a newline.
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setComposing(undefined);
            }
          }}
        />
        <div className="dex-new-controls">
          {/* A project selector only when several repos' tasks share the board, so the
              target store is unambiguous; one (or zero) project needs no choice. A
              sub-task is locked to its parent's store, so it never offers one. */}
          {!parent && projects.length > 1 && (
            <select
              className="dex-new-project"
              disabled={inFlight}
              title="Target repository"
              value={project ?? projects[0]}
              onChange={(e) => setProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {/* Author the task AND immediately spawn a worker agent on it. */}
          <button
            className="btn btn-sm dex-new-start"
            disabled={!canSubmit}
            title={
              pending === "start"
                ? "Spawning the author agent…"
                : "Add task and start an agent working it"
            }
            aria-label="Add task and start immediately"
            onClick={() => void submit(true)}
          >
            <i
              className={
                pending === "start" ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-rocket"
              }
            />{" "}
            Add task and start immediately
          </button>
          {/* The default action — what Enter triggers: author the task only. */}
          <button
            className="btn btn-sm btn-primary dex-new-submit"
            disabled={!canSubmit}
            title={pending === "add" ? "Spawning the author agent…" : "Add task (Enter)"}
            aria-label="Add task"
            onClick={() => void submit()}
          >
            <i
              className={
                pending === "add" ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-plus"
              }
            />{" "}
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions (spawn / spawn-all / delete) — the optimistic, in-flight controls
// ---------------------------------------------------------------------------

/**
 * The extra warning a delete confirmation carries when removing the task would
 * leave something behind the daemon board can't clean up: a live worktree/agent
 * (which `dex delete` doesn't touch — deleting the task would orphan it) and/or
 * subtasks (a `--force` delete cascades to them). Returns `undefined` for a plain
 * leaf task with no live work, so its confirmation stays unadorned. Rides along to
 * main's native confirm dialog. A 1:1 port of `dex.ts`'s `dexDeleteWarning`.
 */
function dexDeleteWarning(row: DexRow): string | undefined {
  const parts: string[] = [];
  if (row.worktree || row.agent) {
    parts.push("it has a live worktree/agent that won't be removed");
  }
  if (row.isEpic) parts.push("its subtasks will also be deleted");
  return parts.length > 0 ? `Warning: ${parts.join("; ")}.` : undefined;
}

/**
 * The start control for a ready dex row: a compact play button that runs
 * `dex.spawn` to create the task's worktree and launch a seeded agent. Optimistic
 * — the moment it's clicked the id is in flight, so it disables + spins
 * ("Starting…") without waiting for the round-trip; the click doesn't bubble to
 * the row's open-detail. Only rendered for {@link canSpawnDex} rows. `detail`
 * renders the labeled detail-page twin (`dex-detail-spawn`) sharing the same
 * `dex-spawn` hook + bridge path.
 */
function DexSpawnButton({ id, detail = false }: { id: string; detail?: boolean }): JSX.Element {
  const { spawning, spawnDex } = useDexContext();
  const inFlight = spawning.has(id);
  const title = inFlight ? "Starting agent…" : "Start an agent for this task";
  return (
    <button
      className={detail ? "btn btn-sm dex-spawn dex-detail-spawn" : "icon-btn dex-spawn"}
      disabled={inFlight}
      title={title}
      aria-label={title}
      onClick={
        inFlight
          ? undefined
          : (e) => {
              // Don't open the task detail; just spawn the agent.
              e.stopPropagation();
              spawnDex(id);
            }
      }
    >
      <i className={inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-play"} />
      {detail ? (inFlight ? " Starting…" : " Start agent") : null}
    </button>
  );
}

/**
 * The "spawn all ready" control: one click runs `dex.spawn-all` to create a
 * worktree + seeded agent for every ready task at once — the fleet counterpart of
 * the per-row {@link DexSpawnButton}. `project` scopes the launch to one repo's
 * store on a multi-repo board (undefined launches the single-repo board's sole
 * store). The label carries the ready `count`; optimistically disables + spins
 * ("Spawning…") while THIS scope's launch is in flight. Rendered only when
 * `count > 0` (the caller gates this).
 */
function DexSpawnAllButton({ count, project }: { count: number; project?: string }): JSX.Element {
  const { spawningAll, spawnAllReady, setPreviewScope } = useDexContext();
  const scope = project ?? PANE_SCOPE;
  const inFlight = spawningAll.has(scope);
  const plural = count === 1 ? "" : "s";
  const label = inFlight
    ? `Spawning ${count} ready task${plural}…`
    : `Spawn agents for ${count} ready task${plural}`;
  // Once the launch is in flight the button disables, so its onMouseLeave never
  // fires — clear the preview here so no rows stay stuck lit after the click (and
  // a disabled button can't leave a stale scope armed).
  useEffect(() => {
    if (inFlight) setPreviewScope(undefined);
  }, [inFlight, setPreviewScope]);
  return (
    <button
      className="icon-btn dex-spawn-all"
      disabled={inFlight}
      title={label}
      aria-label={label}
      // Hovering arms the board's preview for this rocket's scope (the exact rows a
      // click would launch); leaving/blurring clears it. Skip arming while disabled
      // so a focus-then-launch can't re-arm a stale scope.
      onMouseEnter={inFlight ? undefined : () => setPreviewScope(scope)}
      onMouseLeave={() => setPreviewScope(undefined)}
      onBlur={() => setPreviewScope(undefined)}
      onClick={
        inFlight
          ? undefined
          : (e) => {
              e.stopPropagation();
              setPreviewScope(undefined);
              spawnAllReady(project);
            }
      }
    >
      <i className={inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-rocket"} />
    </button>
  );
}

/**
 * The delete control for a dex task: a trash button whose click hands the task to
 * main, which raises a native confirm dialog and only deletes on confirm (the
 * confirmation stays in main — the non-activating panel can't show a
 * `window.confirm`, so there's no renderer prompt). {@link dexDeleteWarning} rides
 * along so a live worktree/agent or cascading subtasks are flagged before the
 * irreversible delete. Optimistically disables + spins while in flight (cleared
 * whether the user confirms, declines, or it errors). `labeled` spells the action
 * out for the roomier detail page; the compact row uses an icon-only button. The
 * click never bubbles to the row's open-detail.
 */
function DexDeleteControl({
  row,
  labeled = false,
}: {
  row: DexRow;
  labeled?: boolean;
}): JSX.Element {
  const { deleting, deleteDex } = useDexContext();
  const inFlight = deleting.has(row.id);
  // In a compact row the control hugs the trailing edge. When a spawn button or
  // worktree indicator precedes it, their own `margin-left:auto` already pushes the
  // trailing cluster right; otherwise the control itself anchors that push.
  const anchor = !labeled && !canSpawnDex(row) && row.worktree === undefined;
  const title = inFlight ? "Deleting…" : "Delete task";
  return (
    <span className={`chips dex-delete${anchor ? " dex-delete-anchor" : ""}`}>
      <button
        className={labeled ? "btn btn-sm dex-delete-btn" : "icon-btn dex-delete-btn"}
        disabled={inFlight}
        title={title}
        aria-label={title}
        onClick={
          inFlight
            ? undefined
            : (e) => {
                e.stopPropagation();
                deleteDex(row);
              }
        }
      >
        <i className={inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-trash-can"} />
        {labeled ? (inFlight ? " Deleting…" : " Delete") : null}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rows + tree
// ---------------------------------------------------------------------------

/**
 * The shared body of a dex row — the status marker, the name, the identity dot +
 * click-to-copy id chip, and the optional blocker / landable / live-agent chips.
 * Sits after the leading chevron/spacer column, so the tree row and the graph
 * node row draw an identical row vocabulary (only their leading column and
 * indentation differ).
 */
function DexRowBody({ row }: { row: DexRow }): JSX.Element {
  const open = isOpenDexTask(row);
  return (
    <>
      <i className={dexMarkerClass(row)} title={DEX_STATUS_LABEL[row.displayStatus]} />

      <span className="branch">{row.name}</span>

      {/* An open (unblocked, unfinished) task leads with a solid identity-color
          dot, then the id chip (which carries the same color as a faint tint). */}
      {open && <DexTaskDot id={row.id} />}
      <DexIdChip id={row.id} open={open} />

      {row.blockedByCount > 0 && <DexBlockedChip count={row.blockedByCount} />}
      {row.landable && <LandableChip state={row.landable} />}
      {row.agent && <AgentMarker agent={row.agent} />}
    </>
  );
}

/**
 * One dex task row: an expand/collapse chevron (epics) or aligning spacer
 * (leaves) followed by the shared {@link DexRowBody} (status marker, name,
 * identity dot + click-to-copy id chip, and the optional blocker / landable /
 * live-agent chips), plus the trailing spawn (ready rows) + delete controls.
 * Clicking the row body opens the task's detail (sets the selection); clicking an
 * epic's chevron toggles its children without opening detail; the action buttons
 * stop propagation so they don't.
 *
 * The row is a drag source + drop target for dependency editing (drop A onto B ⇒
 * B blocked-by A), via {@link useDexRowDrag}. The linked-worktree indicator is
 * NOT here yet — its own follow-on adds it.
 */
function DexTaskRow({ row }: { row: DexRow }): JSX.Element {
  const { collapsed, toggleCollapsed, setSelectedId, previewScope } = useDexContext();
  const isCollapsed = collapsed.has(row.id);
  const blockedHint = row.blockedByCount > 0 ? ` (blocked by ${row.blockedByCount})` : "";
  // Drag this row onto another to wire a dependency (drop A onto B ⇒ B blocked-by A).
  const drag = useDexRowDrag(row);
  // Light up when a hovered rocket would spawn this row, so the "all" it launches
  // is legible before the click.
  const preview = isSpawnPreviewRow(row, previewScope) ? " dex-row-spawn-preview" : "";

  return (
    <div
      className={`row dex-row${row.isEpic ? " dex-epic" : ""}${preview}${drag.className}`}
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

      <DexRowBody row={row} />

      {/* Every row trails a "new sub-task" control (the cluster's leading anchor); a
          ready, unblocked, unworked task adds a spawn play button; every row trails a
          delete control (all stop propagation so the row stays closed). */}
      <DexSubtaskButton parentId={row.id} />
      {canSpawnDex(row) && <DexSpawnButton id={row.id} />}
      <DexDeleteControl row={row} />
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

// ---------------------------------------------------------------------------
// Graph view (the dependency-graph branch)
// ---------------------------------------------------------------------------

/**
 * One graph node flattened to a render row: the task, its blocker-nesting depth,
 * and the blocker it sits under (so a drag onto the unblock zone removes exactly
 * that edge). Roots carry `blockerId: undefined`.
 */
interface DexGraphRowItem {
  row: DexRow;
  depth: number;
  blockerId: string | undefined;
}

/**
 * Flatten the dependency forest depth-first into render rows, carrying each
 * node's blocker-nesting depth and the blocker it sits under. A blocked task
 * nests under *every* blocker it waits on, so the same row can appear more than
 * once — the index is what makes a render key unique. A 1:1 port of `dex.ts`'s
 * `dexGraphRows` walk.
 */
function flattenDexGraph(roots: readonly DexGraphNode[]): DexGraphRowItem[] {
  const items: DexGraphRowItem[] = [];
  const walk = (node: DexGraphNode, depth: number, blockerId: string | undefined): void => {
    items.push({ row: node.row, depth, blockerId });
    for (const child of node.children) walk(child, depth + 1, node.row.id);
  };
  for (const root of roots) walk(root, 0, undefined);
  return items;
}

/**
 * One dependency-graph node row. Mirrors {@link DexTaskRow} (the shared
 * {@link DexRowBody} — status marker, name, identity dot + id chip, blocker /
 * landable / agent chips, click-to-open-detail, the trailing spawn + delete
 * controls) but indents by *graph* depth rather than tree depth, and carries an
 * aligning spacer where the tree's chevron sits (the graph has no collapsible
 * epics). The `dex-graph-row` class tags it for the bundle test + any
 * graph-specific styling; `dex-graph-nested` marks a dependent drawn under one of
 * its blockers. The row is a drag source/target like the tree row, and a nested
 * node also carries the blocker it sits under so dragging it onto the
 * {@link DexUnblockZone} removes that one edge.
 */
function DexGraphRow({
  row,
  depth,
  blockerId,
}: {
  row: DexRow;
  depth: number;
  blockerId: string | undefined;
}): JSX.Element {
  const { setSelectedId, previewScope } = useDexContext();
  const blockedHint = row.blockedByCount > 0 ? ` (blocked by ${row.blockedByCount})` : "";
  // Drag this node onto another to wire a dependency (drop A onto B ⇒ B blocked-by
  // A); a nested node carries its parent blocker so a drop on the unblock zone
  // removes that one edge.
  const drag = useDexRowDrag(row, blockerId);
  // Light up when a hovered rocket would spawn this row — same affordance as the
  // tree row, so the preview works in graph view too.
  const preview = isSpawnPreviewRow(row, previewScope) ? " dex-row-spawn-preview" : "";
  return (
    <div
      className={`row dex-row dex-graph-row${depth > 0 ? " dex-graph-nested" : ""}${preview}${drag.className}`}
      // Indent by blocker-nesting depth so dependents read as nested under blockers.
      style={{ paddingLeft: `${depth * 14}px` }}
      title={`${row.name} — ${DEX_STATUS_LABEL[row.status]}${blockedHint}`}
      onClick={() => setSelectedId(row.id)}
      {...drag.props}
    >
      {/* Aligning spacer where the tree's chevron sits, so markers line up with
          the tree view's columns. */}
      <span className="dex-chevron-spacer" />
      <DexRowBody row={row} />

      {/* Mirror the tree row's trailing controls: a "new sub-task" anchor on every
          row, a spawn play button on ready rows, a delete control on every row (all
          stop propagation). */}
      <DexSubtaskButton parentId={row.id} />
      {canSpawnDex(row) && <DexSpawnButton id={row.id} />}
      <DexDeleteControl row={row} />
    </div>
  );
}

/**
 * The dependency-graph forest: the unblocked tasks as roots, each blocked task
 * nested under every blocker it waits on. Derivation lives in the pure, tested
 * {@link deriveDexGraph} (main-process vocabulary, no recompute here); this just
 * walks its output and lays out the node rows. The "drop here to unblock" zone
 * sits above the rows so a dragged-out node lands on it naturally.
 */
function DexGraph({ rows }: { rows: readonly DexRow[] }): JSX.Element {
  const items = useMemo(() => flattenDexGraph(deriveDexGraph(rows)), [rows]);
  return (
    <>
      <DexUnblockZone />
      {items.map((item, i) => (
        <DexGraphRow
          key={`${item.row.id}-${i}`}
          row={item.row}
          depth={item.depth}
          blockerId={item.blockerId}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// View-mode toggle (tree ↔ graph)
// ---------------------------------------------------------------------------

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
 * The tree/graph view-mode toggle: an icon-only button reflecting the CURRENT
 * mode (tree → sitemap, graph → diagram). Clicking flips the mode — owning it in
 * component state (the renderer-owned half of seed-then-own) AND persisting it via
 * `setDexViewMode`, so it's restored on the next open (mirroring tab selection).
 */
function DexViewToggle(): JSX.Element {
  const { viewMode, setViewMode } = useDexContext();
  const actions = useActions();
  const { icon, switchLabel } = DEX_VIEW_MODE_BTN[viewMode];
  return (
    <button
      // Same subtle borderless icon-button style as the collapse-all control.
      className="icon-btn dex-view-toggle"
      title={switchLabel}
      aria-label={switchLabel}
      onClick={() => {
        const next = nextDexViewMode(viewMode);
        setViewMode(next);
        actions.setDexViewMode(next); // persist so it's restored next open
      }}
    >
      <i className={`fa-solid fa-${icon}`} />
    </button>
  );
}

/**
 * The expand/collapse-all toggle over a set of epics — pane-wide on a single-repo
 * board, or scoped to one repo group's epics on a multi-repo board. Collapse-all
 * collapses any still-open epic; expand-all (when every one is already collapsed)
 * reopens them. A tree-only affordance, so the caller renders it only in tree mode
 * with epics to fold. Each toggle creates a fresh collapse Set (the shared
 * `toggleCollapsed`) so React re-renders.
 */
function DexCollapseAllButton({ epicIds }: { epicIds: string[] }): JSX.Element {
  const { collapsed, toggleCollapsed } = useDexContext();
  const allCollapsed = epicIds.every((id) => collapsed.has(id));
  return (
    <button
      className="icon-btn dex-toggle-all"
      title={allCollapsed ? "Expand all" : "Collapse all"}
      aria-label={allCollapsed ? "Expand all" : "Collapse all"}
      onClick={(e) => {
        e.stopPropagation();
        // Toggle only the epics whose state needs flipping so the result is
        // uniform either way (collapse the open ones; expand the closed ones).
        for (const id of epicIds) {
          if (allCollapsed === collapsed.has(id)) toggleCollapsed(id);
        }
      }}
    >
      <i className={`fa-solid fa-${allCollapsed ? "angles-down" : "angles-up"}`} />
    </button>
  );
}

/**
 * The Dex section header for a single-repo board: the tree/graph view-mode toggle,
 * the New-task composer's "+" control (so the first task can be authored even from
 * an empty board), the "spawn all ready" button (when any task is ready), and — in
 * tree mode, when there are epics to fold — the expand/collapse-all toggle. On a
 * multi-repo board the New/spawn-all/collapse-all controls move into each repo
 * header (see {@link DexRepoHeader}); only {@link DexPaneHeader}'s view toggle
 * stays pane-level.
 */
function DexHeader({
  epicIds,
  readyCount,
}: {
  epicIds: string[];
  readyCount: number;
}): JSX.Element {
  const { viewMode } = useDexContext();
  // Collapse-all only applies to the tree's epics — skip it in graph mode and
  // when there are no epics to fold.
  const showCollapseAll = viewMode === "tree" && epicIds.length > 0;
  return (
    <div className="repo-header dex-header">
      <DexViewToggle />
      <DexNewButton scope={PANE_SCOPE} />
      {/* Fleet launch: spawn an agent for every ready task at once. Hidden when
          nothing is ready (a no-op that would just toast "no ready tasks"). */}
      {readyCount > 0 && <DexSpawnAllButton count={readyCount} />}
      {showCollapseAll && <DexCollapseAllButton epicIds={epicIds} />}
    </div>
  );
}

/**
 * The pane-level header on a multi-repo board: just the tree/graph view-mode
 * toggle, the one genuinely pane-global control (the New "+", spawn-all, and
 * collapse-all are per-repo, in each {@link DexRepoHeader}). A "launch/add
 * everything everywhere" control would be ambiguous on a multi-repo board (which
 * store does a new task land in? which repos fleet-launch?), so it's dropped.
 */
function DexPaneHeader(): JSX.Element {
  return (
    <div className="repo-header dex-header">
      <DexViewToggle />
    </div>
  );
}

/**
 * A collapsible per-repo header on a multi-repo board, modeled on
 * {@link ../worktrees.js}'s `WorktreeRepoHeader`: a chevron + repo name + task-count
 * chip whose click toggles the whole group's rows, alongside the per-repo action
 * cluster the pane-level toolbar used to carry — the New "+" (scoped so a new task
 * lands in THIS repo's store), the "spawn all ready" launch (only when this repo
 * has ready tasks), and — in tree mode with epics to fold — the collapse-all toggle
 * over just this group's epics. The chevron toggle is a `<button>` so it stays
 * keyboard-reachable; the action cluster sits beside it (not nested) since buttons
 * can't nest. Click is stopped from bubbling so toggling never opens a task.
 */
function DexRepoHeader({
  group,
  collapsed,
  epicIds,
  readyCount,
}: {
  group: DexRepoGroup;
  collapsed: boolean;
  epicIds: string[];
  readyCount: number;
}): JSX.Element {
  const { toggleCollapsed, viewMode } = useDexContext();
  const count = group.rows.length;
  const showCollapseAll = viewMode === "tree" && epicIds.length > 0;
  return (
    <div className="dex-repo-header">
      <button
        className="dex-repo-header-btn"
        title={`${group.project} — ${count} task${count === 1 ? "" : "s"}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleCollapsed(repoCollapseKey(group.project));
        }}
      >
        <i className={`fa-solid fa-chevron-${collapsed ? "right" : "down"}`} />
        <span className="branch dex-repo-name">{group.project}</span>
        <span className="chip muted dex-repo-count">{count}</span>
      </button>
      <span className="dex-repo-actions">
        <DexNewButton scope={group.project} />
        {readyCount > 0 && <DexSpawnAllButton count={readyCount} project={group.project} />}
        {showCollapseAll && <DexCollapseAllButton epicIds={epicIds} />}
      </span>
    </div>
  );
}

/**
 * One repo group on a multi-repo board: its {@link DexRepoHeader} (with the
 * per-repo New / spawn-all / collapse-all controls) and — unless the group is
 * collapsed — the group's rows in the active view (the tree's visible rows, or the
 * dependency graph over just this repo's rows; blocker edges never span repos, so a
 * per-repo graph is the whole forest for that repo). The New-task dialog the "+"
 * arms is a single top-level overlay (see {@link DexSectionBody}), not a per-group
 * inline form, so it opens centered regardless of which repo armed it.
 */
function DexRepoGroupView({ group }: { group: DexRepoGroup }): JSX.Element {
  const { collapsed, viewMode } = useDexContext();
  const isCollapsed = collapsed.has(repoCollapseKey(group.project));
  const epicIds = group.rows.filter((r) => r.isEpic).map((r) => r.id);
  const readyCount = group.rows.filter(canSpawnDex).length;
  return (
    <>
      <DexRepoHeader
        group={group}
        collapsed={isCollapsed}
        epicIds={epicIds}
        readyCount={readyCount}
      />
      {!isCollapsed &&
        (viewMode === "graph" ? (
          <DexGraph rows={group.rows} />
        ) : (
          visibleTreeRows(group.rows, collapsed).map((row) => <DexTaskRow key={row.id} row={row} />)
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Task detail view + inline editor
// ---------------------------------------------------------------------------

/**
 * Whether a task is ready to hand to a fresh agent: an unblocked `ready` row with
 * no live worktree or agent (so a started task shows its status instead of a
 * start button). A 1:1 port of the old `dex.ts#canSpawnDex`; the per-row spawn
 * controls (the Actions section above) reuse it.
 */
function canSpawnDex(row: DexRow): boolean {
  return (
    row.status === "ready" &&
    row.blockedByCount === 0 &&
    row.worktree === undefined &&
    row.agent === undefined
  );
}

/**
 * Whether `row` is one a hovered rocket (fleet-launch) button would spawn, given
 * the armed `previewScope`. Reuses {@link canSpawnDex} verbatim so the lit set and
 * the launched set can never drift, then matches the rocket's scope: the
 * {@link PANE_SCOPE} sentinel lights every ready row (the single-repo board's sole
 * store), while a repo scope lights only that repo's ready rows — mirroring how
 * {@link DexContextValue.spawnAllReady} keys a launch on `project ?? PANE_SCOPE`.
 * `undefined` (no rocket hovered) lights nothing.
 */
function isSpawnPreviewRow(row: DexRow, previewScope: string | undefined): boolean {
  if (previewScope === undefined || !canSpawnDex(row)) return false;
  return previewScope === PANE_SCOPE || row.project === previewScope;
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
 * rebuilt, preserving focus + selection with no focus-restoration hack.
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
            {canSpawnDex(row) && <DexSpawnButton id={row.id} detail />}
            <button
              className="btn btn-sm dex-edit-btn"
              title="Edit this task's name and description"
              aria-label="Edit this task's name and description"
              onClick={() => setEditing(true)}
            >
              <i className="fa-solid fa-pen" />
              {" Edit"}
            </button>
            <DexDeleteControl row={row} labeled />
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
 * collapse + selection + view-mode state). With a still-present task selected it
 * shows that task's detail ({@link DexDetail}), regardless of grouping. Otherwise:
 * on a multi-repo board, the pane-level view toggle over one collapsible
 * {@link DexRepoGroupView} per repo (each carrying its own New / spawn-all /
 * collapse-all); on a single-repo board, the unchanged flat path — the
 * {@link DexHeader} (view toggle, New, spawn-all, collapse-all) over the active
 * view. An installed-but-empty board still shows the single-repo header (so the
 * toggle + New control are reachable) above the empty state.
 */
function DexSectionBody({ section }: { section: DexSection }): JSX.Element {
  const { collapsed, viewMode, selectedId, setSelectedId, composing } = useDexContext();

  // Detail view takes over the pane when a (still-present) task is selected. A
  // selection whose task went away (completed/removed) falls back to the list.
  const selected =
    selectedId !== undefined ? section.rows.find((r) => r.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId !== undefined && !selected) setSelectedId(undefined);
  }, [selectedId, selected, setSelectedId]);
  if (selected) return <DexDetail row={selected} />;

  // The New-task dialog is a single top-level overlay driven by the armed scope, not
  // an inline form per render site — so it opens centered regardless of which "+"
  // armed it, and (mounted only by `composing`, never by board data) survives a
  // background push without remounting its textarea. The armed scope resolves the
  // projects the inline sites used to pass: the pane sentinel offers the board's
  // distinct projects (single-repo → no selector), a repo scope pre-binds to that
  // one repo (one-element list → no selector, the task lands there). A sub-task scope
  // (`task:<id>`) instead resolves the parent row, so the dialog names it and pins the
  // child to its store; if that parent went away (completed/removed) there's nothing
  // to arm, so the dialog drops rather than misrender the scope as a bogus project.
  const parentId = subtaskParentId(composing);
  const parentRow =
    parentId !== undefined ? section.rows.find((r) => r.id === parentId) : undefined;
  const dialog =
    composing === undefined || (parentId !== undefined && !parentRow) ? null : parentRow ? (
      <DexNewDialog
        projects={[]}
        parent={{ id: parentRow.id, name: parentRow.name, project: parentRow.project }}
      />
    ) : (
      <DexNewDialog projects={composing === PANE_SCOPE ? dexProjects(section) : [composing]} />
    );

  // Multi-repo board: a per-repo collapsible group, each with its own header +
  // controls. The pane-level header keeps only the view toggle.
  if (section.multiRepo && section.repoGroups.length > 0) {
    return (
      <>
        <DexPaneHeader />
        {section.repoGroups.map((group) => (
          <DexRepoGroupView key={group.project} group={group} />
        ))}
        {dialog}
      </>
    );
  }

  // Single-repo board: the header and the body render at stable positions whether
  // the board is empty or has rows. An installed-but-empty board still shows the
  // header, so the first task can be authored from it; below it an empty state keeps
  // the tab as "Dex".
  const epicIds = section.rows.filter((r) => r.isEpic).map((r) => r.id);
  const readyCount = section.rows.filter(canSpawnDex).length;
  return (
    <>
      <DexHeader epicIds={epicIds} readyCount={readyCount} />
      {section.rows.length === 0 ? (
        <div className="message">No open tasks</div>
      ) : viewMode === "graph" ? (
        // Graph mode walks the blocker edges; tree mode is the pre-ordered render.
        <DexGraph rows={section.rows} />
      ) : (
        visibleTreeRows(section.rows, collapsed).map((row) => <DexTaskRow key={row.id} row={row} />)
      )}
      {dialog}
    </>
  );
}

/**
 * The Dex pane: the section shell wrapping the {@link DexProvider} + active view.
 * Hidden (renders nothing) when the dex plugin is absent, matching `dexSectionEl`'s
 * null return. The pane reads the main-process-derived {@link DexSection} as a prop
 * — no derivation here, same data-down contract as the rest of the renderer port.
 * `savedViewMode` is the persisted tree/graph mode the view seeds from on first
 * render (then this pane owns it — see {@link DexProvider}).
 */
export function DexPane({
  section,
  savedViewMode,
}: {
  section: DexSection;
  savedViewMode?: DexViewMode;
}): JSX.Element | null {
  if (!section.visible) return null;
  return (
    <section className="repo-section dex-section">
      <DexProvider savedViewMode={savedViewMode}>
        <DexSectionBody section={section} />
      </DexProvider>
    </section>
  );
}
