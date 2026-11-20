#!/usr/bin/env node
// Start (or stop) the project's dev server and report the URL it listens on.
//
//   node server.mjs start --project <dir> [--cmd "npm run dev"] [--port 3000] [--timeout 120]
//   node server.mjs stop  --project <dir>
//
// `start` prints one JSON line: { url, pid, cmd, log, reused }
// The server keeps running after this script exits; `stop` shuts it down.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveDirs, ensureOutDir, log, die } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const action = args._[0];
const { project, out } = resolveDirs(args);
const stateFile = path.join(out, 'server.json');
const logFile = path.join(out, 'server.log');
const COMMON_PORTS = [3000, 5173, 4321, 8080, 4200, 8000, 5000, 3001, 5174, 8888];

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function responds(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return res.status > 0;
  } catch { return false; }
}

function detectCommand() {
  if (args.cmd) return String(args.cmd);
  const pkgPath = path.join(project, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    die('no package.json here, so I cannot guess the dev command. Pass --cmd "<command that starts the app>".');
  }
  const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {};
  const name = ['dev', 'start', 'serve', 'develop'].find((n) => scripts[n]);
  if (!name) die(`package.json has no dev/start/serve script (found: ${Object.keys(scripts).join(', ') || 'none'}). Pass --cmd.`);
  const has = (f) => fs.existsSync(path.join(project, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
  return `${pm} run ${name}`;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

async function start() {
  ensureOutDir(out);
  const prev = readState();
  if (prev && alive(prev.pid) && (await responds(prev.url))) {
    process.stdout.write(JSON.stringify({ ...prev, reused: true }) + '\n');
    return;
  }

  const cmd = detectCommand();
  const timeoutMs = Number(args.timeout || 120) * 1000;

  // Ports that already answer belong to something else; never mistake them for this app.
  const busy = new Set();
  await Promise.all(COMMON_PORTS.map(async (p) => { if (await responds(`http://localhost:${p}`)) busy.add(p); }));
  if (args.port && busy.has(Number(args.port))) die(`port ${args.port} is already in use by another process`);

  const fd = fs.openSync(logFile, 'w');
  const env = { ...process.env, BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' };
  if (args.port) env.PORT = String(args.port);
  const child = spawn(cmd, { cwd: project, shell: true, detached: true, stdio: ['ignore', fd, fd], env });
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 1; });
  child.unref();
  log(`Starting: ${cmd}`);

  const deadline = Date.now() + timeoutMs;
  const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/g;
  let url = null;
  while (Date.now() < deadline && !url) {
    await new Promise((r) => setTimeout(r, 500));
    const text = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    if (exited !== null) {
      die(`the dev server exited with code ${exited} before it was ready.\n--- last output ---\n${text.split('\n').slice(-25).join('\n')}`);
    }
    const candidates = new Set();
    if (args.port) candidates.add(Number(args.port));
    for (const m of text.matchAll(urlRe)) candidates.add(Number(m[1]));
    // Quiet servers never print a URL: after a grace period, look for a newly opened common port.
    if (Date.now() > deadline - timeoutMs + 8000) COMMON_PORTS.filter((p) => !busy.has(p)).forEach((p) => candidates.add(p));
    for (const p of candidates) {
      if (busy.has(p)) continue;
      if (await responds(`http://localhost:${p}`)) { url = `http://localhost:${p}`; break; }
    }
  }
  if (!url) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n');
    die(`the dev server did not answer within ${timeoutMs / 1000}s.\n--- last output ---\n${tail}`);
  }

  const state = { url, pid: child.pid, cmd, log: logFile, startedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ...state, reused: false }) + '\n');
  process.exit(0);
}

function stop() {
  const state = readState();
  if (!state) { process.stdout.write(JSON.stringify({ stopped: false, reason: 'no server was started by break-my-app' }) + '\n'); return; }
  let stopped = false;
  if (alive(state.pid)) {
    // The dev command runs under a shell, so signal the whole process group.
    try { process.kill(-state.pid, 'SIGTERM'); stopped = true; } catch {
      try { process.kill(state.pid, 'SIGTERM'); stopped = true; } catch { /* already gone */ }
    }
  }
  fs.rmSync(stateFile, { force: true });
  process.stdout.write(JSON.stringify({ stopped, pid: state.pid }) + '\n');
}

if (action === 'start') await start();
else if (action === 'stop') stop();
else die('usage: server.mjs <start|stop> --project <dir> [--cmd "..."] [--port N] [--timeout seconds]');
