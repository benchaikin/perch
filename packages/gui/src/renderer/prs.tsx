/**
 * The PRs / Stack pane as a React component tree: repo sections, standalone PR
 * rows, nested stack groups, the review-comment + needs-rebase badges, and the
 * per-PR Sync / Resolve-conflicts / Open-agent / Merge actions. A 1:1 port of the
 * imperative DOM builders in {@link ./prs.ts}; it is the REFERENCE pane the rest
 * of the renderer port (Services/Dex/Worktrees) copies — the same shape: data
 * down as props (the pushed {@link PanelState}), events up via the typed
 * {@link useActions} surface, optimistic in-flight state read from the pushed
 * availability/in-flight sets, and `stopPropagation` on every row-action button
 * so a button click never also fires the row's open-in-browser handler.
 *
 * Class names are kept byte-equivalent to the DOM builders (`row`, `branch`,
 * `pr`, `chips`, `stack-group`, `resolve-conflicts-btn`, `open-agent-btn`,
 * `merge-pr-btn`, the badge tones) so `renderer.css` keeps applying unchanged.
 */
import type { GroupRow, PanelState, PrRow, RepoSection } from "../panel-state.js";
import { Badge, Chip, HEALTH_ICON, HEALTH_LABEL, Loading, Message } from "./components.js";
import { useActions } from "./actions.js";

/**
 * The action-availability + in-flight sets the PR rows read from the pushed
 * state — a flat lift of the module-level `let`s the old `prs.ts` seeded in
 * `renderPrsPane`, threaded down as props instead of file-scope globals.
 */
interface PrFlags {
  syncAvailable: boolean;
  syncing: string[];
  resolveConflictsAvailable: boolean;
  resolvingConflicts: string[];
  openAgentAvailable: boolean;
  openingAgents: string[];
  mergePrAvailable: boolean;
  mergingPrs: string[];
}

/** Pull the {@link PrFlags} out of a pushed {@link PanelState}. */
function prFlags(state: PanelState): PrFlags {
  return {
    syncAvailable: state.syncAvailable,
    syncing: state.syncing,
    resolveConflictsAvailable: state.resolveConflictsAvailable,
    resolvingConflicts: state.resolvingConflicts,
    openAgentAvailable: state.openAgentAvailable,
    openingAgents: state.openingAgents,
    mergePrAvailable: state.mergePrAvailable,
    mergingPrs: state.mergingPrs,
  };
}

/**
 * The "review comments to address" badge: a Font Awesome comment icon + the
 * count. Rendered only when `count > 0`; emphasized (the `many` modifier) when
 * `count > 1`, where there's usually real work to do.
 */
function ReviewCommentBadge({ count }: { count: number }): JSX.Element {
  return (
    <span
      className={`badge reviewcomments${count > 1 ? " many" : ""}`}
      title={`${count} review comment${count === 1 ? "" : "s"} to address`}
    >
      <i className="fa-regular fa-comment" />
      {` ${count}`}
    </span>
  );
}

/**
 * The per-PR "Resolve conflicts" button, shown only on a conflicting row when
 * the action exists. Clicking spins up an agent (via `stack.resolve-conflicts`)
 * to rebase the PR's branch onto its base, resolve, and push. While the spawn is
 * in flight the button disables and shows a spinner; the click is stopped from
 * bubbling to the row's open-in-browser handler.
 */
function ResolveConflictsButton({
  row,
  resolvingConflicts,
}: {
  row: PrRow;
  resolvingConflicts: string[];
}): JSX.Element {
  const actions = useActions();
  const inFlight = resolvingConflicts.includes(row.branch);
  return (
    <button
      className="btn btn-primary btn-sm resolve-conflicts-btn"
      disabled={inFlight}
      title={`Spin up an agent to resolve this PR's merge conflict (${row.repo})`}
      onClick={(e) => {
        // Don't open the PR in the browser; just spawn the agent.
        e.stopPropagation();
        void actions.resolveConflicts({
          headRefName: row.branch,
          baseRefName: row.baseRefName,
          repo: row.repo,
          number: row.number,
        });
      }}
    >
      {inFlight ? (
        <>
          <i className="fa-solid fa-circle-notch fa-spin" />
          {" Resolving…"}
        </>
      ) : (
        <>
          <i className="fa-solid fa-code-merge" />
          {" Resolve conflicts"}
        </>
      )}
    </button>
  );
}

