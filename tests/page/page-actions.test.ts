/**
 * Regression cases for an external review of 2026-09-05, run against the real page interface.
 *
 * Each case here reproduces something the review measured and this project had wrong:
 *
 * 1. A control the connector had already decided to mask still gave up its data through another
 *    representation — a textarea's content through the page text, a select's values through its
 *    option list. Masking one field while another carries the same characters is not masking.
 * 2. Node budgets bounded the output but not the work: past its budget a walk rejected nodes and
 *    then kept scanning the rest of the document, so a thirty-thousand-node page cost thirty
 *    thousand filter calls whatever the cap said. A `role` attribute was not bounded at all, and a
 *    two-megabyte one produced a two-megabyte result that still reported `truncated: false`.
 * 3. A form submission was reported as done whenever it was requested, including when the browser
 *    refused it as invalid and the page received no submit event at all.
 *
 * The sentinels are deliberately not secrets, so a masking rule cannot make a leak pass unnoticed,
 * and every case that proves something is hidden is paired with one proving ordinary content is
 * not, because over-hiding would break the product just as surely.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startProbes, type ProbeEnvironment } from './harness.ts'

/** Declared in `page-actions.js`; asserted here so a change to either side is caught. */
const MAX_VISITED_NODES = 6000
const MAX_TEXT_NODES = 24000
const MAX_ROLE_CHARS = 40
const MAX_RESULT_BYTES = 512 * 1024

let probes: ProbeEnvironment

before(async () => { probes = await startProbes() })
after(async () => { await probes.close() })

/**
 * @param count - how many empty siblings to build.
 * @returns a document with that many of them.
 */
function wideDocument(count: number): string {
  return `<!doctype html><meta charset="utf-8"><title>wide</title><body><div id="host"></div>
<script>
const host = document.getElementById('host');
const batch = document.createDocumentFragment();
for (let index = 0; index < ${count}; index += 1) {
  const node = document.createElement('span');
  node.textContent = 'x';
  batch.appendChild(node);
}
host.appendChild(batch);
</script></body>`
}

