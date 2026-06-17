/**
 * The Worktrees panel: one row per git worktree (flat, or grouped under
 * collapsible per-repo headers when multi-repo), each annotated with its linked
 * dex task's identity color + status. {@link worktreesSectionEl} is the panel
 * entry the top-level render calls. Borrows {@link dexTaskDotEl} /
 * {@link DEX_STATUS_LABEL} from the Dex panel so a worktree reads as the same
 * "team color" as its task across the fleet.
 */
import {
  type WorktreeRow,
  type WorktreesSection,
  type WorktreeRepoGroup,
} from "../worktrees-state.js";
import { dexHealth, isOpenDexTask } from "../dex-state.js";
import { dexTaskColor } from "@perch/sdk/dex-color";
import type { LinkedTask } from "../worktree-task-link.js";
import { DEX_STATUS_LABEL, dexTaskDotEl } from "./dex.js";
import { requestRender } from "./rerender.js";

/** Collapsed worktree repo ids (their rows are hidden); preserved across re-renders. */
const collapsedWorktreeRepos = new Set<string>();

/**
 * Build a collapsible worktree repo header: a chevron, health dot, count,
 * and optional dirty/conflict indicators. Clicking toggles the repo's children.
 */
function worktreeRepoHeaderEl(group: WorktreeRepoGroup, collapsed: boolean): HTMLElement {
  const el = document.createElement("button");
  el.className = "worktree-repo-header-btn";
  const rowCount = group.count;
  const detail = [
    `${rowCount} worktree${rowCount !== 1 ? "s" : ""}`,
    group.dirtyCount > 0 ? `${group.dirtyCount} dirty` : "",
    group.hasConflict ? "conflict" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  el.title = `${group.repo} — ${detail}`;

  const chevron = document.createElement("i");
  chevron.className = `fa-solid fa-chevron-${collapsed ? "right" : "down"}`;
  el.append(chevron);

  const dot = document.createElement("i");
  dot.className = `dot ${group.health} fa-solid fa-code-branch`;
  el.append(dot);

  const name = document.createElement("span");
  name.className = "branch worktree-repo-name";
  name.textContent = group.repo;
  el.append(name);

  const indicators = document.createElement("span");
  indicators.className = "worktree-repo-indicators";

  const count = document.createElement("span");
  count.className = "chip muted worktree-repo-count";
  count.textContent = String(rowCount);
  indicators.append(count);

  if (group.dirtyCount > 0) {
    const dirty = document.createElement("span");
    dirty.className = "chip warn";
    dirty.title = `${group.dirtyCount} uncommitted change${group.dirtyCount === 1 ? "" : "s"}`;
    dirty.textContent = `●${group.dirtyCount}`;
    indicators.append(dirty);
  }

  if (group.hasConflict) {
    const conflict = document.createElement("span");
    conflict.className = "chip bad";
    conflict.textContent = "conflict";
    indicators.append(conflict);
  }

  el.append(indicators);

  el.addEventListener("click", (e) => {
    // Toggle the repo's children without propagating.
    e.stopPropagation();
    if (collapsed) collapsedWorktreeRepos.delete(group.repo);
    else collapsedWorktreeRepos.add(group.repo);
    requestRender();
  });

  return el;
}

/**
 * Build the chip annotating a worktree row with the dex task it was created for.
 * The branch label (`dex/<id>-<slug>`) already supplies the row's identity — the
 * task id and a slug of its name — so the chip doesn't repeat them; it carries the
 * one thing the branch can't: the task's live status (`🗒 <status>`), toned the
 * same way the dex board's status chip is (`dexHealth` — blocked=red, in-progress/
 * done/ready). The full id + real name + status live in the hover tooltip.
 * Non-interactive (clicking the row still opens the worktree dir).
 *
 * When the linked task is open (unblocked, unfinished — see {@link isOpenDexTask}),
 * the chip also carries the task's stable identity color via the same
 * `dex-open`/`--task-color` accent its dex row uses, so a worktree reads as the
 * same "team color" as its task across the fleet. A blocked/done task's chip
 * keeps its plain status tone.
 */
function worktreeTaskChipEl(task: LinkedTask): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `chip ${dexHealth(task.status)} worktree-task`;
  chip.title = `${task.id} · ${task.name} — ${DEX_STATUS_LABEL[task.status]}`;
  if (isOpenDexTask(task)) {
    const color = dexTaskColor(task.id);
    chip.classList.add("dex-open");
    chip.style.setProperty("--task-color", color.hex);
    chip.style.setProperty("--task-color-rgb", `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`);
  }
  chip.append(`🗒 ${DEX_STATUS_LABEL[task.status]}`);
  return chip;
}