/**
 * The per-PR "Open agent" button, shown on every row when the action exists.
 * Clicking drops a free-form, auto-mode Claude session into the PR's worktree
 * (via `stack.open-agent`). A quieter icon-only control — no visible text, so
 * `title` + `aria-label` carry the description. While the spawn is in flight the
 * button disables and shows a spinner; the click is stopped from bubbling.
 */
function OpenAgentButton({
  row,
  openingAgents,
}: {
  row: PrRow;
  openingAgents: string[];
}): JSX.Element {
  const actions = useActions();
  const inFlight = openingAgents.includes(row.branch);
  const title = `Open a free-form Claude agent session on this PR's branch (${row.repo})`;
  return (
    <button
      className="icon-btn open-agent-btn"
      disabled={inFlight}
      title={title}
      aria-label={title}
      onClick={(e) => {
        // Don't open the PR in the browser; just spawn the agent.
        e.stopPropagation();
        void actions.openAgent({ headRefName: row.branch, repo: row.repo, number: row.number });
      }}
    >
      {inFlight ? (
        <i className="fa-solid fa-circle-notch fa-spin" />
      ) : (
        <i className="fa-solid fa-robot" />
      )}
    </button>
  );
}

/**
 * The per-PR "Merge" button, shown only on a standalone, mergeable PR row when
 * the action exists (stacked layers never get it — they merge bottom-up via the
 * stack-wide Sync). Clicking merges the PR via `stack.merge-pr`; the main process
 * confirms first. While the merge is in flight the button disables and shows a
 * spinner; the click is stopped from bubbling.
 */
function MergeButton({ row, mergingPrs }: { row: PrRow; mergingPrs: string[] }): JSX.Element {
  const actions = useActions();
  const inFlight = mergingPrs.includes(row.branch);
  return (
    <button
      className="btn btn-primary btn-sm merge-pr-btn"
      disabled={inFlight}
      title={`Merge this PR (${row.repo})`}
      onClick={(e) => {
        // Don't open the PR in the browser; just merge it.
        e.stopPropagation();
        void actions.mergePr({ number: row.number, repo: row.repo, headRefName: row.branch });
      }}
    >
      {inFlight ? (
        <>
          <i className="fa-solid fa-circle-notch fa-spin" />
          {" Merging…"}
        </>
      ) : (
        <>
          <i className="fa-solid fa-code-merge" />
          {" Merge"}
        </>
      )}
    </button>
  );
}

/**
 * One PR row; clicking opens the PR in the browser. When `pos` is given (a
 * stacked PR), it shows the layer's position number instead of a health dot.
 */
function PrRowView({ row, pos, flags }: { row: PrRow; pos?: number; flags: PrFlags }): JSX.Element {
  const actions = useActions();
  return (
    <div
      className="row"
      title={`${row.title} — #${row.number}`}
      onClick={() => actions.openPr(row.url)}
    >
      {/* Stacked PRs get a position number (1 = trunk-adjacent base); standalone
          PRs get a health-shaped icon (a non-color cue) tinted by health. */}
      {pos !== undefined ? (
        <span className={`num ${row.health}`}>{pos}</span>
      ) : (
        <i
          className={`dot ${row.health} fa-solid fa-${HEALTH_ICON[row.health]}`}
          title={HEALTH_LABEL[row.health]}
        />
      )}

      <span className="branch">{row.title}</span>
      <span className="pr">{`#${row.number}`}</span>

      <span className="chips">
        {row.chips.map((c, i) => (
          <Chip key={i} {...c} />
        ))}
        {row.humanReviewCommentCount > 0 && (
          <ReviewCommentBadge count={row.humanReviewCommentCount} />
        )}
        {row.needsRebase && <Badge kind="rebase" label="rb" hint="Needs rebase" />}
      </span>

      {/* A standalone, mergeable PR gets a one-click Merge — restricted to
          standalone rows (`pos === undefined`); stacked layers merge bottom-up. */}
      {pos === undefined && row.canMerge && flags.mergePrAvailable && (
        <MergeButton row={row} mergingPrs={flags.mergingPrs} />
      )}

      {/* A conflicting PR gets a one-click Resolve-conflicts button. */}
      {row.conflict && flags.resolveConflictsAvailable && (
        <ResolveConflictsButton row={row} resolvingConflicts={flags.resolvingConflicts} />
      )}

      {/* Every PR gets an Open-agent button — hidden only when the action is absent. */}
      {flags.openAgentAvailable && (
        <OpenAgentButton row={row} openingAgents={flags.openingAgents} />
      )}
    </div>
  );
}

