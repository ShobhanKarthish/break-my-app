// Turn a finding's recorded steps into a self-contained Playwright test that
// fails while the bug exists. Self-contained on purpose: a test can be moved into
// the project's own e2e folder without dragging helper files along.
import fs from 'node:fs';
import path from 'node:path';
import { slug } from './common.mjs';

const q = (s) => JSON.stringify(s);

function apiSpec(f) {
  const r = f.repro;
  const L = [];
  L.push(`test(${q(`${f.id}: ${f.title}`)}, async ({ playwright, baseURL }) => {`);
  L.push('  // A fresh client with no cookies: this is what a stranger on the internet sends.');
  L.push('  const anon = await playwright.request.newContext({ baseURL });');
  if (r.malformed) {
    L.push(`  const res = await anon.fetch(${q(r.path)}, {`);
    L.push(`    method: ${q(r.method)},`);
    L.push("    headers: { 'content-type': 'application/json' },");
    L.push("    data: Buffer.from('{\"bma\":'), // deliberately broken JSON, sent byte-for-byte");
    L.push('  });');
  } else {
    L.push(`  const res = await anon.get(${q(r.path)}, { maxRedirects: 0 });`);
  }
  if (r.assert === 'requires-auth') {
    L.push("  expect(res.status(), 'a request with no session should be refused or redirected').toBeGreaterThanOrEqual(300);");
  } else {
    L.push("  expect(res.status(), 'bad input should get a 4xx answer, not a server crash').toBeLessThan(500);");
  }
  L.push('  await anon.dispose();');
  L.push('});');
  return L;
}

