/**
 * The managed-process management block, rendered on the Services tab above the
 * services plugin's descriptor fields. Lists the configured processes with a
 * per-row Remove action and an add form (name + command + optional cwd); every
 * action resolves to a refreshed {@link ServicesResult} the store re-renders
 * from. Controls are disabled while a services bridge call is in flight
 * (`servicesBusy`); the add form's draft is preserved across re-renders.
 */
import { useState } from "react";
import type { Proc } from "../procs.js";
import type { ServicesResult } from "../settings-ipc.js";
import type { SettingsStore } from "./settings-store.js";

/** Build one proc row: name, command (titled), optional cwd, and Remove. */
function ProcRow({
  proc,
  busy,
  store,
}: {
  proc: Proc;
  busy: boolean;
  store: SettingsStore;
}) {
  return (
    <div className="repo">
      <div className="repo-info">
        <div className="repo-name">
          <span>{proc.name}</span>
        </div>
        <div className="repo-path" title={proc.command}>
          {proc.command}
        </div>
        {proc.cwd && (
          <div className="repo-path" title={proc.cwd}>
            {proc.cwd}
          </div>
        )}
      </div>
      <div className="repo-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void store.runServices((b) => b.removeProc(proc.name))}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** A labeled text input for the add-service form. */
function ProcInput({
  label,
  placeholder,
  value,
  busy,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field-stacked">
      <div className="field-label">{label}</div>
      <input
        className="field-control"
        type="text"
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The empty add-service draft. */
const EMPTY_DRAFT = { name: "", command: "", cwd: "" };

/** The Services section (list + inline error + add form). */
export function ServicesSection({
  services,
  busy,
  store,
}: {
  services: ServicesResult;
  busy: boolean;
  store: SettingsStore;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const onAdd = async () => {
    const proc: Proc = {
      name: draft.name,
      command: draft.command,
      ...(draft.cwd.trim() ? { cwd: draft.cwd } : {}),
    };
    await store.runServices((b) => b.addProc(proc));
    // Clear the draft only on a clean add (no validation/RPC error).
    if (!store.getSnapshot().services.error) setDraft(EMPTY_DRAFT);
  };

  return (
    <section className="section">
      <header className="header">
        <span className="title">Services</span>
        <span className="subtitle">Processes Perch runs and supervises.</span>
      </header>
      <hr className="rule" />
      <div className="rows">
        {!services.daemonUp ? (
          <div className="empty">Perch daemon is not running. Start it to manage services.</div>
        ) : services.procs.length === 0 ? (
          <div className="empty">No services configured — add one to run it.</div>
        ) : (
          services.procs.map((proc) => (
            <ProcRow key={proc.name} proc={proc} busy={busy} store={store} />
          ))
        )}
      </div>
      {services.error && <div className="error">{services.error}</div>}
      <div className="fields">
        <ProcInput
          label="Name"
          placeholder="web"
          value={draft.name}
          busy={busy}
          onChange={(name) => setDraft((d) => ({ ...d, name }))}
        />
        <ProcInput
          label="Command"
          placeholder="npm run dev"
          value={draft.command}
          busy={busy}
          onChange={(command) => setDraft((d) => ({ ...d, command }))}
        />
        <ProcInput
          label="Working directory (optional)"
          placeholder="/path/to/dir"
          value={draft.cwd}
          busy={busy}
          onChange={(cwd) => setDraft((d) => ({ ...d, cwd }))}
        />
      </div>
      <footer className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !services.daemonUp}
          onClick={() => void onAdd()}
        >
          Add service
        </button>
      </footer>
    </section>
  );
}
