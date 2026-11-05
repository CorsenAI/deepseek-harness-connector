// Source-similarity audit between this repository and the reference clones in .refs/.
//
// The mission forbids copying, translating, or line-by-line rewriting third-party source. Saying so
// is not evidence; this script produces the evidence. It compares two ways:
//
//   exact  — runs of identical normalised tokens. Catches pasted or lightly edited code.
//   shape  — the same, after every identifier becomes ID, every string STR, every number NUM.
//            Catches a line-by-line rewrite with renamed variables, which exact matching misses.
//
// Overlap with .refs/hermes-connector is reported separately from overlap with .refs/dsh-browser,
// because the first is Corsen's own code and expected, and the second must be nothing but
// unavoidable boilerplate. Every reported run is printed with both locations and its text, so the
// verdicts in docs/PROVENANCE-AUDIT.md are checkable rather than asserted.
//
// Usage: node scripts/provenance-audit.mjs [--exact 16] [--shape 40] [--json out.json]

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const EXACT_MIN = Number(argument("--exact", "16"));
const SHAPE_MIN = Number(argument("--shape", "40"));
const JSON_OUT = argument("--json", "");

/** Our own source, the subject of the audit. Documentation is excluded: prose is not code. */
const OURS = ["extension/src", "companion/src", "companion/tests", "scripts", "tests"].map((dir) => join(root, dir));

/** The references, each with the verdict expected of it. */
const REFERENCES = [
  { name: "dsh-browser", dir: join(root, ".refs", "dsh-browser"), expectation: "third-party: boilerplate only" },
  { name: "hermes-connector", dir: join(root, ".refs", "hermes-connector"), expectation: "Corsen-owned: overlap expected" },
];

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".html", ".css", ".yml", ".yaml", ".sh", ".ps1", ".py"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "lib", "coverage", ".scratch", "build"]);
const SKIP_FILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|.*\.min\.js|.*\.d\.ts)$/;

/**
 * Every source file under a directory.
 * @param {string} dir The directory.
 * @returns {string[]} Absolute paths, sorted.
 */
function sourceFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current).sort(); } catch { return; }
    for (const name of entries) {
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); continue; }
      if (SOURCE_EXT.has(extname(name)) && !SKIP_FILES.test(full.split("\\").join("/"))) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * Strip comments the way a reader would, well enough for matching. Not a parser; a `//` inside a
 * string is treated as a comment, which only makes the audit slightly more lenient toward a match.
 * @param {string} text Source text.
 * @param {string} ext File extension.
 * @returns {string} Text without comments.
 */
