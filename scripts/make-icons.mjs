// Generate the extension's icon set as PNGs, with no image dependency.
//
// A build that produces its own icons keeps the repository free of binary blobs nobody can review
// or reproduce, and makes a brand change a one-line edit rather than a round trip through a design
// tool. Run it with `node scripts/make-icons.mjs`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

/** Corsen AI's dark premium palette: a near-black ground with a single bright accent. */
const BACKGROUND = [16, 18, 24];
const ACCENT = [88, 166, 255];
const ACCENT_DIM = [58, 108, 168];

/** Sizes Chrome asks for. */
const SIZES = [16, 48, 128];

/**
 * Draw the mark: a rounded dark tile carrying a bracket-and-link glyph.
 *
 * The glyph reads as "a browser under instruction": a square frame for the tab and a horizontal
 * link through it. It is drawn from geometry so it stays crisp at 16 pixels, where an outline logo
 * would turn to mud.
 * @param {number} size The square edge length.
 * @returns {Uint8Array} RGBA pixels.
 */
function draw(size) {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.22;
  const stroke = Math.max(1, Math.round(size * 0.09));
  const inset = Math.round(size * 0.26);
  const frameTop = inset;
  const frameBottom = size - inset;
  const barY = Math.round(size / 2);

  /**
   * @param {number} x Column.
   * @param {number} y Row.
   * @param {number[]} colour RGB.
   * @param {number} alpha 0-255.
   */
  const put = (x, y, colour, alpha) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
    pixels[offset + 3] = alpha;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Rounded-corner mask: outside the corner arc the tile is transparent.
      const cx = Math.min(x + 0.5, size - x - 0.5);
      const cy = Math.min(y + 0.5, size - y - 0.5);
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      put(x, y, BACKGROUND, 255);
    }
  }

  // The two vertical brackets: the tab frame.
  for (let y = frameTop; y < frameBottom; y += 1) {
    for (let t = 0; t < stroke; t += 1) {
      put(inset + t, y, ACCENT, 255);
      put(size - inset - 1 - t, y, ACCENT_DIM, 255);
    }
  }
  // The horizontal link through the frame: the session driving it.
  for (let x = Math.round(size * 0.14); x < size - Math.round(size * 0.14); x += 1) {
    for (let t = 0; t < stroke; t += 1) {
      put(x, barY - Math.floor(stroke / 2) + t, ACCENT, 255);
    }
  }
  return pixels;
}

const target = join(dirname(dirname(fileURLToPath(import.meta.url))), "extension", "assets");
mkdirSync(target, { recursive: true });
for (const size of SIZES) {
  const file = join(target, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, size, draw(size)));
  process.stdout.write(`wrote ${file}\n`);
}
