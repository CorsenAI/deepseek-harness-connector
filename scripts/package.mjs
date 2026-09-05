// Build the release artifacts deterministically.
//
// Produces the extension ZIP and the companion tarball, and writes SHA256SUMS and a release
// manifest. The tarball is built here from source — `lib/` is removed, compiled, and packed by
// npm — never picked up from `dist/`: an artifact that survives a source change unchanged is a
// stale artifact, and the first version of this script recorded exactly that.
// The ZIP is written by a small in-repo encoder rather than a dependency so that every
// byte is accounted for: entries are sorted, timestamps are fixed, there are no extra fields, and no
// build-time value enters the archive. Two builds from one commit produce identical bytes, which is
// what lets a reviewer verify that the submitted package is the tagged source.
//
// Usage: node scripts/package.mjs [--out dist]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionDir = join(root, "extension");
const companionDir = join(root, "companion");

/**
 * The complete list of files the Store package may contain. Anything else in `extension/` is a
 * packaging failure, not an oversight to be tolerated. `docs/RELEASE.md` carries the same list.
 */
export const EXTENSION_ALLOWLIST = Object.freeze([
  "manifest.json",
  "src/background.js",
  "src/bindings.js",
  "src/i18n.js",
  "src/page-actions.js",
  "src/panel-state.js",
  "src/protocol.js",
  "src/redact.js",
  "src/sidepanel.css",
  "src/sidepanel.html",
  "src/sidepanel.js",
  "assets/icon-16.png",
  "assets/icon-48.png",
  "assets/icon-128.png",
]);

/**
 * Files present in `extension/` for tooling that must never ship. Listed explicitly so a new
 * tooling file is a conscious addition here rather than a silent inclusion in the ZIP.
 */
export const EXTENSION_TOOLING = Object.freeze(["package.json", "tsconfig.json"]);

/** A fixed DOS date/time: 1980-01-01 00:00:00, the earliest ZIP can represent. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

/**
 * CRC-32 as ZIP requires.
 * @param {Uint8Array} bytes The data.
 * @returns {number} The checksum.
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode files as a deterministic ZIP.
 *
 * @param {{ name: string, data: Buffer }[]} entries Files, which are sorted by name here.
 * @returns {Buffer} The archive.
 */
export function deterministicZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store when deflate would not help, so the archive never grows for tiny files.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // no extra field
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attributes
    central.writeUInt32LE(0, 38);          // external attributes: none, so no host-specific mode leaks in
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Read a ZIP's central directory and inflate each entry.
 *
 * The decoder lives beside the encoder so the two are maintained together, and so a test can
 * unpack the exact bytes the packager produced and load them in a browser (gate AD).
 * @param {Buffer} zip The archive.
 * @returns {{ name: string, data: Buffer }[]} The entries, in central-directory order.
 */
export function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");
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

/**
 * Every file under a directory, as forward-slash relative paths.
 * @param {string} dir The directory.
 * @returns {string[]} Sorted relative paths.
 */
