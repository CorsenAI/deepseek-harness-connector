/**
 * Redaction tests.
 *
 * Every case here names a credential that must never reach a model request. A failure is a data
 * disclosure, not a formatting regression.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  boundText,
  isSecretField,
  isSecretParam,
  MASK,
  redactionConfig,
  safeValue,
  scrubUrl,
} from '../../extension/src/redact.js'

describe('URL scrubbing', () => {
  it('masks a token in the query string', () => {
    const scrubbed = scrubUrl('https://app.test/callback?access_token=abc123&state=ok')
    assert.equal(scrubbed.includes('abc123'), false)
    assert.equal(scrubbed.includes('state=ok'), true)
  })

  it('masks every common credential parameter spelling', () => {
    for (const name of [
      'token', 'access_token', 'id_token', 'refresh_token', 'api_key', 'apiKey', 'x-api-key',
      'auth', 'authorization', 'secret', 'client_secret', 'password', 'passwd', 'jwt', 'sig',
      'signature', 'session', 'sessionId', 'code', 'otp', 'private_key', 'bearer', 'credential',
    ]) {
      const scrubbed = scrubUrl(`https://app.test/?${encodeURIComponent(name)}=SUPERSECRET`)
      assert.equal(scrubbed.includes('SUPERSECRET'), false, `${name} was not masked`)
    }
  })

  it('masks credentials returned in a fragment, as implicit OAuth does', () => {
    const scrubbed = scrubUrl('https://app.test/#access_token=abc123&token_type=bearer')
    assert.equal(scrubbed.includes('abc123'), false)
  })

  it('removes userinfo embedded in the authority', () => {
    const scrubbed = scrubUrl('https://alice:hunter2@intranet.test/reports')
    assert.equal(scrubbed.includes('hunter2'), false)
    assert.equal(scrubbed.includes('alice'), false)
    assert.equal(scrubbed.includes('intranet.test/reports'), true)
  })

  it('leaves an ordinary URL untouched', () => {
    const url = 'https://example.test/docs/page?q=hello&page=2'
    assert.equal(scrubUrl(url), url)
  })

  it('reports only the scheme of a URL it cannot parse', () => {
    assert.equal(scrubUrl('not a url at all'), '[unparseable URL]')
  })

  it('reports only the scheme of an opaque-payload URL', () => {
    // `new URL()` accepts all of these, so an allowlist rather than a parse attempt is what keeps
    // an inline program or document out of a model request.
    assert.equal(scrubUrl('javascript:steal(document.cookie)'), 'javascript:[opaque URL]')
    assert.equal(scrubUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), 'data:[opaque URL]')
    assert.equal(scrubUrl('blob:https://app.test/9d3a-4f'), 'blob:[opaque URL]')
  })

  it('still reports a restricted browser page, which the model needs to understand the failure', () => {
    assert.equal(scrubUrl('chrome://settings/passwords'), 'chrome://settings/passwords')
    assert.equal(scrubUrl('about:blank'), 'about:blank')
  })

  it('handles empty and non-string input without throwing', () => {
    assert.equal(scrubUrl(''), '')
    assert.equal(scrubUrl(undefined as unknown as string), '')
    assert.equal(scrubUrl(null as unknown as string), '')
  })

  it('does not leak a secret through a repeated parameter', () => {
    const scrubbed = scrubUrl('https://app.test/?token=one&token=two&safe=keep')
    assert.equal(scrubbed.includes('one'), false)
    assert.equal(scrubbed.includes('two'), false)
    assert.equal(scrubbed.includes('safe=keep'), true)
  })
})

describe('parameter classification', () => {
  it('recognises credential-bearing names case-insensitively', () => {
    assert.equal(isSecretParam('Access_Token'), true)
    assert.equal(isSecretParam('X-API-KEY'), true)
    assert.equal(isSecretParam('sessionId'), true)
  })

  it('leaves ordinary names alone', () => {
    for (const name of ['q', 'page', 'sort', 'lang', 'utm_source', 'id', 'ref']) {
      assert.equal(isSecretParam(name), false, `${name} should not be treated as a credential`)
    }
  })
})

describe('field classification', () => {
  it('masks every password input', () => {
    assert.equal(isSecretField({ type: 'password' }), true)
    assert.equal(isSecretField({ type: 'PASSWORD' }), true)
  })

  it('masks hidden inputs, whose values the user never sees', () => {
    assert.equal(isSecretField({ type: 'hidden', name: 'csrf' }), true)
  })

  it('trusts the browser autocomplete declaration', () => {
    for (const token of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp']) {
      assert.equal(isSecretField({ type: 'text', autocomplete: token }), true, `${token} was not masked`)
    }
  })

  it('masks a payment field declared through a compound autocomplete value', () => {
    assert.equal(isSecretField({ type: 'text', autocomplete: 'section-payment cc-number' }), true)
  })

  it('masks a field whose name or id names a secret', () => {
    assert.equal(isSecretField({ type: 'text', name: 'user_password' }), true)
    assert.equal(isSecretField({ type: 'text', id: 'cardNumber' }), true)
    assert.equal(isSecretField({ type: 'text', name: 'cvv' }), true)
    assert.equal(isSecretField({ type: 'text', id: 'totp-code' }), true)
    assert.equal(isSecretField({ type: 'text', name: 'apiKey' }), true)
  })

  it('masks a field whose visible label names a secret', () => {
    assert.equal(isSecretField({ type: 'text', label: 'Security code' }), true)
    assert.equal(isSecretField({ type: 'text', label: 'One time password' }), true)
  })

  it('masks a short numeric field the page declares digit-by-digit', () => {
    assert.equal(isSecretField({ type: 'text', pattern: '\\d{6}', inputMode: 'numeric' }), true)
    assert.equal(isSecretField({ type: 'text', pattern: '[0-9]{4}', inputMode: 'numeric' }), true)
  })

  it('leaves an ordinary field readable', () => {
    assert.equal(isSecretField({ type: 'text', name: 'search', label: 'Search' }), false)
    assert.equal(isSecretField({ type: 'email', name: 'email', autocomplete: 'email' }), false)
    assert.equal(isSecretField({ type: 'text', name: 'street-address' }), false)
    assert.equal(isSecretField({ type: 'number', name: 'quantity', inputMode: 'numeric' }), false)
  })

  it('classifies nothing as readable when given nothing', () => {
    assert.equal(isSecretField({}), false)
    assert.equal(isSecretField(undefined as unknown as Record<string, string>), false)
  })
})

describe('value reporting', () => {
  it('replaces a secret value with a fixed-width mask', () => {
    assert.equal(safeValue('hunter2', true), MASK)
    assert.equal(safeValue('a-much-longer-password-value', true), MASK, 'the mask must not reveal length')
  })

  it('caps an ordinary value', () => {
    const long = 'x'.repeat(500)
    const reported = safeValue(long, false, 200)
    assert.equal(reported.length, 203)
    assert.equal(reported.endsWith('...'), true)
  })

  it('reports a short ordinary value unchanged', () => {
    assert.equal(safeValue('hello', false), 'hello')
  })
})

describe('text bounds', () => {
  it('reports truncation rather than silently dropping content', () => {
    const bounded = boundText('x'.repeat(100), 10)
    assert.equal(bounded.text.length, 10)
    assert.equal(bounded.truncated, true)
  })

  it('leaves text within the cap untouched', () => {
    assert.deepEqual(boundText('short', 10), { text: 'short', truncated: false })
  })
})

describe('injected configuration', () => {
  it('is JSON-serializable, because it is passed to the page as an argument', () => {
    const config = redactionConfig()
    assert.deepEqual(JSON.parse(JSON.stringify(config)), config)
  })

  it('carries every rule the page needs to apply', () => {
    const config = redactionConfig() as Record<string, unknown>
    for (const key of ['mask', 'secretParamFragments', 'secretAutocomplete', 'secretFieldFragments', 'secretInputTypes']) {
      assert.ok(config[key] !== undefined, `${key} is missing from the injected configuration`)
    }
    assert.ok((config['secretFieldFragments'] as string[]).includes('password'))
    assert.ok((config['secretInputTypes'] as string[]).includes('password'))
  })
})
