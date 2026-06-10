/**
 * Duration parsing for refresh policies.
 *
 * Supports the compact forms used in `RefreshPolicy.every`, e.g. `"60s"`,
 * `"5m"`, `"2h"`, `"500ms"`. Returns milliseconds.
 */

const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
} as const;

type Unit = keyof typeof UNIT_MS;

/**
 * Parse a duration string like `"60s"` or `"5m"` into milliseconds.
 *
 * @throws if the string is not a positive number followed by a known unit
 *   (`ms`, `s`, `m`, `h`).
 */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `perchd: invalid duration ${JSON.stringify(value)} (expected e.g. "60s", "5m")`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as Unit;
  const ms = amount * UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`perchd: invalid duration ${JSON.stringify(value)} (must be > 0)`);
  }
  return ms;
}
