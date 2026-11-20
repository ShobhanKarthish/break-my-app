// Shared helpers for the break-my-app scripts. No dependencies beyond Node itself.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/** Minimal `--key value` / `--flag` parser. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/**
 * The harness only ever attacks a machine-local server. Fuzzing someone else's
 * site (or the user's own production) is exactly the harm this guard prevents.
 */
export function isLocalUrl(u) {
  let host;
  try { host = new URL(u).hostname; } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

export function resolveDirs(args) {
  const project = path.resolve(String(args.project || process.cwd()));
  const out = path.resolve(String(args.out || path.join(project, '.break-my-app')));
  return { project, out };
}

/**
 * Find @playwright/test: prefer the project's own copy (so generated tests run
 * with the version the repo already uses), else the private copy setup.mjs
 * installs into the output directory.
 */
export function resolvePlaywright(project, out) {
  for (const base of [project, out]) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      const mod = req('@playwright/test');
      const version = req('@playwright/test/package.json').version;
      return { base, mod, version };
    } catch { /* try the next location */ }
  }
  return null;
}

export function ensureOutDir(out) {
  fs.mkdirSync(out, { recursive: true });
  // Everything in here is evidence and runtime, never source: keep it out of git.
  const gi = path.join(out, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
}

export function log(...parts) { process.stderr.write(parts.join(' ') + '\n'); }

export function die(msg, code = 1) {
  process.stderr.write(`break-my-app: ${msg}\n`);
  process.exit(code);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'root';
}
