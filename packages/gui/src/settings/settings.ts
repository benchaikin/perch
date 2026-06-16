/**
 * Settings renderer. Runs in the sandboxed browser context with only the typed
 * `window.perchSettings` bridge (no Node/Electron). Renders a **tabbed** surface:
 * a vertical list of tabs down the LEFT, one per plugin, with the selected tab's
 * content in a pane on the RIGHT.
 *
 *   - **Pull Requests** (stack) — the Repositories add / remove / make-default
 *     list (each action resolves to a refreshed {@link SettingsResult} we
 *     re-render from) PLUS the stack plugin's descriptor fields.
 *   - **Services** — the services plugin's descriptor fields (the logs-terminal
 *     command + process-compose connection config).
 *   - Any other plugin that declares a descriptor gets its own tab.
 *
 * Per-plugin content is descriptor-driven: each field renders a control by type
 * (enum→select, boolean→checkbox, string→text, number→number, list→an editable
 * stack of removable rows + an add row); changing one writes back via
 * `config.update` and re-reads the descriptors. No
 * plugin-specific UI code lives here — only the well-known tab grouping (which
 * tab owns the repos list) does. Bundled to plain browser JS by esbuild.
 */
import type { PluginSettingsDescription, SettingsFieldState } from "@perch/core";
import type { Proc } from "../procs.js";
import type { RepoEntry } from "../repos.js";
import type { PluginSettingsResult, ServicesResult, SettingsResult } from "../settings-ipc.js";
import { coerceFieldValue } from "../settings-fields.js";
import {
  buildSettingsTabs,
  resolveActiveTab,
  visibleFields,
  type SettingsTab,
} from "./settings-tabs.js";

const tabsEl = byId("tabs");
const paneEl = byId("pane");

/** Latest snapshots from the bridge calls; the active tab re-renders from these. */
let reposResult: SettingsResult = { repos: [], daemonUp: false };
let pluginsResult: PluginSettingsResult = { plugins: [], daemonUp: false };
let servicesResult: ServicesResult = { procs: [], daemonUp: false };
/** The selected tab id; preserved across re-renders when it still exists. */
let activeTabId: string | undefined;
/** Disables repo actions while a repos bridge call is in flight. */
let reposBusy = false;
/** Disables managed-process actions while a services bridge call is in flight. */
let servicesBusy = false;
/** The add-service form's draft inputs, preserved across re-renders. */
const procDraft: Proc = { name: "", command: "", cwd: "" };

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

// ── Repositories section (Pull Requests tab) ────────────────────────────────

/** Build one repo row: name (+ default tag), path, and per-row actions. */
function repoRowEl(repo: RepoEntry): HTMLElement {
  const el = document.createElement("div");
  el.className = "repo";

  const info = document.createElement("div");
  info.className = "repo-info";

  const name = document.createElement("div");
  name.className = "repo-name";
  const nameText = document.createElement("span");
  nameText.textContent = repo.name;
  name.append(nameText);
  if (repo.isDefault) {
    const tag = document.createElement("span");
    tag.className = "default-tag";
    tag.textContent = "default";
    name.append(tag);
  }
  info.append(name);

  const path = document.createElement("div");
  path.className = "repo-path";
  path.textContent = repo.path;
  path.title = repo.path;
  info.append(path);

  el.append(info);

  const actions = document.createElement("div");
  actions.className = "repo-actions";

  if (!repo.isDefault) {
    const makeDefault = document.createElement("button");
    makeDefault.className = "btn btn-sm";
    makeDefault.textContent = "Make default";
    makeDefault.title = "Move this repo to the front (the stack default)";
    makeDefault.disabled = reposBusy;
    makeDefault.addEventListener("click", () =>
      runRepos(() => window.perchSettings.setDefault(repo.path)),
    );
    actions.append(makeDefault);
  }

  const remove = document.createElement("button");
  remove.className = "btn btn-sm";
  remove.textContent = "Remove";
  remove.disabled = reposBusy;
  remove.addEventListener("click", () =>
    runRepos(() => window.perchSettings.removeRepo(repo.path)),
  );
  actions.append(remove);

  el.append(actions);
  return el;
}

