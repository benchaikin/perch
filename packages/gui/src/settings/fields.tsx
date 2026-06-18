/**
 * Descriptor-driven field controls for the Settings window. Each control is
 * chosen by the field's `type` (enum→select, boolean→checkbox, string→text,
 * number→number, list→an editable stack of removable rows + an add row) and is
 * seeded from the field's current `value`. Changing a control hands the raw value
 * to `onPersist`, which coerces it and writes back via the bridge — exactly as
 * the old vanilla renderer did, just expressed as React.
 *
 * Scalar text/number controls commit on blur (mirroring the old `change`-event
 * semantics) so a re-describe doesn't fire on every keystroke; select/checkbox
 * commit immediately. List edits persist the WHOLE array, so add/remove/edit all
 * flow back through the bridge's re-describe rather than mutating local state.
 */
import { useEffect, useState } from "react";
import type { PluginSettingsDescription, SettingsFieldState } from "@perch/core";
import { visibleFields } from "./settings-tabs.js";

/** Persist one field's raw control value (the shell coerces + writes it back). */
type PersistField = (field: SettingsFieldState, raw: unknown) => void;

/** Read a field's current value as a `string[]` (empty when unset/non-array). */
function listValue(field: SettingsFieldState): string[] {
  return Array.isArray(field.value) ? field.value.map((entry) => String(entry)) : [];
}

/** Read a field's current value as a display string (empty when null/undefined). */
function scalarValue(field: SettingsFieldState): string {
  return field.value != null ? String(field.value) : "";
}

/** A text/number input that commits on blur, re-seeding when the value changes. */
function ScalarInput({
  field,
  type,
  onPersist,
}: {
  field: SettingsFieldState;
  type: "text" | "number";
  onPersist: PersistField;
}) {
  const [draft, setDraft] = useState(scalarValue(field));
  // A persisted edit re-describes the field; re-seed the draft from the fresh value.
  useEffect(() => setDraft(scalarValue(field)), [field.value]);
  return (
    <input
      className="field-control"
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onPersist(field, draft)}
    />
  );
}

/** The control for a single scalar field (enum/boolean/number/string). */
function ScalarControl({
  field,
  onPersist,
}: {
  field: SettingsFieldState;
  onPersist: PersistField;
}) {
  switch (field.type) {
    case "enum":
      return (
        <select
          className="field-control"
          value={scalarValue(field)}
          onChange={(e) => onPersist(field, e.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "boolean":
      return (
        <input
          className="field-control"
          type="checkbox"
          checked={field.value === true}
          onChange={(e) => onPersist(field, e.target.checked)}
        />
      );
    case "number":
      return <ScalarInput field={field} type="number" onPersist={onPersist} />;
    case "string":
      return <ScalarInput field={field} type="text" onPersist={onPersist} />;
    case "list":
      // Unreachable — list fields render via ListControl; satisfies the switch.
      return null;
  }
}

/**
 * The control for a `list` field: one removable row per current entry plus an
 * add-row input. Every edit persists the WHOLE array (the shell coerces + writes
 * it), which re-describes + re-renders — so add/remove/edit flow back through the
 * bridge rather than mutating local state. The add input commits on Enter or the
 * Add button; a blank value is a no-op.
 */
function ListControl({
  field,
  onPersist,
}: {
  field: SettingsFieldState;
  onPersist: PersistField;
}) {
  const entries = listValue(field);
  const [draft, setDraft] = useState("");

  const commitAdd = () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    onPersist(field, [...entries, value]);
  };

  return (
    <div className="list-field">
      <div className="list-rows">
        {entries.map((entry, index) => (
          <ListRow
            // The value+index keys the row to its slot so a re-describe re-seeds it.
            key={`${index}:${entry}`}
            entry={entry}
            onCommit={(next) => {
              const updated = entries.slice();
              updated[index] = next;
              onPersist(field, updated);
            }}
            onRemove={() => {
              const updated = entries.slice();
              updated.splice(index, 1);
              onPersist(field, updated);
            }}
          />
        ))}
      </div>
      <div className="list-row">
        <input
          className="field-control list-row-input"
          type="text"
          placeholder="Add…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitAdd();
            }
          }}
        />
        <button type="button" className="btn btn-sm" onClick={commitAdd}>
          Add
        </button>
      </div>
    </div>
  );
}

/** One editable list row: a text input (commits on blur) + a Remove button. */
function ListRow({
  entry,
  onCommit,
  onRemove,
}: {
  entry: string;
  onCommit: (next: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(entry);
  return (
    <div className="list-row">
      <input
        className="field-control list-row-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== entry) onCommit(draft);
        }}
      />
      <button type="button" className="btn btn-sm" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** One labeled field row: label + its type's control + an optional description. */
function FieldControl({
  field,
  onPersist,
}: {
  field: SettingsFieldState;
  onPersist: PersistField;
}) {
  const label = <div className="field-label">{field.label}</div>;
  const desc = field.description ? <div className="field-desc">{field.description}</div> : null;

  // Checkbox reads better inline with its label; a list is its own multi-input
  // block (a heading div, not a wrapping label); other controls stack above it.
  if (field.type === "boolean") {
    return (
      <div className="field">
        <label className="field-inline">
          <ScalarControl field={field} onPersist={onPersist} />
          {label}
        </label>
        {desc}
      </div>
    );
  }
  if (field.type === "list") {
    return (
      <div className="field">
        {label}
        <ListControl field={field} onPersist={onPersist} />
        {desc}
      </div>
    );
  }
  return (
    <div className="field">
      <label className="field-stacked">
        {label}
        <ScalarControl field={field} onPersist={onPersist} />
      </label>
      {desc}
    </div>
  );
}

/**
 * The descriptor-driven fields block for a plugin: a header + one control per
 * currently-visible field (a field's `showWhen` rule is applied via
 * {@link visibleFields}, so dependent controls appear only when relevant).
 */
export function PluginFields({
  plugin,
  heading,
  onPersist,
}: {
  plugin: PluginSettingsDescription;
  heading: string;
  onPersist: (pluginId: string, field: SettingsFieldState, raw: unknown) => void;
}) {
  const shown = visibleFields(plugin.fields);
  return (
    <section className="section">
      <header className="header">
        <span className="title">{heading}</span>
      </header>
      <hr className="rule" />
      {shown.length === 0 ? (
        <div className="empty">No settings for this plugin.</div>
      ) : (
        <div className="fields">
          {shown.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              onPersist={(f, raw) => onPersist(plugin.pluginId, f, raw)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