/** Build one worktree row: a health dot, branch/name (main tagged), and state chips. */
function worktreeRowEl(row: WorktreeRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row worktree-row";
  const detail = [
    row.branch ?? "(detached)",
    row.dirty ? `${row.dirtyCount} uncommitted` : "clean",
    row.conflict ? "conflict" : "",
    row.prunable ? "prunable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  el.title = `${row.name} — ${detail}`;

  const dot = document.createElement("i");
  dot.className = `dot ${row.health} fa-solid fa-${row.conflict ? "code-merge" : "code-branch"}`;
  el.append(dot);

  // Branch is the primary label (what an agent is working on); the worktree
  // directory name follows, muted, when it differs.
  const branch = document.createElement("span");
  branch.className = "branch";
  branch.textContent = row.branch ?? "(detached)";
  el.append(branch);

  if (row.main) {
    const tag = document.createElement("span");
    tag.className = "chip muted";
    tag.textContent = "main";
    el.append(tag);
  }

  const chips = document.createElement("span");
  chips.className = "chips";
  // The linked dex task leads the chips so the row reads "what this is for". An
  // open task leads with a solid dot in its identity color — the same dot its
  // dex row shows — so a worktree matches its task at a glance.
  if (row.task) {
    if (isOpenDexTask(row.task)) chips.append(dexTaskDotEl(row.task.id));
    chips.append(worktreeTaskChipEl(row.task));
  }
  if (row.dirty) {
    const d = document.createElement("span");
    d.className = "chip warn";
    d.title = `${row.dirtyCount} uncommitted change${row.dirtyCount === 1 ? "" : "s"}`;
    d.textContent = `●${row.dirtyCount}`;
    chips.append(d);
  }
  if (row.conflict) {
    const c = document.createElement("span");
    c.className = "chip bad";
    c.textContent = "conflict";
    chips.append(c);
  }
  if ((row.ahead ?? 0) > 0 || (row.behind ?? 0) > 0) {
    const ab = document.createElement("span");
    ab.className = `chip ${(row.ahead ?? 0) > 0 && (row.behind ?? 0) > 0 ? "warn" : "muted"}`;
    ab.title = `${row.ahead ?? 0} ahead, ${row.behind ?? 0} behind upstream`;
    ab.textContent = `↑${row.ahead ?? 0} ↓${row.behind ?? 0}`;
    chips.append(ab);
  }
  if (row.prunable) {
    const p = document.createElement("span");
    p.className = "chip bad";
    p.textContent = "prunable";
    chips.append(p);
  }
  el.append(chips);

  // Click opens the worktree directory via the configured command.
  el.addEventListener("click", () => window.perch.worktreeOpen(row.path));
  return el;
}

/**
 * Build the "Worktrees" section: one row per worktree (main first). Returns null
 * when hidden (no worktrees plugin / none). When multiRepo is true, rows are
 * grouped under collapsible repo headers with aggregate indicators; otherwise
 * a flat list of rows. No section title — the active "Worktrees" tab already
 * names it.
 */
export function worktreesSectionEl(section: WorktreesSection): HTMLElement | null {
  if (!section.visible) return null;
  const el = document.createElement("section");
  el.className = "repo-section worktrees-section";

  if (section.multiRepo && section.repoGroups.length > 0) {
    // Grouped render: collapsible per-repo sections with aggregate indicators.
    for (const group of section.repoGroups) {
      const collapsed = collapsedWorktreeRepos.has(group.repo);
      el.append(worktreeRepoHeaderEl(group, collapsed));
      if (!collapsed) {
        for (const row of group.rows) {
          el.append(worktreeRowEl(row));
        }
      }
    }
  } else {
    // Flat render: single repo or empty group list.
    for (const row of section.rows) {
      el.append(worktreeRowEl(row));
    }
  }

  return el;
}
