/**
 * The Services panel: a per-process row (health dot, name, status, lifecycle +
 * Logs buttons) and the whole-stack header controls. {@link servicesSectionEl}
 * is the panel entry the top-level render calls.
 */
import type {
  ServiceAction,
  ServiceHealth,
  ServicesBulkAction,
  ServiceRow,
  ServicesControl,
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

/** Build one service row: a health-colored dot, the name, and an optional detail. */
function serviceRowEl(svc: ServiceRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row service-row";
  el.title = `${svc.name} — ${svc.statusLabel}${svc.detail ? ` (${svc.detail})` : ""}`;

  const dot = document.createElement("i");
  dot.className = `dot ${svc.health} fa-solid fa-${SERVICE_HEALTH_ICON[svc.health]}`;
  dot.title = svc.statusLabel;
  el.append(dot);

  const name = document.createElement("span");
  name.className = "branch";
  name.textContent = svc.name;
  el.append(name);

  const status = document.createElement("span");
  status.className = "service-status";
  status.textContent = svc.detail ? `${svc.statusLabel} · ${svc.detail}` : svc.statusLabel;
  el.append(status);

  el.append(serviceActionsEl(svc));
  return el;
}

/**
 * Build the action-button cluster for a service row. Renders the
 * status-appropriate lifecycle buttons (Restart always; Stop xor Start, M2),
 * plus a fire-and-forget **Logs** button (M3) that opens a terminal tailing this
 * process. While a lifecycle action is in flight for the service, those buttons
 * disable and the first shows a spinner — mirroring the Sync button's
 * `fa-circle-notch fa-spin` pattern. Logs stays enabled (it doesn't mutate
 * lifecycle state).
 */
function serviceActionsEl(svc: ServiceRow): HTMLElement {
  const actions = document.createElement("span");
  actions.className = "service-actions";
  svc.buttons.forEach((button, i) => {
    const { icon, tint } = SERVICE_ACTION_ICON[button.action];
    const btn = document.createElement("button");
    // The visible label is gone, so the former text moves to title + aria-label.
    const label = `${button.label} ${svc.name}`;
    btn.className = `btn btn-sm service-btn tint-${tint}`;
    btn.disabled = svc.inFlight;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    const glyph = document.createElement("i");
    if (svc.inFlight && i === 0) {
      // The acting button (always first) shows the spinner; no click handler
      // while in flight (the cluster is disabled anyway).
      glyph.className = "fa-solid fa-circle-notch fa-spin";
      btn.append(glyph);
    } else {
      glyph.className = `fa-solid fa-${icon}`;
      btn.append(glyph);
      btn.addEventListener("click", (e) => {
        // The row itself isn't clickable, but stop propagation defensively.
        e.stopPropagation();
        window.perch.serviceAction({ name: svc.name, action: button.action });
      });
    }
    actions.append(btn);
  });

  // Logs button: present on every row, independent of lifecycle state. Rendered
  // as a muted icon button for consistency with the lifecycle actions.
  if (svc.logs) {
    const logs = document.createElement("button");
    logs.className = "btn btn-sm service-btn service-logs tint-logs";
    const logsLabel = `Open logs for ${svc.name}`;
    logs.title = logsLabel;
    logs.setAttribute("aria-label", logsLabel);
    const glyph = document.createElement("i");
    glyph.className = "fa-solid fa-file-lines";
    logs.append(glyph);
    logs.addEventListener("click", (e) => {
      e.stopPropagation();
      window.perch.serviceLogs(svc.name);
    });
    actions.append(logs);
  }

  return actions;
}

/**
 * Build one top-level (whole-stack) control button for the Services header.
 * Mirrors the per-row action buttons: an icon-only tinted button that disables
 * while any bulk action is in flight, with the active one showing a spinner.
 */
function servicesControlEl(control: ServicesControl, bulkActing?: ServicesBulkAction): HTMLElement {
  const { icon, tint } = SERVICE_BULK_ICON[control.action];
  const btn = document.createElement("button");
  btn.className = `btn btn-sm service-btn service-bulk-btn tint-${tint}`;
  btn.title = control.label;
  btn.setAttribute("aria-label", control.label);
  btn.disabled = bulkActing !== undefined;

  const glyph = document.createElement("i");
  if (bulkActing === control.action) {
    glyph.className = "fa-solid fa-circle-notch fa-spin";
    btn.append(glyph, ` ${control.label}`);
  } else {
    glyph.className = `fa-solid fa-${icon}`;
    btn.append(glyph, ` ${control.label}`);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.perch.servicesBulk(control.action);
    });
  }
  return btn;
}

/**
 * Build the "Services" section: a header (title + whole-stack controls) and one
 * row per process. Returns null when the section is hidden (no services live and
 * none configured), so the panel is unchanged for users without process-compose.
 * When process-compose is down but procs are configured, rows show as stopped
 * and the header's **Start all** brings the stack up.
 *
 * `showTitle` is false when this section is the active full-tab pane: the panel
 * header title already names "Services", so the section's own title would
 * duplicate it — we drop the label and keep the header as a (right-aligned)
 * controls toolbar above the rows.
 */
export function servicesSectionEl(section: ServicesSection, showTitle = true): HTMLElement | null {
  if (!section.visible) return null;
  const el = document.createElement("section");
  el.className = "repo-section services-section";

  const header = document.createElement("div");
  header.className = "repo-header services-header";
  if (showTitle) {
    const title = document.createElement("span");
    title.textContent = "Services";
    header.append(title);
  }

  if (section.controls.length > 0) {
    const controls = document.createElement("span");
    controls.className = "services-controls";
    for (const control of section.controls) {
      controls.append(servicesControlEl(control, section.bulkActing));
    }
    header.append(controls);
  }
  // Only emit the header when it carries something (a title and/or controls);
  // with `showTitle` false and no controls it would be an empty bar.
  if (header.childElementCount > 0) el.append(header);

  for (const svc of section.rows) el.append(serviceRowEl(svc));
  return el;
}
