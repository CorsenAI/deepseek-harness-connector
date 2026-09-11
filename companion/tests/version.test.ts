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
import { classifyDshVersion, SUPPORTED_DSH, supportedRangeText } from '../src/dsh/version.ts'

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
    for (const future of ['0.2.0', '0.9.0', '1.0.0', '999.0.0']) {
      const verdict = classifyDshVersion(future)
      assert.equal(verdict.status, 'incompatible', `${future} must not be called supported`)
      assert.match(String(verdict.reason), /has not been tested/)
    }
  })

  it('calls a newer release inside the same line untested, and lets it load', () => {
    for (const newer of ['0.1.6', '0.1.9', '0.1.6-alpha.1']) {
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
    // `0.2.0-rc.1` precedes `0.2.0`, so it falls inside the untested band rather than past the
    // refusal boundary. Getting this backwards would refuse a release candidate of a version we
    // accept, or accept one past the line.
    assert.equal(classifyDshVersion('0.2.0-rc.1').status, 'untested')
    assert.equal(classifyDshVersion('0.2.0').status, 'incompatible')
  })

  it('describes the range in terms a user can act on', () => {
    const text = supportedRangeText()
    assert.match(text, new RegExp(SUPPORTED_DSH.minimum.replace(/\./g, '\\.')))
    assert.match(text, new RegExp(SUPPORTED_DSH.refuseFrom.replace(/\./g, '\\.')))
    assert.match(text, /tested/)
  })
})