export function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const name of readDirSorted(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * @param {string} dir The directory.
 * @returns {string[]} Its entries, sorted for determinism.
 */
function readDirSorted(dir) {
  return readdirSync(dir).sort();
}

/**
 * @param {Buffer} bytes The data.
 * @returns {string} Lowercase hex SHA-256.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the extension ZIP from the allowlist, refusing any stray file.
 * @returns {{ zip: Buffer, files: string[] }} The archive and what went in.
 */
export function buildExtensionZip() {
  const present = listFiles(extensionDir);
  const allowed = new Set(EXTENSION_ALLOWLIST);
  const tooling = new Set(EXTENSION_TOOLING);
  const unexpected = present.filter((file) => !allowed.has(file) && !tooling.has(file));
  const missing = EXTENSION_ALLOWLIST.filter((file) => !present.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`refusing to package: unexpected files in extension/: ${unexpected.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`refusing to package: allowlisted files are missing: ${missing.join(", ")}`);
  }
  const entries = EXTENSION_ALLOWLIST.map((name) => ({ name, data: readFileSync(join(extensionDir, name)) }));
  return { zip: deterministicZip(entries), files: [...EXTENSION_ALLOWLIST] };
}

/**
 * Build the companion's `lib/` from source and pack it with npm, under this process's own Node.
 *
 * `lib/` is removed first so nothing from an earlier build can ride along, then compiled with the
 * companion's own TypeScript, then packed. `npm-cli.js` is run through `process.execPath` rather
 * than a shell, so a repository path with a space in it, like this one's, needs no quoting and
 * behaves the same on every platform.
 * @param {string} outDir Where the tarball is written.
 * @returns {{name: string, bytes: Buffer}} The tarball as npm produced it.
 */
export function buildCompanionTarball(outDir) {
  rmSync(join(companionDir, "lib"), { recursive: true, force: true });
  // One source of truth for the licence text: the repository's own, copied in for the package.
  copyFileSync(join(root, "LICENSE"), join(companionDir, "LICENSE"));
  execFileSync(process.execPath, [
    join(companionDir, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(companionDir, "tsconfig.build.json"),
  ], { cwd: companionDir, stdio: "inherit" });

  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "" && existsSync(candidate));
  const npmCli = candidates[0];
  if (!npmCli) throw new Error("npm-cli.js was not found next to the running Node; the companion cannot be packed");

  const report = execFileSync(process.execPath, [
    npmCli, "pack", "--pack-destination", outDir, "--json", "--loglevel", "error",
  ], { cwd: companionDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const [packed] = JSON.parse(report);
  if (!packed || typeof packed.filename !== "string") throw new Error("npm pack did not report a filename");
  return { name: packed.filename, bytes: readFileSync(join(outDir, packed.filename)) };
}

/**
 * Run when executed directly.
 */
function main() {
  const outIndex = process.argv.indexOf("--out");
  const outDir = resolve(root, outIndex >= 0 ? (process.argv[outIndex + 1] ?? "dist") : "dist");
  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
  const companion = JSON.parse(readFileSync(join(companionDir, "package.json"), "utf8"));
  if (manifest.version !== companion.version) {
    throw new Error(`extension ${manifest.version} and companion ${companion.version} must share one version`);
  }
  const version = manifest.version;

  let commit = "unknown";
  let clean = false;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    clean = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "";
  } catch {
    // Not a git checkout. The manifest records that rather than pretending.
  }

  const { zip, files } = buildExtensionZip();
  const zipName = `dsh-browser-connector-extension-${version}.zip`;
  writeFileSync(join(outDir, zipName), zip);

  const tarball = buildCompanionTarball(outDir);
  const artifacts = [{ name: zipName, bytes: zip }, tarball];

  const sums = artifacts.map((artifact) => `${sha256(artifact.bytes)}  ${artifact.name}`).join("\n");
  writeFileSync(join(outDir, "SHA256SUMS"), `${sums}\n`);

  writeFileSync(join(outDir, "release-manifest.json"), `${JSON.stringify({
    product: "DeepSeek Harness Connector",
    publisher: "Corsen AI",
    version,
    protocolVersion: 1,
    commit,
    cleanTree: clean,
    builtAt: new Date().toISOString(),
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      sha256: sha256(artifact.bytes),
      bytes: artifact.bytes.length,
    })),
    extensionFiles: files,
  }, null, 2)}\n`);

  process.stdout.write(`wrote ${zipName} (${zip.length} bytes, ${files.length} files)\n`);
  process.stdout.write(`sha256 ${sha256(zip)}\n`);
  process.stdout.write(`wrote ${tarball.name} (${tarball.bytes.length} bytes, built from source)\n`);
  process.stdout.write(`sha256 ${sha256(tarball.bytes)}\n`);
  if (!clean) process.stdout.write("warning: the working tree is not clean; this is not a release build\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
