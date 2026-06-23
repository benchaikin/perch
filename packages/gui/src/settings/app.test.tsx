/**
 * jsdom component tests for the Settings window React shell. These exercise the
 * parts the pure transforms (settings-tabs, settings-fields) can't: that each
 * descriptor field type renders the right control and that changing it writes the
 * coerced value back through the bridge; that the Repositories list's
 * add/remove/make-default buttons call the right bridge action; and that the
 * active tab follows the seed-then-own-then-fallback pattern.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSettingsDescription, SettingsFieldState } from "@perch/core";
import type {
  PerchSettingsBridge,
  PluginSettingsResult,
  ServicesResult,
  SettingsResult,
} from "../settings-ipc.js";
import type { RepoEntry } from "../repos.js";
import { Settings } from "./app.js";
import { createSettingsStore } from "./settings-store.js";
import { GENERAL_TAB_ID } from "./settings-tabs.js";

afterEach(() => cleanup());

/** A bridge whose every method resolves to an empty, daemon-up result by default. */
function makeBridge(overrides: Partial<PerchSettingsBridge> = {}): PerchSettingsBridge {
  const repos: SettingsResult = { repos: [], daemonUp: true };
  const plugins: PluginSettingsResult = { plugins: [], daemonUp: true };
  const services: ServicesResult = { procs: [], daemonUp: true };
  return {
    listRepos: mock.fn(async () => repos),
    addRepo: mock.fn(async () => repos),
    removeRepo: mock.fn(async () => repos),
    setDefault: mock.fn(async () => repos),
    describePlugins: mock.fn(async () => plugins),
    setField: mock.fn(async () => plugins),
    listProcs: mock.fn(async () => services),
    addProc: mock.fn(async () => services),
    removeProc: mock.fn(async () => services),
    ...overrides,
  };
}

/** Build the store over `bridge`, run the initial loads, and mount the shell. */
async function setup(bridge: PerchSettingsBridge) {
  const store = createSettingsStore(bridge);
  await store.init();
  render(<Settings store={store} />);
  return store;
}

/** Fire a DOM event inside act() so the resulting state updates flush. */
async function fire(action: () => void): Promise<void> {
  await act(async () => {
    action();
  });
}

/** The full set of field types, all under the (first/seeded) General tab. */
const FIELDS: SettingsFieldState[] = [
  {
    key: "dir",
    type: "enum",
    label: "Direction",
    value: "down",
    options: [
      { value: "down", label: "Down" },
      { value: "up", label: "Up" },
    ],
  },
  { key: "enabled", type: "boolean", label: "Enabled", value: false },
  { key: "count", type: "number", label: "Count", value: 3 },
  { key: "name", type: "string", label: "Name", value: "hi" },
  { key: "paths", type: "list", label: "Paths", value: ["/a"] },
];

/** A descriptor on the General tab carrying `fields`. */
function generalPlugin(fields: SettingsFieldState[]): PluginSettingsDescription {
  return { pluginId: GENERAL_TAB_ID, name: "General", fields };
}

test("enum field renders a select and persists the chosen value", async () => {
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(FIELDS)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  const select = screen.getByLabelText("Direction") as HTMLSelectElement;
  assert.equal(select.tagName, "SELECT");
  await fire(() => fireEvent.change(select, { target: { value: "up" } }));

  assert.equal(setField.mock.calls.length, 1);
  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "dir",
    value: "up",
  });
});

test("boolean field renders a checkbox and persists the coerced boolean", async () => {
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(FIELDS)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  const checkbox = screen.getByLabelText("Enabled") as HTMLInputElement;
  assert.equal(checkbox.type, "checkbox");
  await fire(() => fireEvent.click(checkbox));

  assert.equal(setField.mock.calls.length, 1);
  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "enabled",
    value: true,
  });
});

test("number field renders a number input and persists a finite number on blur", async () => {
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(FIELDS)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  const input = screen.getByLabelText("Count") as HTMLInputElement;
  assert.equal(input.type, "number");
  await fire(() => fireEvent.change(input, { target: { value: "7" } }));
  await fire(() => fireEvent.blur(input));

  assert.equal(setField.mock.calls.length, 1);
  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "count",
    value: 7,
  });
});

test("string field renders a text input and persists the string on blur", async () => {
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(FIELDS)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  const input = screen.getByLabelText("Name") as HTMLInputElement;
  assert.equal(input.type, "text");
  await fire(() => fireEvent.change(input, { target: { value: "world" } }));
  await fire(() => fireEvent.blur(input));

  assert.equal(setField.mock.calls.length, 1);
  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "name",
    value: "world",
  });
});

