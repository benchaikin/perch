/**
 * The managed-process management block, rendered on the Services tab above the
 * services plugin's descriptor fields. Lists the configured processes with a
 * per-row Remove action and an "Add Service" button that opens a modal dialog
 * (name + command + optional cwd); every action resolves to a refreshed
 * {@link ServicesResult} the store re-renders from. Controls are disabled while
 * a services bridge call is in flight (`servicesBusy`); the add form's draft is
 * preserved while the dialog is open.
 */
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
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

/** Modal dialog for adding a new service. */
function AddServiceDialog({
  busy,
  error,
  draft,
  setDraft,
  onAdd,
  onClose,
}: {
  busy: boolean;
  error: string | undefined;
  draft: typeof EMPTY_DRAFT;
  setDraft: Dispatch<SetStateAction<typeof EMPTY_DRAFT>>;
  onAdd: () => void;
  onClose: () => void;
}) {
  // Esc closes the dialog unless busy.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return (
    // Backdrop dims the surface and closes on outside click (unless busy).
    <div
      className="svc-dialog-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      {/* Clicks inside must not reach the backdrop. */}
      <div
        className="svc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="svc-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="svc-dialog-header-row">
          <div id="svc-dialog-title" className="svc-dialog-header">
            Add Service
          </div>
          <button
            className="svc-dialog-close"
            disabled={busy}
            title="Close (Esc)"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
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
        {error && <div className="error">{error}</div>}
        <footer className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={onAdd}
          >
            Create
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The Services section (list + Add Service button that opens a modal). */
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
  const [dialogOpen, setDialogOpen] = useState(false);

  const onAdd = async () => {
    const proc: Proc = {
      name: draft.name,
      command: draft.command,
      ...(draft.cwd.trim() ? { cwd: draft.cwd } : {}),
    };
    await store.runServices((b) => b.addProc(proc));
    // On a clean add: close the dialog and reset the draft.
    if (!store.getSnapshot().services.error) {
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
    }
    // On error: keep the dialog open with the draft intact so the user can fix and retry.
  };

  const onClose = () => {
    setDialogOpen(false);
    setDraft(EMPTY_DRAFT);
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
      {services.error && !dialogOpen && <div className="error">{services.error}</div>}
      <footer className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !services.daemonUp}
          onClick={() => setDialogOpen(true)}
        >
          Add Service
        </button>
      </footer>
      {dialogOpen && (
        <AddServiceDialog
          busy={busy}
          error={services.error}
          draft={draft}
          setDraft={setDraft}
          onAdd={() => void onAdd()}
          onClose={onClose}
        />
      )}
    </section>
  );
}
