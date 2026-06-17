/**
 * Shared dex-task identity colors — a stable, deterministic id → color mapping,
 * used by every surface that wants to give a dex task a recognizable identity
 * accent: the GUI tints a task's id chip with it; the worktrees board tints a
 * linked worktree; the terminal launcher feeds it (as RGB) to iTerm2's tab-color
 * escape (OSC 6) so an agent's window tab matches its task. Lives in the SDK so
 * all three author against ONE mapping — same id, same color, everywhere.
 *
 * The mapping is a stable string hash of the id indexed into a curated,
 * color-blind-friendly palette (Tableau 10): well-separated mid-tone hues that
 * stay legible as an accent on BOTH the light and dark themes. Hashing into a
 * bounded palette (rather than hash → hue) trades a small chance of collision
 * for guaranteed-distinct, vetted colors — two tasks may share a color, but no
 * task ever gets an illegible or muddy one. Pure + total over arbitrary ids
 * (including ""), so callers never have to guard the input.
 *
 * This module is deliberately dependency-free (no node built-ins) so the browser
 * renderer can import it via the `@perch/sdk/dex-color` subpath without pulling
 * the node-only bits of the SDK into its bundle.
 */

/** An RGB color, channels in 0–255. */
export interface DexRgb {
  r: number;
  g: number;
  b: number;
}

/** A dex task's resolved identity color in the forms its consumers need. */
export interface DexTaskColor {
  /** Index into {@link DEX_TASK_PALETTE} (stable for the id). */
  index: number;
  /** Lowercase 6-digit hex, also a valid CSS color (e.g. `"#4e79a7"`). */
  hex: string;
  /** The same color as 0–255 RGB channels. */
  rgb: DexRgb;
}

/**
 * The curated identity palette: Tableau 10. Ten categorical hues chosen to be
 * mutually distinguishable (including for the common red-green color
 * deficiencies) and mid-toned enough to read as an accent on either theme.
 * Order is load-bearing only in that the hash indexes into it; the entries are
 * already well-separated, so neighbors differ clearly.
 */
export const DEX_TASK_PALETTE = [
  "#4e79a7", // blue
  "#f28e2b", // orange
  "#e15759", // red
  "#76b7b2", // teal
  "#59a14f", // green
  "#edc948", // gold
  "#b07aa1", // purple
  "#ff9da7", // pink
  "#9c755f", // brown
  "#bab0ac", // gray
] as const;

/**
 * FNV-1a (32-bit) hash of `id`, returned as an unsigned int. A small, fast,
 * well-distributed string hash with no dependencies — all we need to scatter
 * ids across the palette. `Math.imul` keeps the multiply in 32-bit; `>>> 0`
 * yields the unsigned result. Total: any string (including "") hashes.
 */
function hashId(id: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0;
}

/** Parse a `#rrggbb` palette entry into 0–255 channels. */
function hexToRgb(hex: string): DexRgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/**
 * Resolve a dex task id to its stable identity color. Deterministic and total:
 * the same id always yields the same color, and every string (including "")
 * yields a valid palette color. This is the one source of truth — adapters
 * ({@link dexTaskColorCss}, {@link dexTaskColorRgb}) are thin views over it.
 */
export function dexTaskColor(id: string): DexTaskColor {
  const index = hashId(id) % DEX_TASK_PALETTE.length;
  // The modulo keeps `index` in range, so the entry always exists; the `??`
  // satisfies `noUncheckedIndexedAccess` without an assertion.
  const hex = DEX_TASK_PALETTE[index] ?? DEX_TASK_PALETTE[0];
  return { index, hex, rgb: hexToRgb(hex) };
}

/**
 * GUI adapter: the task's color as a CSS color string (the palette hex). Use it
 * directly as a `color` / `border-color`, or pair it with {@link dexTaskColorRgb}
 * for an `rgba(...)` tint fill.
 */
export function dexTaskColorCss(id: string): string {
  return dexTaskColor(id).hex;
}

/**
 * RGB adapter: the task's color as 0–255 channels. The form the terminal
 * launcher feeds to iTerm2's OSC 6 tab-color escape, which takes 0–255 channels
 * directly (no scaling).
 */
export function dexTaskColorRgb(id: string): DexRgb {
  return dexTaskColor(id).rgb;
}
