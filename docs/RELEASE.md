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
3. **Typecheck clean.** `npm run typecheck` — companion, extension, and the test tree.
4. **Every suite passes.** `npm run test` — unit, the page module in a real browser, and the end-to-end suites including the released pair (which needs a real `dsh`; see `tests/e2e/released-pair.test.ts`).
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
| `corsen-ai-dsh-browser-connector-<version>.tgz` | `scripts/package.mjs` — removes `lib/`, compiles it with the companion's TypeScript, then runs `npm pack` under the same Node | `lib/`, `cordis.patch.yml`, `package.json`, `README.md` |
| `dsh-browser-connector-extension-<version>.zip` | `scripts/package.mjs` | `manifest.json`, `src/`, `assets/` — nothing else |
| `SHA256SUMS` | `scripts/package.mjs` | One line per artifact |
| `release-manifest.json` | `scripts/package.mjs` | Commit SHA, versions, artifact hashes, build timestamp |

The extension ZIP must be **byte-identical** across two builds from the same commit. Entry order
is sorted, timestamps are fixed, and no build-time value enters the archive.

The tarball is never picked up from `dist/`: `scripts/package.mjs` builds it from source every time,
and `scripts/verify-package.mjs` proves that every `lib/` file inside it is byte-identical to the
`lib/` just compiled. An earlier version of the packager recorded whatever tarball already sat in
`dist/`, which silently shipped stale code; that is why this check exists.

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
npm run test:page
npm run test:e2e                   # real browser; the released-pair suite needs dist/ and a real dsh (DSH_BIN_DIR)
node scripts/package.mjs           # builds lib/, packs the tarball, builds the ZIP, writes SHA256SUMS + release-manifest.json
node scripts/verify-package.mjs    # allowlist, leakage scan, reproducibility, frozen permissions, tarball lib/ identical to the fresh build
node --experimental-strip-types scripts/capture-screenshots.ts   # the Store screenshots, from this build

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

## Code signing on macOS and Windows

Nothing this project ships is a native executable, so **no signing certificate is required today**:

- The companion is an npm package (`@corsen-ai/dsh-browser-connector`) of plain JavaScript that
  runs under the user's own Node.js, installed by `dsh plugin ... add`. It is the same trust model
  as DeepSeek Harness itself, which is also an npm package. macOS Gatekeeper and notarization apply
  to Mach-O binaries, `.app` bundles, and `.pkg` installers, none of which exist here.
- The Chrome extension is signed by the Chrome Web Store at publication; nothing is signed locally.

**That answers whether we need a certificate. It does not answer whether the install path works on
a machine that has just downloaded these files, and the two are not the same question** — a point
an external review made on 2026-09-05, correctly. The operating systems apply controls to scripts as
well as to binaries, by how the file arrives and how it is opened:

| Path | What the OS does | State |
|---|---|---|
| `bash install.sh` in Terminal, from a clone | Nothing; Gatekeeper gates *launching* quarantined applications, not an interpreter reading a file | verified on Linux and macOS |
| `install.sh` downloaded by a browser, then run in Terminal | The file carries `com.apple.quarantine`; running it through `bash`, and running it directly as `./install.sh`, both work and leave the attribute in place | **verified on macOS 26.6, 2026-09-11**: the attribute Chrome writes (`0083;…;Google Chrome;…`) was set on the file, both runs installed and started the broker, the attribute was unchanged afterwards |
| `install.sh` double-clicked in Finder | macOS opens a `.sh` file in its default text handler rather than executing it; the installer is documented as a Terminal command and nothing else | not a launch path; no claim made |
| `Install Connector.cmd` double-clicked on Windows | The wrapper passes `-ExecutionPolicy Bypass` to **that one PowerShell process**, which changes no machine or user setting. With Mark-of-the-Web on both files, run from a console it installs and starts the broker | **verified on Windows 11, 2026-09-11** from a console with both files marked; the Explorer double-click, where SmartScreen may show a dialog, cannot be exercised over SSH and stays a manual check |
| `install.ps1` run directly by a user whose policy is `RemoteSigned` (Windows 11's default for the current user) and whose file is marked from the web | PowerShell refuses: "cannot be loaded. The file … is not digitally signed"; nothing is created. The user runs the `.cmd` instead, or unblocks that one file with `Unblock-File` | **verified on Windows 11, 2026-09-11**: refused with 0 files created; after `Unblock-File` on that file alone the direct run installed |

Whatever a platform does, the answer is never to tell a user to turn a protection off globally: no
`Set-ExecutionPolicy Unrestricted` for the machine, and no blanket `xattr -dr
com.apple.quarantine` over a directory. Per-file, per-process, and explained, or not at all.

If a native artifact is ever introduced — a menu-bar helper, a single-file executable of the
broker, a `.pkg` or `.msi` — the requirements become:

| Platform | What is needed | Command shape |
|---|---|---|
| macOS | Apple Developer Program membership; a *Developer ID Application* certificate (and *Developer ID Installer* for a `.pkg`); hardened runtime; a secure timestamp; notarization with `notarytool`; stapling | `codesign --sign "Developer ID Application: Corsen AI (TEAMID)" --options runtime --timestamp <bundle>` then `xcrun notarytool submit <zip|pkg> --keychain-profile <profile> --wait` then `xcrun stapler staple <bundle>` |
| Windows | An Authenticode code-signing certificate (OV, or EV to avoid the SmartScreen reputation ramp-up), a timestamp server | `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a <file>` |

Both would run in CI from secrets, never from a developer machine, and the resulting hashes would be
recorded in `release-manifest.json` like every other artifact. Until such an artifact exists, this
section is a plan, not a process.
