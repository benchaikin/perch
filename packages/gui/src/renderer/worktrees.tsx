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
 * One worktree row: a health dot, the branch (the primary label — what an agent
 * is working on), a `main` tag, and the state chips. Clicking opens the worktree
 * directory via the configured command.
 */
function WorktreeRowView({ row }: { row: WorktreeRow }): JSX.Element {
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  if (!section.visible) return null;

  function toggle(repo: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  const grouped = section.multiRepo && section.repoGroups.length > 0;
  return (
    <section className="repo-section worktrees-section">
      {grouped
        ? section.repoGroups.map((group) => {
            const isCollapsed = collapsed.has(group.repo);
            return (
              <Fragment key={group.repo}>
                <WorktreeRepoHeader group={group} collapsed={isCollapsed} onToggle={toggle} />
                {!isCollapsed &&
                  group.rows.map((row) => <WorktreeRowView key={row.path} row={row} />)}
              </Fragment>
            );
          })
        : section.rows.map((row) => <WorktreeRowView key={row.path} row={row} />)}
    </section>
  );
}
