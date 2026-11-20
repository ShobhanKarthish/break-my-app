#!/usr/bin/env node
// Self-test: run the whole pipeline against the deliberately broken demo app and
// check that every planted bug is found and the clean page is left alone.
//
//   node evals/selftest.mjs [--keep]     (--keep leaves the temp folder for inspection)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each entry is a bug planted in fixtures/broken-app/server.js: [detector, text the finding's location must contain].
const EXPECTED = [
  ['page-error', '/broken'],            // throws on load
  ['console-error', '/broken'],
  ['http-4xx', '/broken'],              // fetches a missing API route
  ['no-viewport-meta', '/broken'],
  ['broken-page', '/old-link'],         // dead link on the home page
  ['page-error', '/dashboard'],         // no error handling around fetch
  ['blank-screen', '/dashboard'],
  ['horizontal-overflow', '/wide'],
  ['xss', '/search'],                   // reflected
  ['xss', '/guestbook'],                // stored, fires on /wall
  ['http-5xx', '/signup'],              // long input reaches the "database"
  ['silent-failure', '/signup'],        // 400 with no message
  ['double-submit', '/signup'],
  ['api-open', '/api/users'],           // private data, no auth
  ['api-5xx', '/api/signup'],           // malformed JSON
];
const CLEAN = '/ok';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');
const keep = process.argv.includes('--keep');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bma-selftest-'));
const app = path.join(work, 'app');
fs.cpSync(path.join(here, 'fixtures', 'broken-app'), app, { recursive: true });

const run = (script, args, opts = {}) =>
  execFileSync(process.execPath, [path.join(scripts, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const lastJson = (out) => JSON.parse(out.trim().split('\n').at(-1));

let started = false;
let failed = [];
try {
  console.error('selftest: setting up Playwright…');
  run('setup.mjs', ['--project', app]);
  console.error('selftest: starting the demo app…');
  const { url } = lastJson(run('server.mjs', ['start', '--project', app]));
  started = true;
  console.error(`selftest: attacking ${url}…`);
  run('harness.mjs', ['--url', url, '--project', app, '--routes-file', path.join(app, 'routes.json')], { stdio: ['ignore', 'pipe', 'ignore'] });

  const { findings } = JSON.parse(fs.readFileSync(path.join(app, '.break-my-app', 'findings.json'), 'utf8'));
  const where = (f) => `${f.where || ''} ${f.path || ''}`;
  for (const [detector, place] of EXPECTED) {
    const hit = findings.some((f) => f.detector === detector && where(f).includes(place));
    console.log(`${hit ? 'ok  ' : 'MISS'}  ${detector.padEnd(20)} ${place}`);
    if (!hit) failed.push(`missed ${detector} at ${place}`);
  }
  const noise = findings.filter((f) => f.path === CLEAN || (f.paths || []).includes(CLEAN));
  console.log(`${noise.length ? 'FAIL' : 'ok  '}  no findings on the clean page ${CLEAN}`);
  for (const f of noise) failed.push(`false alarm on ${CLEAN}: ${f.detector} (${f.title})`);
  const missingTests = findings.filter((f) => !f.reproFile || !fs.existsSync(path.join(app, '.break-my-app', f.reproFile)));
  console.log(`${missingTests.length ? 'FAIL' : 'ok  '}  every finding has a reproduction test (${findings.length} findings)`);
  for (const f of missingTests) failed.push(`no test for ${f.id}`);
} catch (e) {
  failed.push(`pipeline error: ${String(e.message).split('\n')[0]}`);
} finally {
  if (started) { try { run('server.mjs', ['stop', '--project', app]); } catch { /* best effort */ } }
  if (keep) console.error(`selftest: kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}

if (failed.length) {
  console.error(`\nselftest FAILED:\n- ${failed.join('\n- ')}`);
  process.exit(1);
}
console.log('\nselftest passed');
