/**
 * The PR / Stack panel: standalone PR rows, nested stack groups, the per-repo
 * sections, and the per-PR Sync / Resolve-conflicts actions. {@link renderPrsPane}
 * is the panel entry the top-level render calls; the action-availability flags it
 * reads (sync / resolve-conflicts) are seeded there from the pushed state.
 */
import type { GroupRow, PanelState, PrRow, RepoSection } from "../panel-state.js";
import { HEALTH_ICON, HEALTH_LABEL, badgeEl, chipEl, loadingEl, messageEl } from "./common.js";

let syncAvailable = false;
/** Repos with a sync in flight — their Sync button shows progress. */
let syncingRepos: string[] = [];
/** Whether the resolve-conflicts action exists (gates the per-PR conflict button). */
let resolveConflictsAvailable = false;
/** Branches with a resolve-conflicts spawn in flight — their button shows a spinner. */
let resolvingConflicts: string[] = [];
/** Whether the open-agent action exists (gates the per-PR "Open agent" button). */
let openAgentAvailable = false;
/** Branches with an open-agent spawn in flight — their button shows a spinner. */
let openingAgents: string[] = [];

/**
 * Build the "review comments to address" badge: a Font Awesome comment icon +
 * the count. Caller only appends it when `count > 0`; it's emphasized (the
 * `many` modifier) when `count > 1`, where there's usually real work to do.
 */
function reviewCommentBadgeEl(count: number): HTMLElement {
  const el = document.createElement("span");
  el.className = `badge reviewcomments${count > 1 ? " many" : ""}`;
  el.title = `${count} review comment${count === 1 ? "" : "s"} to address`;
  const icon = document.createElement("i");
  icon.className = "fa-regular fa-comment";
  el.append(icon, ` ${count}`);
  return el;
}

/**
 * Build the per-PR "Resolve conflicts" button, shown only on a conflicting row
 * when the action exists. Clicking spins up an agent (via `stack.resolve-conflicts`)
 * in a worktree on the PR's branch to rebase onto its base, resolve, and push —
 * the one-click complement to the Sync action (which stops on a conflict). While
 * the spawn is in flight the button disables and shows a spinner, and the click
 * is stopped from bubbling to the row's open-in-browser handler.
 */
function resolveConflictsBtnEl(row: PrRow): HTMLElement {
  const btn = document.createElement("button");
  // Primary accent like the Sync button — it's the recommended action on a
  // conflicting row. `resolve-conflicts-btn` is a marker class for targeting.
  btn.className = "btn btn-primary btn-sm resolve-conflicts-btn";
  const inFlight = resolvingConflicts.includes(row.branch);
  btn.disabled = inFlight;
  btn.title = `Spin up an agent to resolve this PR's merge conflict (${row.repo})`;
  if (inFlight) {
    const spinner = document.createElement("i");
    spinner.className = "fa-solid fa-circle-notch fa-spin";
    btn.append(spinner, " Resolving…");
  } else {
    const glyph = document.createElement("i");
    glyph.className = "fa-solid fa-code-merge";
    btn.append(glyph, " Resolve conflicts");
    btn.addEventListener("click", (e) => {
      // Don't open the PR in the browser; just spawn the agent.
      e.stopPropagation();
      void window.perch.resolveConflicts({
        headRefName: row.branch,
        baseRefName: row.baseRefName,
        repo: row.repo,
        number: row.number,
      });
    });
  }
  return btn;
}

/**
 * Build the per-PR "Open agent" button, shown on every row when the action
 * exists. Clicking drops a free-form, auto-mode Claude session into the PR's
 * worktree (via `stack.open-agent`) with no seeded prompt — an "open an agent
 * here, no agenda" entry point for ad-hoc work. While the spawn is in flight the
 * button disables and shows a spinner, and the click is stopped from bubbling to
 * the row's open-in-browser handler.
 */
function openAgentBtnEl(row: PrRow): HTMLElement {
  const btn = document.createElement("button");
  // A quieter secondary button — it's general-purpose, not the recommended
  // action like Resolve conflicts. `open-agent-btn` is a marker class.
  btn.className = "btn btn-sm open-agent-btn";
  const inFlight = openingAgents.includes(row.branch);
  btn.disabled = inFlight;
  btn.title = `Open a free-form Claude agent session on this PR's branch (${row.repo})`;
  if (inFlight) {
    const spinner = document.createElement("i");
    spinner.className = "fa-solid fa-circle-notch fa-spin";
    btn.append(spinner, " Opening…");
  } else {
    const glyph = document.createElement("i");
    glyph.className = "fa-solid fa-robot";
    btn.append(glyph, " Open agent");
    btn.addEventListener("click", (e) => {
      // Don't open the PR in the browser; just spawn the agent.
      e.stopPropagation();
      void window.perch.openAgent({
        headRefName: row.branch,
        repo: row.repo,
        number: row.number,
      });
    });
  }
  return btn;
}

/**
 * Build one PR row; clicking opens the PR in the browser. When `pos` is given
 * (a stacked PR), it shows the layer's position number instead of a dot.
 */
