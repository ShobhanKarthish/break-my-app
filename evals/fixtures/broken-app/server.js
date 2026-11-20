// A deliberately broken app for testing break-my-app. Zero dependencies.
// Every bug here is one the harness is supposed to catch; /ok is the clean control.
//
//   /dashboard   no error handling around fetch → crashes and blanks when the API fails
//   /signup      double submit, silent 400, 500 + stack trace on long input, 500 on bad JSON
//   /search      reflected XSS
//   /guestbook   stored XSS (shows up on /wall)
//   /wide        sideways scroll on phones
//   /broken      throws on load, console error, 404 API call, no viewport tag
//   /old-link    404, linked from the home page
//   /api/users   private data with no auth
const http = require('node:http');

const PORT = Number(process.env.PORT || 4317);
const messages = [];
const signups = [];

const page = (title, body, { viewport = true } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${viewport ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}
<title>${title}</title>
<style>body{font-family:system-ui;margin:24px;max-width:640px}input,button{font:inherit;padding:6px;margin:4px 0;display:block}nav{display:flex;flex-wrap:wrap;gap:4px 12px}</style>
</head><body>${body}</body></html>`;

const nav = '<nav><a href="/">Home</a><a href="/ok">OK</a><a href="/dashboard">Dashboard</a><a href="/signup">Sign up</a><a href="/search">Search</a><a href="/guestbook">Guestbook</a><a href="/wall">Wall</a><a href="/wide">Wide</a><a href="/broken">Broken</a><a href="/old-link">Old link</a></nav>';

const routes = {
  '/': () => page('Home', `${nav}<h1>Demo shop</h1><p>Looks fine, right?</p>`),

  '/ok': () => page('OK', `${nav}<h1>All good</h1><p id="status">Checking…</p>
<script>
fetch('/api/health').then(r => { if (!r.ok) throw new Error('bad status'); return r.json(); })
  .then(d => { document.getElementById('status').textContent = 'Service is ' + d.status; })
  .catch(() => { document.getElementById('status').textContent = 'Could not reach the service. Please try again.'; });
</script>`),

  '/dashboard': () => page('Dashboard', `<div id="root">Loading…</div>
<script>
fetch('/api/stats').then(r => r.json()).then(data => {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.innerHTML = '<h1>Dashboard</h1><ul>' + data.items.map(i => '<li>' + i.label + ': ' + i.value + '</li>').join('') + '</ul><a href="/">Home</a>';
});
</script>`),

  '/signup': () => page('Sign up', `${nav}<h1>Sign up</h1>
<form id="f">
  <label>Name <input name="name"></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Age <input name="age" type="number"></label>
  <button type="submit">Create account</button>
</form><p id="msg"></p>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) document.getElementById('msg').textContent = 'Welcome aboard!';
});
</script>`),

  '/search': (url) => {
    const q = url.searchParams.get('q') || '';
    return page('Search', `${nav}<h1>Search</h1><form method="get" action="/search"><input name="q" placeholder="Search products"><button type="submit">Search</button></form>${q ? `<p>Results for ${q}: none</p>` : ''}`);
  },

  '/guestbook': (url) => page('Guestbook', `${nav}<h1>Guestbook</h1>${url.searchParams.get('sent') ? '<p>Thanks for signing!</p>' : ''}
<form method="post" action="/guestbook"><label>Message <textarea name="message"></textarea></label><button type="submit">Sign guestbook</button></form>`),

  '/wall': () => page('Wall', `${nav}<h1>Wall</h1><ul>${messages.map((m) => `<li>${m}</li>`).join('') || '<li>No messages yet</li>'}</ul>`),

  '/wide': () => page('Wide', `${nav}<h1>Orders</h1><table style="width:900px;border-collapse:collapse"><tr>${['Order', 'Customer', 'Address', 'Status', 'Total', 'Placed'].map((h) => `<th style="border:1px solid #ccc;padding:8px">${h}</th>`).join('')}</tr></table>`),

  '/broken': () => page('Broken', `${nav}<h1>Broken</h1><script>
console.error('Failed to initialise analytics: config is undefined');
fetch('/api/missing');
undefinedFunctionCall();
</script>`, { viewport: false }),
};

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/health') return json(res, 200, { status: 'up' });
    if (url.pathname === '/api/stats') return json(res, 200, { items: [{ label: 'Orders', value: 12 }, { label: 'Revenue', value: '$340' }] });
    if (url.pathname === '/api/users') {
      return json(res, 200, [{ id: 1, name: 'Ada', email: 'ada@example.test', password_hash: '$2b$10$abcdefghijklmnopqrstuv' }]);
    }
    if (url.pathname === '/api/signup' && req.method === 'POST') {
      const data = JSON.parse(await readBody(req)); // throws on malformed JSON
      if (!data.name || !data.name.trim()) return json(res, 400, { error: 'name is required' });
      if (data.name.length > 255) throw new Error('value too long for type character varying(255)');
      signups.push(data);
      return json(res, 201, { ok: true, count: signups.length });
    }
    if (url.pathname === '/guestbook' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      messages.push(form.get('message') || '');
      res.writeHead(303, { location: '/guestbook?sent=1' });
      return res.end();
    }
    const handler = routes[url.pathname];
    if (handler && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(handler(url));
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(page('Not found', '<h1>404</h1><p>Nothing here.</p>'));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(err.stack); // leaks the stack trace, on purpose
  }
}).listen(PORT, () => console.log(`  Local:   http://localhost:${PORT}/`));
