/**
 * Behavior tests for the React {@link ServicesPane}, under jsdom. Renders the
 * component from a fake `ServicesSection` and asserts what the old imperative
 * builder guaranteed: rows render from state with their load-bearing class
 * names; per-service, bulk, and logs buttons fire the right `window.perch`
 * action; the in-flight state disables + spins the cluster; the section's own
 * title is suppressed in the full-tab (`showTitle=false`) pane; and a hidden
 * section renders nothing.
 *
 * jsdom + window.perch are installed BEFORE react-dom is imported (dynamic
 * import below), so React's DOM detection sees a real document and its event
 * system wires onto the container.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  SERVICES_PANE_SCOPE,
  type ServiceRow,
  type ServicesBulkAction,
  type ServicesControl,
  type ServicesRepoGroup,
  type ServicesSection,
} from "../services-state.js";
import type { ServiceActionRequest } from "../ipc.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const win = dom.window;
(globalThis as unknown as { window: unknown }).window = win;
(globalThis as unknown as { document: unknown }).document = win.document;

// Records every bridge call the rendered buttons make, so the assertions can
// check the exact action wiring (the data-down / events-up contract).
const calls = {
  serviceAction: [] as ServiceActionRequest[],
  servicesBulk: [] as { action: ServicesBulkAction; project?: string }[],
  serviceLogs: [] as string[],
  copyText: [] as string[],
  servicesSetAuto: [] as { scope: string; enabled: boolean }[],
};
(win as unknown as { perch: unknown }).perch = {
  serviceAction: (request: ServiceActionRequest) => calls.serviceAction.push(request),
  servicesBulk: (action: ServicesBulkAction, project?: string) =>
    calls.servicesBulk.push({ action, project }),
  serviceLogs: (name: string) => calls.serviceLogs.push(name),
  copyText: (text: string) => calls.copyText.push(text),
  // Never resolves: the toggle's optimistic pending state persists so the test
  // can observe the flipped pill (it settles when the next poll's section arrives).
  servicesSetAuto: (request: { scope: string; enabled: boolean }) => {
    calls.servicesSetAuto.push(request);
    return new Promise<void>(() => {});
  },
};

// Imported after the DOM + bridge globals are in place (react-dom reads them at
// load; the component reads window.perch on click).
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { ServicesPane } = await import("./services.js");

/** A running row with the Restart + Stop lifecycle buttons and a Logs button. */
function runningRow(name: string, overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    name,
    status: "running",
    statusLabel: "running",
    health: "ok",
    pid: 4242,
    buttons: [
      { action: "restart", label: "Restart" },
      { action: "stop", label: "Stop" },
    ],
    logs: true,
    inFlight: false,
    ...overrides,
  };
}

const BULK_CONTROLS: ServicesControl[] = [
  { action: "startAll", label: "Start all" },
  { action: "stopAll", label: "Stop all" },
  { action: "restartAll", label: "Restart all" },
];

/** A repo group with the given project label and rows (none → an empty group). */
function group(project: string, ...rows: ServiceRow[]): ServicesRepoGroup {
  return { project, rows, controls: [], auto: false };
}

/** A repo group carrying the full bulk-control trio (a server-up named repo). */
function groupWithControls(
  project: string,
  rows: ServiceRow[],
  bulkActing?: ServicesBulkAction,
): ServicesRepoGroup {
  return { project, rows, controls: BULK_CONTROLS, bulkActing, auto: false };
}

/** A section literal that may omit the grouping/auto fields (defaulted to the flat case). */
type SectionInput = Omit<ServicesSection, "grouped" | "repoGroups" | "auto"> &
  Partial<Pick<ServicesSection, "grouped" | "repoGroups" | "auto">>;

/** Fill the grouping defaults so flat-case tests can pass plain literals. */
function asSection(input: SectionInput): ServicesSection {
  return { grouped: false, repoGroups: [], auto: false, ...input };
}

/**
 * Mount `<ServicesPane>` into a fresh, document-attached container, returning a
 * `rerender` so collapse-state tests can push a follow-up render (like a 5s poll)
 * into the SAME root.
 */