function prRowEl(row: PrRow, pos?: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.title = `${row.title} — #${row.number}`;
  el.addEventListener("click", () => window.perch.openPr(row.url));

  // Stacked PRs get a position number (1 = trunk-adjacent base); standalone PRs
  // get a health-shaped icon (check / triangle / x) — a non-color cue so health
  // never depends on the red/green hue alone. Both are tinted by health too.
  if (pos !== undefined) {
    const marker = document.createElement("span");
    marker.className = `num ${row.health}`;
    marker.textContent = String(pos);
    el.append(marker);
  } else {
    const marker = document.createElement("i");
    marker.className = `dot ${row.health} fa-solid fa-${HEALTH_ICON[row.health]}`;
    marker.title = HEALTH_LABEL[row.health];
    el.append(marker);
  }

  const title = document.createElement("span");
  title.className = "branch";
  title.textContent = row.title;
  el.append(title);

  const pr = document.createElement("span");
  pr.className = "pr";
  pr.textContent = `#${row.number}`;
  el.append(pr);

  const chips = document.createElement("span");
  chips.className = "chips";
  for (const c of row.chips) chips.append(chipEl(c));
  if (row.humanReviewCommentCount > 0) {
    chips.append(reviewCommentBadgeEl(row.humanReviewCommentCount));
  }
  if (row.needsRebase) chips.append(badgeEl("rebase", "rb", "Needs rebase"));
  // A merge conflict is already shown by the `⚠ merge` mergeable chip
  // (mergeable === "CONFLICTING"); don't double-indicate it with a `cf` badge.
  el.append(chips);

  // A conflicting PR gets a one-click "Resolve conflicts" button that spins up
  // an agent on its branch — hidden for clean PRs and when the action is absent.
  if (row.conflict && resolveConflictsAvailable) el.append(resolveConflictsBtnEl(row));

  // Every PR gets an "Open agent" button — a general-purpose, agenda-free Claude
  // session on its branch — hidden only when the action is absent.
  if (openAgentAvailable) el.append(openAgentBtnEl(row));

  return el;
}

/** Build a nested stack group: a "stack of N" header + indented PR rows. */
function stackGroupEl(group: Extract<GroupRow, { kind: "stack" }>): HTMLElement {
  const el = document.createElement("div");
  // The linking bar is colored by whole-stack health (green = clean, amber =
  // comments to address, red = blocking attention).
  el.className = `stack-group ${group.health}`;

  const head = document.createElement("div");
  head.className = "stack-head";

  const label = document.createElement("span");
  label.className = "stack-label";
  label.textContent = `stack of ${group.rows.length}`;
  if (group.needsRebase) label.append(badgeEl("rebase", "rb", "Stack needs rebase"));
  head.append(label);

  // Sync shows only on a gh-stack-tracked stack and when the action exists.
  if (group.tracked && syncAvailable) {
    const sync = document.createElement("button");
    sync.className = "btn btn-primary btn-sm";
    const inFlight = syncingRepos.includes(group.repo);
    sync.disabled = inFlight;
    sync.title = `Rebase this stack onto trunk (${group.repo})`;
    if (inFlight) {
      // A spinner while the cascading rebase runs (it can take a few seconds).
      const spinner = document.createElement("i");
      spinner.className = "fa-solid fa-circle-notch fa-spin";
      sync.append(spinner, " Syncing…");
    } else {
      sync.textContent = "Sync";
      sync.addEventListener("click", () => window.perch.sync(group.repo));
    }
    head.append(sync);
  }
  el.append(head);

  const layers = document.createElement("div");
  layers.className = "stack-layers";
  // Rows are base-first; number 1..N from the base (which reads at the top).
  group.rows.forEach((row, i) => layers.append(prRowEl(row, i + 1)));
  el.append(layers);

  return el;
}

/** Build one group (standalone PR or nested stack). */
function groupEl(group: GroupRow): HTMLElement {
  return group.kind === "pr" ? prRowEl(group.pr) : stackGroupEl(group);
}

/** Build one repo section: a header, an optional error note, then its groups. */
function repoSectionEl(repo: RepoSection): HTMLElement {
  const el = document.createElement("section");
  el.className = "repo-section";

  const header = document.createElement("div");
  header.className = "repo-header";
  header.textContent = repo.name;
  el.append(header);

  if (repo.error) {
    const note = document.createElement("div");
    note.className = "repo-error";
    note.textContent = repo.error;
    note.title = repo.error;
    el.append(note);
  }

  for (const group of repo.groups) el.append(groupEl(group));
  return el;
}

/** Render the PRs pane (stack plugin) into `container` per the panel status. */
export function renderPrsPane(container: HTMLElement, state: PanelState): void {
  // Seed the action-availability flags the PR rows read from the pushed state.
  syncAvailable = state.syncAvailable;
  syncingRepos = state.syncing;
  resolveConflictsAvailable = state.resolveConflictsAvailable;
  resolvingConflicts = state.resolvingConflicts;
  openAgentAvailable = state.openAgentAvailable;
  openingAgents = state.openingAgents;

  if (state.status === "ok") {
    for (const repo of state.repos) container.append(repoSectionEl(repo));
  } else if (state.status === "loading") {
    container.append(loadingEl(state.message ?? "Loading…"));
  } else {
    // empty / daemon-down / error → a centered message in the PRs pane.
    const isError = state.status === "daemon-down" || state.status === "error";
    container.append(messageEl(state.message ?? "", isError));
  }
}
