/**
 * Human-readable rendering of capability results for the non-`--json` path.
 *
 * Aims for a simple, readable view rather than a full table engine:
 * - primitives print as-is;
 * - an array of flat objects prints as an aligned table;
 * - everything else prints as indented JSON.
 */

/** Render an arbitrary capability result as a readable string. */
export function renderResult(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    if (value.every(isFlatRecord)) return renderTable(value as Record<string, unknown>[]);
  }

  return JSON.stringify(value, null, 2);
}

/** A plain object whose values are all primitives (table-friendly). */
function isFlatRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || typeof x !== "object");
}

/** Render an array of flat records as an aligned, column-headed table. */
function renderTable(rows: Record<string, unknown>[]): string {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const cell = (v: unknown): string => (v === undefined ? "" : String(v));
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cell(row[col]).length)),
  );

  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  const header = line(columns);
  const sep = line(widths.map((w) => "-".repeat(w)));
  const body = rows.map((row) => line(columns.map((col) => cell(row[col]))));
  return [header, sep, ...body].join("\n");
}