function mount(
  input: SectionInput,
  showTitle = false,
): {
  container: HTMLElement;
  rerender: (next: SectionInput) => void;
} {
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  const draw = (next: SectionInput): void =>
    flushSync(() => root.render(<ServicesPane section={asSection(next)} showTitle={showTitle} />));
  draw(input);
  return { container: container as unknown as HTMLElement, rerender: draw };
}

/** Mount `<ServicesPane>` and return just the container (the common case). */
function render(input: SectionInput, showTitle = false): HTMLElement {
  return mount(input, showTitle).container;
}

/** A left click that bubbles to React's delegated listener on the root container. */
function click(el: Element): void {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

test("renders one row per service with its name, status detail, and health dot", () => {
  const c = render({
    visible: true,
    rows: [
      runningRow("api"),
      runningRow("worker", {
        health: "bad",
        status: "crashed",
        statusLabel: "crashed",
        pid: undefined,
        detail: "exit 1",
      }),
    ],
    controls: [],
  });

  const rows = c.querySelectorAll(".service-row");
  assert.equal(rows.length, 2);
  const names = [...c.querySelectorAll(".service-row .branch")].map((n) => n.textContent);
  assert.deepEqual(names, ["api", "worker"]);
  // The running row badges the bare pid (no "pid" label); the crashed row keeps
  // its exit code as plain text.
  const statuses = [...c.querySelectorAll(".service-status")].map((n) => n.textContent);
  assert.deepEqual(statuses, ["running · 4242", "crashed · exit 1"]);
  // The pid renders as a click-to-copy badge; the exit code does not.
  assert.equal(c.querySelector(".service-status .service-pid")?.textContent, "4242");
  assert.equal(rows[1]?.querySelector(".service-pid"), null);
  // The health dot carries the health class (color) the row was given.
  assert.ok(c.querySelector(".service-row .dot.ok"));
  assert.ok(c.querySelector(".service-row .dot.bad"));
});

test("a per-service lifecycle button calls serviceAction with that service + action", () => {
  calls.serviceAction.length = 0;
  const c = render({ visible: true, rows: [runningRow("api")], controls: [] });

  // Buttons are icon-only; the action lives in title/aria-label.
  const stop = [...c.querySelectorAll<HTMLButtonElement>(".service-actions button")].find(
    (b) => b.title === "Stop api",
  );
  assert.ok(stop, "expected a Stop button for the running service");
  click(stop);
  assert.deepEqual(calls.serviceAction, [{ name: "api", action: "stop" }]);
});

test("the Logs button calls serviceLogs with the service name", () => {
  calls.serviceLogs.length = 0;
  const c = render({ visible: true, rows: [runningRow("api")], controls: [] });

  const logs = c.querySelector<HTMLButtonElement>(".service-logs");
  assert.ok(logs);
  click(logs);
  assert.deepEqual(calls.serviceLogs, ["api"]);
});

test("clicking the PID badge copies the bare pid and confirms inline", () => {
  calls.copyText.length = 0;
  const c = render({ visible: true, rows: [runningRow("api")], controls: [] });

  const badge = c.querySelector<HTMLElement>(".service-status .service-pid");
  assert.ok(badge, "a running service renders a pid badge");
  assert.equal(badge.textContent, "4242");
  flushSync(() => click(badge));
  // The bare pid (as a string) is copied — no "pid" prefix.
  assert.deepEqual(calls.copyText, ["4242"]);
  // The chip flips to its confirmation, marked with the shared `copied` class.
  assert.equal(badge.textContent, "copied ✓");
  assert.ok(badge.classList.contains("copied"));
});

test("clicking the PID badge does not trigger the row (stopPropagation)", () => {
  // A React onClick on an ancestor stands in for the row's own behavior; the
  // badge's stopPropagation must keep React from dispatching to it. (A React
  // ancestor, not a native listener: React delegates at the root, so a native
  // handler would fire before the synthetic stopPropagation runs.)
  let ancestorClicks = 0;
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <div onClick={() => ancestorClicks++}>
        <ServicesPane
          section={asSection({ visible: true, rows: [runningRow("api")], controls: [] })}
          showTitle={false}
        />
      </div>,
    ),
  );

  const badge = container.querySelector<HTMLElement>(".service-status .service-pid");
  assert.ok(badge);
  flushSync(() => click(badge));
  assert.equal(ancestorClicks, 0, "the click never reaches the row's handler");
});

