// Verify the release artifacts: allowlist, leakage, and reproducibility.
//
// Exits non-zero when any check fails. Run after `scripts/package.mjs`.
//
// Usage: node scripts/verify-package.mjs [--dist dist]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { buildExtensionZip, EXTENSION_ALLOWLIST, sha256 } from "./package.mjs";

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

/**
 * Read a ZIP's central directory and inflate each entry.
 * @param {Buffer} zip The archive.
 * @returns {{ name: string, data: Buffer }[]} The entries.
 */
function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central directory");
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(dataStart, dataStart + compressed);
    entries.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
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
 * List the entries of a gzipped ustar archive.
 *
 * Parsed in-process rather than by shelling out to `tar`: the installed `tar` differs by platform,
 * and the MSYS one on Windows reads a drive-letter path as a remote host. A verifier that depends
 * on which `tar` is on PATH is not a verifier. Headers are 512-byte blocks; the name is at offset 0
 * and the octal size at 124. Two zero blocks end the archive.
 * @param {Buffer} archive The `.tgz` bytes.
 * @returns {string[]} Entry names, in archive order.
 */
function listTarball(archive) {
  const tar = gunzipSync(archive);
  const names = [];
  let cursor = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156]);
    // Regular files and directories are listed; pax extended headers (`x`, `g`) carry metadata for
    // the entry that follows and are skipped over by size like any other block.
    if (typeflag === "0" || typeflag === "\0" || typeflag === "5") names.push(name);
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

// The companion tarball, when present, passes the same name rules and ships only built output.
const tarball = join(dist, `corsen-ai-dsh-browser-connector-${manifest.version}.tgz`);
if (existsSync(tarball)) {
  const listing = listTarball(readFileSync(tarball));
  check(listing.length > 0, "tarball lists at least one entry");
  check(!listing.some((name) => FORBIDDEN_NAMES.some((pattern) => pattern.test(name))), "tarball has no forbidden names");
  check(listing.every((name) => name.startsWith("package/")), "tarball entries are rooted at package/");
  check(!listing.some((name) => /\/(src|tests)\//.test(name)), "tarball ships lib/, not src/ or tests/");
  check(listing.includes("package/cordis.patch.yml"), "tarball carries cordis.patch.yml, which dsh plugin requires");
  check(listing.includes("package/lib/broker-main.js"), "tarball carries the broker entry");
}

process.stdout.write(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
