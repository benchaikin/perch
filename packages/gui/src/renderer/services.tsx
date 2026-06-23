/**
 * The Services panel, as React. A per-process row (health dot, name, status,
 * lifecycle + Logs buttons) and the per-repo group headers' whole-stack controls.
 * {@link ServicesPane} is the component the panel body renders for the Services
 * tab (see `panel.tsx`).
 *
 * This is a view-layer port: the section is fully derived in the main process
 * ({@link buildServicesSection}) and pushed in `PanelState.services`; the
 * component draws it verbatim. In-flight feedback is read straight from the
 * pushed state (`svc.inFlight` / each group's `bulkActing`) — the main process
 * flips those the moment an action starts, so there's no renderer-side optimistic
 * state to track. Class names + titles match the old imperative builder so
 * renderer.css keeps matching.
 */
import { useState } from "react";
import {
  SERVICES_PANE_SCOPE,
  type ServiceAction,
  type ServiceHealth,
  type ServicesBulkAction,
  type ServiceRow,
  type ServicesControl,
  type ServicesRepoGroup,
  type ServicesSection,
} from "../services-state.js";
import { HEALTH_ICON } from "./common.js";
import { CopyChip } from "./copy-chip.js";

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

/** The bare process id of a running/starting service as a click-to-copy badge. */
function ServicePidBadge({ pid }: { pid: number }): JSX.Element {
  return <CopyChip value={String(pid)} className="service-pid" title="Copy pid" />;
}

/** One service row: a health-colored dot, the name, a status detail, and actions. */
function ServiceRowEl({ svc }: { svc: ServiceRow }): JSX.Element {
  // The pid rides its own badge, but still belongs in the hover tooltip so the
  // row's full status reads on hover like it did when pid was plain text.
  const tooltipDetail = svc.pid !== undefined ? `pid ${svc.pid}` : svc.detail;
  return (
    <div
      className="row service-row"
      title={`${svc.name} — ${svc.statusLabel}${tooltipDetail ? ` (${tooltipDetail})` : ""}`}
    >
      <i
        className={`dot ${svc.health} fa-solid fa-${SERVICE_HEALTH_ICON[svc.health]}`}
        title={svc.statusLabel}
      />
      <span className="branch">{svc.name}</span>
      <span className="service-status">
        {svc.statusLabel}
        {svc.pid !== undefined ? (
          <>
            {" · "}
            <ServicePidBadge pid={svc.pid} />
          </>
        ) : svc.detail ? (
          ` · ${svc.detail}`
        ) : null}
      </span>
      <ServiceActions svc={svc} />
    </div>
  );
}

/**
 * One whole-stack control button for a Services group/section header. Mirrors the
 * icon-only per-row action buttons: a tinted, icon-only button (the label lives on
 * `title` + `aria-label`) that disables while a bulk action is in flight for its
 * scope, with the active one showing a spinner. `project` scopes the action to one
 * repo's services (omitted on the flat fallback acts on the whole stack).
 */
function ServicesControlEl({
  control,
  project,
  bulkActing,
}: {
  control: ServicesControl;
  project?: string;
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
              window.perch.servicesBulk(control.action, project);
            }
      }
    >
      <i className={spinning ? "fa-solid fa-circle-notch fa-spin" : `fa-solid fa-${icon}`} />
    </button>
  );
}

/**
 * The optimistic in-flight state for the Auto/Manual toggles: a `Map<scope,
 * enabled>` of the modes being written (so a clicked pill reads the new state and
 * disables until the next `services.list` poll catches up), plus the setter that
 * flips it. Threaded from {@link ServicesPane} to the group/section headers,
 * mirroring dex-pane's `autoSpawnPending`/`setAutoSpawn` context.
 */
interface AutoToggleState {
  pending: ReadonlyMap<string, boolean>;
  setAuto(scope: string, enabled: boolean): void;
}

/**
 * The per-repo Auto/Manual toggle for the Services tab: one click flips the
 * repo's mode, persisted under `plugins.services.auto[<scope>]`. In Auto the
 * daemon keeps the repo's services running (restart crashed, start stopped) each
 * poll; Manual (the default) leaves lifecycle to the user. The displayed state
 * reads the optimistic override (while a write is in flight) ahead of the
 * pushed `enabled`, and the button disables until the write resolves — the
 * Services analog of {@link DexAutoSpawnToggle} (shares the `.auto-mode-pill` CSS).
 */
