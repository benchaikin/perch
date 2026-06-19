/**
 * The Worktrees pane as a React component tree: one row per git worktree (flat,
 * or grouped under collapsible per-repo headers when multi-repo), each annotated
 * with its linked dex task's identity color + status. {@link WorktreesPane} is
 * the component the panel body renders for the Worktrees tab (see `panel.tsx`).
 *
 * Follows the {@link ./prs.js} reference pane: data down as props (the pushed
 * {@link WorktreesSection}), events up via the typed {@link useActions} surface,
 * and the collapsed-repo set held as explicit React state. It borrows the shared
 * {@link DexTaskDot} /
 * {@link DEX_STATUS_LABEL} from {@link ./dex-task-chip.js} so a worktree reads as
 * the same "team color" as its task across the fleet.
 *
 * Class names are kept byte-equivalent to the DOM builders (`row`, `branch`,
 * `chip`, `worktree-row`, `worktree-repo-header-btn`, `worktree-task`, the
 * health/tone tones) so `renderer.css` keeps applying unchanged.
 */
import type { CSSProperties } from "react";
import { Fragment, useState } from "react";
import type { WorktreeRepoGroup, WorktreeRow, WorktreesSection } from "../worktrees-state.js";
import { dexHealth, isOpenDexTask } from "../dex-state.js";
import type { LinkedTask } from "../worktree-task-link.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import { DEX_STATUS_LABEL, DexTaskDot } from "./dex-task-chip.js";
import { useActions } from "./actions.js";

/**
 * A collapsible worktree repo header: a chevron, health dot, name, count, and
 * optional dirty/conflict indicators. Clicking toggles the repo's children; the
 * click is stopped from bubbling so it never opens a worktree.
 */
function WorktreeRepoHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: WorktreeRepoGroup;
  collapsed: boolean;
  onToggle: (repo: string) => void;
}): JSX.Element {
  const rowCount = group.count;
  const detail = [
    `${rowCount} worktree${rowCount !== 1 ? "s" : ""}`,
    group.dirtyCount > 0 ? `${group.dirtyCount} dirty` : "",
    group.hasConflict ? "conflict" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      className="worktree-repo-header-btn"
      title={`${group.repo} — ${detail}`}
      onClick={(e) => {
        // Toggle the repo's children without propagating.
        e.stopPropagation();
        onToggle(group.repo);
      }}
    >
      <i className={`fa-solid fa-chevron-${collapsed ? "right" : "down"}`} />
      <i className={`dot ${group.health} fa-solid fa-code-branch`} />
      <span className="branch worktree-repo-name">{group.repo}</span>
      <span className="worktree-repo-indicators">
        <span className="chip muted worktree-repo-count">{rowCount}</span>
        {group.dirtyCount > 0 && (
          <span
            className="chip warn"
            title={`${group.dirtyCount} uncommitted change${group.dirtyCount === 1 ? "" : "s"}`}
          >
            {`●${group.dirtyCount}`}
          </span>
        )}
        {group.hasConflict && <span className="chip bad">conflict</span>}
      </span>
    </button>
  );
}

/**
 * The chip annotating a worktree row with the dex task it was created for. The
 * branch label (`dex/<id>-<slug>`) already supplies the row's identity — the
 * task id and a slug of its name — so the chip doesn't repeat them; it carries
 * the one thing the branch can't: the task's live status (`🗒 <status>`), toned
 * the same way the dex board's status chip is (`dexHealth` — blocked=red,
 * in-progress/done/ready). The full id + real name + status live in the hover
 * tooltip. Non-interactive (clicking the row still opens the worktree dir).
 *
 * When the linked task is open (unblocked, unfinished — see {@link isOpenDexTask}),
 * the chip also carries the task's stable identity color via the same
 * `dex-open`/`--task-color` accent its dex row uses, so a worktree reads as the
 * same "team color" as its task across the fleet. A blocked/done task's chip
 * keeps its plain status tone.
 */
