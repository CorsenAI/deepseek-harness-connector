/**
 * Reading a JPEG's own dimensions, so a reported size is checked against the bytes rather than
 * trusted.
 * @module
 */

import assert from 'node:assert/strict'

/**
 * Read a JPEG's dimensions from its start-of-frame marker.
 * @param bytes - the file.
 * @returns width and height.
 */
export function jpegDimensions(bytes: Buffer): { width: number, height: number } {
  assert.equal(bytes[0], 0xff)
  assert.equal(bytes[1], 0xd8, 'not a JPEG')
  let offset = 2
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 0xff, `marker expected at ${offset}`)
    const marker = bytes[offset + 1] as number
    const length = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  throw new Error('no start-of-frame marker')
}