test("a flat-fallback bulk control calls servicesBulk unscoped (no project)", () => {
  calls.servicesBulk.length = 0;
  // No groups → the flat pane cluster; its controls act on the whole stack.
  const c = render({ visible: true, rows: [runningRow("api")], controls: BULK_CONTROLS });

  const restartAll = [...c.querySelectorAll<HTMLButtonElement>(".service-bulk-btn")].find(
    (b) => b.title === "Restart all",
  );
  assert.ok(restartAll);
  click(restartAll);
  assert.deepEqual(calls.servicesBulk, [{ action: "restartAll", project: undefined }]);
});

test("a group header bulk control calls servicesBulk scoped to that repo", () => {
  calls.servicesBulk.length = 0;
  const c = render({
    visible: true,
    rows: [runningRow("api"), runningRow("ui")],
    controls: [],
    grouped: true,
    repoGroups: [
      groupWithControls("ashby", [runningRow("api")]),
      groupWithControls("web", [runningRow("ui")]),
    ],
  });

  // The grouped pane has no pane-level cluster — controls live in group headers.
  assert.equal(c.querySelector(".services-header .services-controls"), null);

  // Each group header carries its own trio; clicking web's Stop all scopes to web.
  const webHeader = [...c.querySelectorAll(".services-repo-header")].find(
    (h) => h.querySelector(".services-repo-name")?.textContent === "web",
  );
  assert.ok(webHeader);
  const stopAll = [...webHeader.querySelectorAll<HTMLButtonElement>(".service-bulk-btn")].find(
    (b) => b.title === "Stop all",
  );
  assert.ok(stopAll);
  click(stopAll);
  assert.deepEqual(calls.servicesBulk, [{ action: "stopAll", project: "web" }]);
});

test("an in-flight group bulk action spins only that group's controls", () => {
  const c = render({
    visible: true,
    rows: [runningRow("api"), runningRow("ui")],
    controls: [],
    grouped: true,
    repoGroups: [
      groupWithControls("ashby", [runningRow("api")], "stopAll"),
      groupWithControls("web", [runningRow("ui")]),
    ],
  });

  const headerFor = (project: string): Element =>
    [...c.querySelectorAll(".services-repo-header")].find(
      (h) => h.querySelector(".services-repo-name")?.textContent === project,
    )!;
  const ashbyBtns = [
    ...headerFor("ashby").querySelectorAll<HTMLButtonElement>(".service-bulk-btn"),
  ];
  const webBtns = [...headerFor("web").querySelectorAll<HTMLButtonElement>(".service-bulk-btn")];

  // ashby's cluster disables + its Stop all spins; web's stays interactive.
  assert.ok(
    ashbyBtns.every((b) => b.disabled),
    "the acting group's controls disable",
  );
  assert.ok(
    ashbyBtns.find((b) => b.title === "Stop all")?.querySelector("i.fa-spin"),
    "the acting control spins",
  );
  assert.ok(
    webBtns.every((b) => !b.disabled),
    "the idle group's controls stay enabled",
  );
});

test("the (unknown) bucket header renders no bulk controls", () => {
  const c = render({
    visible: true,
    rows: [runningRow("api"), runningRow("stray")],
    controls: [],
    grouped: true,
    repoGroups: [
      groupWithControls("ashby", [runningRow("api")]),
      group("(unknown)", runningRow("stray")), // controls: []
    ],
  });

  const unknownHeader = [...c.querySelectorAll(".services-repo-header")].find(
    (h) => h.querySelector(".services-repo-name")?.textContent === "(unknown)",
  );
  assert.ok(unknownHeader);
  assert.equal(unknownHeader.querySelector(".service-bulk-btn"), null);
});