/** Build the Repositories management block (list + inline error + add button). */
function reposSectionEl(): HTMLElement {
  const section = document.createElement("section");
  section.className = "section";

  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "Repositories";
  const subtitle = document.createElement("span");
  subtitle.className = "subtitle";
  subtitle.textContent = "The first repo is the default.";
  header.append(title, subtitle);
  section.append(header);

  const rule = document.createElement("hr");
  rule.className = "rule";
  section.append(rule);

  const rows = document.createElement("div");
  rows.className = "rows";
  if (!reposResult.daemonUp) {
    rows.append(emptyEl("Perch daemon is not running. Start it to manage repos."));
  } else if (reposResult.repos.length === 0) {
    rows.append(emptyEl("No repos configured yet. Add one to get started."));
  } else {
    for (const repo of reposResult.repos) rows.append(repoRowEl(repo));
  }
  section.append(rows);

  if (reposResult.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = reposResult.error;
    section.append(err);
  }

  const footer = document.createElement("footer");
  footer.className = "actions";
  const add = document.createElement("button");
  add.className = "btn btn-primary";
  add.textContent = "Add repo…";
  add.disabled = reposBusy;
  add.addEventListener("click", () => runRepos(() => window.perchSettings.addRepo()));
  footer.append(add);
  section.append(footer);

  return section;
}

/**
 * Run an async repos bridge call with the repo controls disabled, then store the
 * result and re-render the active tab. A rejected call (unexpected) surfaces as
 * an inline error rather than a silent dead button.
 */
