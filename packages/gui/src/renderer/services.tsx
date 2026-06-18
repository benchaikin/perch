/**
 * The Services panel, as React. A per-process row (health dot, name, status,
 * lifecycle + Logs buttons) and the whole-stack header controls.
 * {@link ServicesPane} is the component the panel body renders for the Services
 * tab (see `panel.tsx`).
 *
 * This is a view-layer port: the section is fully derived in the main process
 * ({@link buildServicesSection}) and pushed in `PanelState.services`; the
 * component draws it verbatim. In-flight feedback is read straight from the
 * pushed state (`svc.inFlight` / `section.bulkActing`) — the main process flips
 * those the moment an action starts, so there's no renderer-side optimistic
 * state to track. Class names + titles match the old imperative builder so
 * renderer.css keeps matching.
 */
import { useState } from "react";
import type {
  ServiceAction,
  ServiceHealth,
  ServicesBulkAction,
  ServiceRow,
  ServicesControl,
  ServicesRepoGroup,
  ServicesSection,
} from "../services-state.js";
import { HEALTH_ICON } from "./common.js";

/**
 * Service markers carry a fourth state — `muted` (stopped) — on top of the
 * PR health trio. Reuse the same shapes for the overlapping states so PR and
 * service dots read consistently, and give "stopped" a plain neutral circle.
 */
const SERVICE_HEALTH_ICON: Record<ServiceHealth, string> = {
  ok: HEALTH_ICON.ok,
  warn: HEALTH_ICON.warn,
  bad: HEALTH_ICON.bad,
  muted: "circle",
};

/**
 * Each service action renders as a Font Awesome icon button tinted by function.
 * Like the health marker, the distinct icon *shape* (play / stop / rotate) is
 * the primary signal so it reads without relying on the red/green hue a
 * colorblind viewer can't separate; the `tint` CSS class layers color on top.
 * `start` = green go, `stop` = red halt, `restart` = neutral/amber reload.
 */
const SERVICE_ACTION_ICON: Record<ServiceAction, { icon: string; tint: string }> = {
  start: { icon: "play", tint: "start" },
  stop: { icon: "stop", tint: "stop" },
  restart: { icon: "arrows-rotate", tint: "restart" },
};

/** Icon + tint for the top-level (whole-stack) Services header controls. */
const SERVICE_BULK_ICON: Record<ServicesBulkAction, { icon: string; tint: string }> = {
  startAll: { icon: "play", tint: "start" },
  stopAll: { icon: "stop", tint: "stop" },
  restartAll: { icon: "arrows-rotate", tint: "restart" },
};

/**
 * The action-button cluster for a service row: the status-appropriate lifecycle
 * buttons (Restart always; Stop xor Start, M2), plus a fire-and-forget **Logs**
 * button (M3) that opens a terminal tailing this process. While a lifecycle
 * action is in flight, those buttons disable and the first shows a spinner —
 * mirroring the Sync button's `fa-circle-notch fa-spin` pattern. Logs stays
 * enabled (it doesn't mutate lifecycle state).
 */
function ServiceActions({ svc }: { svc: ServiceRow }): JSX.Element {
  return (
    <span className="service-actions">
      {svc.buttons.map((button, i) => {
        const { icon, tint } = SERVICE_ACTION_ICON[button.action];
        // The visible label is gone, so the former text moves to title + aria-label.
        const label = `${button.label} ${svc.name}`;
        // The acting button (always first) shows the spinner; no click handler
        // while in flight (the cluster is disabled anyway).
        const spinning = svc.inFlight && i === 0;
        return (
          <button
            key={button.action}
            className={`btn btn-sm service-btn tint-${tint}`}
            disabled={svc.inFlight}
            title={label}
            aria-label={label}
            onClick={
              spinning
                ? undefined
                : (e) => {
                    // The row itself isn't clickable, but stop propagation defensively.
                    e.stopPropagation();
                    window.perch.serviceAction({ name: svc.name, action: button.action });
                  }
            }
          >
            <i className={spinning ? "fa-solid fa-circle-notch fa-spin" : `fa-solid fa-${icon}`} />
          </button>
        );
      })}
      {/* Logs button: present on every row, independent of lifecycle state.
          Rendered as a muted icon button for consistency with the lifecycle actions. */}
      {svc.logs ? (
        <button
          className="btn btn-sm service-btn service-logs tint-logs"
          title={`Open logs for ${svc.name}`}
          aria-label={`Open logs for ${svc.name}`}
          onClick={(e) => {
            e.stopPropagation();
            window.perch.serviceLogs(svc.name);
          }}
        >
          <i className="fa-solid fa-file-lines" />
        </button>
      ) : null}
    </span>
  );
}

