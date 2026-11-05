## Problem and change

What was observed, what is expected, and the smallest change that gets there. Link the issue.

## Validation

The exact commands, the platforms, and the results. Say what was not run.

- [ ] A behavioural regression test that fails without the fix, failure paths included.
- [ ] Multi-session isolation and stale asynchronous answers checked where the change touches routing, ownership or the transport.
- [ ] `npm run typecheck`, `npm run test:unit`, `npm run test:page` and `npm run test:e2e` pass on the last commit.
- [ ] No pairing code, page content, credential or personal data in the diff, the tests or the fixtures.
- [ ] Nothing copied from another DeepSeek Harness browser project (`docs/PROVENANCE.md`).

## Release impact

Does this change the extension's permissions, the protocol, the installation, the supported DeepSeek Harness range, or the release metadata? A merged change does not by itself publish a Store or npm version.
