/**
 * Unit tests for the shared dex-task identity colors: determinism (same id →
 * same color), totality (every string maps, including edge cases), the hex/rgb
 * adapters agreeing, and a visible spread of distinct colors across sample ids.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEX_TASK_PALETTE, dexTaskColor, dexTaskColorCss, dexTaskColorRgb } from "./dex-color.js";

const HEX = /^#[0-9a-f]{6}$/;

test("dexTaskColor: deterministic — same id yields the same color", () => {
  for (const id of ["8ovqrfk8", "rlzkjoz5", "", "a"]) {
    const first = dexTaskColor(id);
    assert.deepEqual(dexTaskColor(id), first);
    // Stable across many calls, not just two.
    for (let i = 0; i < 50; i++) assert.deepEqual(dexTaskColor(id), first);
  }
});

test("dexTaskColor: total — arbitrary strings map to a valid palette color", () => {
  const ids = [
    "", // empty
    "x", // single char
    "8ovqrfk8",
    "a-very-long-id-".repeat(50),
    "unicode-🎨-é-中", // non-ASCII
    "  spaces  ",
    "\n\t",
  ];
  for (const id of ids) {
    const color = dexTaskColor(id);
    assert.ok(
      color.index >= 0 && color.index < DEX_TASK_PALETTE.length,
      `index in range for ${JSON.stringify(id)}`,
    );
    assert.equal(color.hex, DEX_TASK_PALETTE[color.index]);
    assert.match(color.hex, HEX);
    for (const ch of [color.rgb.r, color.rgb.g, color.rgb.b]) {
      assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255, `channel ${ch} in 0–255`);
    }
  }
});

test("dexTaskColor: hex and rgb agree (rgb is the parsed hex)", () => {
  for (const id of ["8ovqrfk8", "rlzkjoz5", "2b7x2x9r", ""]) {
    const { hex, rgb } = dexTaskColor(id);
    const toHex = (n: number) => n.toString(16).padStart(2, "0");
    assert.equal(`#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`, hex);
  }
});

test("adapters: css is the hex, rgb is the rgb", () => {
  for (const id of ["8ovqrfk8", "foo", ""]) {
    const color = dexTaskColor(id);
    assert.equal(dexTaskColorCss(id), color.hex);
    assert.deepEqual(dexTaskColorRgb(id), color.rgb);
  }
});

test("palette: entries are well-formed and all distinct", () => {
  // Materially larger than the original Tableau 10 so concurrent tasks rarely
  // collide (>= ~20 hues halves the per-pair collision probability).
  assert.ok(DEX_TASK_PALETTE.length >= 20, "enough hues to spread tasks across");
  for (const hex of DEX_TASK_PALETTE) assert.match(hex, HEX);
  assert.equal(new Set(DEX_TASK_PALETTE).size, DEX_TASK_PALETTE.length, "no duplicate hues");
});

// WCAG relative luminance (0 = black, 1 = white) of a `#rrggbb` color.
const luminance = (hex: string) => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
// WCAG contrast ratio (1 = none, 21 = black-on-white) between two luminances.
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
// The renderer's two theme backgrounds (renderer.css `--bg`): light then dark.
const LIGHT_BG = luminance("#f5f5f5");
const DARK_BG = luminance("#1e1e1e");
// Achromatic = the four neutrals (white + grays); chroma measured as channel spread.
const isNeutral = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16;
};

test("palette: chromatic hues stay in the mid-tone band, neutrals stay legible", () => {
  // Two-tier legibility guarantee, matching how the GUI renders the identity dot
  // and chip (renderer.css):
  //
  //  • The twenty chromatic hues carry their own legibility: each stays in a
  //    mid-tone luminance band so it never washes out on the light theme nor
  //    disappears on the dark one. (The legacy light pink #ff9da7 is the most
  //    extreme inherited entry, so the band is wide enough to include it.)
  //
  //  • The four neutrals (white + grays) deliberately break that band — that's
  //    the point of adding them. They lean on the rendering instead: the dot's
  //    theme-aware contrast ring and the chip tint layered over its own
  //    background keep them visible on the theme where their fill is weak. We
  //    can't unit-test that CSS, but we CAN assert the precondition it relies
  //    on: a neutral must contrast strongly (>= 3:1) against at LEAST one of the
  //    two theme backgrounds, so the ring only ever has to rescue the other
  //    side — never a color that vanishes into both.
  for (const hex of DEX_TASK_PALETTE) {
    const lum = luminance(hex);
    if (isNeutral(hex)) {
      const best = Math.max(contrast(lum, LIGHT_BG), contrast(lum, DARK_BG));
      assert.ok(best >= 3, `neutral ${hex} contrasts a theme bg (best ratio ${best.toFixed(2)})`);
    } else {
      assert.ok(
        lum >= 0.1 && lum <= 0.65,
        `chromatic ${hex} luminance ${lum.toFixed(3)} in mid band`,
      );
    }
  }
});

test("palette: the four neutrals (white + three grays) are present", () => {
  // The neutral spread the identity palette is meant to include, distinct from
  // the inherited warm gray (#bab0ac) and from each other.
  for (const hex of ["#ffffff", "#8a8a8a", "#555555", "#333333"]) {
    assert.ok(
      DEX_TASK_PALETTE.includes(hex as (typeof DEX_TASK_PALETTE)[number]),
      `palette includes ${hex}`,
    );
    assert.ok(isNeutral(hex), `${hex} is achromatic`);
  }
});

test("dexTaskColor: a handful of sample ids spread across multiple colors", () => {
  // Real-looking dex ids should not all collide onto one color — sanity-check
  // that the hash actually scatters them so rows are visibly distinguishable.
  const sampleIds = [
    "8ovqrfk8",
    "rlzkjoz5",
    "2b7x2x9r",
    "sekzxyx3",
    "abc12345",
    "zzzzzzzz",
    "task-001",
    "task-002",
  ];
  const colors = new Set(sampleIds.map((id) => dexTaskColor(id).hex));
  assert.ok(colors.size >= 4, `expected a spread of colors, got ${colors.size}`);
});
