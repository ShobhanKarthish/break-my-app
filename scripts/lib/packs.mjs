// The attack packs. Each takes the shared run context and records findings.
//   ctx = { origin, desktop, mobile, api, pages, known, findings, snap, eye, opts, stats }
import { openPage, settle, inspect, observe, pathOf, isWrite, STACK_LEAK } from './probe.mjs';
import { PAYLOADS, VALID, planFills, applyFills, bypassValidation, submitForm, describeSteps, formRepro } from './forms.mjs';
import { log } from './common.mjs';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 20000 };
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s);

async function record(ctx, page, finding) {
  const added = ctx.findings.add(finding);
  if (added && page) added.shot = await ctx.snap(page);
  return added;
}

/** The UI gave the user no sign that anything happened. */
const noFeedback = (before, after) => !!before && !!after && after.text === before.text && after.alerts <= before.alerts && after.url === before.url;

const sinceMark = (ev, mark) => ({
  console: ev.console.slice(mark.console), pageErrors: ev.pageErrors.slice(mark.pageErrors), bad: ev.bad.slice(mark.bad),
  failed: ev.failed.slice(mark.failed), api: ev.api.slice(mark.api), writes: ev.writes.slice(mark.writes), pending: ev.pending,
});
const markOf = (ev) => ({ console: ev.console.length, pageErrors: ev.pageErrors.length, bad: ev.bad.length, failed: ev.failed.length, api: ev.api.length, writes: ev.writes.length });

// ───────────────────────────── mobile ─────────────────────────────

export async function mobilePack(ctx) {
  for (const p of ctx.pages) {
    const { page } = await openPage(ctx.mobile, ctx.origin);
    try {
      await page.goto(ctx.origin + p.path, GOTO);
      await settle(page);
      const s = await inspect(page);
      if (!s) continue;
      if (s.scrollWidth > s.clientWidth + 1) {
        const worst = s.offenders.map((o) => `${o.el} (${o.width}px wide, ends at ${o.right}px)`).join('; ');
        await record(ctx, page, {
          detector: 'horizontal-overflow', pack: 'mobile', severity: 'medium', path: p.path,
          title: `Page scrolls sideways on a phone (${p.path})`,
          detail: `At 375px wide the page content is ${s.scrollWidth}px wide, so it overflows by ${s.scrollWidth - s.clientWidth}px.` + (worst ? ` Widest offenders: ${worst}.` : ''),
          evidence: { scrollWidth: s.scrollWidth, viewportWidth: s.clientWidth, offenders: s.offenders },
          steps: ['Set the browser to 375×812 (iPhone-sized)', `Open ${p.path}`, 'Scroll sideways'],
          repro: { kind: 'page', path: p.path, viewport: ctx.opts.mobileViewport, assert: 'overflow' },
          // A shared header or nav overflows on every page: report it once, listing the pages.
          dedupe: `horizontal-overflow|${s.offenders[0]?.el ?? p.path}|${s.scrollWidth}`,
        });
      }
      if (!s.viewportMeta) {
        await record(ctx, page, {
          detector: 'no-viewport-meta', pack: 'mobile', severity: 'medium', path: p.path,
          title: 'No mobile viewport tag: phones will render the desktop layout zoomed out',
          detail: 'The page has no <meta name="viewport">. Without it, phones lay the page out about 980px wide and shrink it, so text is tiny and responsive CSS never applies.',
          evidence: {}, steps: [`Open ${p.path} on a phone`],
          repro: { kind: 'page', path: p.path, assert: 'viewport-meta' },
          dedupe: 'no-viewport-meta',
        });
      }
    } catch (e) { log(`  mobile: ${p.path}: ${String(e.message).split('\n')[0]}`); }
    finally { await page.close().catch(() => {}); }
  }
}

// ───────────────────────────── inputs ─────────────────────────────

export async function inputsPack(ctx) {
  for (const [pi, p] of ctx.pages.entries()) {
    const forms = p.forms.filter((f) => !f.skip).slice(0, ctx.opts.maxForms);
    for (const form of forms) {
      log(`  inputs: ${p.path} · ${form.name}`);
      const tag = `p${pi}f${form.index}`;
      ctx.xssSources.set(tag, { path: p.path, form });
      for (const payload of PAYLOADS) await attackForm(ctx, p, form, payload, tag, {});
      await attackForm(ctx, p, form, VALID, tag, { double: true });
      ctx.stats.formsAttacked++;
    }
  }
}