function WorktreeTaskChip({ task }: { task: LinkedTask }): JSX.Element {
  const open = isOpenDexTask(task);
  let style: CSSProperties | undefined;
  if (open) {
    const color = dexTaskColor(task.id);
    style = {
      ["--task-color"]: color.hex,
      ["--task-color-rgb"]: `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`,
    } as CSSProperties;
  }
  return (
    <span
      className={`chip ${dexHealth(task.status)} worktree-task${open ? " dex-open" : ""}`}
      title={`${task.id} · ${task.name} — ${DEX_STATUS_LABEL[task.status]}`}
      style={style}
    >
      {`🗒 ${DEX_STATUS_LABEL[task.status]}`}
    </span>
  );
}

/**
 * The extra warning a remove confirmation carries when dropping the worktree
 * would discard work or orphan a live session: uncommitted changes (a forced
 * remove throws them away), an in-flight merge conflict, a locked tree, or a
 * linked open dex task (an agent may be running in that terminal — the task
 * itself is left intact, but its checkout vanishes). Returns `undefined` for a
 * clean, unlinked tree, so its confirmation stays unadorned. Mirrors
 * `dex-pane`'s `dexDeleteWarning`; rides along to main's native confirm dialog.
 */
function worktreeRemoveWarning(row: WorktreeRow): string | undefined {
  const parts: string[] = [];
  if (row.dirty) {
    parts.push(
      `${row.dirtyCount} uncommitted change${row.dirtyCount === 1 ? "" : "s"} will be discarded`,
    );
  }
  if (row.conflict) parts.push("it has unresolved merge conflicts");
  if (row.locked) parts.push("the worktree is locked");
  if (row.task && isOpenDexTask(row.task)) {
    parts.push(`its dex task ${row.task.id} (an agent may be running here) will be orphaned`);
  }
  return parts.length > 0 ? `Warning: ${parts.join("; ")}.` : undefined;
}

/**
 * Whether removing this worktree needs `git worktree remove --force`. git refuses
 * to drop a dirty, conflicted, locked, or prunable (stale) tree without it; these
 * are exactly the abandoned agent worktrees users want to clean up, so we force
 * after the confirm dialog has warned of the discarded work.
 */
function worktreeNeedsForce(row: WorktreeRow): boolean {
  return row.dirty || row.conflict || row.locked || row.prunable;
}

/**
 * The remove (trash) control on a worktree row: a single trash button whose click
 * hands the worktree to main, which raises a native confirm dialog and only
 * removes on confirm (the non-activating panel can't show a `window.confirm`, so
 * the confirmation stays in main). {@link worktreeRemoveWarning} rides along so
 * discarded changes or an orphaned linked task are flagged first. Optimistically
 * disables + spins while in flight (cleared whether the user confirms, declines,
 * or it errors). The click never bubbles to the row's open-in-terminal. Modeled
 * on `dex-pane`'s `DexDeleteControl`.
 */
function WorktreeRemoveControl({
  row,
  inFlight,
  onRemove,
}: {
  row: WorktreeRow;
  inFlight: boolean;
  onRemove: (row: WorktreeRow) => void;
}): JSX.Element {
  const title = inFlight ? "Removing…" : "Remove worktree";
  return (
    <button
      className="icon-btn worktree-remove-btn"
      disabled={inFlight}
      title={title}
      aria-label={title}
      onClick={
        inFlight
          ? undefined
          : (e) => {
              e.stopPropagation();
              onRemove(row);
            }
      }
    >
      <i className={inFlight ? "fa-solid fa-circle-notch fa-spin" : "fa-solid fa-trash-can"} />
    </button>
  );
}

/**
 * One worktree row: a health dot, the branch (the primary label — what an agent
 * is working on), a `main` tag, and the state chips. Clicking opens the worktree
 * directory via the configured command. A non-main row also carries a trailing
 * trash control to remove the worktree (gated by a confirm dialog in main).
 */
