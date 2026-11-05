# Performance

What one browser action costs, measured, on named machines. Nothing here is compared with any other
project; the numbers exist so that a change which makes an action slower or a payload larger is a
change someone can see.

## What is measured

`tests/perf/measure.ts` drives the shipped extension in a real Chrome for Testing through the
in-process broker, the way every end-to-end suite does, and records for each action:

- the **round trip as the plugin sees it** — from `AgentClient.request` to its settlement, through
  the broker, the extension's service worker, and the page;
- the **exact bytes of the two frames that carry the answer**, read off the wire by the recording
  relay from `tests/e2e/wiretap.ts`: the `action_result` the browser sends and the
  `action_response` the plugin receives (the two differ by the envelope, 2 bytes here);
- whether the page reported its payload as **truncated**.

Every task runs once unmeasured, to settle layout and the worker's first wake, then `--runs` times.
Median and p95 are nearest-rank over those runs.

The fixtures are the repository's own:

| Page | What it is |
|---|---|
| `page-a.html` | A small sign-in form with masked fields and two buttons — a login or settings page |
| `page-c.html` | The twenty-action fixture — a page with a bit of everything |
| `page-large.html` | Generated at run time: 3,000 paragraphs (about 450 KB of text), 300 buttons, 120 fields — a long article with a comment section, built to reach every walk budget |

The wall-clock walk deadline (`MAX_WALK_MS`, 5 s) is checked once every 256 nodes, so its cost is
the price of one `performance.now()` read times at most `(6000 + 24000) / 256 = 118` reads per
full-budget snapshot. That price is measured in the same page, the same way the walk reads it.

## Reproduce

```bash
npm ci && npm ci --prefix companion && npx playwright install chromium
node --experimental-strip-types tests/perf/measure.ts --runs 30 --json perf.json
# on a machine without a display:
DSH_E2E_HEADLESS=1 node --experimental-strip-types tests/perf/measure.ts --runs 30
```

The script prints the table below and, with `--json`, writes the same figures with the environment.

## Measurements

### 2026-09-11 — Ubuntu 26.04.1, Intel Core Ultra 9 285K (24 cores), 247 GiB, Node v26.8.1, Chrome for Testing 153.0.8010.12, commit `ebd8ba3`

Headed, under Xvfb (the mode users run):

| Task | Runs | Median ms | p95 ms | Min ms | Max ms | Result frame (median B) | Response frame (median B) | Truncated runs |
|---|---|---|---|---|---|---|---|---|
| page-a snapshot | 30 | 2.0 | 3.7 | 1.4 | 5.1 | 832 | 834 | 0 |
| page-a read_text | 30 | 1.6 | 4.2 | 1.0 | 4.8 | 299 | 301 | 0 |
| page-a click | 30 | 1.5 | 2.9 | 0.9 | 3.4 | 148 | 150 | 0 |
| page-a current_url | 30 | 1.2 | 2.0 | 1.0 | 2.2 | 128 | 130 | 0 |
| page-c snapshot | 30 | 3.9 | 5.1 | 2.0 | 5.5 | 1013 | 1015 | 0 |
| page-c find | 30 | 3.1 | 4.5 | 1.1 | 4.6 | 186 | 188 | 0 |
| page-large snapshot | 30 | 18.7 | 27.5 | 17.1 | 28.5 | 64567 | 64569 | 30 |
| page-large read_text | 30 | 3.9 | 6.6 | 2.4 | 8.1 | 40469 | 40471 | 30 |
| page-large find (last paragraph) | 30 | 8.6 | 13.4 | 7.8 | 20.1 | 172 | 174 | 0 |

Deadline clock: 72.0 ns per `performance.now()`, at most 118 reads per full-budget snapshot,
**8.5 µs** per snapshot at most — under a thousandth of the smallest snapshot above.

New headless mode (`DSH_E2E_HEADLESS=1`), same machine and commit:

| Task | Runs | Median ms | p95 ms | Min ms | Max ms | Result frame (median B) | Truncated runs |
|---|---|---|---|---|---|---|---|
| page-a snapshot | 30 | 1.7 | 3.0 | 1.2 | 3.4 | 832 | 0 |
| page-a read_text | 30 | 1.6 | 3.8 | 0.9 | 4.0 | 299 | 0 |
| page-a click | 30 | 1.2 | 1.9 | 0.9 | 2.1 | 148 | 0 |
| page-a current_url | 30 | 1.2 | 2.7 | 0.8 | 3.2 | 128 | 0 |
| page-c snapshot | 30 | 2.3 | 4.4 | 1.4 | 5.0 | 1013 | 0 |
| page-c find | 30 | 1.2 | 2.6 | 0.9 | 2.6 | 186 | 0 |
| page-large snapshot | 30 | 18.0 | 20.2 | 16.3 | 22.5 | 64567 | 30 |
| page-large read_text | 30 | 4.3 | 7.6 | 2.7 | 7.6 | 40469 | 30 |
| page-large find (last paragraph) | 30 | 8.2 | 12.9 | 7.3 | 17.9 | 172 | 0 |

Deadline clock: 73.0 ns per read, 8.6 µs per snapshot at most.

