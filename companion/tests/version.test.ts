/**
 * How a DeepSeek Harness runtime is classified against what has actually been tested.
 *
 * An external review of 2026-09-05 ran the version adapter and found `999.0.0` reported as
 * supported: the declared range had a floor and no ceiling, so every future release counted as
 * tested. Nothing covered this module, which is why the hole survived. It is covered now, and the
 * three states it must keep apart are asserted one by one: a version with a passing compatibility
 * row, one newer than anything tested, and one the connector refuses.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { classifyDshVersion, DSH_ENGINES_RANGE, SUPPORTED_DSH, supportedRangeText } from '../src/dsh/version.ts'

describe('classifying a DeepSeek Harness runtime', () => {
  it('calls the tested versions tested', () => {
    assert.equal(classifyDshVersion(SUPPORTED_DSH.minimum).status, 'tested')
    assert.equal(classifyDshVersion(SUPPORTED_DSH.maximumTested).status, 'tested')
    assert.equal(classifyDshVersion(SUPPORTED_DSH.minimum).reason, null)
  })

  it('refuses anything older than the minimum', () => {
    for (const older of ['0.1.1', '0.1.2-rc.0', '0.0.1-rc.9', '0.0.0']) {
      const verdict = classifyDshVersion(older)
      assert.equal(verdict.status, 'incompatible', `${older} must be refused`)
      assert.match(String(verdict.reason), /older than/)
    }
  })

  it('refuses a far-future version instead of calling it supported', () => {
    // The exact case the review ran. A connector that claims to support a release nobody has seen
    // is claiming something it cannot know.
    for (const future of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.2', '0.3.0', '0.9.0', '1.0.0', '999.0.0']) {
      const verdict = classifyDshVersion(future)
      assert.equal(verdict.status, 'incompatible', `${future} must not be called supported`)
      assert.match(String(verdict.reason), /has not been tested/)
    }
  })

  it('calls a newer release inside the same line untested, and lets it load', () => {
    for (const newer of ['0.2.2', '0.2.2-rc.2', '0.2.3-alpha.1', '0.2.9']) {
      const verdict = classifyDshVersion(newer)
      assert.equal(verdict.status, 'untested', `${newer} is newer than tested, not incompatible`)
      assert.match(String(verdict.reason), /nothing has been verified/)
    }
  })

  it('refuses a string that is not a version at all', () => {
    for (const nonsense of ['', 'latest', '1', '1.2', 'v1.2.3', 'next']) {
      assert.equal(classifyDshVersion(nonsense).status, 'incompatible')
    }
  })

  it('orders prereleases below their release, as semantic versioning requires', () => {
    // `0.2.2-rc.1` precedes `0.2.2`, so the release past the tested candidate is untested, not
    // tested; and every prerelease of the next line sits at or past `0.3.0-0`, so none of them is
    // let in as merely untested. Getting either backwards would claim what was never run.
    assert.equal(classifyDshVersion('0.2.2-rc.1').status, 'tested')
    assert.equal(classifyDshVersion('0.2.2').status, 'untested')
    assert.equal(classifyDshVersion('0.2.99').status, 'untested')
    assert.equal(classifyDshVersion('0.3.0-alpha.1').status, 'incompatible')
    // The lines in between were bracketed by tested lanes.
    for (const between of ['0.1.5-rc.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.5']) {
      assert.equal(classifyDshVersion(between).status, 'tested', between)
    }
  })

  it('declares the same range to DeepSeek Harness in engines.dsh', () => {
    // DeepSeek Harness 0.2.1 and later read `engines.dsh` and refuse the package before running any
    // of it; the two boundaries must be one boundary.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines?: Record<string, string> }
    assert.equal(manifest.engines?.['dsh'], DSH_ENGINES_RANGE)
    assert.equal(DSH_ENGINES_RANGE, `>=${SUPPORTED_DSH.minimum} <${SUPPORTED_DSH.refuseFrom}`)
  })

  it('describes the range in terms a user can act on', () => {
    const text = supportedRangeText()
    // Escape every metacharacter, not only the dot: a version is text to find, not a pattern.
    const literal = (value: string): RegExp => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    assert.match(text, literal(SUPPORTED_DSH.minimum))
    assert.match(text, /0\.3\.0 and its prereleases are refused/)
    assert.match(text, literal(SUPPORTED_DSH.maximumTested))
    assert.match(text, /tested/)
  })
})
