/**
 * The stack plugin's {@link AlertWidget}: renders one actionable-PR alert in the
 * dashboard alert bar and registers itself into the shared {@link alertWidgets}
 * registry under the `stack` plugin id at module load (the side effect every
 * importer triggers).
 *
 * The dashboard hands the widget the opaque alert plus an `onDismiss` callback; the
 * widget reads the alert's {@link StackAlertPayload} (its plugin owns the shape)
 * and draws a repo chip, the condition label, the PR title + number, and the
 * action buttons that fit the condition — Sync for `needs-rebase`, Merge for
 * `ready-to-merge`, and an Open-PR link on all of them — plus a dismiss ✕. The
 * row itself opens the PR; the action buttons stop the click from also firing that.
 */
import { alertWidgets, type AlertWidget } from "./alert-widgets.js";
import type { StackAlertCondition, StackAlertPayload } from "../panel-state.js";
import { useActions } from "./actions.js";

/** Per-condition presentation: the chip label, its tone, and a leading icon. */
const CONDITION_META: Record<
  StackAlertCondition,
  { label: string; tone: "ok" | "warn" | "bad"; icon: string }
> = {
  "needs-rebase": { label: "Needs rebase", tone: "bad", icon: "code-branch" },
  "ci-failing": { label: "CI failing", tone: "bad", icon: "circle-xmark" },
  "review-comments": { label: "Review comments", tone: "warn", icon: "comment" },
  "ready-to-merge": { label: "Ready to merge", tone: "ok", icon: "code-merge" },
};

/**
 * The stack plugin's alert widget. Reads the alert's payload (opaque to the
 * dashboard, owned here) and renders the labelled condition + the buttons it
 * affords.
 */
export const StackAlertWidget: AlertWidget = ({ alert, onDismiss }) => {
  const actions = useActions();
  const payload = alert.payload as StackAlertPayload;
  const meta = CONDITION_META[payload.condition];
  const openPr = (): void => actions.openPr(payload.url);

  return (
    <div
      className={`alert-item ${meta.tone}`}
      title={`${payload.title} — #${payload.number}`}
      onClick={openPr}
    >
      <span className={`chip ${meta.tone}`} title={meta.label}>
        <i className={`fa-solid fa-${meta.icon}`} />
        {` ${meta.label}`}
      </span>
      <span className="chip muted alert-repo" title={payload.repo}>
        {payload.repo}
      </span>
      <span className="alert-branch">{payload.branch}</span>
      <span className="pr">{`#${payload.number}`}</span>

      <span className="alert-actions">
        {payload.condition === "needs-rebase" && (
          <button
            className="btn btn-primary btn-sm"
            title={`Rebase this stack onto trunk (${payload.repo})`}
            onClick={(e) => {
              e.stopPropagation();
              actions.sync(payload.repo);
            }}
          >
            <i className="fa-solid fa-arrows-rotate" />
            {" Sync"}
          </button>
        )}
        {payload.condition === "ready-to-merge" && (
          <button
            className="btn btn-primary btn-sm"
            title={`Merge PR #${payload.number} (${payload.repo})`}
            onClick={(e) => {
              e.stopPropagation();
              void actions.mergePr({
                number: payload.number,
                repo: payload.repo,
                headRefName: payload.branch,
              });
            }}
          >
            <i className="fa-solid fa-code-merge" />
            {" Merge"}
          </button>
        )}
        <button
          className="btn btn-sm"
          title="Open the PR on GitHub"
          onClick={(e) => {
            e.stopPropagation();
            openPr();
          }}
        >
          <i className="fa-solid fa-arrow-up-right-from-square" />
          {" Open PR"}
        </button>
        <button
          className="icon-btn alert-dismiss"
          title="Dismiss this alert"
          aria-label="Dismiss this alert"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <i className="fa-solid fa-xmark" />
        </button>
      </span>
    </div>
  );
};

// Register into the shared registry at module load — the dashboard resolves
// `alert.pluginId === "stack"` to this widget. Importing this module is the
// side effect that wires it in.
alertWidgets.register("stack", StackAlertWidget);