function stripComments(text, ext) {
  if (ext === ".sh" || ext === ".yml" || ext === ".yaml" || ext === ".py" || ext === ".ps1") {
    return text.replace(/^\s*#.*$/gm, "");
  }
  if (ext === ".html") {
    // Until nothing changes: one pass over "<!<!-- -->-- -->" would leave a comment behind.
    let previous;
    do { previous = text; text = text.replace(/<!--[\s\S]*?-->/g, ""); } while (text !== previous);
    return text;
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** One token: a word, a string literal, a number, or a single punctuation character. */
const TOKEN = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;

/** Words that are structure, not identity; they survive shape neutralisation. */
const KEYWORDS = new Set(("async await break case catch class const continue default delete do else export extends "
  + "finally for from function if import in instanceof let new null of return static super switch this throw "
  + "true false try typeof undefined var void while yield type interface readonly declare as is keyof "
  + "def elif except lambda pass raise with not and or None True False").split(" "));

/**
 * Tokenise one file into positioned tokens, in both exact and shape form.
 * @param {string} path The file.
 * @returns {{ exact: string[], shape: string[], lines: number[] }} Parallel arrays.
 */
function tokenise(path) {
  const ext = extname(path);
  const text = stripComments(readFileSync(path, "utf8"), ext);
  const exact = [];
  const shape = [];
  const lines = [];
  let line = 1;
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    line += (text.slice(last, match.index).match(/\n/g) ?? []).length;
    last = match.index;
    const token = match[0];
    exact.push(token);
    lines.push(line);
    if (/^["'`]/.test(token)) shape.push("STR");
    else if (/^\d/.test(token)) shape.push("NUM");
    else if (/^[A-Za-z_$]/.test(token)) shape.push(KEYWORDS.has(token) ? token : "ID");
    else shape.push(token);
  }
  return { exact, shape, lines };
}

/**
 * Index every k-token window of the reference files.
 * @param {{ path: string, tokens: string[], lines: number[] }[]} files Tokenised reference files.
 * @param {number} k Window length.
 * @returns {Map<string, { file: number, at: number }[]>} Window text to its locations.
 */
function index(files, k) {
  const table = new Map();
  files.forEach((file, fileIndex) => {
    for (let at = 0; at + k <= file.tokens.length; at += 1) {
      const key = file.tokens.slice(at, at + k).join("\u0001");
      const list = table.get(key);
      if (list) list.push({ file: fileIndex, at });
      else table.set(key, [{ file: fileIndex, at }]);
    }
  });
  return table;
}

/**
 * Find maximal shared runs of at least k tokens between our files and the reference index.
 * @param {{ path: string, tokens: string[], lines: number[] }[]} ours Tokenised subject files.
 * @param {{ path: string, tokens: string[], lines: number[] }[]} theirs Tokenised reference files.
 * @param {number} k Window length.
 * @returns {object[]} Runs, longest first.
 */
function sharedRuns(ours, theirs, k) {
  const table = index(theirs, k);
  const runs = [];
  for (const mine of ours) {
    const covered = new Set();
    for (let at = 0; at + k <= mine.tokens.length; at += 1) {
      if (covered.has(at)) continue;
      const hits = table.get(mine.tokens.slice(at, at + k).join("\u0001"));
      if (!hits) continue;
      for (const hit of hits) {
        const other = theirs[hit.file];
        let length = k;
        while (at + length < mine.tokens.length && hit.at + length < other.tokens.length
          && mine.tokens[at + length] === other.tokens[hit.at + length]) length += 1;
        for (let covering = at; covering < at + length; covering += 1) covered.add(covering);
        runs.push({
          length,
          ours: { file: relative(root, mine.path).split("\\").join("/"), line: mine.lines[at], endLine: mine.lines[at + length - 1] },
          theirs: { file: relative(root, other.path).split("\\").join("/"), line: other.lines[hit.at], endLine: other.lines[hit.at + length - 1] },
          text: mine.tokens.slice(at, at + Math.min(length, 60)).join(" ").slice(0, 300),
        });
        break; // One reference location per subject position is enough to establish the run.
      }
    }
  }
  // Drop runs wholly contained in a longer run at the same subject location.
  runs.sort((a, b) => b.length - a.length);
  const kept = [];
  for (const run of runs) {
    const inside = kept.some((longer) => longer.ours.file === run.ours.file
      && longer.ours.line <= run.ours.line && longer.ours.endLine >= run.ours.endLine && longer.length > run.length);
    if (!inside) kept.push(run);
  }
  return kept;
}

/**
 * The longest run of any length, for the headline statistic even when nothing crosses a threshold.
 * @param {object[]} ours Tokenised subject files.
 * @param {object[]} theirs Tokenised reference files.
 * @returns {object|null} The single longest shared run at a low window, or null.
 */
function longestRun(ours, theirs) {
  const runs = sharedRuns(ours, theirs, 6);
  return runs[0] ?? null;
}

const subject = OURS.flatMap(sourceFiles);
const subjectExact = subject.map((path) => ({ path, ...(() => { const t = tokenise(path); return { tokens: t.exact, lines: t.lines }; })() }));
const subjectShape = subject.map((path) => ({ path, ...(() => { const t = tokenise(path); return { tokens: t.shape, lines: t.lines }; })() }));

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: { exactTokens: EXACT_MIN, shapeTokens: SHAPE_MIN },
  subject: { files: subject.length, tokens: subjectExact.reduce((n, f) => n + f.tokens.length, 0) },
  references: [],
};

for (const reference of REFERENCES) {
  const files = sourceFiles(reference.dir);
  if (files.length === 0) {
    report.references.push({ name: reference.name, expectation: reference.expectation, missing: true });
    process.stdout.write(`${reference.name}: reference clone not found at ${reference.dir}\n`);
    continue;
  }
  const refExact = files.map((path) => ({ path, ...(() => { const t = tokenise(path); return { tokens: t.exact, lines: t.lines }; })() }));
  const refShape = files.map((path) => ({ path, ...(() => { const t = tokenise(path); return { tokens: t.shape, lines: t.lines }; })() }));

  const exact = sharedRuns(subjectExact, refExact, EXACT_MIN);
  const shape = sharedRuns(subjectShape, refShape, SHAPE_MIN);
  const longest = longestRun(subjectExact, refExact);

  // Coverage: what fraction of our tokens sit inside a reported run. Maximal runs at one subject
  // location do not overlap after de-duplication, so the sum is a true count, not an over-count.
  const coverage = (runs) => runs.reduce((n, run) => n + run.length, 0);
  const exactCovered = coverage(exact);
  const shapeCovered = coverage(shape);
  const percent = (n) => `${((100 * n) / report.subject.tokens).toFixed(2)}%`;

  report.references.push({
    name: reference.name,
    expectation: reference.expectation,
    files: files.length,
    tokens: refExact.reduce((n, f) => n + f.tokens.length, 0),
    longestExactRun: longest ? { length: longest.length, ours: longest.ours, theirs: longest.theirs, text: longest.text } : null,
    exactCoverage: { tokens: exactCovered, percentOfSubject: Number(((100 * exactCovered) / report.subject.tokens).toFixed(2)) },
    shapeCoverage: { tokens: shapeCovered, percentOfSubject: Number(((100 * shapeCovered) / report.subject.tokens).toFixed(2)) },
    exactRuns: exact,
    shapeRuns: shape,
  });

  process.stdout.write(`\n== ${reference.name} (${reference.expectation}) ==\n`);
  process.stdout.write(`reference: ${files.length} files, ${refExact.reduce((n, f) => n + f.tokens.length, 0)} tokens\n`);
  process.stdout.write(`longest exact shared run: ${longest ? `${longest.length} tokens — ours ${longest.ours.file}:${longest.ours.line}, theirs ${longest.theirs.file}:${longest.theirs.line}` : "none"}\n`);
  process.stdout.write(`exact runs >= ${EXACT_MIN} tokens: ${exact.length}, covering ${exactCovered} subject tokens (${percent(exactCovered)})\n`);
  process.stdout.write(`shape runs >= ${SHAPE_MIN} tokens: ${shape.length}, covering ${shapeCovered} subject tokens (${percent(shapeCovered)})\n`);
  for (const run of exact.slice(0, 40)) {
    process.stdout.write(`  [${run.length}] ${run.ours.file}:${run.ours.line}-${run.ours.endLine}  <->  ${run.theirs.file}:${run.theirs.line}-${run.theirs.endLine}\n      ${run.text}\n`);
  }
  for (const run of shape.slice(0, 40)) {
    process.stdout.write(`  [${run.length}] ${run.ours.file}:${run.ours.line}-${run.ours.endLine}  <->  ${run.theirs.file}:${run.theirs.line}-${run.theirs.endLine}\n`);
  }
}

process.stdout.write(`\nsubject: ${subject.length} files, ${report.subject.tokens} tokens\n`);
if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${JSON_OUT}\n`);
}

// Release gate. A copied function blows past a few dozen exact tokens at once, and a rewritten
// module raises coverage across many runs; either ceiling catches what the other might miss. The
// ceilings apply only to third-party references — overlap with Corsen's own Hermes is expected.
const MAX_RUN = Number(argument("--max-run", "0"));
const MAX_COVERAGE = Number(argument("--max-coverage", "0"));
if (MAX_RUN > 0 || MAX_COVERAGE > 0) {
  const breaches = [];
  for (const reference of report.references) {
    if (reference.missing || !reference.expectation.startsWith("third-party")) continue;
    const longest = reference.longestExactRun?.length ?? 0;
    if (MAX_RUN > 0 && longest >= MAX_RUN) {
      breaches.push(`${reference.name}: longest exact run ${longest} tokens reaches the ${MAX_RUN}-token ceiling (${reference.longestExactRun.ours.file}:${reference.longestExactRun.ours.line})`);
    }
    if (MAX_COVERAGE > 0 && reference.exactCoverage.percentOfSubject > MAX_COVERAGE) {
      breaches.push(`${reference.name}: exact coverage ${reference.exactCoverage.percentOfSubject}% exceeds the ${MAX_COVERAGE}% ceiling`);
    }
  }
  if (breaches.length > 0) {
    process.stdout.write(`\nAUDIT FAILED\n${breaches.map((line) => `  ${line}`).join("\n")}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`\naudit gate passed: no third-party exact run >= ${MAX_RUN} tokens, coverage <= ${MAX_COVERAGE}%\n`);
  }
}
