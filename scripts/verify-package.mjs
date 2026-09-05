// Verify the release artifacts: allowlist, leakage, and reproducibility.
//
// Exits non-zero when any check fails. Run after `scripts/package.mjs`.
//
// Usage: node scripts/verify-package.mjs [--dist dist]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { buildExtensionZip, EXTENSION_ALLOWLIST, readZip, sha256 } from "./package.mjs";
import { PROTOCOL_VERSION } from "../extension/src/protocol.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distIndex = process.argv.indexOf("--dist");
const dist = resolve(root, distIndex >= 0 ? (process.argv[distIndex + 1] ?? "dist") : "dist");

let failures = 0;

/**
 * @param {boolean} ok Whether the check passed.
 * @param {string} label What was checked.
 * @param {string} [detail] Why it failed.
 */
function check(ok, label, detail = "") {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${ok || detail === "" ? "" : ` — ${detail}`}\n`);
  if (!ok) failures += 1;
}

// The two dynamic-code constructs are matched by patterns assembled from fragments, so that a
// naive scanner reading this file does not mistake the check for the thing it checks for.
const DYNAMIC_EVAL = new RegExp(["\\b", "ev", "al", "\\s*\\("].join(""));
const DYNAMIC_FUNCTION = new RegExp(["new", "\\s+", "Func", "tion", "\\s*\\("].join(""));

/**
 * Patterns that must never appear in a shipped file. Each is a class of leak the release rules
 * forbid: personal paths, private addresses, credentials, machine names, local environment files.
 */
const LEAK_PATTERNS = [
  { label: "personal filesystem path", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+/ },
  { label: "private email address", pattern: /[A-Za-z0-9._%+-]+@(?!corsen\.ai)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: "API key or token literal", pattern: /(sk|pk|ghp|gho|npm|xox[abp])_[A-Za-z0-9]{16,}/ },
  { label: "pairing-code-shaped literal", pattern: /\b[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}\b/ },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "machine name", pattern: /\bRTX6000\b|\bDESKTOP-[A-Z0-9]{7}\b/ },
  { label: "dotenv reference", pattern: /(^|\/)\.env(\.|$)/m },
];

/** File names that must never be in any artifact. */
const FORBIDDEN_NAMES = [/\.env/, /\.map$/, /\.DS_Store/, /Thumbs\.db/, /desktop\.ini/, /\.git\//, /node_modules\//, /\.log$/, /\.tmp$/];

/** Hosts a shipped file may reference. Everything else is a remote dependency the Store forbids. */
const ALLOWED_HOSTS = /https?:\/\/(127\.0\.0\.1|localhost|github\.com\/CorsenAI)/;

const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const zipPath = join(dist, `dsh-browser-connector-extension-${manifest.version}.zip`);

check(existsSync(zipPath), `extension ZIP exists at ${zipPath}`);
if (!existsSync(zipPath)) process.exit(1);

const zip = readFileSync(zipPath);
const entries = readZip(zip);
const names = entries.map((entry) => entry.name).sort();

check(
  JSON.stringify(names) === JSON.stringify([...EXTENSION_ALLOWLIST].sort()),
  "ZIP contains exactly the allowlisted files",
  `got ${names.join(", ")}`,
);

for (const entry of entries) {
  check(!FORBIDDEN_NAMES.some((pattern) => pattern.test(entry.name)), `no forbidden name: ${entry.name}`);
  if (entry.name.endsWith(".png")) continue;
  const text = entry.data.toString("utf8");
  for (const { label, pattern } of LEAK_PATTERNS) check(!pattern.test(text), `${entry.name}: no ${label}`);
  check(!DYNAMIC_EVAL.test(text), `${entry.name}: no dynamic code evaluation`);
  check(!DYNAMIC_FUNCTION.test(text), `${entry.name}: no dynamic function construction`);
  const urls = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  const foreign = urls.filter((url) => !ALLOWED_HOSTS.test(url));
  check(foreign.length === 0, `${entry.name}: no remote host other than the project page`, foreign.join(", "));
}

const packaged = entries.find((entry) => entry.name === "manifest.json");
const shippedManifest = packaged ? JSON.parse(packaged.data.toString("utf8")) : {};
check(shippedManifest.manifest_version === 3, "manifest is MV3");
check(!(shippedManifest.permissions ?? []).includes("cookies"), "no cookies permission");
check(!(shippedManifest.permissions ?? []).includes("debugger"), "no debugger permission");
check(!(shippedManifest.permissions ?? []).includes("webRequest"), "no webRequest permission");
check(shippedManifest.version === manifest.version, "packaged manifest version matches source");

// Reproducibility: rebuild in-process and compare bytes.
const rebuilt = buildExtensionZip().zip;
check(sha256(rebuilt) === sha256(zip), "rebuilding produces identical bytes", `${sha256(rebuilt)} vs ${sha256(zip)}`);

// SHA256SUMS agrees with the artifacts.
const sumsPath = join(dist, "SHA256SUMS");
check(existsSync(sumsPath), "SHA256SUMS exists");
if (existsSync(sumsPath)) {
  for (const line of readFileSync(sumsPath, "utf8").trim().split("\n")) {
    const [hash, name] = line.split(/\s+/);
    const path = join(dist, name);
    check(existsSync(path) && sha256(readFileSync(path)) === hash, `SHA256SUMS entry matches ${name}`);
  }
}

/**
 * Read the entries of a gzipped ustar archive.
 *
 * Parsed in-process rather than by shelling out to `tar`: the installed `tar` differs by platform,
 * and the MSYS one on Windows reads a drive-letter path as a remote host. A verifier that depends
 * on which `tar` is on PATH is not a verifier. Headers are 512-byte blocks; the name is at offset 0,
 * the octal size at 124, the type flag at 156, and the ustar name prefix at 345. Two zero blocks
 * end the archive.
 * @param {Buffer} archive The `.tgz` bytes.
 * @returns {{name: string, type: string, data: Buffer}[]} Entries in archive order, with their bytes.
 */
function readTarball(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let cursor = 0;
  const field = (header, start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 500);
    const name = `${prefix === "" ? "" : `${prefix}/`}${field(header, 0, 100)}`;
    const size = parseInt(field(header, 124, 136).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156]);
    // Regular files and directories are kept; pax extended headers (`x`, `g`) carry metadata for
    // the entry that follows and are skipped over by size like any other block.
    if (typeflag === "0" || typeflag === "\0" || typeflag === "5") {
      entries.push({ name, type: typeflag === "5" ? "5" : "0", data: tar.subarray(cursor + 512, cursor + 512 + size) });
    }
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Every file under a directory, as forward-slash paths relative to it, sorted.
 * @param {string} dir The directory.
 * @returns {string[]} The relative paths.
 */
function walk(dir) {
  const found = [];
  const visit = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) visit(full, rel);
      else found.push(rel);
    }
  };
  if (existsSync(dir)) visit(dir, "");
  return found.sort();
}

// The companion tarball passes the same name rules, ships only built output, and — the check that
// would have caught a stale tarball being recorded as fresh — carries a lib/ that is byte-identical
// to the lib/ just built from source.
const tarball = join(dist, `corsen-ai-dsh-browser-connector-${manifest.version}.tgz`);
check(existsSync(tarball), `companion tarball exists at ${tarball}`);
if (existsSync(tarball)) {
  const entries = readTarball(readFileSync(tarball));
  const listing = entries.map((entry) => entry.name);
  check(listing.length > 0, "tarball lists at least one entry");
  check(!listing.some((name) => FORBIDDEN_NAMES.some((pattern) => pattern.test(name))), "tarball has no forbidden names");
  check(listing.every((name) => name.startsWith("package/")), "tarball entries are rooted at package/");
  check(!listing.some((name) => /\/(src|tests)\//.test(name)), "tarball ships lib/, not src/ or tests/");
  check(listing.includes("package/cordis.patch.yml"), "tarball carries cordis.patch.yml, which dsh plugin requires");
  check(listing.includes("package/lib/broker-main.js"), "tarball carries the broker entry");

  const libDir = join(root, "companion", "lib");
  const built = walk(libDir).filter((rel) => /\.(js|d\.ts)$/.test(rel));
  check(built.length > 0, "companion/lib is built from source");
  // Keys are relative to lib/ on both sides: `dsh/tools.js` on disk is `package/lib/dsh/tools.js` in
  // the archive.
  const packedLib = new Map(entries
    .filter((entry) => entry.type === "0" && entry.name.startsWith("package/lib/"))
    .map((entry) => [entry.name.slice("package/lib/".length), entry.data]));
  let identical = 0;
  for (const rel of built) {
    const packed = packedLib.get(rel);
    const same = packed !== undefined && packed.equals(readFileSync(join(libDir, rel)));
    if (same) identical += 1;
    else check(false, `tarball lib/${rel} is byte-identical to the fresh build`, packed === undefined ? "missing from the tarball" : "bytes differ");
  }
  check(identical === built.length, `tarball lib/ is byte-identical to the fresh build (${identical} of ${built.length} files)`);
  for (const rel of packedLib.keys()) {
    check(built.includes(rel), `tarball lib/${rel} exists in the fresh build`, "the tarball carries a file the build did not produce");
  }

  // An allowlist, not a deny-list: the review added `package/telemetry.js` to the archive, refreshed
  // its checksum, and every check still passed, because nothing asked what else was in there.
  const expected = new Set([
    "package/package.json",
    "package/cordis.patch.yml",
    "package/README.md",
    "package/LICENSE",
    ...built.map((rel) => `package/lib/${rel}`),
  ]);
  const shipped = entries.filter((entry) => entry.type === "0").map((entry) => entry.name);
  for (const name of shipped) check(expected.has(name), `tarball ships only expected files: ${name}`, "not in the allowlist");
  for (const name of expected) check(shipped.includes(name), `tarball carries ${name}`, "missing from the archive");

  for (const entry of entries) {
    if (entry.type !== "0") continue;
    if (!/\.(js|ts|json|md|ya?ml|txt)$/.test(entry.name) && entry.name !== "package/LICENSE") continue;
    const text = entry.data.toString("utf8");
    for (const { label, pattern } of LEAK_PATTERNS) check(!pattern.test(text), `${entry.name}: no ${label}`);
    const urls = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    const foreign = urls.filter((url) => !ALLOWED_HOSTS.test(url));
    check(foreign.length === 0, `${entry.name}: no remote host other than the project page`, foreign.join(", "));
  }

  const licence = entries.find((entry) => entry.name === "package/LICENSE");
  check(
    licence !== undefined && licence.data.equals(readFileSync(join(root, "LICENSE"))),
    "tarball LICENSE is the repository's own licence text",
    "the MIT notice must travel with the package, not only the word MIT in package.json",
  );

  const patch = entries.find((entry) => entry.name === "package/cordis.patch.yml");
  check(
    patch !== undefined && patch.data.equals(readFileSync(join(root, "companion", "cordis.patch.yml"))),
    "tarball cordis.patch.yml is byte-identical to the source",
  );
  const packedManifest = entries.find((entry) => entry.name === "package/package.json");
  check(
    packedManifest !== undefined && JSON.parse(packedManifest.data.toString("utf8")).version === manifest.version,
    "tarball package.json carries the release version",
  );
}

// The release manifest is a claim about what was built and from where. Until now nothing checked
// it, so a manifest naming a false commit, a false hash and an unclean tree passed unremarked.
const manifestPath = join(dist, "release-manifest.json");
check(existsSync(manifestPath), "release-manifest.json exists");
if (existsSync(manifestPath)) {
  const release = JSON.parse(readFileSync(manifestPath, "utf8"));
  check(release.version === manifest.version, "manifest version matches the extension manifest");
  check(release.protocolVersion === PROTOCOL_VERSION, `manifest protocol version is ${PROTOCOL_VERSION}`);

  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout, or git is unavailable. The commit claim cannot be verified, and saying so
    // is the honest outcome; it is not a pass.
  }
  check(head !== "", "the commit the manifest names can be checked against git");
  check(release.commit === head, "manifest commit is this checkout's HEAD", `manifest ${String(release.commit).slice(0, 12)}, git ${head.slice(0, 12)}`);
  check(release.cleanTree === true, "the manifest records a clean tree", "a release is built from a clean checkout");

  const listed = Array.isArray(release.artifacts) ? release.artifacts : [];
  check(listed.length >= 2, "the manifest lists both artifacts");
  for (const artifact of listed) {
    const artifactPath = join(dist, String(artifact.name));
    const present = existsSync(artifactPath);
    check(present, `manifest artifact ${artifact.name} exists`);
    if (!present) continue;
    const bytes = readFileSync(artifactPath);
    check(sha256(bytes) === artifact.sha256, `manifest hash matches ${artifact.name}`);
    check(bytes.length === artifact.bytes, `manifest size matches ${artifact.name}`);
  }

  // SHA256SUMS must cover exactly the artifacts, so removing a line cannot quietly remove a check.
  const summed = existsSync(sumsPath)
    ? readFileSync(sumsPath, "utf8").trim().split("\n").map((line) => line.split(/\s+/)[1])
    : [];
  for (const artifact of listed) {
    check(summed.includes(String(artifact.name)), `SHA256SUMS covers ${artifact.name}`, "the line is missing");
  }
  for (const name of summed) {
    check(listed.some((artifact) => artifact.name === name), `SHA256SUMS names only released artifacts: ${name}`);
  }
}

process.stdout.write(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