/** One service row: a health-colored dot, the name, a status detail, and actions. */
function ServiceRowEl({ svc }: { svc: ServiceRow }): JSX.Element {
  return (
    <div
      className="row service-row"
      title={`${svc.name} — ${svc.statusLabel}${svc.detail ? ` (${svc.detail})` : ""}`}
    >
      <i
        className={`dot ${svc.health} fa-solid fa-${SERVICE_HEALTH_ICON[svc.health]}`}
        title={svc.statusLabel}
      />
      <span className="branch">{svc.name}</span>
      <span className="service-status">
        {svc.detail ? `${svc.statusLabel} · ${svc.detail}` : svc.statusLabel}
      </span>
      <ServiceActions svc={svc} />
    </div>
  );
}

/**
 * One top-level (whole-stack) control button for the Services header. Mirrors
 * the per-row action buttons: a tinted button that disables while any bulk
 * action is in flight, with the active one showing a spinner. Unlike the
 * icon-only per-row buttons, the header controls keep their text label.
 */
function ServicesControlEl({
  control,
  bulkActing,
}: {
  control: ServicesControl;
  bulkActing?: ServicesBulkAction;
}): JSX.Element {
  const { icon, tint } = SERVICE_BULK_ICON[control.action];
  const spinning = bulkActing === control.action;
  return (
    <button
      className={`btn btn-sm service-btn service-bulk-btn tint-${tint}`}
      title={control.label}
      aria-label={control.label}
      disabled={bulkActing !== undefined}
      onClick={
        spinning
          ? undefined
          : (e) => {
              e.stopPropagation();
              window.perch.servicesBulk(control.action);
            }
      }
    >
      <i className={spinning ? "fa-solid fa-circle-notch fa-spin" : `fa-solid fa-${icon}`} />
      {` ${control.label}`}
    </button>
  );
}

/**
 * One repo group: a collapsible header (chevron + repo name + service-count chip)
 * over its service rows. Clicking the header toggles just this group's rows. The
 * simple PR-pane pattern (no per-repo controls) — the bulk Start/Stop/Restart-all
 * stays pane-level since it targets the whole process-compose stack, not a repo
 * subset.
 */
function ServicesRepoGroupView({
  group,
  collapsed,
  onToggle,
}: {
  group: ServicesRepoGroup;
  collapsed: boolean;
  onToggle: (project: string) => void;
}): JSX.Element {
  const count = group.rows.length;
  return (
    <div className="services-repo-group">
      <button
        className="services-repo-header-btn"
        title={`${group.project} — ${count} service${count === 1 ? "" : "s"}`}
        onClick={(e) => {
          // Toggle this group's rows without propagating.
          e.stopPropagation();
          onToggle(group.project);
        }}
      >
        <i className={`fa-solid fa-chevron-${collapsed ? "right" : "down"}`} />
        <span className="branch services-repo-name">{group.project}</span>
        <span className="chip muted services-repo-count">{count}</span>
      </button>
      {!collapsed && group.rows.map((svc) => <ServiceRowEl key={svc.name} svc={svc} />)}
    </div>
  );
}

/**
 * The "Services" section: a header (optional title + whole-stack controls) and
 * the process rows. Renders nothing when the section is hidden (no services live
 * and none configured), so the panel is unchanged for users without
 * process-compose.
 *
 * With more than one repo configured (`section.multiRepo`) the rows render under
 * collapsible per-repo headers (config order, including configured-but-empty
 * repos); otherwise they render as a flat list, exactly as before. Collapse is
 * LOCAL component state (like the PRs pane), so it survives the 5s `services.list`
 * poll re-render.
 *
 * `showTitle` is false when this section is the active full-tab pane: the panel
 * header title already names "Services", so the section's own title would
 * duplicate it — we drop the label and keep the header as a (right-aligned)
 * controls toolbar above the rows. The header is only emitted when it carries
 * something (a title and/or controls); with `showTitle` false and no controls
 * it would be an empty bar.
 */
export function ServicesPane({
  section,
  showTitle = true,
}: {
  section: ServicesSection;
  showTitle?: boolean;
}): JSX.Element | null {
  // Collapsed-repo set as component state, keyed by repo name — survives the
  // background poll re-render and resets on tab switch/relaunch (the pane
  // unmounts), matching the PRs/Dex/Worktrees panes.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  function toggle(project: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }

  if (!section.visible) return null;
  const hasHeader = showTitle || section.controls.length > 0;
  return (
    <section className="repo-section services-section">
      {hasHeader ? (
        <div className="repo-header services-header">
          {showTitle ? <span>Services</span> : null}
          {section.controls.length > 0 ? (
            <span className="services-controls">
              {section.controls.map((control) => (
                <ServicesControlEl
                  key={control.action}
                  control={control}
                  bulkActing={section.bulkActing}
                />
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {section.multiRepo
        ? section.repoGroups.map((group) => (
            <ServicesRepoGroupView
              key={group.project}
              group={group}
              collapsed={collapsed.has(group.project)}
              onToggle={toggle}
            />
          ))
        : section.rows.map((svc) => <ServiceRowEl key={svc.name} svc={svc} />)}
    </section>
  );
}
