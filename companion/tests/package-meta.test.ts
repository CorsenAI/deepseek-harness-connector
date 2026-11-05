/**
 * The display metadata DeepSeek Harness reads from the package without running it.
 *
 * DeepSeek Harness 0.2 shows an installed plugin — in the Plugins page of its Web and Desktop
 * clients, and in the cards of a plugin index — by the `meta.title` and `meta.description` of its
 * exported `locale/<language>.json` files, falling back to the package name, and by the image its
 * `package.json` `icon` names (SVG, PNG, JPEG or WebP, at most 256 KiB, inside the package). These
 * cases hold the package to those rules; the released-pair suite has DeepSeek Harness's own reader
 * read the installed package.
 * @module
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, it } from 'node:test'

const PACKAGE = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE), 'utf8')) as {
  icon?: string
  exports: Record<string, unknown>
  files: string[]
}

describe('the package’s display metadata for DeepSeek Harness', () => {
  it('exports its locale files, as DeepSeek Harness resolves them through the package exports', () => {
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
    assert.ok(manifest.files.includes('locale/*.json'), 'the locale files must be published')
  })

  it('has an English title and description, and every language file is named by a language id and complete', () => {
    const files = readdirSync(new URL('locale/', PACKAGE)).filter((name) => name.endsWith('.json'))
    assert.ok(files.includes('en.json'), 'English is the fallback every other language needs')
    for (const name of files) {
      assert.match(name.slice(0, -5), /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, `${name} must be named by a language id`)
      const parsed = JSON.parse(readFileSync(new URL(`locale/${name}`, PACKAGE), 'utf8')) as { meta?: { title?: unknown, description?: unknown } }
      for (const field of ['title', 'description'] as const) {
        const value = parsed.meta?.[field]
        assert.ok(typeof value === 'string' && value.trim() !== '', `${name}: meta.${field} must be a non-empty string`)
      }
      // An unofficial community project says so wherever it describes itself.
      assert.match(String(parsed.meta?.description), /Corsen AI/, `${name}: the description must say who publishes it`)
      assert.match(String(parsed.meta?.description), /\bUnofficial\b|\bNon officiel\b/, `${name}: the description must say it is unofficial`)
    }
  })

  it('names a PNG icon inside the package, under 256 KiB, the same picture as the extension’s', () => {
    assert.equal(manifest.icon, './icon.png')
    assert.ok(manifest.files.includes('icon.png'), 'the icon must be published')
    const icon = readFileSync(new URL('icon.png', PACKAGE))
    assert.ok(statSync(new URL('icon.png', PACKAGE)).size <= 256 * 1024)
    assert.deepEqual([...icon.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG signature')
    assert.ok(icon.equals(readFileSync(new URL('../../extension/assets/icon-128.png', import.meta.url))), 'one picture for the extension and the package')
  })
})
