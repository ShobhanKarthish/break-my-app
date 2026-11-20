// Form discovery, hostile payloads, and the mechanics of filling and submitting.
// Everything here is deterministic: the same page always yields the same plan,
// which is what lets a finding be replayed as a test.

/** Find the forms (and "loose" inputs outside any <form>) on the current page. */
export async function discoverForms(page) {
  return page.evaluate(() => {
    const FILL = ':is(input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=image]), textarea, select)';
    const SUBMIT = ':is(button[type=submit], input[type=submit], button:not([type]))';
    const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log\s?out|sign\s?out|unsubscribe|deactivate|cancel (?:account|subscription|plan))\b/i;
    const PAYMENT = /card|cvc|cvv|iban|routing|account.?number/i;

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const attr = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const count = (root, css) => { try { return root.querySelectorAll(css).length; } catch { return 0; } };
    const labelOf = (el) => (
      el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type || el.tagName.toLowerCase()
    ).trim().replace(/\s+/g, ' ').slice(0, 40);

    // Prefer selectors a human would write (#id, [name]); fall back to position.
    const describeField = (el, formScope, listSel, root, index) => {
      let selector;
      if (el.id && count(document, '#' + CSS.escape(el.id)) === 1) selector = '#' + CSS.escape(el.id);
      else if (el.name && formScope && count(root, `[name="${attr(el.name)}"]`) === 1) selector = `${formScope} >> [name="${attr(el.name)}"]`;
      else selector = `${listSel} >> nth=${index}`;
      return {
        selector,
        label: labelOf(el),
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : el.tagName.toLowerCase())).toLowerCase(),
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : undefined,
        required: !!el.required,
        payment: (el.autocomplete || '').startsWith('cc-') || PAYMENT.test(el.name + ' ' + el.id),
      };
    };

    const out = [];
    const forms = [...document.querySelectorAll('form')];
    forms.forEach((form, fi) => {
      const scope = `form >> nth=${fi}`;
      const all = [...form.querySelectorAll(FILL)];
      const fields = all.map((el, i) => (visible(el) ? describeField(el, scope, `${scope} >> ${FILL}`, form, i) : null)).filter(Boolean);
      const submits = [...form.querySelectorAll(SUBMIT)];
      const sIdx = submits.findIndex(visible);
      const sEl = sIdx >= 0 ? submits[sIdx] : null;
      const sLabel = sEl ? (sEl.innerText || sEl.value || 'Submit').trim().slice(0, 40) : null;
      const name = (form.getAttribute('aria-label') || sLabel || form.id || form.getAttribute('name') || `form ${fi + 1}`).trim().slice(0, 40);
      let skip = null;
      if (!fields.length) skip = 'no visible fields';
      else if (fields.some((f) => f.payment)) skip = 'looks like a payment form';
      else if (DESTRUCTIVE.test(`${sLabel || ''} ${form.getAttribute('action') || ''}`)) skip = 'looks destructive';
      out.push({
        index: fi, name, scope, loose: false, skip, fields,
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        submit: sEl ? { selector: `${scope} >> ${SUBMIT} >> nth=${sIdx}`, label: sLabel } : null,
      });
    });

    // Inputs that live outside any <form> (common in React apps): treat them as one form
    // and use the first safe button that comes after the last input as its submit.
    const LOOSE = `${FILL}:not(form *)`;
    const looseAll = [...document.querySelectorAll(LOOSE)];
    const looseFields = looseAll.map((el, i) => (visible(el) ? describeField(el, null, LOOSE, document, i) : null)).filter(Boolean);
    if (looseFields.length) {
      const last = looseAll.filter(visible).at(-1);
      const BTN = 'button:not(form *)';
      const buttons = [...document.querySelectorAll(BTN)];
      const bIdx = buttons.findIndex((b) => visible(b) && !b.disabled && (last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !DESTRUCTIVE.test(b.innerText));
      const bLabel = bIdx >= 0 ? buttons[bIdx].innerText.trim().slice(0, 40) : null;
      out.push({
        index: forms.length, name: bLabel || 'inputs outside a form', scope: null, loose: true,
        skip: looseFields.some((f) => f.payment) ? 'looks like a payment form' : null,
        fields: looseFields, method: 'js',
        submit: bIdx >= 0 ? { selector: `${BTN} >> nth=${bIdx}`, label: bLabel } : null,
      });
    }
    return out;
  });
}

const xssCanary = (tag) => `"><img src=x onerror="(window.__bma_xss=window.__bma_xss||[]).push('${tag}')">'--`;

/**
 * Hostile inputs. Each one stands for a class of real-world input that apps
 * built on the happy path tend not to survive.
 */
export const PAYLOADS = [
  // First on purpose: this is the one ordinary users hit, so it should own the finding when several payloads trip the same bug.
  { name: 'required-only', what: 'only the required fields filled in', requiredOnly: true },
  { name: 'empty', what: 'every field left empty', text: () => '', number: '', date: '' },
  { name: 'whitespace', what: 'only spaces', text: () => '   ', number: '', date: '' },
  { name: 'long', what: '5,000 characters', text: () => 'A'.repeat(5000), code: "'A'.repeat(5000)", number: '9'.repeat(30) },
  { name: 'markup', what: 'HTML/script markup', text: xssCanary, number: '0' },
  { name: 'unicode', what: 'emoji, right-to-left and zero-width characters', text: () => '\u{1F9E8} Ω≈ç√ 表ポあ ‮desrever‬ zero​width', number: '0' },
  { name: 'negative', what: 'negative numbers', text: () => '-1', number: '-1', date: '0001-01-01' },
  { name: 'huge', what: 'absurdly large numbers', text: () => '99999999999999999999', number: '99999999999999999999', date: '9999-12-31' },
];

