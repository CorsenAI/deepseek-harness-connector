/**
 * The release channel: the companion of a version is the tarball on the project's GitHub release of
 * that version, and every place that names it agrees (ADR 0011).
 *
 * The setup card builds the command from the extension's version; both installers carry the version
 * as a constant and download the same URL by default; the packager writes the file under that name.
 * A drift between any two of them is a user who installs the wrong pair, or nothing.
 * @module
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { RELEASE_DOWNLOADS, companionTarballUrl, installCommandFor, onboardingFor } from '../../extension/src/panel-state.js'

const root = new URL('../../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')
const version = (JSON.parse(read('extension/manifest.json')) as { version: string }).version
const escaped = version.replace(/\./g, '\\.')

describe('the release channel', () => {
  it('names the companion tarball of the same version on the project\'s GitHub release', () => {
    assert.equal((JSON.parse(read('companion/package.json')) as { version: string }).version, version, 'extension and companion versions')
    assert.equal(RELEASE_DOWNLOADS, 'https://github.com/CorsenAI/deepseek-harness-connector/releases/download')
    assert.equal(companionTarballUrl(version), `${RELEASE_DOWNLOADS}/v${version}/corsen-ai-dsh-browser-connector-${version}.tgz`)
    assert.equal(installCommandFor(version), `dsh plugin --profile web add ${companionTarballUrl(version)}`)
    assert.equal(installCommandFor(version, 'headless'), `dsh plugin --profile headless add ${companionTarballUrl(version)}`)
    assert.equal(onboardingFor({ platformOs: 'linux', probe: 'none', brokerUrl: 'ws://127.0.0.1:8781', version }).installCommand, installCommandFor(version))
  })

  it('is what both installers download by default, at the same version', () => {
    const sh = read('scripts/install.sh')
    const ps = read('scripts/install.ps1')
    assert.match(sh, new RegExp(`^VERSION="${escaped}"$`, 'm'), 'install.sh carries the version')
    assert.match(ps, new RegExp(`^\\$Version = "${escaped}"$`, 'm'), 'install.ps1 carries the version')
    assert.ok(sh.includes(`PACKAGE="${RELEASE_DOWNLOADS}/v$VERSION/corsen-ai-dsh-browser-connector-$VERSION.tgz"`), 'install.sh defaults to the release URL')
    assert.ok(ps.includes(`$Package = "${RELEASE_DOWNLOADS}/v$Version/corsen-ai-dsh-browser-connector-$Version.tgz"`), 'install.ps1 defaults to the release URL')
  })

  it('is the file name npm pack gives the package, which the verifier expects', () => {
    // package.mjs lets `npm pack` name the tarball: for a scoped package that is the name with its
    // `@` dropped and its `/` turned into `-`, then the version. The URL must end in exactly that.
    const name = (JSON.parse(read('companion/package.json')) as { name: string }).name
    const packed = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
    assert.ok(companionTarballUrl(version).endsWith(`/${packed}`), `${companionTarballUrl(version)} must end in ${packed}`)
    assert.ok(read('scripts/verify-package.mjs').includes('`corsen-ai-dsh-browser-connector-${manifest.version}.tgz`'), 'verify-package.mjs looks for the same name')
  })
})
