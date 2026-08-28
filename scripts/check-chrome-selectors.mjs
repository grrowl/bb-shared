#!/usr/bin/env node
/**
 * CI selector-pin: verify every chrome-shim selector still exists in a built
 * bb SPA, so a bb version bump that renames or removes one of our hide targets
 * fails CI instead of silently un-hiding owner-only chrome for guests.
 *
 * Source of truth: worker/src/chrome-selectors.ts. Each entry there carries a
 * `probe` — a stable substring (a `data-testid` value or an `aria-label` text)
 * that survives minification and appears verbatim in the built output. This
 * script greps the built SPA for every probe; any probe that appears in NO
 * file is drift, and the script exits non-zero naming it.
 *
 * We read the `.ts` file as text and extract the probes with a regex rather
 * than importing it, so the check stays a zero-dependency `.mjs` with no TS
 * loader / build step. The file format is controlled here, so the regex is
 * reliable; keep each entry's `css: '…'` single-quoted and `probe: "…"`
 * double-quoted.
 *
 * Usage:
 *   node scripts/check-chrome-selectors.mjs <spa-dist-path> [options]
 *
 *   <spa-dist-path>   Path to a built bb SPA (e.g. bb/apps/app/dist).
 *
 * Options:
 *   --ext <list>      Comma-separated file extensions to scan
 *                     (default: js,mjs,cjs,html,htm — i.e. built output).
 *                     Pass e.g. --ext tsx,ts,html to smoke-test against a bb
 *                     source tree that has not been built.
 *   --selectors <p>   Path to chrome-selectors.ts
 *                     (default: <repo>/worker/src/chrome-selectors.ts).
 *
 * Exit codes: 0 all probes present · 1 one or more probes missing (drift) ·
 * 2 usage / IO error (bad path, no candidate files, unreadable selectors).
 *
 * The audited bb version is pinned in the repo-root BB_VERSION file. Bump it
 * (and re-run this against the new build) whenever bb is upgraded.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_SELECTORS = join(REPO_ROOT, "worker", "src", "chrome-selectors.ts");
const DEFAULT_EXTS = ["js", "mjs", "cjs", "html", "htm"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function die(code, message) {
  process.stderr.write(`check-chrome-selectors: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  let ext = null;
  let selectors = DEFAULT_SELECTORS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ext") ext = argv[++i];
    else if (arg === "--selectors") selectors = argv[++i];
    else if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg.startsWith("--")) die(2, `unknown option: ${arg}`);
    else positional.push(arg);
  }
  const exts = (ext ? ext.split(",") : DEFAULT_EXTS)
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return { distPath: positional[0], exts, selectors };
}

/** Extract `{ css, probe }` pairs from the selectors .ts file text, in order. */
function loadSelectors(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    die(2, `cannot read selectors file ${path}: ${err.message}`);
  }
  const cssList = [...text.matchAll(/css:\s*'([^']+)'/g)].map((m) => m[1]);
  const probeList = [...text.matchAll(/probe:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (probeList.length === 0) {
    die(2, `no probes found in ${path} — expected \`probe: "…"\` entries`);
  }
  if (cssList.length !== probeList.length) {
    // Non-fatal: pair what we can, fall back to the probe as the label.
    process.stderr.write(
      `check-chrome-selectors: warning: ${cssList.length} css vs ` +
        `${probeList.length} probe entries — labels may be imprecise\n`,
    );
  }
  return probeList.map((probe, i) => ({ probe, css: cssList[i] ?? probe }));
}

/** Recursively collect files under `root` whose extension is in `exts`. */
function collectFiles(root, exts) {
  const out = [];
  const want = new Set(exts.map((e) => `.${e}`));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && want.has(extname(entry.name).toLowerCase())) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

function main() {
  const { help, distPath, exts, selectors } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(
      "Usage: node scripts/check-chrome-selectors.mjs <spa-dist-path> " +
        "[--ext js,html] [--selectors path]\n",
    );
    process.exit(0);
  }
  if (!distPath) die(2, "missing <spa-dist-path> argument (see --help)");
  if (!existsSync(distPath) || !statSync(distPath).isDirectory()) {
    die(2, `not a directory: ${distPath}`);
  }

  const pins = loadSelectors(selectors);
  const files = collectFiles(distPath, exts);
  if (files.length === 0) {
    die(
      2,
      `no .${exts.join("/.")} files under ${distPath} — is this a built SPA? ` +
        `For a source tree, pass e.g. --ext tsx,ts,html`,
    );
  }

  // A probe is satisfied by the first file that contains it.
  const missing = new Set(pins.map((p) => p.probe));
  for (const file of files) {
    if (missing.size === 0) break;
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable / binary — skip
    }
    for (const probe of [...missing]) {
      if (content.includes(probe)) missing.delete(probe);
    }
  }

  process.stdout.write(
    `check-chrome-selectors: scanned ${files.length} file(s) under ${distPath} ` +
      `for ${pins.length} selector probe(s)\n`,
  );

  if (missing.size > 0) {
    process.stderr.write(
      `\ncheck-chrome-selectors: DRIFT — ${missing.size} selector(s) not found ` +
        `in the built SPA. bb likely renamed or removed these; update ` +
        `worker/src/chrome-selectors.ts and BB_VERSION.\n\n`,
    );
    for (const { probe, css } of pins) {
      if (missing.has(probe)) {
        process.stderr.write(`  MISSING  ${css}\n           probe: "${probe}"\n`);
      }
    }
    process.exit(1);
  }

  process.stdout.write("check-chrome-selectors: OK — all selectors present\n");
  process.exit(0);
}

main();