export const VALID = { name: 'valid', what: 'ordinary valid values' };
const VALID_BY_TYPE = { email: 'bma.test@example.test', number: '1', password: 'Bma-test-12345!', url: 'https://example.test', tel: '5550100', date: '2020-01-01' };

/** Decide what goes in each field for a payload. */
export function planFills(form, payload, tag) {
  const fills = [];
  const EMPTY = PAYLOADS.find((p) => p.name === 'empty');
  for (const f of form.fields) {
    const base = { selector: f.selector, label: f.label };
    if (payload.requiredOnly) { fills.push(...planFills({ fields: [f] }, f.required ? VALID : EMPTY, tag)); continue; }
    const empty = payload.name === 'empty';
    if (f.type === 'checkbox' || f.type === 'radio') { if (!empty) fills.push({ ...base, action: 'check' }); continue; }
    if (f.tag === 'select') {
      const v = f.options?.[1] ?? f.options?.[0];
      if (!empty && v !== undefined) fills.push({ ...base, action: 'select', value: v });
      continue;
    }
    if (['range', 'color', 'time', 'month', 'week', 'datetime-local'].includes(f.type)) continue;
    if (payload === VALID) { fills.push({ ...base, action: 'fill', value: VALID_BY_TYPE[f.type] ?? 'Test value' }); continue; }
    if (f.type === 'number') { fills.push({ ...base, action: 'fill', value: payload.number ?? '0' }); continue; }
    if (f.type === 'date') { fills.push({ ...base, action: 'fill', value: payload.date ?? '2020-01-01' }); continue; }
    fills.push({ ...base, action: 'fill', value: payload.text(tag), code: payload.code });
  }
  return fills;
}

/** Perform the fills; return only the ones that actually happened, so the repro matches reality. */
export async function applyFills(page, fills) {
  const done = [];
  for (const f of fills) {
    const loc = page.locator(f.selector).first();
    try {
      if (f.action === 'check') await loc.check({ timeout: 1500 });
      else if (f.action === 'select') await loc.selectOption(f.value, { timeout: 1500 });
      else await loc.fill(f.value, { timeout: 1500 });
      done.push(f);
    } catch { /* disabled, read-only or covered: a real user could not fill it either */ }
  }
  return done;
}

/**
 * Switch off the browser's built-in validation. A script or a curl command never
 * runs it, so the server has to cope. Returns true if the browser would have
 * blocked this submit (the finding is then attacker-only, not something a normal user hits).
 */
export async function bypassValidation(page, form) {
  if (form.loose) return false;
  try {
    return await page.locator(form.scope).evaluate((el) => { const blocked = !el.checkValidity(); el.noValidate = true; return blocked; });
  } catch { return false; }
}

export async function submitForm(page, form, { double = false } = {}) {
  try {
    if (form.submit) {
      const btn = page.locator(form.submit.selector).first();
      if (double) await btn.dblclick({ timeout: 1500 });
      else await btn.click({ timeout: 1500 });
    } else {
      const last = form.fields.filter((f) => f.tag !== 'select' && f.type !== 'checkbox' && f.type !== 'radio').at(-1);
      if (!last) return false;
      await page.locator(last.selector).first().press('Enter', { timeout: 1500 });
    }
    return true;
  } catch { return false; }
}

const show = (f) => {
  if (f.action === 'check') return `Tick "${f.label}"`;
  if (f.action === 'select') return `Choose "${f.value}" in "${f.label}"`;
  if (f.value === '') return `Leave "${f.label}" empty`;
  const v = f.code ? '5,000 "A" characters' : JSON.stringify(f.value.length > 70 ? f.value.slice(0, 70) + '…' : f.value);
  return `Type ${v} into "${f.label}"`;
};

/** Plain-language steps for the report. */
export function describeSteps(path, form, fills, { bypassed = false, double = false, offline = false } = {}) {
  const steps = [`Open ${path}`, ...fills.map(show)];
  if (bypassed) steps.push('Skip the browser\'s own field validation (as a script or attacker would)');
  if (offline) steps.push('Lose the network connection');
  const verb = double ? 'Double-click' : 'Click';
  steps.push(form.submit ? `${verb} "${form.submit.label}"` : 'Press Enter in the last field');
  return steps;
}

/** Machine-readable version of the same steps, consumed by the repro test generator. */
export function formRepro(form, fills, { bypassed = false, double = false, offline = false } = {}) {
  const last = form.fields.filter((f) => f.tag !== 'select' && f.type !== 'checkbox' && f.type !== 'radio').at(-1);
  return {
    fills: fills.map(({ selector, action, value, code }) => ({ selector, action, value, code })),
    noValidate: bypassed ? form.scope : null,
    submit: form.submit?.selector ?? null,
    enter: form.submit ? null : last?.selector ?? null,
    double, offline,
  };
}