function ServicesAutoToggle({
  scope,
  enabled,
  auto,
}: {
  scope: string;
  enabled: boolean;
  auto: AutoToggleState;
}): JSX.Element {
  const pending = auto.pending.get(scope);
  const inFlight = pending !== undefined;
  const on = pending ?? enabled;
  const label = on
    ? "Auto on — stopped services are started and crashed ones restarted automatically. Click for Manual."
    : "Auto off (Manual) — start/stop/restart services yourself. Click for Auto.";
  return (
    <button
      className={`icon-btn auto-mode-pill${on ? " on" : ""}`}
      disabled={inFlight}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={
        inFlight
          ? undefined
          : (e) => {
              e.stopPropagation();
              auto.setAuto(scope, !on);
            }
      }
    >
      <i
        className={
          inFlight ? "fa-solid fa-circle-notch fa-spin" : `fa-solid fa-${on ? "robot" : "hand"}`
        }
      />
      <span className="auto-mode-pill-label">{on ? "Auto" : "Manual"}</span>
    </button>
  );
}

/**
 * One repo group: a collapsible header (chevron + repo name + service-count chip)
 * plus this repo's whole-stack Start/Stop/Restart-all controls, over its service
 * rows. Clicking the name toggles just this group's rows; the controls act on only
 * this repo's services (`group.project`). The `"(unknown)"` bucket carries no
 * controls (`group.controls` is empty) — it maps to no real project to target.
 */
function ServicesRepoGroupView({
  group,
  collapsed,
  onToggle,
  auto,
}: {
  group: ServicesRepoGroup;
  collapsed: boolean;
  onToggle: (project: string) => void;
  auto: AutoToggleState;
}): JSX.Element {
  const count = group.rows.length;
  return (
    <div className="services-repo-group">
      <div className="services-repo-header">
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
        <ServicesAutoToggle scope={group.project} enabled={group.auto} auto={auto} />
        {group.controls.length > 0 ? (
          <span className="services-controls services-repo-actions">
            {group.controls.map((control) => (
              <ServicesControlEl
                key={control.action}
                control={control}
                project={group.project}
                bulkActing={group.bulkActing}
              />
            ))}
          </span>
        ) : null}
      </div>
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
 * When any repo is known (`section.grouped`) the rows render under collapsible
 * per-repo headers (config order, including configured-but-empty repos), even for
 * a single repo — the header names the project. Only an older daemon with no repo
 * association falls back to a flat list. Collapse is LOCAL component state (like
 * the PRs pane), so it survives the 5s `services.list` poll re-render.
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
  // Optimistic Auto/Manual toggle state, keyed by scope — flips the pill on click
  // and clears when the next `services.list` poll reports the persisted mode.
  const [autoPending, setAutoPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  function toggle(project: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }

  // Flip the scope's mode optimistically (so the pill reads the new state and
  // disables while in flight), persist it via main, and clear the override when
  // it resolves — by then main has re-read the list, which reports the persisted
  // mode. Keyed per scope so two repos can toggle independently.
  const auto: AutoToggleState = {
    pending: autoPending,
    setAuto(scope, enabled) {
      if (autoPending.has(scope)) return;
      setAutoPending((prev) => new Map(prev).set(scope, enabled));
      void (async () => {
        try {
          await window.perch.servicesSetAuto({ scope, enabled });
        } finally {
          setAutoPending((prev) => {
            const next = new Map(prev);
            next.delete(scope);
            return next;
          });
        }
      })();
    },
  };

  if (!section.visible) return null;
  // The pane-level (unscoped) controls render only on the flat fallback — when the
  // rows group by repo, each group header carries its own scoped controls instead.
  const showPaneControls = !section.grouped && section.controls.length > 0;
  // The flat fallback also carries the (pane-scoped) Auto toggle; grouped layouts
  // put a toggle in each repo header instead.
  const showPaneAuto = !section.grouped;
  const hasHeader = showTitle || showPaneControls || showPaneAuto;
  return (
    <section className="repo-section services-section">
      {hasHeader ? (
        <div className="repo-header services-header">
          {showTitle ? <span>Services</span> : null}
          {showPaneAuto ? (
            <ServicesAutoToggle scope={SERVICES_PANE_SCOPE} enabled={section.auto} auto={auto} />
          ) : null}
          {showPaneControls ? (
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
      {section.grouped
        ? section.repoGroups.map((group) => (
            <ServicesRepoGroupView
              key={group.project}
              group={group}
              collapsed={collapsed.has(group.project)}
              onToggle={toggle}
              auto={auto}
            />
          ))
        : section.rows.map((svc) => <ServiceRowEl key={svc.name} svc={svc} />)}
    </section>
  );
}