describe('the page interface, in a real browser', () => {
  describe('a control that is masked stays masked in every representation', () => {
    const SECRETS = `<!doctype html><meta charset="utf-8"><title>shapes</title><body>
<form>
  <label for="tok">API token</label>
  <textarea id="tok" name="api_token">LEAK_TEXTAREA_4729</textarea>

  <label for="card">Card number</label>
  <select id="card" name="card-number" autocomplete="cc-number">
    <option value="4111111111111111">LEAK_OPTION_LABEL_3947</option>
    <option value="5555444433332222">LEAK_OPTION_LABEL_OTHER</option>
  </select>

  <label>Password hint<textarea name="hint_field">LEAK_BY_LABEL_ONLY_8812</textarea></label>

  <label for="note">Delivery note</label>
  <textarea id="note" name="delivery_note">ORDINARY_TEXTAREA_OK</textarea>

  <label for="size">Size</label>
  <select id="size" name="size">
    <option value="large">ORDINARY_OPTION_OK</option>
    <option value="small">ORDINARY_OPTION_TWO</option>
  </select>
</form></body>`

    it('keeps a masked textarea out of the snapshot text, read_text, and find', async () => {
      const probe = await probes.open(SECRETS)
      const snapshot = await probe.run('snapshot')
      const readText = await probe.run('read_text')
      const found = await probe.run('find', { text: 'LEAK_TEXTAREA_4729' })

      const whole = JSON.stringify(snapshot.result)
      assert.ok(!whole.includes('LEAK_TEXTAREA_4729'), 'the snapshot must not carry a masked field’s content anywhere')
      assert.ok(!String(readText.result.data?.['text']).includes('LEAK_TEXTAREA_4729'), 'read_text must not carry it either')
      assert.equal(found.result.data?.['found'], false, 'find must not locate what the snapshot refuses to report')

      const entry = (snapshot.result.data?.['elements'] as Record<string, unknown>[])
        .find((candidate) => String(candidate['name']).includes('API token'))
      assert.equal(entry?.['masked'], true)
      assert.ok(!String(entry?.['value']).includes('LEAK'), 'the value itself stays masked')
    })

    it('keeps a masked select’s option values and labels out of the inventory', async () => {
      const probe = await probes.open(SECRETS)
      const snapshot = await probe.run('snapshot')
      const whole = JSON.stringify(snapshot.result)

      assert.ok(!whole.includes('4111111111111111'), 'an option value is the same data as the value it masks')
      assert.ok(!whole.includes('LEAK_OPTION_LABEL_3947'), 'an option label carries it just as well')

      const entry = (snapshot.result.data?.['elements'] as Record<string, unknown>[])
        .find((candidate) => Array.isArray(candidate['options']) && String(candidate['name']).includes('Card'))
      assert.equal(entry?.['masked'], true)
      const options = entry?.['options'] as Record<string, unknown>[]
      assert.equal(options.length, 2, 'the model still learns how many options there are')
      assert.equal(options[0]?.['selected'], true, 'and which one is selected')
    })

    it('does not print a masked select’s options in a failed match either', async () => {
      const probe = await probes.open(SECRETS)
      const snapshot = await probe.run('snapshot')
      const card = (snapshot.result.data?.['elements'] as Record<string, unknown>[])
        .find((candidate) => String(candidate['name']).includes('Card'))
      const failure = await probe.run('select_option', { ref: card?.['ref'], value: 'nothing-matches-this' })

      assert.equal(failure.result.ok, false)
      const message = String(failure.result.error?.message)
      assert.ok(!message.includes('4111111111111111'), 'a failure message is a result like any other')
      assert.match(message, /masked option/i)
    })

    it('confines a control that only its visible label marks as secret', async () => {
      const probe = await probes.open(SECRETS)
      const snapshot = await probe.run('snapshot')
      const whole = JSON.stringify(snapshot.result)

      assert.ok(!whole.includes('LEAK_BY_LABEL_ONLY_8812'), 'the label decided this field is secret; its content must follow')
      assert.match(String(snapshot.result.data?.['text']), /Password hint/, 'the label itself is ordinary visible text')
    })

    it('leaves ordinary controls fully readable and operable', async () => {
      const probe = await probes.open(SECRETS)
      const snapshot = await probe.run('snapshot')
      const text = String(snapshot.result.data?.['text'])

      assert.match(text, /ORDINARY_TEXTAREA_OK/, 'an ordinary textarea’s content is page content')
      const size = (snapshot.result.data?.['elements'] as Record<string, unknown>[])
        .find((candidate) => String(candidate['name']).includes('Size'))
      const options = size?.['options'] as Record<string, unknown>[]
      assert.equal(options[0]?.['value'], 'large')
      assert.equal(options[0]?.['label'], 'ORDINARY_OPTION_OK')

      const chosen = await probe.run('select_option', { ref: size?.['ref'], label: 'ORDINARY_OPTION_TWO' })
      assert.equal(chosen.result.ok, true)
      assert.equal(await probe.page.evaluate(() => (document.getElementById('size') as HTMLSelectElement).value), 'small')
    })
  })

  describe('a hostile document cannot buy unbounded work or an unbounded result', () => {
    it('stops the inventory walk at its budget instead of scanning the whole document', async () => {
      const probe = await probes.open(wideDocument(30000))
      const snapshot = await probe.run('snapshot')

      const [inventoryCalls] = snapshot.walkCalls
      assert.ok(
        (inventoryCalls ?? 0) <= MAX_VISITED_NODES + 1,
        `the inventory walk touched ${inventoryCalls} nodes against a budget of ${MAX_VISITED_NODES}`,
      )
      assert.equal(snapshot.result.data?.['truncated'], true, 'and says the page was not read in full')
    })

    it('stops the text walk at its budget too', async () => {
      const probe = await probes.open(wideDocument(30000))
      const readText = await probe.run('read_text')

      const [textCalls] = readText.walkCalls
      assert.ok(
        (textCalls ?? 0) <= MAX_TEXT_NODES + 1,
        `the text walk touched ${textCalls} nodes against a budget of ${MAX_TEXT_NODES}`,
      )
    })

    it('bounds a role attribute, which is a token and never a payload', async () => {
      const probe = await probes.open(`<!doctype html><meta charset="utf-8"><title>role</title><body>
<button id="b">go</button>
<script>document.getElementById('b').setAttribute('role', 'x'.repeat(2 * 1024 * 1024))</script></body>`)
      const snapshot = await probe.run('snapshot')

      const entry = (snapshot.result.data?.['elements'] as Record<string, unknown>[])[0]
      assert.ok(String(entry?.['role']).length <= MAX_ROLE_CHARS)
      assert.ok(snapshot.bytes < 100_000, `the result was ${snapshot.bytes} bytes`)
    })

    it('bounds the whole result, not only its parts, and reports that it did', async () => {
      const probe = await probes.open(`<!doctype html><meta charset="utf-8"><title>bulk</title><body><div id="host"></div>
<script>
const host = document.getElementById('host');
for (let select = 0; select < 100; select += 1) {
  const control = document.createElement('select');
  control.name = 'choice' + select;
  for (let option = 0; option < 50; option += 1) {
    const item = document.createElement('option');
    item.value = String(option) + 'v'.repeat(180);
    item.textContent = String(option) + 'l'.repeat(140);
    control.appendChild(item);
  }
  host.appendChild(control);
}
</script></body>`)
      const snapshot = await probe.run('snapshot')

      assert.ok(snapshot.bytes <= MAX_RESULT_BYTES, `the result was ${snapshot.bytes} bytes`)
      assert.equal(snapshot.result.data?.['truncated'], true, 'a trimmed result must never look complete')
    })

    it('walks a deeply nested chain iteratively, within its budget', async () => {
      // The depth here is 200, not the thousands a threat model might imagine, for a measured
      // reason: this machine's Chromium crashes or hangs while *building* a document nested a
      // thousand levels deep, before any connector code runs. The browser bounds that case, and a
      // test asserting our behaviour past the browser's own limit would prove nothing. What is
      // ours, and is asserted, is that depth costs nodes like any other shape and never recursion.
      const probe = await probes.open(`<!doctype html><meta charset="utf-8"><title>deep</title><body><div id="host"></div>
<script>
let node = document.getElementById('host');
for (let depth = 0; depth < 200; depth += 1) {
  const child = document.createElement('div');
  node.appendChild(child);
  node = child;
}
node.textContent = 'DEEP_BOTTOM_OK';
</script></body>`)
      const snapshot = await probe.run('snapshot')

      assert.equal(snapshot.result.ok, true, 'a deep document is answered, not crashed')
      assert.match(String(snapshot.result.data?.['text']), /DEEP_BOTTOM_OK/, 'and its content is reached')
      for (const calls of snapshot.walkCalls) {
        assert.ok(calls <= MAX_TEXT_NODES + 1, `a walk touched ${calls} nodes`)
      }
    })
  })

  describe('a submission is reported as what the browser actually did', () => {
    const FORM = `<!doctype html><meta charset="utf-8"><title>submit</title><body>
<form id="f"><input id="a" name="a"><input id="b" name="b" required></form>
<form id="g"><input id="c" name="c"></form>
<script>
globalThis.submits = 0;
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', (event) => { event.preventDefault(); globalThis.submits += 1; });
}
</script></body>`

    it('reports the typing that happened and the submission that did not', async () => {
      const probe = await probes.open(FORM)
      const snapshot = await probe.run('snapshot')
      const first = (snapshot.result.data?.['elements'] as Record<string, unknown>[])[0]

      const typed = await probe.run('type', { ref: first?.['ref'], text: 'hello', submit: true })

      assert.equal(typed.result.ok, true, 'the typing really happened, so the action is not a failure')
      assert.equal(typed.result.data?.['submitted'], false, 'and the submission really did not')
      assert.match(String(typed.result.data?.['submitFailed']), /not valid/i)
      assert.equal(await probe.page.evaluate(() => (document.getElementById('a') as HTMLInputElement).value), 'hello')
      assert.equal(await probe.page.evaluate(() => (globalThis as unknown as { submits: number }).submits), 0)
    })

    it('reports a submission the browser did dispatch', async () => {
      const probe = await probes.open(FORM)
      const snapshot = await probe.run('snapshot')
      // The third input is the one in the form with nothing required, so validation passes.
      const refs = (snapshot.result.data?.['elements'] as Record<string, unknown>[]).map((entry) => entry['ref'])
      assert.equal(refs.length, 3, 'the fixture offers exactly three inputs')

      const typed = await probe.run('type', { ref: refs[2], text: 'hello', submit: true })

      assert.equal(typed.result.data?.['submitted'], true)
      assert.equal(typed.result.data?.['submitFailed'], undefined, 'nothing failed, so nothing is reported as failed')
      assert.equal(await probe.page.evaluate(() => (globalThis as unknown as { submits: number }).submits), 1)
    })
  })

  describe('a control is named the way the HTML accessibility mappings name it', () => {
    // The order the HTML Accessibility API Mappings give, checked here because it is also a trust
    // boundary: a tooltip nobody sees without hovering must not rename a control that shows its own
    // text. Every control below carries a title that says something else.
    const NAMES = `<!doctype html><meta charset="utf-8"><title>names</title><body>
<button id="b1" title="TITLE_B1">Shown B1</button>
<a id="a1" href="#" title="TITLE_A1">Shown A1</a>
<button id="b2" title="TITLE_B2"></button>
<div id="d1" role="button" tabindex="0" title="TITLE_D1">Shown D1</div>
<label for="t1">Label T1</label><input id="t1" title="TITLE_T1" placeholder="PLACEHOLDER_T1">
<input id="t2" title="TITLE_T2" placeholder="PLACEHOLDER_T2">
<input id="t3" placeholder="PLACEHOLDER_T3">
<input id="t4" aria-label="ARIA_T4" title="TITLE_T4"><span id="lb">Labelled T5</span>
<input id="t5" aria-labelledby="lb" aria-label="ARIA_T5">
<input id="s1" type="submit" value="Send S1" title="TITLE_S1">
<select id="sel" title="TITLE_SEL"><option>Alpha</option><option>Beta</option></select>
<summary id="sum" title="TITLE_SUM">Shown SUM</summary>
</body>`

    it('names a control by what it shows before its tooltip, and by its tooltip only when it shows nothing', async () => {
      const probe = await probes.open(NAMES)
      const snapshot = await probe.run('snapshot')
      const names = new Map((snapshot.result.data?.['elements'] as Record<string, unknown>[]).map((entry) => [String(entry['role']) + ':' + String(entry['name']), entry]))
      const has = (role: string, name: string): boolean => names.has(`${role}:${name}`)

      assert.ok(has('button', 'Shown B1'), 'a button that shows text is named by it')
      assert.ok(has('link', 'Shown A1'), 'a link that shows text is named by it')
      assert.ok(has('button', 'TITLE_B2'), 'an empty button falls back to its tooltip')
      assert.ok(has('button', 'Shown D1'), 'a role=button element is named by its content')
      assert.ok(has('button', 'Send S1'), 'a submit button is named by its value')
      assert.ok(has('button', 'Shown SUM') || has('summary', 'Shown SUM'), 'a summary is named by its content')
      assert.ok(has('combobox', 'TITLE_SEL') || has('select', 'TITLE_SEL'), 'a select is named by its tooltip, never by its options')
      const whole = JSON.stringify(snapshot.result)
      for (const hidden of ['TITLE_B1', 'TITLE_A1', 'TITLE_D1', 'TITLE_S1', 'TITLE_SUM']) {
        assert.ok(!whole.includes(hidden), `${hidden} is a tooltip on a control that shows its own text and must not be reported`)
      }
    })

    it('names a text field by its label, then its tooltip, then its placeholder, and ARIA before all of them', async () => {
      const probe = await probes.open(NAMES)
      const snapshot = await probe.run('snapshot')
      const textboxes = (snapshot.result.data?.['elements'] as Record<string, unknown>[])
        .filter((entry) => entry['role'] === 'textbox').map((entry) => String(entry['name']))

      assert.ok(textboxes.includes('Label T1'), 'a labelled field is named by its label')
      assert.ok(textboxes.includes('TITLE_T2'), 'an unlabelled field with a title is named by the title, as the mappings say')
      assert.ok(textboxes.includes('PLACEHOLDER_T3'), 'a field with nothing but a placeholder is named by it')
      assert.ok(textboxes.includes('ARIA_T4'), 'aria-label wins over the title')
      assert.ok(textboxes.includes('Labelled T5'), 'aria-labelledby wins over aria-label')
      for (const unexpected of ['TITLE_T1', 'PLACEHOLDER_T1', 'PLACEHOLDER_T2', 'TITLE_T4', 'ARIA_T5']) {
        assert.ok(!textboxes.includes(unexpected), `${unexpected} lost the name computation and must not be a name`)
      }
    })
  })
})
