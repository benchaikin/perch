/**
 * Settings renderer. Runs in the sandboxed browser context with only the typed
 * `window.perchSettings` bridge (no Node/Electron). Renders the configured
 * stack repos and wires the Add / Remove / Make-default controls; each action
 * resolves to a refreshed {@link SettingsResult} that we re-render from.
 * Bundled to plain browser JS by esbuild.
 */
import type { RepoEntry } from "../repos.js";
import type { SettingsResult } from "../settings-ipc.js";

const rowsEl = byId("rows");
const errorEl = byId("error");
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

/** Apply a {@link SettingsResult} to the DOM. */
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

addBtn.addEventListener("click", () => run(() => window.perchSettings.addRepo()));

// Load the current list on open.
void run(() => window.perchSettings.listRepos());