test("list field renders rows + an add row and persists the whole array on add", async () => {
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(FIELDS)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  // The existing entry renders as an editable row…
  const existing = screen.getByDisplayValue("/a");
  assert.equal((existing as HTMLInputElement).type, "text");

  // …and the add row appends the trimmed value to the whole array (coerced).
  const addInput = screen.getByPlaceholderText("Add…");
  await fire(() => fireEvent.change(addInput, { target: { value: "/b" } }));
  await fire(() => fireEvent.click(screen.getByText("Add")));

  assert.equal(setField.mock.calls.length, 1);
  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "paths",
    value: ["/a", "/b"],
  });
});

test("list row Remove persists the array with that entry dropped", async () => {
  const fields: SettingsFieldState[] = [
    { key: "paths", type: "list", label: "Paths", value: ["/a", "/b"] },
  ];
  const plugins: PluginSettingsResult = { plugins: [generalPlugin(fields)], daemonUp: true };
  const setField = mock.fn<PerchSettingsBridge["setField"]>(async () => plugins);
  await setup(makeBridge({ describePlugins: mock.fn(async () => plugins), setField }));

  // Two rows → two Remove buttons; removing the first drops "/a".
  const removes = screen.getAllByText("Remove");
  assert.equal(removes.length, 2);
  await fire(() => fireEvent.click(removes[0]!));

  assert.deepEqual(setField.mock.calls[0]!.arguments[0], {
    pluginId: GENERAL_TAB_ID,
    key: "paths",
    value: ["/b"],
  });
});

// ── Repositories list (Pull Requests tab) ───────────────────────────────────

const REPOS: RepoEntry[] = [
  { name: "alpha", path: "/repos/alpha", isDefault: true },
  { name: "beta", path: "/repos/beta", isDefault: false },
];

/** Mount with a repo list and switch to the Pull Requests tab. */
async function setupRepos(overrides: Partial<PerchSettingsBridge>) {
  const repos: SettingsResult = { repos: REPOS, daemonUp: true };
  const bridge = makeBridge({ listRepos: mock.fn(async () => repos), ...overrides });
  await setup(bridge);
  await fire(() => fireEvent.click(screen.getByRole("button", { name: "Pull Requests" })));
  return bridge;
}

test("repos list: Make default calls setDefault for the non-default repo", async () => {
  const setDefault = mock.fn<PerchSettingsBridge["setDefault"]>(async () => ({ repos: REPOS, daemonUp: true }));
  await setupRepos({ setDefault });

  // Only the non-default repo (beta) offers Make default.
  await fire(() => fireEvent.click(screen.getByText("Make default")));
  assert.equal(setDefault.mock.calls.length, 1);
  assert.equal(setDefault.mock.calls[0]!.arguments[0], "/repos/beta");
});

test("repos list: Remove calls removeRepo for that row's path", async () => {
  const removeRepo = mock.fn<PerchSettingsBridge["removeRepo"]>(async () => ({
    repos: REPOS,
    daemonUp: true,
  }));
  await setupRepos({ removeRepo });

  await fire(() => fireEvent.click(screen.getAllByText("Remove")[0]!));
  assert.equal(removeRepo.mock.calls.length, 1);
  assert.equal(removeRepo.mock.calls[0]!.arguments[0], "/repos/alpha");
});

test("repos list: Add repo… calls addRepo", async () => {
  const addRepo = mock.fn(async () => ({ repos: REPOS, daemonUp: true }));
  await setupRepos({ addRepo });

  await fire(() => fireEvent.click(screen.getByText("Add repo…")));
  assert.equal(addRepo.mock.calls.length, 1);
});

// ── Services tab ─────────────────────────────────────────────────────────────

/** Mount and switch to the Services tab. */
async function setupServices(overrides: Partial<PerchSettingsBridge> = {}) {
  const bridge = makeBridge(overrides);
  await setup(bridge);
  await fire(() => fireEvent.click(screen.getByRole("button", { name: "Services" })));
  return bridge;
}

test("services: Add Service button opens the dialog", async () => {
  await setupServices();

  // Dialog is not present initially.
  assert.equal(screen.queryByRole("dialog"), null);

  await fire(() => fireEvent.click(screen.getByText("Add Service")));

  // Dialog is now visible with all three fields.
  assert.ok(screen.getByRole("dialog"));
  assert.ok(screen.getByLabelText("Name"));
  assert.ok(screen.getByLabelText("Command"));
  assert.ok(screen.getByLabelText("Working directory (optional)"));
});

test("services: Cancel closes the dialog without calling addProc", async () => {
  const addProc = mock.fn(async () => ({ procs: [], daemonUp: true }));
  await setupServices({ addProc });

  await fire(() => fireEvent.click(screen.getByText("Add Service")));
  assert.ok(screen.getByRole("dialog"));

  await fire(() => fireEvent.click(screen.getByText("Cancel")));

  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(addProc.mock.calls.length, 0);
});

