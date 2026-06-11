/**
 * Settings renderer. Runs in the sandboxed browser context with only the typed
 * `window.perchSettings` bridge (no Node/Electron). Renders a sectioned panel:
 *
 *   - **Stack Repositories** — the add / remove / make-default repo list (each
 *     action resolves to a refreshed {@link SettingsResult} we re-render from).
 *   - **Per-plugin settings** — one auto-generated section per plugin that
 *     declares a settings descriptor, rendered from `settings.describe` with a
 *     control per field by type (enum→select, boolean→checkbox, string→text,
 *     number→number). Changing a control writes back via `config.update` and
 *     re-reads the descriptors.
 *
 * No plugin-specific UI code lives here — every per-plugin section is driven by
 * the descriptor. Bundled to plain browser JS by esbuild.
 */
import type { PluginSettingsDescription, SettingsFieldState } from "@perch/core";
import type { RepoEntry } from "../repos.js";
import type { PluginSettingsResult, SettingsResult } from "../settings-ipc.js";
import { coerceFieldValue } from "../settings-fields.js";

const rowsEl = byId("rows");
const errorEl = byId("error");
const pluginsEl = byId("plugins");
const addBtn = byId("add") as HTMLButtonElement;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

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
    makeDefault.addEventListener("click", () =>
      run(() => window.perchSettings.setDefault(repo.path)),
    );
    actions.append(makeDefault);
  }

  const remove = document.createElement("button");
  remove.className = "btn btn-sm";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => run(() => window.perchSettings.removeRepo(repo.path)));
  actions.append(remove);

  el.append(actions);
  return el;
}

/** Apply a {@link SettingsResult} to the repositories section. */
function render(result: SettingsResult): void {
  rowsEl.replaceChildren();

  if (!result.daemonUp) {
    const msg = document.createElement("div");
    msg.className = "empty";
    msg.textContent = "Perch daemon is not running. Start it to manage repos.";
    rowsEl.append(msg);
  } else if (result.repos.length === 0) {
    const msg = document.createElement("div");
    msg.className = "empty";
    msg.textContent = "No repos configured yet. Add one to get started.";
    rowsEl.append(msg);
  } else {
    for (const repo of result.repos) rowsEl.append(repoRowEl(repo));
  }

  if (result.error) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }

  addBtn.disabled = false;
}

/**
 * Run an async bridge call with the buttons disabled, then render its result.
 * A rejected call (unexpected) surfaces as an inline error rather than a silent
 * dead button.
 */
async function run(call: () => Promise<SettingsResult>): Promise<void> {
  addBtn.disabled = true;
  try {
    render(await call());
  } catch (err) {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
    addBtn.disabled = false;
  }
}

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
  control.classList.add("field-control");

  // Checkbox reads better inline with its label; other controls stack above it.
  if (field.type === "boolean") {
    const inline = document.createElement("label");
    inline.className = "field-inline";
    inline.append(control, labelText);
    row.append(inline);
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
  }
}

/** Build one labeled section for a plugin and its fields. */
function pluginSectionEl(plugin: PluginSettingsDescription): HTMLElement {
  const section = document.createElement("section");
  section.className = "section";

  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = plugin.name;
  header.append(title);
  section.append(header);

  const rule = document.createElement("hr");
  rule.className = "rule";
  section.append(rule);

  if (plugin.fields.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No settings for this plugin.";
    section.append(empty);
  } else {
    const fields = document.createElement("div");
    fields.className = "fields";
    for (const field of plugin.fields) fields.append(fieldControlEl(plugin.pluginId, field));
    section.append(fields);
  }

  return section;
}

/** Apply a {@link PluginSettingsResult} to the per-plugin sections area. */
function renderPlugins(result: PluginSettingsResult): void {
  pluginsEl.replaceChildren();

  // Daemon-down is already surfaced by the repos section; show nothing here.
  if (!result.daemonUp) return;

  const withFields = result.plugins.filter((p) => p.fields.length > 0);
  if (withFields.length === 0) {
    if (result.error) {
      const msg = document.createElement("div");
      msg.className = "empty";
      msg.textContent = result.error;
      pluginsEl.append(msg);
    } else {
      const msg = document.createElement("div");
      msg.className = "empty muted-note";
      msg.textContent = "No plugin settings.";
      pluginsEl.append(msg);
    }
    return;
  }

  for (const plugin of withFields) pluginsEl.append(pluginSectionEl(plugin));

  if (result.error) {
    const msg = document.createElement("div");
    msg.className = "error";
    msg.textContent = result.error;
    pluginsEl.append(msg);
  }
}

/** Run an async per-plugin bridge call, then re-render the plugin sections. */
async function runPlugins(call: () => Promise<PluginSettingsResult>): Promise<void> {
  try {
    renderPlugins(await call());
  } catch (err) {
    pluginsEl.replaceChildren();
    const msg = document.createElement("div");
    msg.className = "error";
    msg.textContent = err instanceof Error ? err.message : String(err);
    pluginsEl.append(msg);
  }
}

// Load the current repo list + plugin descriptors on open.
void run(() => window.perchSettings.listRepos());
void runPlugins(() => window.perchSettings.describePlugins());

addBtn.addEventListener("click", () => run(() => window.perchSettings.addRepo()));
