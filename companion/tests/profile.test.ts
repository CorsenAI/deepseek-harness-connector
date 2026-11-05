/**
 * Where the connector believes the DeepSeek Harness home is, and which profile loaded it.
 *
 * Until 2026-11-05 the connector resolved its own idea of the home: `%LOCALAPPDATA%\dsh` on
 * Windows, and a `DSH_HOME` naming a profile directory read as its grandparent. DeepSeek Harness
 * has neither rule — its home is a non-blank `DSH_HOME`, else `~/.dsh` on every platform — so on a
 * Windows machine without `DSH_HOME` the installer looked for the package `dsh plugin add` had just
 * installed in a directory DeepSeek Harness never wrote, and failed. Nothing tested this function;
 * the installer lanes all set `DSH_HOME`. These cases pin the rule, and the last one compares it
 * with DeepSeek Harness's own resolver, input by input.
 * @module
 */

import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { resolveDshHome as officialResolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { profileNameFromPath, resolveDshHome, resolveProfileIdentity } from '../src/dsh/profile.ts'

const OS_HOME = resolve('/home/someone')

describe('resolving the DeepSeek Harness home', () => {
  it('is ~/.dsh when DSH_HOME is unset, on every platform — never %LOCALAPPDATA%', () => {
    const environment = { LOCALAPPDATA: resolve('/somewhere/AppData/Local') }
    assert.equal(resolveDshHome(environment, OS_HOME), join(OS_HOME, '.dsh'))
  })

  it('treats a blank or whitespace-only DSH_HOME as unset, so a blank override never means the current directory', () => {
    for (const blank of ['', ' ', '\t', ' \n ']) {
      assert.equal(resolveDshHome({ DSH_HOME: blank }, OS_HOME), join(OS_HOME, '.dsh'), JSON.stringify(blank))
    }
  })

  it('uses a configured DSH_HOME as the home, made absolute', () => {
    const absolute = resolve('/data/dsh-home')
    assert.equal(resolveDshHome({ DSH_HOME: absolute }, OS_HOME), absolute)
    assert.equal(resolveDshHome({ DSH_HOME: 'relative/home' }, OS_HOME), resolve('relative/home'))
  })

  it('expands the tilde prefixes DeepSeek Harness expands, and no others', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '~' }, OS_HOME), OS_HOME)
    assert.equal(resolveDshHome({ DSH_HOME: '~/alt' }, OS_HOME), join(OS_HOME, 'alt'))
    assert.equal(resolveDshHome({ DSH_HOME: '~\\alt' }, OS_HOME), join(OS_HOME, 'alt'))
    assert.equal(resolveDshHome({ DSH_HOME: '~alt' }, OS_HOME), resolve('~alt'))
  })

  it('does not reinterpret a DSH_HOME that names a profile directory', () => {
    // DeepSeek Harness takes it literally; reading it as the grandparent would put the connector's
    // state in a home the running DeepSeek Harness is not using.
    const profileDirectory = resolve('/data/dsh/profiles/web')
    assert.equal(resolveDshHome({ DSH_HOME: profileDirectory }, OS_HOME), profileDirectory)
  })

  it('agrees with DeepSeek Harness’s own resolver on every case above', () => {
    const cases: (string | undefined)[] = [undefined, '', '   ', resolve('/data/dsh-home'), 'relative/home', '~', '~/alt', '~alt', resolve('/data/dsh/profiles/web')]
    for (const value of cases) {
      const environment = value === undefined ? {} : { DSH_HOME: value }
      // The official resolver reads the operating-system home itself; compare on the real one.
      assert.equal(resolveDshHome(environment), officialResolveDshHome(undefined, environment), `DSH_HOME=${JSON.stringify(value)}`)
    }
  })
})

describe('naming the profile that loaded the connector', () => {
  it('reads the profile from a dsh plugin installation path', () => {
    const url = pathToFileURL(join(OS_HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@corsen-ai', 'dsh-browser-connector', 'lib', 'plugin.js')).href
    assert.equal(profileNameFromPath(url), 'desktop')
  })

  it('names no profile for a path outside any profile, and for the profiles directory’s own node_modules', () => {
    assert.equal(profileNameFromPath(pathToFileURL(join(OS_HOME, 'src', 'plugin.js')).href), null)
    assert.equal(profileNameFromPath(pathToFileURL(join(OS_HOME, '.dsh', 'profiles', 'node_modules', 'x', 'plugin.js')).href), null)
    assert.equal(profileNameFromPath('data:text/javascript,0'), null)
  })

  it('builds the routing identity from the profile name and a digest of the resolved home', () => {
    const home = resolve('/data/dsh-home')
    const one = resolveProfileIdentity({ configuredName: 'web', environment: { DSH_HOME: home } })
    const other = resolveProfileIdentity({ configuredName: 'web', environment: { DSH_HOME: resolve('/data/other-home') } })
    assert.equal(one.home, home)
    assert.match(one.profileId, /^web\.[0-9a-f]{12}$/)
    assert.notEqual(one.profileId, other.profileId, 'two homes must never share a routing identity')
    assert.equal(resolveProfileIdentity({ configuredName: 'a b/c', environment: { DSH_HOME: home } }).profileName, 'a-b-c')
  })
})