async function attackForm(ctx, p, form, payload, tag, { double = false }) {
  const { page, ev } = await openPage(ctx.desktop, ctx.origin);
  try {
    await page.goto(ctx.origin + p.path, GOTO);
    await settle(page);
    const fills = await applyFills(page, planFills(form, payload, tag));
    // Ordinary-user payloads keep the browser's validation on; hostile ones switch it off.
    const bypassed = payload === VALID || payload.requiredOnly ? false : await bypassValidation(page, form);
    const before = await inspect(page);
    const pre = new Set((await observe(ev, before)).map((s) => `${s.detector}|${s.key}`));
    const mark = markOf(ev);
    if (!(await submitForm(page, form, { double }))) return;
    await settle(page, 4000);
    const after = await inspect(page);
    const post = sinceMark(ev, mark);
    const symptoms = await observe(post, after);

    const opt = { bypassed, double };
    const steps = describeSteps(p.path, form, fills, opt);
    const fr = formRepro(form, fills, opt);
    const where = `${p.path} · ${form.name}`;
    const variant = double ? 'valid values, double-click' : payload.name;
    const silent = noFeedback(before, after);
    const base = { pack: 'inputs', path: p.path, where, steps, variant };
    const withInput = double ? 'on a normal submit' : `when a form is submitted with ${payload.what}`;

    for (const s of symptoms) {
      const k = `${s.detector}|${s.key}`;
      if (pre.has(k) || ctx.known.has(k)) continue; // already broken before we touched anything
      if (s.detector === 'page-error') {
        await record(ctx, page, { ...base, detector: 'page-error', severity: 'high',
          title: `Uncaught exception ${withInput} (${where})`,
          detail: `The page threw: ${clip(s.message)}`, evidence: { message: s.message, stack: s.stack },
          repro: { kind: 'page', path: p.path, form: fr, assert: 'page-error' }, dedupe: `page-error|${where}|${s.key}` });
      } else if (s.detector === 'http-5xx') {
        await record(ctx, page, { ...base, detector: 'http-5xx', severity: 'high',
          title: `Server error ${s.status} on ${s.key} ${withInput} (${where})`,
          detail: `${s.key} answered ${s.status}.` + (silent ? ' The page showed the user nothing.' : '') + (s.leaksStack ? ' The response body leaks a stack trace.' : ''),
          evidence: { status: s.status, request: s.key, body: clip(s.body || '', 500), silent, leaksStack: s.leaksStack },
          repro: { kind: 'page', path: p.path, form: fr, assert: 'http-5xx' }, dedupe: `http-5xx|${where}|${s.key}` });
      } else if (s.detector === 'blank-screen' || s.detector === 'error-overlay' || s.detector === 'error-screen') {
        const what = s.detector === 'blank-screen' ? 'The page went blank' : s.detector === 'error-overlay' ? 'A framework error overlay appeared' : `The page showed a raw error ("${s.key}")`;
        await record(ctx, page, { ...base, detector: s.detector, severity: 'high',
          title: `${what} ${withInput} (${where})`, detail: `${what} after the submit.`, evidence: {},
          repro: { kind: 'page', path: p.path, form: fr, assert: s.detector === 'blank-screen' ? 'blank' : 'error-screen' }, dedupe: `${s.detector}|${where}` });
      } else if (s.detector === 'xss') {
        await record(ctx, page, { ...base, detector: 'xss', severity: 'high',
          title: `Typed markup runs as code (XSS) (${where})`,
          detail: 'A harmless test tag typed into the form was inserted into the page as live HTML and its script ran. Anyone can make this page run their own script in another user\'s browser.',
          evidence: { landedOn: after?.url }, repro: { kind: 'page', path: p.path, form: fr, assert: 'xss' }, dedupe: `xss|${where}` });
        ctx.xssReported.add(tag);
      }
    }

    // The server said no, and the user was told nothing.
    const rejected = post.bad.find((r) => r.status >= 400 && r.status < 500 && isWrite(r.method));
    if (rejected && silent) {
      const attackerOnly = bypassed;
      await record(ctx, page, { ...base, detector: 'silent-failure', severity: attackerOnly ? 'low' : 'medium',
        title: `Form fails silently ${withInput} (${where})`,
        detail: `${rejected.method} ${pathOf(rejected.url)} was rejected with ${rejected.status}, but nothing on the page changed: no message, no highlighted field.` +
          (attackerOnly ? ' The browser\'s own validation would stop a normal user before this point, so this mainly matters for robustness.' : ''),
        evidence: { status: rejected.status, request: `${rejected.method} ${pathOf(rejected.url)}` },
        repro: { kind: 'page', path: p.path, form: fr, assert: 'feedback', alertsBefore: before.alerts }, dedupe: `silent-failure|${where}|${rejected.status}|${attackerOnly}` });
    }

    if (double) {
      const groups = new Map();
      for (const w of post.writes) { const k = `${w.method} ${w.url}\n${w.body}`; groups.set(k, (groups.get(k) || 0) + 1); }
      const dup = [...groups.entries()].find(([, n]) => n > 1);
      if (dup) {
        const req = dup[0].split('\n')[0].replace(ctx.origin, '');
        await record(ctx, page, { ...base, detector: 'double-submit', severity: 'medium',
          title: `Double-click submits twice (${where})`,
          detail: `Double-clicking the submit control sent ${dup[1]} identical ${req} requests. Real users double-click all the time; this is how duplicate orders, signups and charges happen.`,
          evidence: { request: req, times: dup[1] },
          repro: { kind: 'page', path: p.path, form: fr, assert: 'single-submit' }, dedupe: `double-submit|${where}` });
      }
    }
  } catch (e) {
    log(`    ${payload.name}: ${String(e.message).split('\n')[0]}`);
  } finally { await page.close().catch(() => {}); }
}

