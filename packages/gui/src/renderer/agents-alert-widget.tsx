/**
 * The agents plugin's AlertWidget: renders a blocked-agent alert (raised by the
 * `agents` plugin as `agents:<sessionId>:blocked`) in the dashboard's alert region.
 *
 * The agents plugin raises the alert with an opaque payload (the wire shape of
 * its `BlockedAgentAlert`); this widget — registered under the `"agents"` plugin
 * id into the shared {@link alertWidgets} registry — owns rendering it: a header,
 * the linked dex task chip (when the session was attributable to one), the
 * session id, the blocking message, and a **Respond** action that opens the
 * agent's worktree in the terminal so the user can answer it. The payload type is
 * mirrored here (not imported from the node-only agents plugin) because the
 * renderer is a thin client that only knows the daemon's wire shapes — exactly how
 * `agents-state.ts` mirrors `AgentSession`.
 */
import type { CSSProperties } from "react";
import { dexTaskColor } from "@perch/sdk/dex-color";
import { useActions } from "./actions.js";
import { alertWidgets, type AlertWidgetProps } from "./alert-widgets.js";
import { CopyChip } from "./copy-chip.js";
import { DexTaskDot } from "./dex-task-chip.js";

/** The plugin id this widget registers under (the agents plugin's id). */
export const AGENTS_PLUGIN_ID = "agents";

/**
 * The wire shape of the agents plugin's `BlockedAgentAlert` payload — the fields
 * this widget renders. `payload` arrives as `unknown`; the widget narrows to this.
 */
interface BlockedAgentAlert {
  sessionId: string;
  taskId?: string;
  branch?: string;
  cwd?: string;
  message?: string;
}

/**
 * The linked dex task as a click-to-copy chip in the task's stable identity
 * color — mirrors the Dex pane's id chip (the `dex-id dex-open` tint), so a
 * blocked agent's alert reads as the same "team color" as its task row.
 */
function DexTaskChip({ id }: { id: string }): JSX.Element {
  const color = dexTaskColor(id);
  const style = {
    ["--task-color"]: color.hex,
    ["--task-color-rgb"]: `${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b}`,
  } as CSSProperties;
  return (
    <span className="agents-alert-task">
      <DexTaskDot id={id} />
      <CopyChip value={id} className="dex-id dex-open" title="Copy task id" style={style} />
    </span>
  );
}

/** Render one blocked-agent alert. */
export function AgentsAlertWidget({ alert, onDismiss }: AlertWidgetProps): JSX.Element {
  const actions = useActions();
  const payload = (alert.payload ?? {}) as BlockedAgentAlert;
  const shortSession = payload.sessionId ? payload.sessionId.slice(0, 8) : "unknown";
  const cwd = payload.cwd;

  return (
    <div className="agents-alert">
      <div className="agents-alert-head">
        <i className="fa-solid fa-hand agents-alert-icon" />
        <span className="agents-alert-title">Agent blocked — awaiting input</span>
      </div>
      <div className="agents-alert-meta">
        {payload.taskId ? <DexTaskChip id={payload.taskId} /> : null}
        <span className="chip muted" title={`Session ${payload.sessionId ?? "unknown"}`}>
          {`session ${shortSession}`}
        </span>
      </div>
      {payload.message ? <p className="agents-alert-message">{payload.message}</p> : null}
      <div className="agents-alert-actions">
        <button
          className="btn btn-primary"
          disabled={!cwd}
          title={cwd ? "Open the agent's worktree to respond" : "No worktree to open"}
          onClick={() => cwd && actions.worktreeOpen(cwd)}
        >
          <i className="fa-solid fa-reply" /> Respond
        </button>
        <button className="btn" title="Dismiss this alert" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Register at module load so the dashboard can resolve `agents` alerts to this
// widget. Imported for its side effect from the renderer entry.
alertWidgets.register(AGENTS_PLUGIN_ID, AgentsAlertWidget);