/** A nested stack group: a "stack of N" header + the stack-wide Sync + indented rows. */
function StackGroupView({
  group,
  flags,
}: {
  group: Extract<GroupRow, { kind: "stack" }>;
  flags: PrFlags;
}): JSX.Element {
  const actions = useActions();
  const syncing = flags.syncing.includes(group.repo);
  return (
    // The linking bar is colored by whole-stack health.
    <div className={`stack-group ${group.health}`}>
      <div className="stack-head">
        <span className="stack-label">
          {`stack of ${group.rows.length}`}
          {group.needsRebase && <Badge kind="rebase" label="rb" hint="Stack needs rebase" />}
        </span>
        {/* Sync shows only on a gh-stack-tracked stack and when the action exists. */}
        {group.tracked && flags.syncAvailable && (
          <button
            className="btn btn-primary btn-sm"
            disabled={syncing}
            title={`Rebase this stack onto trunk (${group.repo})`}
            onClick={() => actions.sync(group.repo)}
          >
            {syncing ? (
              <>
                <i className="fa-solid fa-circle-notch fa-spin" />
                {" Syncing…"}
              </>
            ) : (
              "Sync"
            )}
          </button>
        )}
      </div>
      <div className="stack-layers">
        {/* Rows are base-first; number 1..N from the base (which reads at the top). */}
        {group.rows.map((row, i) => (
          <PrRowView key={row.branch} row={row} pos={i + 1} flags={flags} />
        ))}
      </div>
    </div>
  );
}

/** One group: a standalone PR row or a nested stack. */
function GroupView({ group, flags }: { group: GroupRow; flags: PrFlags }): JSX.Element {
  return group.kind === "pr" ? (
    <PrRowView row={group.pr} flags={flags} />
  ) : (
    <StackGroupView group={group} flags={flags} />
  );
}

/** One repo section: a header, an optional error note, then its groups. */
function RepoSectionView({ repo, flags }: { repo: RepoSection; flags: PrFlags }): JSX.Element {
  return (
    <section className="repo-section">
      <div className="repo-header">{repo.name}</div>
      {repo.error && (
        <div className="repo-error" title={repo.error}>
          {repo.error}
        </div>
      )}
      {repo.groups.map((group, i) => (
        <GroupView key={i} group={group} flags={flags} />
      ))}
    </section>
  );
}

/**
 * The PRs pane: branches on the pushed status — `ok` renders the repo sections,
 * `loading` a spinner, and `empty`/`daemon-down`/`error` a centered message
 * (error-styled for daemon-down/error). A 1:1 port of `renderPrsPane`.
 */
export function PrsPane({ state }: { state: PanelState }): JSX.Element {
  if (state.status === "ok") {
    const flags = prFlags(state);
    return (
      <>
        {state.repos.map((repo) => (
          <RepoSectionView key={repo.name} repo={repo} flags={flags} />
        ))}
      </>
    );
  }
  if (state.status === "loading") {
    return <Loading text={state.message ?? "Loading…"} />;
  }
  // empty / daemon-down / error → a centered message in the PRs pane.
  const isError = state.status === "daemon-down" || state.status === "error";
  return <Message text={state.message ?? ""} isError={isError} />;
}
