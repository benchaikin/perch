/**
 * The Repositories management block, rendered on the Pull Requests tab above the
 * stack plugin's descriptor fields. Lists the configured repos with per-row
 * make-default / remove actions and an "Add repo…" button; every action resolves
 * to a refreshed {@link SettingsResult} the store re-renders from. Controls are
 * disabled while a repos bridge call is in flight (`reposBusy`).
 */
import type { RepoEntry } from "../repos.js";
import type { SettingsResult } from "../settings-ipc.js";
import type { SettingsStore } from "./settings-store.js";

/** Build one repo row: name (+ default tag), path, and per-row actions. */
function RepoRow({
  repo,
  busy,
  store,
}: {
  repo: RepoEntry;
  busy: boolean;
  store: SettingsStore;
}) {
  return (
    <div className="repo">
      <div className="repo-info">
        <div className="repo-name">
          <span>{repo.name}</span>
          {repo.isDefault && <span className="default-tag">default</span>}
        </div>
        <div className="repo-path" title={repo.path}>
          {repo.path}
        </div>
      </div>
      <div className="repo-actions">
        {!repo.isDefault && (
          <button
            type="button"
            className="btn btn-sm"
            title="Move this repo to the front (the stack default)"
            disabled={busy}
            onClick={() => void store.runRepos((b) => b.setDefault(repo.path))}
          >
            Make default
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void store.runRepos((b) => b.removeRepo(repo.path))}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** The Repositories section (list + inline error + add button). */
export function RepositoriesSection({
  repos,
  busy,
  store,
}: {
  repos: SettingsResult;
  busy: boolean;
  store: SettingsStore;
}) {
  return (
    <section className="section">
      <header className="header">
        <span className="title">Repositories</span>
        <span className="subtitle">The first repo is the default.</span>
      </header>
      <hr className="rule" />
      <div className="rows">
        {!repos.daemonUp ? (
          <div className="empty">Perch daemon is not running. Start it to manage repos.</div>
        ) : repos.repos.length === 0 ? (
          <div className="empty">No repos configured yet. Add one to get started.</div>
        ) : (
          repos.repos.map((repo) => (
            <RepoRow key={repo.path} repo={repo} busy={busy} store={store} />
          ))
        )}
      </div>
      {repos.error && <div className="error">{repos.error}</div>}
      <footer className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void store.runRepos((b) => b.addRepo())}
        >
          Add repo…
        </button>
      </footer>
    </section>
  );
}