### 2026-11-05 — the same machine (Ubuntu 26.04.1, Intel Core Ultra 9 285K, Node v26.8.1, Chrome for Testing 153.0.8010.12), commit `e127d3b`

Headed, under Xvfb, after the DeepSeek Harness 0.2 work. The page code is unchanged since the
measurement above, and so is every byte on the wire; the times are the same within run-to-run noise.

| Task | Runs | Median ms | p95 ms | Min ms | Max ms | Result frame (median B) | Response frame (median B) | Truncated runs |
|---|---|---|---|---|---|---|---|---|
| page-a snapshot | 30 | 1.9 | 3.7 | 1.3 | 4.0 | 832 | 834 | 0 |
| page-a read_text | 30 | 2.1 | 4.3 | 1.1 | 5.6 | 299 | 301 | 0 |
| page-a click | 30 | 1.1 | 1.7 | 0.8 | 1.8 | 148 | 150 | 0 |
| page-a current_url | 30 | 0.9 | 1.3 | 0.8 | 1.7 | 128 | 130 | 0 |
| page-c snapshot | 30 | 3.8 | 5.1 | 2.5 | 6.0 | 1013 | 1015 | 0 |
| page-c find | 30 | 1.7 | 3.5 | 1.2 | 3.7 | 186 | 188 | 0 |
| page-large snapshot | 30 | 21.1 | 31.7 | 18.3 | 44.6 | 64567 | 64569 | 30 |
| page-large read_text | 30 | 3.1 | 4.5 | 2.7 | 11.7 | 40469 | 40471 | 30 |
| page-large find (last paragraph) | 30 | 9.8 | 18.0 | 9.2 | 23.8 | 172 | 174 | 0 |

Deadline clock: 73.9 ns per read, 8.7 µs per snapshot at most.

### 2026-09-12 — same machine, Chrome for Testing 153, after the flat-tree walk (open shadow DOM)

The walkers now cross open shadow roots and follow slots (`walkFlatTree` in `page-actions.js`),
which adds a parent check and a host-or-slot check per node walked. Measured against the previous
walker in the same session on the same machine (each 30 runs, headed under Xvfb): `page-large`
snapshot **18.2 → 20.4–22.3 ms** median across three runs of the new code, `read_text`
**2.7 → 3.2–4.7 ms**, `find` **9.8 → 9.4–11.5 ms**; the small pages within their own spread.
About three milliseconds on the one page that spends the whole inventory budget; nothing a user
can notice, and the walk deadline is five seconds.

Headed, the run of record for this code:

| Task | Runs | Median ms | p95 ms | Min ms | Max ms | Result frame (median B) | Truncated runs |
|---|---|---|---|---|---|---|---|
| page-a snapshot | 30 | 1.8 | 4.7 | 1.4 | 5.9 | 832 | 0 |
| page-a read_text | 30 | 2.7 | 5.0 | 1.5 | 5.3 | 299 | 0 |
| page-a click | 30 | 2.3 | 4.2 | 0.9 | 4.2 | 148 | 0 |
| page-a current_url | 30 | 2.3 | 3.9 | 0.7 | 4.0 | 128 | 0 |
| page-c snapshot | 30 | 2.9 | 4.9 | 2.0 | 5.4 | 1013 | 0 |
| page-c find | 30 | 1.8 | 2.4 | 1.2 | 3.2 | 186 | 0 |
| page-large snapshot | 30 | 20.4 | 31.4 | 18.3 | 32.3 | 64567 | 30 |
| page-large read_text | 30 | 4.7 | 5.8 | 3.2 | 10.8 | 40469 | 30 |
| page-large find (last paragraph) | 30 | 11.5 | 19.1 | 9.9 | 28.6 | 172 | 0 |

New headless mode, same code: page-a snapshot 1.6 ms, page-c snapshot 2.1 ms, page-large
snapshot 21.5 ms (p95 24.6), read_text 3.3 ms, find 9.1 ms; frames identical to the table above.
Deadline clock 72.2 ns per read, 8.5 µs per snapshot at most.

## Reading the numbers

- A small page costs **1–4 ms** per action end to end, and under a kilobyte on the wire. The
  broker and the worker are not where time goes.
- The large page's snapshot costs **about 20 ms** and returns **64.5 KB**, and every run reports
  `truncated`. That is the budgets doing what they are for: the inventory stops at 400 interactive
  elements (the page has 420) and the text at the default 40,000 characters (`DEFAULT_TEXT_CHARS`;
  a caller may ask for up to `HARD_TEXT_CHARS`, 200,000). `read_text` on the same page is 40 KB for
  the same reason. The connector tells the model the payload was cut rather than silently handing
  it a partial page.
- `find` on the large page costs **about 10 ms** because it is a visible-text walk to the last
  paragraph; the answer is 172 bytes.
- The wall-clock deadline costs microseconds. It is insurance against a page whose layout is slow,
  not a cost on ordinary pages.
- Headed and headless figures agree within their own spread; the mode is not where the time goes
  either.

Figures from the macOS and Windows lanes belong here as they are run; the environment line the
script prints is the row's provenance.