test("an in-flight row disables its lifecycle buttons, spins the first, and swallows clicks", () => {
  calls.serviceAction.length = 0;
  const c = render({ visible: true, rows: [runningRow("api", { inFlight: true })], controls: [] });

  const lifecycle = [
    ...c.querySelectorAll<HTMLButtonElement>(".service-actions .service-btn"),
  ].filter((b) => !b.classList.contains("service-logs"));
  assert.ok(
    lifecycle.every((b) => b.disabled),
    "lifecycle buttons disable while in flight",
  );
  // The acting button (first) shows the spinner.
  assert.ok(lifecycle[0]?.querySelector("i.fa-spin"), "first button spins while in flight");
  // Clicking the spinning button does nothing (no handler bound).
  click(lifecycle[0]!);
  assert.equal(calls.serviceAction.length, 0);
  // Logs stays enabled — it doesn't mutate lifecycle state.
  assert.equal(c.querySelector<HTMLButtonElement>(".service-logs")?.disabled, false);
});

test("an in-flight bulk action disables the controls and spins the acting one", () => {
  const bulkActing: ServicesBulkAction = "startAll";
  const c = render({
    visible: true,
    rows: [runningRow("api")],
    controls: BULK_CONTROLS,
    bulkActing,
  });

  const controls = [...c.querySelectorAll<HTMLButtonElement>(".service-bulk-btn")];
  assert.ok(
    controls.every((b) => b.disabled),
    "all bulk controls disable while one is in flight",
  );
  const startAll = controls.find((b) => b.title === "Start all");
  assert.ok(startAll?.querySelector("i.fa-spin"), "the acting bulk control spins");
});

test("in the full-tab pane the section's own title is suppressed but controls stay", () => {
  const c = render({ visible: true, rows: [runningRow("api")], controls: BULK_CONTROLS }, false);

  const header = c.querySelector(".services-header");
  assert.ok(header, "the header (controls toolbar) still renders");
  // No bare title span — only the controls span.
  assert.equal(header.querySelector(":scope > span:not(.services-controls)"), null);
  assert.ok(header.querySelector(".services-controls"), "the controls toolbar is present");
});

test("with showTitle the section renders its own Services title", () => {
  const c = render({ visible: true, rows: [], controls: [] }, true);
  const title = c.querySelector(".services-header > span:not(.services-controls)");
  assert.equal(title?.textContent, "Services");
});

test("grouped renders a collapsible header per repo with name + count chip", () => {
  const c = render({
    visible: true,
    rows: [runningRow("api"), runningRow("ui")],
    controls: [],
    grouped: true,
    // ashby (1) + web (1) + perch (0, configured-but-empty).
    repoGroups: [group("ashby", runningRow("api")), group("web", runningRow("ui")), group("perch")],
  });

  const headers = [...c.querySelectorAll(".services-repo-header-btn")];
  assert.equal(headers.length, 3);
  const names = headers.map((h) => h.querySelector(".services-repo-name")?.textContent);
  assert.deepEqual(names, ["ashby", "web", "perch"]);
  // The count chip reflects each group's row count (empty repo → 0).
  const counts = headers.map((h) => h.querySelector(".services-repo-count")?.textContent);
  assert.deepEqual(counts, ["1", "1", "0"]);
  // Both non-empty groups' rows render (everything expanded by default).
  assert.equal(c.querySelectorAll(".service-row").length, 2);
});

test("a single grouped repo renders one collapsible header over its rows", () => {
  const c = render({
    visible: true,
    rows: [runningRow("api")],
    controls: [],
    grouped: true,
    repoGroups: [group("ashby", runningRow("api"))],
  });

  const headers = [...c.querySelectorAll(".services-repo-header-btn")];
  assert.equal(headers.length, 1);
  assert.equal(headers[0]?.querySelector(".services-repo-name")?.textContent, "ashby");
  assert.equal(headers[0]?.querySelector(".services-repo-count")?.textContent, "1");
  assert.equal(c.querySelectorAll(".service-row").length, 1);

  // Clicking the lone header collapses its row.
  flushSync(() => click(headers[0] as HTMLButtonElement));
  assert.equal(c.querySelectorAll(".service-row").length, 0);
  assert.ok(headers[0]?.querySelector("i.fa-chevron-right"));
});