async function runRepos(call: () => Promise<SettingsResult>): Promise<void> {
  reposBusy = true;
  renderActive();
  try {
    reposResult = await call();
  } catch (err) {
    reposResult = {
      ...reposResult,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    reposBusy = false;
    renderActive();
  }
}

// ── Managed processes (Services tab) ─────────────────────────────────────────

/** Build one proc row: name, command (titled), optional cwd, and a Remove button. */
function procRowEl(proc: Proc): HTMLElement {
  const el = document.createElement("div");
  el.className = "repo";

  const info = document.createElement("div");
  info.className = "repo-info";

  const name = document.createElement("div");
  name.className = "repo-name";
  const nameText = document.createElement("span");
  nameText.textContent = proc.name;
  name.append(nameText);
  info.append(name);

  const command = document.createElement("div");
  command.className = "repo-path";
  command.textContent = proc.command;
  command.title = proc.command;
  info.append(command);

  if (proc.cwd) {
    const cwd = document.createElement("div");
    cwd.className = "repo-path";
    cwd.textContent = proc.cwd;
    cwd.title = proc.cwd;
    info.append(cwd);
  }

  el.append(info);

  const actions = document.createElement("div");
  actions.className = "repo-actions";
  const remove = document.createElement("button");
  remove.className = "btn btn-sm";
  remove.textContent = "Remove";
  remove.disabled = servicesBusy;
  remove.addEventListener("click", () =>
    runServices(() => window.perchSettings.removeProc(proc.name)),
  );
  actions.append(remove);
  el.append(actions);

  return el;
}

/** A labeled text input for the add-service form, bound to the `procDraft`. */
function procInputEl(
  field: "name" | "command" | "cwd",
  label: string,
  placeholder: string,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field-stacked";

  const labelText = document.createElement("div");
  labelText.className = "field-label";
  labelText.textContent = label;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "field-control";
  input.placeholder = placeholder;
  input.value = procDraft[field] ?? "";
  input.disabled = servicesBusy;
  input.addEventListener("input", () => {
    procDraft[field] = input.value;
  });

  wrap.append(labelText, input);
  return wrap;
}

/** Build the managed-process management block (list + inline error + add form). */
function servicesSectionEl(): HTMLElement {
  const section = document.createElement("section");
  section.className = "section";

  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "Services";
  const subtitle = document.createElement("span");
  subtitle.className = "subtitle";
  subtitle.textContent = "Processes Perch runs and supervises.";
  header.append(title, subtitle);
  section.append(header);

  const rule = document.createElement("hr");
  rule.className = "rule";
  section.append(rule);

  const rows = document.createElement("div");
  rows.className = "rows";
  if (!servicesResult.daemonUp) {
    rows.append(emptyEl("Perch daemon is not running. Start it to manage services."));
  } else if (servicesResult.procs.length === 0) {
    rows.append(emptyEl("No services configured — add one to run it."));
  } else {
    for (const proc of servicesResult.procs) rows.append(procRowEl(proc));
  }
  section.append(rows);

  if (servicesResult.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = servicesResult.error;
    section.append(err);
  }

  // Add form: Name + Command (required) + optional Cwd, then an Add button.
  const form = document.createElement("div");
  form.className = "fields";
  form.append(
    procInputEl("name", "Name", "web"),
    procInputEl("command", "Command", "npm run dev"),
    procInputEl("cwd", "Working directory (optional)", "/path/to/dir"),
  );
  section.append(form);

  const footer = document.createElement("footer");
  footer.className = "actions";
  const add = document.createElement("button");
  add.className = "btn btn-primary";
  add.textContent = "Add service";
  add.disabled = servicesBusy || !servicesResult.daemonUp;
  add.addEventListener("click", () => {
    const proc: Proc = {
      name: procDraft.name,
      command: procDraft.command,
      ...(procDraft.cwd?.trim() ? { cwd: procDraft.cwd } : {}),
    };
    void runServices(async () => {
      const result = await window.perchSettings.addProc(proc);
      // Clear the draft only on a clean add (no validation/RPC error).
      if (!result.error) {
        procDraft.name = "";
        procDraft.command = "";
        procDraft.cwd = "";
      }
      return result;
    });
  });
  footer.append(add);
  section.append(footer);

  return section;
}

/**
 * Run an async services bridge call with the service controls disabled, then
 * store the result and re-render the active tab. A rejected call (unexpected)
 * surfaces as an inline error rather than a silent dead button.
 */
async function runServices(call: () => Promise<ServicesResult>): Promise<void> {
  servicesBusy = true;
  renderActive();
  try {
    servicesResult = await call();
  } catch (err) {
    servicesResult = {
      ...servicesResult,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    servicesBusy = false;
    renderActive();
  }
}

// ── Per-plugin descriptor fields ─────────────────────────────────────────────

/** Read a control's raw value, then persist via `config.update` and re-render. */
function persistField(pluginId: string, field: SettingsFieldState, raw: unknown): void {
  const value = coerceFieldValue(field.type, raw);
  // A number input cleared to blank coerces to `undefined` — skip the write
  // rather than persist nothing (the control keeps its displayed value).
  if (value === undefined) return;
  void runPlugins(() => window.perchSettings.setField({ pluginId, key: field.key, value }));
}

/** Build one labeled control for a field, seeded from its current `value`. */
function fieldControlEl(pluginId: string, field: SettingsFieldState): HTMLElement {
  const row = document.createElement("div");
  row.className = "field";

  const labelText = document.createElement("div");
  labelText.className = "field-label";
  labelText.textContent = field.label;

  const control = buildControl(pluginId, field);
  // A `list` is its own multi-input block (rows + add row), so it styles its
  // children itself and isn't a single labelable control; every scalar control is
  // a `.field-control` wrapped in a `<label>`.
  if (field.type !== "list") control.classList.add("field-control");

  // Checkbox reads better inline with its label; other controls stack above it.
  if (field.type === "boolean") {
    const inline = document.createElement("label");
    inline.className = "field-inline";
    inline.append(control, labelText);
    row.append(inline);
  } else if (field.type === "list") {
    // Not a single focusable control, so a heading div (not a wrapping label).
    row.append(labelText, control);
  } else {
    const label = document.createElement("label");
    label.className = "field-stacked";
    label.append(labelText, control);
    row.append(label);
  }

  if (field.description) {
    const desc = document.createElement("div");
    desc.className = "field-desc";
    desc.textContent = field.description;
    row.append(desc);
  }

  return row;
}

/** Create the input element for a field, by type, seeded from `field.value`. */
function buildControl(pluginId: string, field: SettingsFieldState): HTMLElement {
  switch (field.type) {
    case "enum": {
      const select = document.createElement("select");
      for (const option of field.options ?? []) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        select.append(opt);
      }
      if (field.value != null) select.value = String(field.value);
      select.addEventListener("change", () => persistField(pluginId, field, select.value));
      return select;
    }
    case "boolean": {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = field.value === true;
      input.addEventListener("change", () => persistField(pluginId, field, input.checked));
      return input;
    }
    case "number": {
      const input = document.createElement("input");
      input.type = "number";
      if (field.value != null) input.value = String(field.value);
      input.addEventListener("change", () => persistField(pluginId, field, input.value));
      return input;
    }
    case "string": {
      const input = document.createElement("input");
      input.type = "text";
      if (field.value != null) input.value = String(field.value);
      input.addEventListener("change", () => persistField(pluginId, field, input.value));
      return input;
    }
    case "list":
      return buildListControl(pluginId, field);
  }
}

/** Read a field's current value as a `string[]` (its empty when unset/non-array). */
function listValue(field: SettingsFieldState): string[] {
  return Array.isArray(field.value) ? field.value.map((entry) => String(entry)) : [];
}

/**
 * Build the control for a `list` field: one removable row per current entry plus
 * an add-row input. Every edit persists the WHOLE array (via `persistField`),
 * which re-describes + re-renders — so add/remove flow back through the bridge
 * rather than mutating local state. The add input keeps focus-by-rebuild simple
 * by committing on Enter or button click.
 */
function buildListControl(pluginId: string, field: SettingsFieldState): HTMLElement {
  const entries = listValue(field);

  const wrap = document.createElement("div");
  wrap.className = "list-field";

  const rows = document.createElement("div");
  rows.className = "list-rows";
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "list-row";

    const text = document.createElement("input");
    text.type = "text";
    text.className = "field-control list-row-input";
    text.value = entry;
    // Editing a row persists the array with that index replaced.
    text.addEventListener("change", () => {
      const next = entries.slice();
      next[index] = text.value;
      persistField(pluginId, field, next);
    });
    row.append(text);

    const remove = document.createElement("button");
    remove.className = "btn btn-sm";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      const next = entries.slice();
      next.splice(index, 1);
      persistField(pluginId, field, next);
    });
    row.append(remove);

    rows.append(row);
  });
  wrap.append(rows);

  // Add row: a text input + Add button. Committing appends the trimmed value and
  // persists; blank input is a no-op (so Enter on an empty field does nothing).
  const addRow = document.createElement("div");
  addRow.className = "list-row";

  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.className = "field-control list-row-input";
  addInput.placeholder = "Add…";
  addRow.append(addInput);

  const commitAdd = () => {
    const value = addInput.value.trim();
    if (!value) return;
    persistField(pluginId, field, [...entries, value]);
  };
  addInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitAdd();
    }
  });

  const add = document.createElement("button");
  add.className = "btn btn-sm";
  add.type = "button";
  add.textContent = "Add";
  add.addEventListener("click", commitAdd);
  addRow.append(add);

  wrap.append(addRow);
  return wrap;
}

