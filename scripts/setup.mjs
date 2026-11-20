#!/usr/bin/env node
// Make sure Playwright and a Chromium build are available, without touching the
// project's own package.json.
//
//   node setup.mjs --project <dir> [--out <dir>]
//
// Prints one JSON line: { ok, playwrightFrom, version, installed }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveDirs, resolvePlaywright, ensureOutDir, log, die } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const { project, out } = resolveDirs(args);
if (!fs.existsSync(project)) die(`project directory not found: ${project}`);
ensureOutDir(out);

const installed = [];
let pw = resolvePlaywright(project, out);

if (!pw) {
  // Install into the output directory, which is git-ignored, so the project's
  // dependencies and lockfile stay exactly as the user left them.
  const pkg = path.join(out, 'package.json');
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name: 'break-my-app-runtime', private: true }, null, 2) + '\n');
  }
  log('Installing @playwright/test into', out, '(one-time)…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--save-dev', '@playwright/test'], {
    cwd: out, stdio: ['ignore', 2, 2], shell: process.platform === 'win32',
  });
  if (r.status !== 0) die('npm install @playwright/test failed (see output above)');
  installed.push('@playwright/test');
  pw = resolvePlaywright(project, out);
  if (!pw) die('installed @playwright/test but still cannot load it');
}

async function canLaunch() {
  try {
    const b = await pw.mod.chromium.launch();
    await b.close();
    return true;
  } catch (e) {
    log(String(e.message || e).split('\n')[0]);
    return false;
  }
}

if (!(await canLaunch())) {
  log('Downloading Chromium for Playwright (one-time)…');
  const r = spawnSync('npx', ['--no-install', 'playwright', 'install', 'chromium'], {
    cwd: pw.base, stdio: ['ignore', 2, 2], shell: process.platform === 'win32',
  });
  if (r.status !== 0) die('`playwright install chromium` failed (see output above)');
  installed.push('chromium');
  if (!(await canLaunch())) die('Chromium still fails to launch after install');
}

process.stdout.write(JSON.stringify({ ok: true, playwrightFrom: pw.base, version: pw.version, installed }) + '\n');