function WorktreeRowView({
  row,
  removing,
  onRemove,
}: {
  row: WorktreeRow;
  removing: boolean;
  onRemove: (row: WorktreeRow) => void;
}): JSX.Element {
  const actions = useActions();
  const detail = [
    row.branch ?? "(detached)",
    row.dirty ? `${row.dirtyCount} uncommitted` : "clean",
    row.conflict ? "conflict" : "",
    row.prunable ? "prunable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const ahead = row.ahead ?? 0;
  const behind = row.behind ?? 0;
  return (
    <div
      className="row worktree-row"
      title={`${row.name} — ${detail}`}
      onClick={() => actions.worktreeOpen(row.path)}
    >
      <i
        className={`dot ${row.health} fa-solid fa-${row.conflict ? "code-merge" : "code-branch"}`}
      />
      <span className="branch">{row.branch ?? "(detached)"}</span>
      {row.main && <span className="chip muted">main</span>}
      <span className="chips">
        {/* The linked dex task leads the chips so the row reads "what this is
            for". An open task leads with a solid dot in its identity color — the
            same dot its dex row shows — so a worktree matches its task at a glance. */}
        {row.task && (
          <>
            {isOpenDexTask(row.task) && <DexTaskDot id={row.task.id} />}
            <WorktreeTaskChip task={row.task} />
          </>
        )}
        {row.dirty && (
          <span
            className="chip warn"
            title={`${row.dirtyCount} uncommitted change${row.dirtyCount === 1 ? "" : "s"}`}
          >
            {`●${row.dirtyCount}`}
          </span>
        )}
        {row.conflict && <span className="chip bad">conflict</span>}
        {(ahead > 0 || behind > 0) && (
          <span
            className={`chip ${ahead > 0 && behind > 0 ? "warn" : "muted"}`}
            title={`${ahead} ahead, ${behind} behind upstream`}
          >
            {`↑${ahead} ↓${behind}`}
          </span>
        )}
        {row.prunable && <span className="chip bad">prunable</span>}
      </span>
      {/* The main worktree is never removable (git refuses; it's the repo's primary
          checkout), so the trash control is omitted there. */}
      {!row.main && <WorktreeRemoveControl row={row} inFlight={removing} onRemove={onRemove} />}
    </div>
  );
}

/**
 * The "Worktrees" pane: one row per worktree (main first). Renders nothing when
 * the section is hidden (no worktrees plugin / none). When `multiRepo` is true,
 * rows are grouped under collapsible repo headers with aggregate indicators;
 * otherwise a flat list of rows. No section title — the active "Worktrees" tab
 * already names it.
 *
 * The collapsed-repo set is component state, preserved across pushes because the
 * pane stays mounted while the Worktrees tab is active.
 */
export function WorktreesPane({ section }: { section: WorktreesSection }): JSX.Element | null {
  const actions = useActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // Paths whose removal is in flight (optimistic spinner + disabled). The pane is
  // props-down with no dex-style context, so the in-flight set lives here as
  // component state — preserved across pushes because the pane stays mounted while
  // the Worktrees tab is active.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  if (!section.visible) return null;

  function toggle(repo: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  // Hand the worktree (path, name, computed force + warning) to main, which raises
  // the native confirm dialog and only removes on confirm; the renderer just fires
  // and shows the optimistic spinner until main resolves (confirm, decline, or
  // error all clear it). On success main re-reads the list and the row drops out.
  function removeWorktree(row: WorktreeRow): void {
    if (removing.has(row.path)) return;
    setRemoving((prev) => new Set(prev).add(row.path));
    void (async () => {
      try {
        await actions.worktreeRemove({
          path: row.path,
          name: row.name,
          force: worktreeNeedsForce(row),
          warning: worktreeRemoveWarning(row),
        });
      } finally {
        setRemoving((prev) => {
          const next = new Set(prev);
          next.delete(row.path);
          return next;
        });
      }
    })();
  }

  const renderRow = (row: WorktreeRow): JSX.Element => (
    <WorktreeRowView
      key={row.path}
      row={row}
      removing={removing.has(row.path)}
      onRemove={removeWorktree}
    />
  );

  const grouped = section.multiRepo && section.repoGroups.length > 0;
  return (
    <section className="repo-section worktrees-section">
      {grouped
        ? section.repoGroups.map((group) => {
            const isCollapsed = collapsed.has(group.repo);
            return (
              <Fragment key={group.repo}>
                <WorktreeRepoHeader group={group} collapsed={isCollapsed} onToggle={toggle} />
                {!isCollapsed && group.rows.map(renderRow)}
              </Fragment>
            );
          })
        : section.rows.map(renderRow)}
    </section>
  );
}