function pageSpec(f) {
  const r = f.repro;
  const L = [];
  if (r.viewport) L.push(`test.use({ viewport: { width: ${r.viewport.width}, height: ${r.viewport.height} } });`, '');
  L.push('async function settle(page: Page) {');
  L.push("  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});");
  L.push('  await page.waitForTimeout(300);');
  L.push('}', '');
  L.push(`test(${q(`${f.id}: ${f.title}`)}, async ({ page }) => {`);

  // Collectors must be attached before anything happens.
  if (r.assert === 'page-error') L.push('  const pageErrors: string[] = [];', "  page.on('pageerror', (e) => pageErrors.push(e.message));");
  if (r.assert === 'console-error') {
    L.push('  const consoleErrors: string[] = [];');
    L.push("  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text()); });");
  }
  if (r.assert === 'http-5xx') {
    L.push('  const serverErrors: string[] = [];');
    L.push("  page.on('response', (res) => { if (res.status() >= 500) serverErrors.push(res.status() + ' ' + res.request().method() + ' ' + new URL(res.url()).pathname); });");
  }
  if (r.assert === 'http-status') {
    L.push('  const failed: string[] = [];');
    L.push(`  page.on('response', (res) => { if (res.status() >= 400 && new URL(res.url()).pathname === ${q(r.requestPath)}) failed.push(res.status() + ' ' + res.url()); });`);
  }
  if (r.assert === 'request-failed') {
    L.push('  const failed: string[] = [];');
    L.push(`  page.on('requestfailed', (req) => { if (new URL(req.url()).pathname === ${q(r.requestPath)}) failed.push(req.url()); });`);
  }
  if (r.assert === 'single-submit') {
    L.push('  const writes: string[] = [];');
    L.push("  page.on('request', (req) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push(req.method() + ' ' + new URL(req.url()).pathname); });");
  }
  // Markup that runs calls alert-free code, but apps under attack may pop dialogs: never hang on one.
  L.push("  page.on('dialog', (d) => d.dismiss().catch(() => {}));");

  if (r.fault) {
    L.push('', `  // Simulate the backend being down: ${r.fault === 'api-500' ? 'every API call answers 500' : 'every API call fails to connect'}.`);
    L.push("  await page.route('**/*', (route) => {");
    L.push("    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();");
    L.push(r.fault === 'api-500'
      ? "    return route.fulfill({ status: 500, contentType: 'application/json', body: '{\"error\":\"injected\"}' });"
      : "    return route.abort('failed');");
    L.push('  });');
  }

  L.push('', `  await page.goto(${q(r.path)});`, '  await settle(page);');

  const form = r.form;
  if (form) {
    L.push('');
    for (const fill of form.fills) {
      const loc = `page.locator(${q(fill.selector)}).first()`;
      if (fill.action === 'check') L.push(`  await ${loc}.check();`);
      else if (fill.action === 'select') L.push(`  await ${loc}.selectOption(${q(fill.value)});`);
      else L.push(`  await ${loc}.fill(${fill.code || q(fill.value)});`);
    }
    if (form.noValidate) {
      L.push('  // Skip the browser\'s built-in validation, as any script or curl command does.');
      L.push(`  await page.locator(${q(form.noValidate)}).evaluate((el) => { (el as HTMLFormElement).noValidate = true; });`);
    }
    if (form.offline) {
      L.push('  // The connection drops just before the user submits.');
      L.push("  await page.route('**/*', (route) => (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort('failed')));");
    }
    if (r.assert === 'feedback') {
      L.push("  const before = await page.locator('body').innerText();");
    }
    if (form.submit) L.push(`  await page.locator(${q(form.submit)}).first().${form.double ? 'dblclick' : 'click'}();`);
    else if (form.enter) L.push(`  await page.locator(${q(form.enter)}).first().press('Enter');`);
    L.push('  await settle(page);');
  }
  if (r.then) L.push('', `  await page.goto(${q(r.then)});`, '  await settle(page);');

  L.push('');
  switch (r.assert) {
    case 'page-error':
      L.push("  expect(pageErrors, 'the page should not throw uncaught exceptions').toEqual([]);"); break;
    case 'console-error':
      L.push("  expect(consoleErrors, 'the page should not log errors to the console').toEqual([]);"); break;
    case 'http-5xx':
      L.push("  expect(serverErrors, 'the server should answer bad input with a 4xx, not crash').toEqual([]);"); break;
    case 'http-status':
    case 'request-failed':
      L.push("  expect(failed, 'every request the page makes should succeed').toEqual([]);"); break;
    case 'blank':
      L.push("  const text = (await page.locator('body').innerText()).trim();");
      L.push("  expect(text.length, 'the page should show something, not a blank screen').toBeGreaterThan(0);"); break;
    case 'error-screen':
      L.push("  await expect(page.locator('body'), 'users should never see a raw framework error').not.toContainText(/Application error|Unhandled Runtime Error|Internal Server Error|Cannot (GET|POST) \\//);");
      L.push("  await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, [data-nextjs-dialog]')).toHaveCount(0);"); break;
    case 'overflow':
      L.push('  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);');
      L.push("  expect(overflow, 'the page should not scroll sideways on a phone').toBeLessThanOrEqual(1);"); break;
    case 'viewport-meta':
      L.push("  await expect(page.locator('meta[name=\"viewport\"]'), 'the page needs a mobile viewport tag').toHaveCount(1);"); break;
    case 'xss':
      L.push('  const ran = await page.evaluate(() => (window as any).__bma_xss ?? []);');
      L.push("  expect(ran, 'typed markup must be shown as text, never run as code').toEqual([]);"); break;
    case 'feedback':
      L.push("  const after = await page.locator('body').innerText();");
      L.push("  const alerts = await page.locator('[role=\"alert\"], [aria-invalid=\"true\"]').count();");
      L.push(`  expect(after !== before || alerts > ${r.alertsBefore ?? 0}, 'the page should tell the user the submit failed').toBe(true);`); break;
    case 'single-submit':
      L.push("  expect(writes.length, 'a double-click should send the request once').toBeLessThanOrEqual(1);"); break;
    default:
      L.push(`  throw new Error('break-my-app: no assertion for ${r.assert}');`);
  }
  L.push('});');
  return L;
}

export function specFor(f) {
  const head = [
    `// ${f.id} · ${f.severity} · ${f.detector}`,
    `// ${f.title}`,
    '// Generated by break-my-app. This test FAILS while the bug exists and should pass once it is fixed.',
  ];
  if (f.needsTriage) head.push(`// NEEDS TRIAGE: ${f.triageNote}`);
  const isApi = f.repro.kind === 'api';
  head.push(isApi ? "import { test, expect } from '@playwright/test';" : "import { test, expect, type Page } from '@playwright/test';", '');
  return [...head, ...(isApi ? apiSpec(f) : pageSpec(f))].join('\n') + '\n';
}

export function writeRepros(outDir, findings, { baseURL, storageState }) {
  const dir = path.join(outDir, 'repro');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of findings) {
    const name = `${f.id}-${slug(f.detector + '-' + (f.where || f.path))}.spec.ts`;
    fs.writeFileSync(path.join(dir, name), specFor(f));
    f.reproFile = `repro/${name}`;
  }
  const cfg = [
    '// Generated by break-my-app: runs the reproduction tests in ./repro against the local app.',
    'export default {',
    "  testDir: './repro',",
    '  timeout: 30000,',
    '  workers: 1,',
    "  reporter: [['list']],",
    '  use: {',
    `    baseURL: process.env.BMA_BASE_URL || ${q(baseURL)},`,
    ...(storageState ? [`    storageState: ${q(storageState)},`] : []),
    '  },',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'playwright.config.mjs'), cfg);
}