/** Build the descriptor-driven fields block for a plugin (header + fields). */
function pluginFieldsEl(plugin: PluginSettingsDescription, heading: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "section";

  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = heading;
  header.append(title);
  section.append(header);

  const rule = document.createElement("hr");
  rule.className = "rule";
  section.append(rule);

  // Apply each field's `showWhen` rule against the current values so dependent
  // controls (e.g. the Custom terminal command) only appear when relevant. A
  // persisted edit re-describes + re-renders, so toggling the controlling field
  // reveals or hides the dependent one on the next render with no extra wiring.
  const shown = visibleFields(plugin.fields);
  if (shown.length === 0) {
    section.append(emptyEl("No settings for this plugin."));
  } else {
    const fields = document.createElement("div");
    fields.className = "fields";
    for (const field of shown) fields.append(fieldControlEl(plugin.pluginId, field));
    section.append(fields);
  }

  return section;
}

/**
 * Run an async per-plugin bridge call, then store the refreshed descriptors and
 * re-render the active tab. A failure surfaces inline on the plugin descriptors.
 */
async function runPlugins(call: () => Promise<PluginSettingsResult>): Promise<void> {
  try {
    pluginsResult = await call();
  } catch (err) {
    pluginsResult = {
      ...pluginsResult,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  renderActive();
}

// ── Tabs + active-pane rendering ─────────────────────────────────────────────

/** A centered muted placeholder line. */
function emptyEl(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  return el;
}

/** Render the left-nav buttons, marking `tabs`' active one. */
function renderTabs(tabs: SettingsTab[]): void {
  tabsEl.replaceChildren();
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = tab.id === activeTabId ? "tab tab-active" : "tab";
    btn.textContent = tab.label;
    btn.setAttribute("aria-current", tab.id === activeTabId ? "page" : "false");
    btn.addEventListener("click", () => {
      if (activeTabId === tab.id) return;
      activeTabId = tab.id;
      renderActive();
    });
    tabsEl.append(btn);
  }
}

/** Render the right pane for a single tab: its repos block (if any) + fields. */
function renderPane(tab: SettingsTab): void {
  paneEl.replaceChildren();

  if (tab.showRepos) paneEl.append(reposSectionEl());
  if (tab.showServices) paneEl.append(servicesSectionEl());

  if (tab.plugin) {
    // The descriptor fields render under the plugin's own name. On the PRs tab
    // they read as a follow-on "Stack" block after the Repositories list above.
    paneEl.append(pluginFieldsEl(tab.plugin, tab.plugin.name));
  } else if (!tab.showRepos && !tab.showServices) {
    // A pinned tab whose plugin isn't loaded (daemon down or plugin disabled).
    // The PRs/Services tabs own a managed list + form, so they're never blank.
    paneEl.append(
      emptyEl(
        pluginsResult.daemonUp
          ? "This plugin isn’t available."
          : "Perch daemon is not running. Start it to configure this plugin.",
      ),
    );
  }

  if (pluginsResult.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = pluginsResult.error;
    paneEl.append(err);
  }
}

/** Rebuild the tab list from the latest data and re-render nav + active pane. */
function renderActive(): void {
  const tabs = buildSettingsTabs(pluginsResult.plugins);
  activeTabId = resolveActiveTab(tabs, activeTabId);
  renderTabs(tabs);

  const active = tabs.find((t) => t.id === activeTabId);
  if (active) {
    renderPane(active);
  } else {
    paneEl.replaceChildren(emptyEl("No settings available."));
  }
}

/** Load the repo list, store it, and re-render. */
async function loadRepos(): Promise<void> {
  try {
    reposResult = await window.perchSettings.listRepos();
  } catch (err) {
    reposResult = {
      repos: [],
      daemonUp: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  renderActive();
}

/** Load the managed-process list, store it, and re-render. */
async function loadProcs(): Promise<void> {
  try {
    servicesResult = await window.perchSettings.listProcs();
  } catch (err) {
    servicesResult = {
      procs: [],
      daemonUp: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  renderActive();
}

// Initial render (with the empty defaults), then load every data source.
renderActive();
void loadRepos();
void loadProcs();
void runPlugins(() => window.perchSettings.describePlugins());