/** After all the fuzzing, revisit every page: did injected markup get stored and served back? */
export async function storedXssSweep(ctx) {
  for (const p of ctx.pages) {
    const { page } = await openPage(ctx.desktop, ctx.origin);
    try {
      await page.goto(ctx.origin + p.path, GOTO);
      await settle(page);
      const s = await inspect(page);
      for (const tag of new Set(s?.xss || [])) {
        const src = ctx.xssSources.get(tag);
        if (!src || ctx.xssReported.has(tag)) continue;
        ctx.xssReported.add(tag);
        const payload = PAYLOADS.find((x) => x.name === 'markup');
        const fills = planFills(src.form, payload, tag);
        const where = `${src.path} · ${src.form.name}`;
        await record(ctx, page, { detector: 'xss', pack: 'inputs', severity: 'high', path: p.path, where,
          title: `Stored XSS: markup typed into ${where} runs on ${p.path}`,
          detail: `A harmless test tag submitted through ${where} was saved and later served on ${p.path} as live HTML, where its script ran. Every visitor to that page would run an attacker's script.`,
          evidence: { submittedAt: src.path, firedOn: p.path },
          steps: [...describeSteps(src.path, src.form, fills, {}), `Open ${p.path}`],
          repro: { kind: 'page', path: src.path, form: formRepro(src.form, fills, { bypassed: true }), then: p.path, assert: 'xss' },
          dedupe: `xss-stored|${tag}` });
      }
    } catch { /* page unreadable: nothing to add */ }
    finally { await page.close().catch(() => {}); }
  }
}

// ───────────────────────────── network ─────────────────────────────

const FAULTS = [
  { name: 'api-500', what: 'every API call returns a 500 error' },
  { name: 'offline', what: 'every API call fails (connection lost)' },
];

const faultRoute = (name) => (route) => {
  const t = route.request().resourceType();
  if (t !== 'fetch' && t !== 'xhr') return route.fallback();
  if (name === 'api-500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"injected by break-my-app"}' });
  return route.abort('failed');
};

