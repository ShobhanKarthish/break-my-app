// Detectors: everything the harness can notice about a page going wrong.
// A "symptom" is { detector, key, ...detail }. Packs decide which symptoms count
// as findings in their situation (a console error while the API is deliberately
// failing is expected; an uncaught exception is not).

const CONSOLE_NOISE = [
  /^Failed to load resource/i,          // duplicates the HTTP detectors
  /favicon\.ico/i,
  /\[HMR\]|\[vite\]|\[webpack-dev-server\]|Fast Refresh|hot[- ]update/i,
  /Download the React DevTools/i,
  /ERR_BLOCKED_BY_CLIENT/i,             // our own safety block on third-party writes
];

const ERROR_SCREEN = /Application error: a (?:client|server)-side exception|Unhandled Runtime Error|^\s*Internal Server Error\s*$|^\s*Cannot (?:GET|POST|PUT|DELETE) \/\S*\s*$|^\s*502 Bad Gateway|^\s*500\b.*Internal Server Error/m;

export const STACK_LEAK = /\n\s+at\s.+[(/].+:\d+:\d+\)?|node_modules[\\/]|Traceback \(most recent call last\)|\.(?:rb|py|php):\d+:in /;

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
export const isWrite = (method) => !SAFE_METHODS.includes(method);

export function pathOf(u) {
  try { const x = new URL(u); return x.pathname + x.search; } catch { return u; }
}

/** Open a page that records everything the detectors need. */
export async function openPage(context, origin) {
  const page = await context.newPage();
  const ev = { console: [], pageErrors: [], bad: [], failed: [], api: [], writes: [], pending: [] };

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (CONSOLE_NOISE.some((re) => re.test(text))) return;
    ev.console.push({ text: text.slice(0, 400) });
  });
  page.on('pageerror', (e) => {
    ev.pageErrors.push({
      message: String(e?.message || e).slice(0, 400),
      stack: String(e?.stack || '').split('\n').slice(0, 5).join('\n'),
    });
  });
  page.on('request', (req) => {
    if (isWrite(req.method())) {
      ev.writes.push({ method: req.method(), url: req.url(), type: req.resourceType(), body: (req.postData() || '').slice(0, 2000) });
    }
  });
  page.on('response', (res) => {
    const req = res.request();
    const url = res.url();
    const type = req.resourceType();
    const same = url.startsWith(origin);
    if (same && (type === 'fetch' || type === 'xhr')) ev.api.push({ method: req.method(), url, status: res.status() });
    if (res.status() >= 400 && !/favicon\.ico/.test(url)) {
      const rec = { status: res.status(), method: req.method(), url, type, same, body: '' };
      ev.bad.push(rec);
      if (res.status() >= 500) {
        ev.pending.push(res.text().then((t) => { rec.body = t.slice(0, 1200); }).catch(() => {}));
      }
    }
  });
  page.on('requestfailed', (req) => {
    const why = req.failure()?.errorText || '';
    // Navigation aborts and our own blocks/faults are not app bugs.
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(why)) return;
    ev.failed.push({ method: req.method(), url: req.url(), why });
  });
  // alert()/confirm() would hang the run. Dismissing also declines "are you sure?" prompts.
  page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

  return { page, ev };
}

export async function settle(page, ms = 5000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(250);
}

/** Read what the user would actually be looking at. */
export async function inspect(page) {
  try {
    return await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      const describe = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) s += '.' + cls.join('.');
        return s;
      };
      const body = document.body;
      const de = document.documentElement;
      const text = body ? body.innerText.trim() : '';
      const hasContent = !!body && [...body.querySelectorAll('img,canvas,svg,video,iframe,input,button,select,textarea')].some(visible);

      // Framework error overlays (dev builds). Next keeps its dialog in a shadow root.
      const nextPortal = document.querySelector('nextjs-portal');
      const overlay =
        !!document.querySelector('vite-error-overlay, #webpack-dev-server-client-overlay, [data-nextjs-dialog-overlay], [data-nextjs-dialog]') ||
        !!nextPortal?.shadowRoot?.querySelector('[data-nextjs-dialog], [data-nextjs-dialog-overlay], [data-nextjs-error-overlay]');

      const vw = de.clientWidth;
      const offenders = [];
      if (de.scrollWidth > vw + 1 && body) {
        for (const el of body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 1 && visible(el)) offenders.push({ el: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
        }
        offenders.sort((a, b) => b.right - a.right);
      }

      return {
        url: location.pathname + location.search,
        text,
        textLen: text.length,
        hasContent,
        overlay,
        alerts: document.querySelectorAll('[role="alert"], [aria-invalid="true"]').length,
        scrollWidth: de.scrollWidth,
        clientWidth: vw,
        offenders: offenders.slice(0, 5),
        viewportMeta: !!document.querySelector('meta[name="viewport"]'),
        xss: Array.isArray(window.__bma_xss) ? window.__bma_xss.slice(0, 20) : [],
      };
    });
  } catch {
    // The page navigated away or crashed mid-read: report it as unreadable rather than guess.
    return null;
  }
}

/** Turn raw events + page state into a flat list of symptoms. */
export async function observe(ev, state) {
  await Promise.all(ev.pending);
  const out = [];
  const seen = new Set();
  const push = (s) => { const k = s.detector + '|' + s.key; if (!seen.has(k)) { seen.add(k); out.push(s); } };

  for (const e of ev.pageErrors) push({ detector: 'page-error', key: e.message, message: e.message, stack: e.stack });
  for (const c of ev.console) push({ detector: 'console-error', key: c.text, message: c.text });
  for (const r of ev.bad) {
    const where = `${r.method} ${pathOf(r.url).split('?')[0]}`;
    if (r.status >= 500) push({ detector: 'http-5xx', key: where, status: r.status, method: r.method, url: r.url, body: r.body, leaksStack: STACK_LEAK.test(r.body) });
    else if (r.same) push({ detector: 'http-4xx', key: where, status: r.status, method: r.method, url: r.url, type: r.type });
  }
  for (const f of ev.failed) push({ detector: 'request-failed', key: `${f.method} ${pathOf(f.url).split('?')[0]}`, method: f.method, url: f.url, why: f.why });

  if (state) {
    if (state.textLen === 0 && !state.hasContent) push({ detector: 'blank-screen', key: 'blank' });
    if (state.overlay) push({ detector: 'error-overlay', key: 'overlay' });
    const m = state.text.match(ERROR_SCREEN);
    if (m) push({ detector: 'error-screen', key: m[0].trim().slice(0, 80), message: m[0].trim().slice(0, 80) });
    if (state.xss.length) push({ detector: 'xss', key: 'xss', tags: state.xss });
  }
  return out;
}