test("clicking a repo header collapses just that group, and it survives a poll re-render", () => {
  const section: SectionInput = {
    visible: true,
    rows: [runningRow("api"), runningRow("ui")],
    controls: [],
    grouped: true,
    repoGroups: [group("ashby", runningRow("api")), group("web", runningRow("ui"))],
  };
  const { container: c, rerender } = mount(section);
  assert.equal(c.querySelectorAll(".service-row").length, 2);

  const ashbyHeader = [...c.querySelectorAll<HTMLButtonElement>(".services-repo-header-btn")].find(
    (h) => h.querySelector(".services-repo-name")?.textContent === "ashby",
  );
  assert.ok(ashbyHeader);
  // flushSync so the collapse state update re-renders before we assert.
  flushSync(() => click(ashbyHeader));

  // Only ashby's row is hidden; web's stays. The chevron flips to "right".
  assert.deepEqual(
    [...c.querySelectorAll(".service-row .branch")].map((n) => n.textContent),
    ["ui"],
  );
  assert.ok(
    ashbyHeader.querySelector("i.fa-chevron-right"),
    "collapsed header shows a right chevron",
  );

  // A background poll pushes a fresh (identical) section; the local collapse
  // state persists because the pane stays mounted.
  rerender(section);
  assert.deepEqual(
    [...c.querySelectorAll(".service-row .branch")].map((n) => n.textContent),
    ["ui"],
  );
});

test("a hidden section renders nothing", () => {
  const c = render({ visible: false, rows: [], controls: [] });
  assert.equal(c.querySelector(".services-section"), null);
  assert.equal(c.textContent, "");
});

// ── Auto/Manual toggle pill ──

test("each repo group header renders an Auto/Manual pill reflecting its mode", () => {
  const c = render({
    visible: true,
    rows: [],
    controls: [],
    grouped: true,
    repoGroups: [
      { ...group("ashby", runningRow("api")), auto: true },
      group("web", runningRow("ui")),
    ],
  });
  const pills = [...c.querySelectorAll(".auto-mode-pill")] as HTMLButtonElement[];
  assert.equal(pills.length, 2);
  // Auto group reads "Auto" + lit; Manual group reads "Manual".
  assert.equal(pills[0]!.querySelector(".auto-mode-pill-label")!.textContent, "Auto");
  assert.ok(pills[0]!.classList.contains("on"));
  assert.equal(pills[1]!.querySelector(".auto-mode-pill-label")!.textContent, "Manual");
  assert.ok(!pills[1]!.classList.contains("on"));
});

test("clicking a group's Manual pill writes Auto and flips optimistically", () => {
  const c = render({
    visible: true,
    rows: [],
    controls: [],
    grouped: true,
    repoGroups: [group("ashby", runningRow("api"))],
  });
  const pill = c.querySelector(".auto-mode-pill") as HTMLButtonElement;
  assert.equal(pill.querySelector(".auto-mode-pill-label")!.textContent, "Manual");
  // flushSync so the optimistic setState lands before we read the DOM back.
  flushSync(() => click(pill));
  // The write targets the repo scope with the new mode…
  assert.deepEqual(calls.servicesSetAuto.at(-1), { scope: "ashby", enabled: true });
  // …and the pill flips to Auto and disables while the write is in flight.
  const flipped = c.querySelector(".auto-mode-pill") as HTMLButtonElement;
  assert.equal(flipped.querySelector(".auto-mode-pill-label")!.textContent, "Auto");
  assert.equal(flipped.disabled, true);
  assert.ok(flipped.querySelector(".fa-circle-notch"));
});

test("the flat fallback renders a pane-scoped Auto/Manual pill in its header", () => {
  const c = render({ visible: true, rows: [runningRow("api")], controls: [] }, true);
  const pill = c.querySelector(".services-header .auto-mode-pill") as HTMLButtonElement;
  assert.ok(pill);
  click(pill);
  assert.deepEqual(calls.servicesSetAuto.at(-1), { scope: SERVICES_PANE_SCOPE, enabled: true });
});