test("services: open→fill→Create calls addProc and closes the dialog on success", async () => {
  const services: ServicesResult = { procs: [{ name: "web", command: "npm run dev" }], daemonUp: true };
  const addProc = mock.fn<PerchSettingsBridge["addProc"]>(async () => services);
  await setupServices({ addProc });

  await fire(() => fireEvent.click(screen.getByText("Add Service")));

  await fire(() =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "web" } }),
  );
  await fire(() =>
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npm run dev" } }),
  );

  await fire(() => fireEvent.click(screen.getByText("Create")));

  assert.equal(addProc.mock.calls.length, 1);
  assert.deepEqual(addProc.mock.calls[0]!.arguments[0], { name: "web", command: "npm run dev" });
  // Dialog is closed on success.
  assert.equal(screen.queryByRole("dialog"), null);
});

test("services: Create with cwd omits blank cwd from the proc", async () => {
  const services: ServicesResult = { procs: [], daemonUp: true };
  const addProc = mock.fn<PerchSettingsBridge["addProc"]>(async () => services);
  await setupServices({ addProc });

  await fire(() => fireEvent.click(screen.getByText("Add Service")));

  await fire(() =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "api" } }),
  );
  await fire(() =>
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "go run ." } }),
  );
  // Working directory left blank.

  await fire(() => fireEvent.click(screen.getByText("Create")));

  assert.equal(addProc.mock.calls.length, 1);
  const proc = addProc.mock.calls[0]!.arguments[0];
  assert.ok(!("cwd" in proc), "cwd should be omitted when blank");
});

test("services: Create with cwd includes it in the proc", async () => {
  const services: ServicesResult = { procs: [], daemonUp: true };
  const addProc = mock.fn<PerchSettingsBridge["addProc"]>(async () => services);
  await setupServices({ addProc });

  await fire(() => fireEvent.click(screen.getByText("Add Service")));

  await fire(() =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "api" } }),
  );
  await fire(() =>
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "go run ." } }),
  );
  await fire(() =>
    fireEvent.change(screen.getByLabelText("Working directory (optional)"), {
      target: { value: "/srv/api" },
    }),
  );

  await fire(() => fireEvent.click(screen.getByText("Create")));

  assert.equal(addProc.mock.calls.length, 1);
  assert.deepEqual(addProc.mock.calls[0]!.arguments[0], {
    name: "api",
    command: "go run .",
    cwd: "/srv/api",
  });
});

test("services: error from addProc keeps the dialog open with the error shown", async () => {
  const errorServices: ServicesResult = { procs: [], daemonUp: true, error: "name already taken" };
  const addProc = mock.fn<PerchSettingsBridge["addProc"]>(async () => errorServices);
  // listProcs must also return the errored result so the store snapshot carries the error.
  await setupServices({
    addProc,
    listProcs: mock.fn(async () => errorServices),
  });

  await fire(() => fireEvent.click(screen.getByText("Add Service")));

  await fire(() =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "web" } }),
  );
  await fire(() =>
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npm start" } }),
  );

  await fire(() => fireEvent.click(screen.getByText("Create")));

  // Dialog stays open.
  assert.ok(screen.getByRole("dialog"));
  // Error is shown inside the dialog.
  assert.ok(screen.getByText("name already taken"));
});

test("services: Add Service button is disabled when daemon is down", async () => {
  const bridge = makeBridge({
    listProcs: mock.fn(async () => ({ procs: [], daemonUp: false })),
  });
  await setup(bridge);
  await fire(() => fireEvent.click(screen.getByRole("button", { name: "Services" })));

  const addBtn = screen.getByText("Add Service") as HTMLButtonElement;
  assert.ok(addBtn.disabled);
});

// ── Active-tab seed / own / fallback ─────────────────────────────────────────

test("active tab: seeds to the first tab, adopts a click, falls back when it vanishes", async () => {
  const custom: PluginSettingsDescription = { pluginId: "custom", name: "Custom", fields: [] };
  const withCustom: PluginSettingsResult = { plugins: [custom], daemonUp: true };
  const store = await setup(
    makeBridge({ describePlugins: mock.fn(async () => withCustom) }),
  );

  const isActive = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-current") === "page";

  // Seed: the first tab (General) is active before any click.
  assert.ok(isActive("General"));
  assert.ok(!isActive("Custom"));

  // Own: clicking the Custom tab adopts it.
  await fire(() => fireEvent.click(screen.getByRole("button", { name: "Custom" })));
  assert.ok(isActive("Custom"));

  // Fallback: when the owned tab disappears (plugin dropped), it falls back to first.
  await act(async () => {
    await store.runPlugins(async () => ({ plugins: [], daemonUp: true }));
  });
  assert.ok(isActive("General"));
  assert.equal(screen.queryByRole("button", { name: "Custom" }), null);
});
