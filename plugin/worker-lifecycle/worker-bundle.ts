// Worker bundling for the deploy pipeline (issue 07).
//
// The `cloudflare` SDK's `scripts.update` wants a single pre-bundled ESM module
// string. The worker source (`worker/`) is multi-file TypeScript with a DO
// class re-export, so we lean on wrangler's own esbuild step in dry-run mode
// (`wrangler deploy --dry-run --outdir <tmp>`) rather than reimplementing the
// bundle — this keeps the worker's `wrangler.toml` (bindings, compat date, DO
// migration) the single source of truth and avoids adding wrangler as a
// *runtime* dep (it stays a devDep of `worker/`, invoked via its local bin).
//
// We deliberately do NOT modify `worker/` (owned concurrently by 09/10/12); we
// only read its build output. `--dry-run` performs no network I/O and no
// deploy — it just writes `worker.js` to the out dir.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface BundleOptions {
  /** Absolute path to the `worker/` package (holds wrangler.toml). */
  workerDir: string;
  /** Injectable runner for tests. Defaults to a real wrangler dry-run. */
  runBuild?: (workerDir: string, outDir: string) => Promise<void>;
  log?: { info?(m: string): void; warn(m: string): void };
}

/** 16 MiB ceiling on captured wrangler stdout/stderr — bundles are far smaller. */
const MAX_BUFFER = 16 * 1024 * 1024;

async function wranglerDryRun(workerDir: string, outDir: string): Promise<void> {
  await execFileAsync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "--outdir", outDir],
    { cwd: workerDir, env: process.env, maxBuffer: MAX_BUFFER },
  );
}

/**
 * Bundle the worker and return its ESM source as a string. wrangler names the
 * entry after `main`'s basename (`src/worker.ts` → `worker.js`, per
 * worker/README.md); if that is absent we fall back to the single `.js` file
 * wrangler emitted.
 */
export async function bundleWorker(opts: BundleOptions): Promise<string> {
  const runBuild = opts.runBuild ?? wranglerDryRun;
  const outDir = await mkdtemp(join(tmpdir(), "bb-shared-"));
  try {
    opts.log?.info?.(`bundling worker from ${opts.workerDir}`);
    await runBuild(opts.workerDir, outDir);
    try {
      return await readFile(join(outDir, "worker.js"), "utf8");
    } catch {
      const entries = await readdir(outDir);
      const jsFile = entries.find((f) => f.endsWith(".js"));
      if (!jsFile) {
        throw new Error(
          `worker bundle produced no .js entry in ${outDir} (found: ${entries.join(", ") || "nothing"})`,
        );
      }
      return await readFile(join(outDir, jsFile), "utf8");
    }
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
