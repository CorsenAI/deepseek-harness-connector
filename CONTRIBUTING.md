# Contributing

Thank you for helping. This connector lets a DeepSeek Harness session act in a signed-in browser,
so its rules are strict on purpose. These are the invariants
that must never be violated — exact routing by `(profileId, sessionId)`, failure closed, one owner
per tab, explicit attachment, page content as untrusted data, no `cookies` / `debugger` / remote
code, redaction before the trust boundary, honest results.

Security reports never go in a public issue: see [`SECURITY.md`](SECURITY.md).

## Getting set up

Node `^22.19 || >=24`. From a clone:

```bash
npm install                        # also installs companion/ (postinstall)
npx playwright install chromium    # Chrome for Testing, for the browser suites
npm run build && npm run typecheck
npm run test:unit                  # no browser needed
npm run test:page                  # the shipped page module in Chrome for Testing
npm run test:e2e                   # the real extension; DSH_E2E_HEADLESS=1 without a display
```

The suites that drive a real DeepSeek Harness (`tests/e2e/released-pair.test.ts`,
`tests/e2e/live-turn.test.ts`) need the release artifacts (`node scripts/package.mjs --out dist`)
and a `dsh` installation with DeepSeek Harness's mock provider of the same version beside it:

```bash
mkdir -p ~/dsh-int/latest && cd ~/dsh-int/latest && npm init -y
V=$(npm view @deepseek-ai/dsh@latest version)
npm install "@deepseek-ai/dsh@$V" "@deepseek-ai/dsh-llm-mock-server@$V"
```

`DSH_BIN_DIR` points a run at one installation; without it the first `~/dsh-int/<lane>` is used.
Without either, those suites skip and say so — a skipped gate is not a passed one. `dsh plugin`
needs pnpm on `PATH`.

## What a change needs

- **A test that fails without it.** For a bug, a behavioural regression test, failure paths
  included; never a test that only asserts a source string exists.
- **No weakened checks.** Never comment out a failing test, loosen an assertion to make it pass, or
  mock away the behaviour under test. The multi-session isolation suites (`docs/TEST-MATRIX.md`,
  A–E) are release blockers.
- **DeepSeek Harness stays in one place.** Only `companion/src/dsh/` imports or calls DeepSeek
  Harness APIs (ADR 0005). Widening the supported DeepSeek Harness range takes a passing run, a row
  in `docs/COMPATIBILITY.md`, and the same range in `SUPPORTED_DSH` and in `engines.dsh` (ADR 0010).
- **The permission set is frozen** (ADR 0009). A new extension permission needs a new ADR.
- **No copied code.** Do not copy, translate or line-by-line rewrite code from other DeepSeek
  Harness browser projects; [`docs/PROVENANCE.md`](docs/PROVENANCE.md) explains the rule and how
  it is audited.
- **Evidence for a gate.** A release gate is closed only with its run recorded in
  `docs/TEST-EVIDENCE.md`: the command, the environment, the artifact version, the result and the
  time.
- **Small commits** that each leave the tree understandable.

## Pull requests and CI

Open a focused pull request against `main` and fill in the template. CI runs typecheck and the unit
suite on Linux, macOS and Windows; the browser suites; packaging with the release verifier; the
installer suites on the three systems against a real `dsh`; the released pair and live turns
against DeepSeek Harness `latest`, `next` and the lowest declared version; the provenance audit;
and CodeQL. Actions are pinned to full commit SHAs and Dependabot proposes their updates; review
those like any other change.

Merging is not publishing. A release follows [`docs/RELEASE.md`](docs/RELEASE.md): artifacts built
from a clean, tagged commit, verified, with their hashes recorded; the npm package and the Chrome
Web Store item are published by the owner only.

## Repository administration

`CODEOWNERS` routes reviews; it does not protect `main` by itself. An administrator should enable a
ruleset that requires pull requests and the CI checks, and blocks force-pushes and branch deletion,
and enable private vulnerability reporting (Settings → Security) so the link in `SECURITY.md` works.
