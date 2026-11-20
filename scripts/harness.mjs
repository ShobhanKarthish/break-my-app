#!/usr/bin/env node
// break-my-app harness: crawl a locally running app, attack it, and record what breaks.
//
//   node harness.mjs --url http://localhost:3000 --project <dir>
//        [--routes-file routes.json]   { "pages": ["/a"], "api": [{ "path": "/api/x", "methods": ["GET","POST"] }] }
//        [--packs mobile,inputs,network,api]   (the baseline crawl always runs)
//        [--quick]                      baseline + mobile + api only, fewer pages
//        [--max-pages 15] [--max-forms 3] [--max-api 40]
//        [--storage-state auth.json]    saved login, so pages behind auth are covered
//        [--out <dir>] [--headed]
//
// Writes report.md, findings.json, screenshots/ and repro/*.spec.ts into the output
// directory, and prints a one-line JSON summary on stdout. Progress goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, isLocalUrl, resolveDirs, resolvePlaywright, ensureOutDir, log, die } from './lib/common.mjs';
import { openPage, settle, inspect, observe, pathOf, isWrite } from './lib/probe.mjs';
import { discoverForms } from './lib/forms.mjs';
import { mobilePack, inputsPack, storedXssSweep, networkPack, apiPack } from './lib/packs.mjs';
import { writeRepros } from './lib/repro.mjs';
import { writeReport, sortFindings } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.url || args.url === true) die('missing --url (the address of the locally running app)');
if (!isLocalUrl(args.url)) {
  die(`refusing to attack ${args.url}: break-my-app only targets localhost. Fuzzing a deployed site can corrupt real data and may be illegal if the site is not yours.`);
}
const { project, out } = resolveDirs(args);
ensureOutDir(out);
const pw = resolvePlaywright(project, out);
if (!pw) die('Playwright is not available yet. Run setup.mjs first.');

const origin = new URL(args.url).origin;
const quick = !!args.quick;
const ALL_PACKS = ['mobile', 'network', 'inputs', 'api'];
const packs = args.packs && args.packs !== true ? String(args.packs).split(',').map((s) => s.trim()).filter(Boolean)
  : quick ? ['mobile', 'api'] : ALL_PACKS;
const bad = packs.filter((p) => !ALL_PACKS.includes(p));
if (bad.length) die(`unknown pack(s): ${bad.join(', ')}. Choose from ${ALL_PACKS.join(', ')}.`);

const opts = {
  maxPages: Number(args['max-pages'] || (quick ? 8 : 15)),
  maxForms: Number(args['max-forms'] || 3),
  maxApi: Number(args['max-api'] || 40),
  mobileViewport: { width: 375, height: 812 },
};
let routes = { pages: [], api: [] };
if (args['routes-file'] && args['routes-file'] !== true) {
  try { routes = { pages: [], api: [], ...JSON.parse(fs.readFileSync(String(args['routes-file']), 'utf8')) }; }
  catch (e) { die(`cannot read --routes-file: ${e.message}`); }
}
const storageState = args['storage-state'] && args['storage-state'] !== true ? path.resolve(String(args['storage-state'])) : undefined;
if (storageState && !fs.existsSync(storageState)) die(`--storage-state file not found: ${storageState}`);

// ───────────────────────────── run state ─────────────────────────────

class Findings {
  constructor() { this.map = new Map(); this.seq = 0; }
  /** Returns the finding if it is new, or null if it merged into an existing one. */
  add(f) {
    const prev = this.map.get(f.dedupe);
    if (prev) {
      prev.count++;
      if (f.variant && !prev.variants.includes(f.variant)) prev.variants.push(f.variant);
      if (f.path && !prev.paths.includes(f.path)) prev.paths.push(f.path);
      return null;
    }
    Object.assign(f, { seq: this.seq++, count: 1, variants: f.variant ? [f.variant] : [], paths: f.path ? [f.path] : [] });
    this.map.set(f.dedupe, f);
    return f;
  }
  list() { return [...this.map.values()]; }
}