export async function networkPack(ctx) {
  for (const p of ctx.pages) {
    // Fault injection only reaches calls made from the browser. A page that fetches
    // nothing client-side has nothing to fail here (server-rendered data is out of reach).
    if (p.apiOnLoad.length) {
      for (const fault of FAULTS) {
        const { page, ev } = await openPage(ctx.desktop, ctx.origin);
        try {
          await page.route('**/*', faultRoute(fault.name));
          await page.goto(ctx.origin + p.path, GOTO);
          await settle(page);
          const s = await inspect(page);
          const symptoms = await observe(ev, s);
          const base = { pack: 'network', path: p.path, where: p.path, variant: fault.name,
            steps: [`Make the app's API unreachable (${fault.what})`, `Open ${p.path}`] };
          let broke = false;
          for (const sym of symptoms) {
            if (p.sig.has(`${sym.detector}|${sym.key}`)) continue;
            if (sym.detector === 'page-error') {
              broke = true;
              await record(ctx, page, { ...base, detector: 'page-error', severity: 'high',
                title: `Page crashes when the API fails (${p.path})`,
                detail: `With API calls failing, the page threw: ${clip(sym.message)}. There is no error handling around the request, so users see a broken page instead of a message.`,
                evidence: { message: sym.message, stack: sym.stack },
                repro: { kind: 'page', path: p.path, fault: fault.name, assert: 'page-error' }, dedupe: `fault-page-error|${p.path}` });
            } else if (sym.detector === 'blank-screen' || sym.detector === 'error-overlay' || sym.detector === 'error-screen') {
              broke = true;
              const what = sym.detector === 'blank-screen' ? 'Blank screen' : 'Raw error screen';
              await record(ctx, page, { ...base, detector: sym.detector, severity: 'high',
                title: `${what} when the API fails (${p.path})`,
                detail: `With API calls failing, the user is left looking at ${sym.detector === 'blank-screen' ? 'an empty page' : 'a raw framework error'}.`, evidence: {},
                repro: { kind: 'page', path: p.path, fault: fault.name, assert: sym.detector === 'blank-screen' ? 'blank' : 'error-screen' }, dedupe: `fault-${sym.detector}|${p.path}` });
            }
          }
          // Whether a spinner spins forever or a helpful message appears needs eyes: keep a screenshot.
          if (!broke) ctx.eye.push({ path: p.path, fault: fault.what, shot: await ctx.snap(page) });
        } catch (e) { log(`  network: ${p.path} (${fault.name}): ${String(e.message).split('\n')[0]}`); }
        finally { await page.close().catch(() => {}); }
      }
    }
    for (const form of p.forms.filter((f) => !f.skip).slice(0, ctx.opts.maxForms)) await submitOffline(ctx, p, form);
  }
}

async function submitOffline(ctx, p, form) {
  const { page, ev } = await openPage(ctx.desktop, ctx.origin);
  try {
    await page.goto(ctx.origin + p.path, GOTO);
    await settle(page);
    const fills = await applyFills(page, planFills(form, VALID, ''));
    await page.route('**/*', (route) => (isWrite(route.request().method()) ? route.abort('failed') : route.fallback()));
    const before = await inspect(page);
    const pre = new Set((await observe(ev, before)).map((s) => `${s.detector}|${s.key}`));
    const mark = markOf(ev);
    if (!(await submitForm(page, form, {}))) return;
    await settle(page, 4000);
    const after = await inspect(page);
    const post = sinceMark(ev, mark);
    // Only JS-driven submits are the app's to handle; a plain form post shows the browser's own offline page.
    if (!post.writes.some((w) => w.type === 'fetch' || w.type === 'xhr')) return;
    const where = `${p.path} · ${form.name}`;
    const opt = { offline: true };
    const base = { pack: 'network', path: p.path, where, variant: 'submit-offline', steps: describeSteps(p.path, form, fills, opt) };
    const fr = formRepro(form, fills, opt);
    const crash = (await observe(post, after)).find((s) => s.detector === 'page-error' && !pre.has(`${s.detector}|${s.key}`) && !ctx.known.has(`${s.detector}|${s.key}`));
    if (crash) {
      await record(ctx, page, { ...base, detector: 'page-error', severity: 'high',
        title: `Uncaught exception when a submit fails offline (${where})`,
        detail: `The request could not be sent and the page threw: ${clip(crash.message)}.` + (noFeedback(before, after) ? ' Nothing on the page changed, so the user cannot tell the submit failed.' : ''),
        evidence: { message: crash.message, stack: crash.stack },
        repro: { kind: 'page', path: p.path, form: fr, assert: 'page-error' }, dedupe: `offline-page-error|${where}` });
    }
    // A crash already explains the silence: one root cause, one finding.
    if (!crash && noFeedback(before, after)) {
      await record(ctx, page, { ...base, detector: 'silent-failure', severity: 'medium',
        title: `Submitting while offline gives no feedback (${where})`,
        detail: 'The request never reached the server, and nothing on the page changed. The user cannot tell whether it worked, so they either leave thinking it saved or keep clicking.',
        evidence: {}, repro: { kind: 'page', path: p.path, form: fr, assert: 'feedback', alertsBefore: before.alerts }, dedupe: `offline-silent|${where}` });
    }
  } catch (e) { log(`  network: ${p.path} · ${form.name}: ${String(e.message).split('\n')[0]}`); }
  finally { await page.close().catch(() => {}); }
}

// ───────────────────────────── api ─────────────────────────────

const SENSITIVE = /e-?mail|passw|hash|salt|token|secret|api[_-]?key|ssn|phone|address|birth|dob|stripe|card|session/i;

