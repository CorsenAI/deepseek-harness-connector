# Release

How a version of this connector is cut. Nothing here is automated yet; it is the procedure the
automation will enforce.

## Three versions, declared together

| Number | Lives in | Moves when |
|---|---|---|
| Extension version | `extension/manifest.json` | Any extension change |
| Package version | `companion/package.json`, `CONNECTOR_VERSION` in `plugin.ts`, `BROKER_VERSION` in `broker-main.ts` | Any package change |
| Protocol version | `companion/src/protocol.ts`, `extension/src/protocol.js` | Any wire-incompatible change |

The extension and package versions are released **together and equal**. A release with the two
numbers apart is not a release. The protocol version is separate and changes far less often.

## Preconditions

Every one of these, in order. A skipped step is recorded as skipped, not as done.

1. **Clean tree.** `git status --porcelain` is empty. The release commit is tagged.
2. **All release-blocking gates pass** in `docs/TEST-MATRIX.md`, with evidence recorded in
   `docs/TEST-EVIDENCE.md` against the release commit.
3. **Typecheck clean.** `npm run typecheck`.
4. **Unit and end-to-end suites pass.** `npm run test:unit && npm run test:e2e`.
5. **Compatibility row present** in `docs/COMPATIBILITY.md` for the DeepSeek Harness versions this
   release supports, with evidence.
6. **Package hygiene.** The tarball and the ZIP contain only allowlisted files. No personal paths,
   emails, keys, secrets, machine names, `.env`, or debug output.
7. **Dependencies audited.** `npm audit` on the companion with no unaddressed high or critical
   findings; lockfile committed.
8. **Third-party notices current.** `THIRD-PARTY-NOTICES.md` matches the dependency set.

## Artifacts

| Artifact | Built by | Contains |
|---|---|---|
| `corsen-ai-dsh-browser-connector-<version>.tgz` | `npm pack` in `companion/` | `lib/`, `cordis.patch.yml`, `package.json`, `README.md` |
| `dsh-browser-connector-extension-<version>.zip` | `scripts/package.mjs` | `manifest.json`, `src/`, `assets/` — nothing else |
| `SHA256SUMS` | `scripts/package.mjs` | One line per artifact |
| `release-manifest.json` | `scripts/package.mjs` | Commit SHA, versions, artifact hashes, build timestamp |

The extension ZIP must be **byte-identical** across two builds from the same commit. Entry order
is sorted, timestamps are fixed, and no build-time value enters the archive.

## Packaging allowlist

The extension ZIP contains exactly:

```
manifest.json
src/background.js
src/bindings.js
src/i18n.js
src/page-actions.js
src/panel-state.js
src/protocol.js
src/redact.js
src/sidepanel.css
src/sidepanel.html
src/sidepanel.js
assets/icon-16.png
assets/icon-48.png
assets/icon-128.png
```

Packaging **fails** if any other file is present, and in particular if any executable or script
file not on this list appears. `extension/package.json` exists for Node tooling and is excluded.

## Steps

```bash
# 1. Bump the three versions where they live, in one commit.
# 2. Update docs/COMPATIBILITY.md and docs/TEST-EVIDENCE.md.
git tag -a v<version> -m "DeepSeek Harness Connector <version>"

# 3. Build and verify from the tagged, clean tree.
npm run build
npm run typecheck
npm run test:unit
npm run test:e2e
node scripts/package.mjs           # produces artifacts + SHA256SUMS + release-manifest.json
node scripts/verify-package.mjs    # allowlist, leakage scan, reproducibility check

# 4. Test the PACKAGED bits, not the source tree.
#    Load the built ZIP in Chromium and re-run the slice (gate AD).
#    Install the tarball into a fresh dsh profile (gate Y).

# 5. Record the artifact hashes in docs/TEST-EVIDENCE.md against the tag.
```

## Publishing

Publishing to npm and submitting to the Chrome Web Store are **manual actions requiring explicit
owner authorization**. This repository prepares everything for them and performs neither.

- npm: `npm publish --access public` from `companion/` at the tag.
- Chrome Web Store: upload the ZIP through the developer dashboard, using the material in `store/`.

## After publishing

- The GitHub release carries the ZIP, the tarball, `SHA256SUMS`, and `release-manifest.json`.
- `docs/COMPATIBILITY.md` is updated if the supported range changed.

## Rolling back

An extension version cannot be un-published from the Store, only superseded. A package version can
be deprecated on npm but not removed. Because the protocol version is checked for equality, an
extension that outruns the package produces a clear "update required" state rather than undefined
behaviour — that is the rollback safety net, and why the mismatch check must never be softened.