const shotsDir = path.join(out, 'screenshots');
fs.rmSync(shotsDir, { recursive: true, force: true });
fs.mkdirSync(shotsDir, { recursive: true });
let shotN = 0;
const snap = async (page) => {
  const rel = `screenshots/shot-${String(++shotN).padStart(3, '0')}.png`;
  try { await page.screenshot({ path: path.join(out, rel), timeout: 5000 }); return rel; } catch { return null; }
};

const startedAt = new Date();
const browser = await pw.mod.chromium.launch({ headless: !args.headed });
const blockedExternal = [];
const seenApi = new Map(); // path -> Set(methods), learned from what the browser actually calls

async function makeContext(extra) {
  const context = await browser.newContext({ ...extra, storageState, ignoreHTTPSErrors: true });
  // Safety: the fuzzer may trigger calls to real third parties (payments, email, analytics).
  // Reads are allowed so the app still works; writes to anything off this machine are dropped.
  await context.route('**/*', (route) => {
    const req = route.request();
    if (isWrite(req.method()) && !isLocalUrl(req.url())) {
      blockedExternal.push(`${req.method()} ${new URL(req.url()).origin}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  context.on('request', (req) => {
    const t = req.resourceType();
    if ((t !== 'fetch' && t !== 'xhr') || !req.url().startsWith(origin)) return;
    const p = new URL(req.url()).pathname;
    if (!seenApi.has(p)) seenApi.set(p, new Set());
    seenApi.get(p).add(req.method());
  });
  return context;
}

const ctx = {
  origin, opts, snap,
  desktop: await makeContext({ viewport: { width: 1280, height: 800 } }),
  mobile: await makeContext({ viewport: opts.mobileViewport, hasTouch: true }),
  api: await pw.mod.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true, extraHTTPHeaders: { accept: 'application/json, text/plain, */*' } }),
  pages: [], known: new Set(), findings: new Findings(), eye: [],
  xssSources: new Map(), xssReported: new Set(), anonymous: !storageState,
  stats: { formsAttacked: 0, apiProbed: 0 },
};

// ───────────────────────────── baseline crawl ─────────────────────────────

const SKIP_LINK = /log-?out|sign-?out|\/delete|\/remove|\/destroy|unsubscribe/i;
const FILE_EXT = /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json|xml|txt|csv|mp4|mp3|woff2?)$/i;
const shape = (p) => p.split('?')[0].split('/').map((s) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^[0-9a-f]{16,}$/i.test(s) ? ':id' : s)).join('/') || '/';
const GLOBAL = new Set(['page-error', 'console-error', 'http-5xx', 'http-4xx', 'request-failed']);
const redirects = [];

async function baseline() {
  const queue = [{ path: pathOf(args.url) || '/', from: null }, ...routes.pages.map((p) => ({ path: p, from: 'routes file' }))];
  const seen = new Set();
  while (queue.length && ctx.pages.length < opts.maxPages) {
    const { path: p, from } = queue.shift();
    if (seen.has(shape(p))) continue;
    seen.add(shape(p));
    log(`  crawl: ${p}`);
    const { page, ev } = await openPage(ctx.desktop, origin);
    try {
      let res = null;
      try { res = await page.goto(origin + p, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
      catch (e) {
        ctx.findings.add({ detector: 'load-failed', pack: 'baseline', severity: 'high', path: p, where: p,
          title: `Page does not load (${p})`, detail: `Opening ${p} failed: ${String(e.message).split('\n')[0]}`, evidence: {},
          steps: [`Open ${p}`], repro: { kind: 'page', path: p, assert: 'blank' }, dedupe: `load-failed|${p}` });
        continue;
      }
      await settle(page);
      const state = await inspect(page);
      const status = res?.status() ?? null;
      const landed = state?.url ?? p;
      if (shape(landed) !== shape(p)) {
        redirects.push({ from: p, to: landed });
        if (seen.has(shape(landed))) continue; // e.g. many routes bouncing to /login
        seen.add(shape(landed));
      }
      const symptoms = await observe(ev, state);
      const rec = { path: landed, status, sig: new Set(), forms: [], apiOnLoad: ev.api.filter((a) => a.method === 'GET').map((a) => pathOf(a.url)), linkedFrom: from };
      for (const s of symptoms) {
        const k = `${s.detector}|${s.key}`;
        rec.sig.add(k);
        if (GLOBAL.has(s.detector)) ctx.known.add(k);
        const f = baselineFinding(s, landed, from);
        if (f) { const added = ctx.findings.add(f); if (added) added.shot = await snap(page); }
      }
      if (status !== null && status >= 400) continue; // an error page is a finding, not a page to attack
      rec.forms = await discoverForms(page).catch(() => []);
      ctx.pages.push(rec);

      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href)).catch(() => []);
      for (const href of links) {
        if (!href.startsWith(origin + '/') && href !== origin) continue;
        const lp = pathOf(href);
        if (SKIP_LINK.test(lp) || FILE_EXT.test(lp.split('?')[0])) continue;
        if (!seen.has(shape(lp))) queue.push({ path: lp, from: landed });
      }
    } finally { await page.close().catch(() => {}); }
  }
}

function baselineFinding(s, p, from) {
  const base = { pack: 'baseline', path: p, where: p, steps: [`Open ${p}`], evidence: {} };
  switch (s.detector) {
    case 'page-error':
      return { ...base, detector: s.detector, severity: 'high', title: `Uncaught exception on page load (${p})`,
        detail: `Just opening the page throws: ${s.message}`, evidence: { message: s.message, stack: s.stack },
        repro: { kind: 'page', path: p, assert: 'page-error' }, dedupe: `page-error|${s.key}` };
    case 'console-error':
      return { ...base, detector: s.detector, severity: 'low', title: `Console error on page load (${p})`,
        detail: `The browser console shows: ${s.message}`, evidence: { message: s.message },
        repro: { kind: 'page', path: p, assert: 'console-error' }, dedupe: `console-error|${s.key}` };
    case 'http-5xx':
      return { ...base, detector: s.detector, severity: 'high', title: `Server error ${s.status} on ${s.key} (loading ${p})`,
        detail: `${s.key} answered ${s.status} during a normal page load.` + (s.leaksStack ? ' The response body leaks a stack trace.' : ''),
        evidence: { status: s.status, request: s.key, body: (s.body || '').slice(0, 500) },
        repro: { kind: 'page', path: p, assert: 'http-5xx' }, dedupe: `http-5xx|${s.key}` };
    case 'http-4xx': {
      if (s.status === 401 || s.status === 403) return null; // normal for a visitor who is not logged in
      const reqPath = pathOf(s.url).split('?')[0];
      if (s.type === 'document') {
        return { ...base, detector: 'broken-page', severity: 'medium', title: `Broken page: ${p} answers ${s.status}`,
          detail: `${p} answers ${s.status}.` + (from ? ` It is linked from ${from}.` : ''), evidence: { status: s.status, linkedFrom: from },
          steps: from && from !== 'routes file' ? [`Open ${from}`, `Follow the link to ${p}`] : [`Open ${p}`],
          repro: { kind: 'page', path: p, assert: 'http-status', requestPath: reqPath }, dedupe: `broken-page|${reqPath}` };
      }
      const data = s.type === 'fetch' || s.type === 'xhr';
      return { ...base, detector: 'http-4xx', severity: data ? 'medium' : 'low', title: `${data ? 'API call' : 'Asset'} fails with ${s.status}: ${s.key} (loading ${p})`,
        detail: `${s.key} answered ${s.status} during a normal page load, so part of the page is missing or broken.`, evidence: { status: s.status, request: s.key, type: s.type },
        repro: { kind: 'page', path: p, assert: 'http-status', requestPath: reqPath }, dedupe: `http-4xx|${s.key}` };
    }
    case 'request-failed':
      return { ...base, detector: s.detector, severity: 'medium', title: `Request never completes: ${s.key} (loading ${p})`,
        detail: `${s.key} failed with ${s.why}. The page depends on something that is not reachable.`, evidence: { request: s.key, error: s.why },
        repro: { kind: 'page', path: p, assert: 'request-failed', requestPath: pathOf(s.url).split('?')[0] }, dedupe: `request-failed|${s.key}` };
    case 'blank-screen':
      return { ...base, detector: s.detector, severity: 'high', title: `Blank page (${p})`, detail: 'The page renders nothing at all: no text, no images, no controls.',
        repro: { kind: 'page', path: p, assert: 'blank' }, dedupe: `blank-screen|${p}` };
    case 'error-overlay':
    case 'error-screen':
      return { ...base, detector: s.detector, severity: 'high', title: `Raw error screen on page load (${p})`,
        detail: s.detector === 'error-overlay' ? 'A framework error overlay covers the page.' : `The page shows a raw error: "${s.key}".`,
        repro: { kind: 'page', path: p, assert: 'error-screen' }, dedupe: `${s.detector}|${p}` };
    default:
      return null; // xss cannot fire before anything was injected
  }
}

// ───────────────────────────── go ─────────────────────────────

let failure = null;
let apiRoutes = [];
try {
  log(`break-my-app → ${origin}  (packs: baseline, ${packs.join(', ')})`);
  await baseline();
  if (!ctx.pages.length) log('  no page loaded successfully; skipping the attack packs');
  else {
    if (packs.includes('mobile')) { log('pack: mobile'); await mobilePack(ctx); }
    if (packs.includes('network')) { log('pack: network'); await networkPack(ctx); }
    if (packs.includes('inputs')) { log('pack: inputs'); await inputsPack(ctx); await storedXssSweep(ctx); }
  }
  if (packs.includes('api')) {
    log('pack: api');
    const merged = new Map();
    for (const r of routes.api || []) merged.set(r.path, { source: 'repo', methods: new Set((r.methods?.length ? r.methods : ['GET']).map((m) => m.toUpperCase())) });
    for (const [p, methods] of seenApi) {
      if (!merged.has(p)) merged.set(p, { source: 'observed', methods: new Set() });
      methods.forEach((m) => merged.get(p).methods.add(m));
    }
    apiRoutes = [...merged].map(([p, r]) => ({ path: p, methods: [...r.methods], source: r.source }));
    await apiPack(ctx, apiRoutes);
  }
} catch (e) { failure = e; }
finally {
  await ctx.api.dispose().catch(() => {});
  await browser.close().catch(() => {});
}
if (failure) die(`harness crashed: ${failure.stack || failure}`);

// ───────────────────────────── output ─────────────────────────────

const findings = sortFindings(ctx.findings.list());
findings.forEach((f, i) => {
  f.id = `BMA-${String(i + 1).padStart(3, '0')}`;
  if (f.shot) {
    const rel = `screenshots/${f.id}.png`;
    try { fs.renameSync(path.join(out, f.shot), path.join(out, rel)); f.shot = rel; } catch { f.shot = null; }
  }
});
ctx.eye = ctx.eye.filter((e) => e.shot);
ctx.eye.forEach((e, i) => {
  const rel = `screenshots/eye-${String(i + 1).padStart(2, '0')}.png`;
  try { fs.renameSync(path.join(out, e.shot), path.join(out, rel)); e.shot = rel; } catch { /* keep the old name */ }
});

writeRepros(out, findings, { baseURL: origin, storageState });
const cfg = path.join(out, 'playwright.config.mjs');
const reproCommand = pw.base === out ? `cd ${JSON.stringify(out)} && npx playwright test` : `cd ${JSON.stringify(pw.base)} && npx playwright test -c ${JSON.stringify(cfg)}`;

const run = {
  url: origin, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
  packs: ['baseline', ...packs], stats: ctx.stats, reproCommand,
  pages: ctx.pages.map((p) => ({ path: p.path, status: p.status, apiOnLoad: p.apiOnLoad, forms: p.forms.map((f) => ({ name: f.name, skip: f.skip, fields: f.fields.length })) })),
  redirects, apiRoutes, blockedExternal, eye: ctx.eye,
  findings: findings.map(({ seq, dedupe, variant, ...f }) => f),
};
fs.writeFileSync(path.join(out, 'findings.json'), JSON.stringify(run, null, 2) + '\n');
writeReport(out, { ...run, findings });

const count = (sev) => findings.filter((f) => f.severity === sev).length;
process.stdout.write(JSON.stringify({
  report: path.join(out, 'report.md'), findingsFile: path.join(out, 'findings.json'),
  findings: { total: findings.length, high: count('high'), medium: count('medium'), low: count('low') },
  pages: ctx.pages.length, redirects, reproCommand,
}) + '\n');