function collectKeys(v, out = new Set(), depth = 0) {
  if (depth > 4 || v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.slice(0, 5).forEach((x) => collectKeys(x, out, depth + 1)); return out; }
  for (const [k, x] of Object.entries(v)) { out.add(k); collectKeys(x, out, depth + 1); }
  return out;
}

/**
 * Call every known API route with no cookies and no session, the way a stranger
 * with curl would. Routes come from the routes file (read out of the repo) plus
 * whatever the browser was seen calling during the crawl.
 */
export async function apiPack(ctx, routes) {
  for (const r of routes.slice(0, ctx.opts.maxApi)) {
    const methods = (r.methods?.length ? r.methods : ['GET']).map((m) => m.toUpperCase());
    try {
      if (methods.includes('GET')) await probeGet(ctx, r);
      const write = methods.find((m) => ['POST', 'PUT', 'PATCH'].includes(m));
      if (write) await probeMalformed(ctx, r.path, write);
      ctx.stats.apiProbed++;
    } catch (e) { log(`  api: ${r.path}: ${String(e.message).split('\n')[0]}`); }
  }
}

async function probeGet(ctx, route) {
  const path = route.path;
  const res = await ctx.api.get(path, { maxRedirects: 0, timeout: 15000 });
  const status = res.status();
  const body = (await res.text().catch(() => '')).slice(0, 4000);
  const type = res.headers()['content-type'] || '';
  const steps = [`Without logging in, request GET ${path} (for example: curl ${ctx.origin}${path})`];
  const base = { pack: 'api', path, where: `GET ${path}`, steps };

  if (status >= 500) {
    ctx.findings.add({ ...base, detector: 'api-5xx', severity: 'high',
      title: `API crashes on a request with no session (GET ${path})`,
      detail: `GET ${path} with no cookies answered ${status} instead of a clean 401/403/404.` + (STACK_LEAK.test(body) ? ' The response leaks a stack trace.' : ''),
      evidence: { status, body: clip(body, 500) }, repro: { kind: 'api', method: 'GET', path, assert: 'not-5xx' }, dedupe: `api-5xx|GET ${path}` });
    return;
  }
  if (status >= 200 && status < 300 && /json/i.test(type)) {
    let parsed; try { parsed = JSON.parse(body); } catch { /* truncated or invalid JSON */ }
    const keys = [...collectKeys(parsed)];
    const sensitive = keys.filter((k) => SENSITIVE.test(k));
    if (!keys.length && !body.trim()) return;
    // A route the logged-out browser calls during normal browsing is public by design;
    // it is only interesting if it hands out private-looking fields.
    if (route.source === 'observed' && ctx.anonymous && !sensitive.length) return;
    ctx.findings.add({ ...base, detector: 'api-open', severity: sensitive.length ? 'high' : 'low', needsTriage: true,
      triageNote: 'Check the route handler. If this data is meant to be public, drop the finding and delete its test.',
      title: `API returns data to anyone, no login needed (GET ${path})`,
      detail: `GET ${path} with no cookies answered ${status} with JSON.` +
        (sensitive.length ? ` It includes fields that look private: ${sensitive.slice(0, 8).join(', ')}.` : keys.length ? ` Fields: ${keys.slice(0, 8).join(', ')}.` : ''),
      evidence: { status, fields: keys.slice(0, 20), sensitiveFields: sensitive, sample: clip(body, 300) },
      repro: { kind: 'api', method: 'GET', path, assert: 'requires-auth' }, dedupe: `api-open|GET ${path}` });
  }
}

async function probeMalformed(ctx, path, method) {
  // A Buffer is sent byte-for-byte; a string would be re-encoded into valid JSON.
  const res = await ctx.api.fetch(path, { method, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"bma":'), maxRedirects: 0, timeout: 15000 });
  const status = res.status();
  if (status < 500) return;
  const body = (await res.text().catch(() => '')).slice(0, 4000);
  ctx.findings.add({ pack: 'api', path, where: `${method} ${path}`, detector: 'api-5xx', severity: 'high',
    title: `API crashes on a malformed request body (${method} ${path})`,
    detail: `${method} ${path} with broken JSON answered ${status} instead of 400. The handler parses the body without catching the error.` + (STACK_LEAK.test(body) ? ' The response leaks a stack trace.' : ''),
    evidence: { status, body: clip(body, 500) },
    steps: [`Send ${method} ${path} with the body {"bma": (deliberately broken JSON)`],
    repro: { kind: 'api', method, path, malformed: true, assert: 'not-5xx' }, dedupe: `api-5xx|${method} ${path}|malformed` });
}
