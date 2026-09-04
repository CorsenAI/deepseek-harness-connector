// Generate the extension's icon set as PNGs, with no image dependency.
//
// A build that produces its own icons keeps the repository free of binary blobs nobody can review
// or reproduce, and makes a brand change a one-line edit rather than a round trip through a design
// tool. Run it with `node scripts/make-icons.mjs`.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Corsen AI's dark premium palette: a near-black ground with a single bright accent. */
const BACKGROUND = [16, 18, 24];
const ACCENT = [88, 166, 255];
const ACCENT_DIM = [58, 108, 168];

/** Sizes Chrome asks for. */
const SIZES = [16, 48, 128];

/**
 * CRC-32, as PNG chunks require.
 * @param {Uint8Array} bytes The chunk type and data.
 * @returns {number} The checksum.
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build one PNG chunk.
 * @param {string} type The four-character chunk type.
 * @param {Buffer} data The chunk payload.
 * @returns {Buffer} The complete chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Encode RGBA pixels as a PNG.
 * @param {number} size The square edge length.
 * @param {Uint8Array} pixels `size * size * 4` bytes, row-major RGBA.
 * @returns {Buffer} The PNG file.
 */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Compression, filter, and interlace methods each have exactly one valid value here.

  // Each scanline is prefixed with its filter type; 0 means "no filtering", which compresses
  // perfectly well for flat artwork and keeps this encoder simple enough to audit.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const target = y * (size * 4 + 1);
    raw[target] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(raw, target + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
  writeFileSync(file, encodePng(size, draw(size)));
  process.stdout.write(`wrote ${file}\n`);
}
