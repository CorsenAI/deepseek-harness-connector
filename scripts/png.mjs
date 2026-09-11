// A PNG codec small enough to audit, with no image dependency.
//
// The icon generator needs to write PNGs and the Store screenshot script needs to read the ones
// Chrome produces and write composites. Both are plain 8-bit RGBA, non-interlaced files, which is
// all this module handles; anything else is refused rather than misread.

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
 * @param {number} width The width in pixels.
 * @param {number} height The height in pixels.
 * @param {Uint8Array} pixels `width * height * 4` bytes, row-major RGBA.
 * @returns {Buffer} The PNG file.
 */
export function encodePng(width, height, pixels) {
  if (pixels.length !== width * height * 4) throw new Error(`expected ${width * height * 4} RGBA bytes, got ${pixels.length}`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Compression, filter, and interlace methods each have exactly one valid value here.

  // Each scanline is prefixed with its filter type; 0 means "no filtering", which compresses
  // perfectly well for flat artwork and keeps this encoder simple enough to audit.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, target + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Paeth predictor, as the PNG specification defines it.
 * @param {number} a The byte to the left.
 * @param {number} b The byte above.
 * @param {number} c The byte above-left.
 * @returns {number} The prediction.
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels.
 * @param {Buffer} file The PNG file.
 * @returns {{width: number, height: number, pixels: Uint8Array}} The image.
 * @throws When the file is not a PNG this module handles.
 */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const data = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error(`unsupported bit depth ${body[8]}`);
      colourType = body[9];
      if (colourType !== 6 && colourType !== 2) throw new Error(`unsupported colour type ${colourType}`);
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length !== height * (stride + 1)) throw new Error("PNG image data has the wrong length");

  const unfiltered = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = unfiltered.subarray(y * stride, (y + 1) * stride);
    const above = y === 0 ? null : unfiltered.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= channels ? above[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported filter type ${filter}`);
      out[x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, pixels: new Uint8Array(unfiltered) };
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = unfiltered[index * 3];
    pixels[index * 4 + 1] = unfiltered[index * 3 + 1];
    pixels[index * 4 + 2] = unfiltered[index * 3 + 2];
    pixels[index * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

/**
 * Paste one image into another, clipping at the target's edges.
 * @param {{width: number, height: number, pixels: Uint8Array}} target The canvas.
 * @param {{width: number, height: number, pixels: Uint8Array}} source The image to paste.
 * @param {number} atX The left edge in the target.
 * @param {number} atY The top edge in the target.
 */
export function paste(target, source, atX, atY) {
  for (let y = 0; y < source.height; y += 1) {
    const ty = atY + y;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < source.width; x += 1) {
      const tx = atX + x;
      if (tx < 0 || tx >= target.width) continue;
      const from = (y * source.width + x) * 4;
      const to = (ty * target.width + tx) * 4;
      target.pixels[to] = source.pixels[from];
      target.pixels[to + 1] = source.pixels[from + 1];
      target.pixels[to + 2] = source.pixels[from + 2];
      target.pixels[to + 3] = source.pixels[from + 3];
    }
  }
}

/**
 * A canvas filled with one colour.
 * @param {number} width The width.
 * @param {number} height The height.
 * @param {[number, number, number]} rgb The fill.
 * @returns {{width: number, height: number, pixels: Uint8Array}} The image.
 */
export function canvas(width, height, rgb) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = rgb[0];
    pixels[index * 4 + 1] = rgb[1];
    pixels[index * 4 + 2] = rgb[2];
    pixels[index * 4 + 3] = 255;
  }
  return { width, height, pixels };
}
