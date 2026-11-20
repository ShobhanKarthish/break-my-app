# Packs and detectors

What the harness does, what each finding means, when it is a false alarm, and the usual fix.
Read this during triage.

## Contents

- [Packs](#packs)
- [Detectors](#detectors)
- [Hostile inputs](#hostile-inputs)

## Packs

| Pack | What it does | Writes data? |
|---|---|---|
| baseline (always) | Opens every page it can find at desktop size and records anything already broken. | No |
| mobile | Reopens each page at 375×812 and checks for sideways scroll and a viewport tag. | No |
| network | Reloads each page with every browser API call failing (once with 500s, once with dropped connections), and submits each form with the connection cut. | No (writes are aborted) |
| inputs | Submits each form once per hostile input, then once with valid values and a double-click. Afterwards revisits every page to see whether injected markup was stored. | **Yes** |
| api | Calls each API route with no cookies; sends broken JSON to routes that accept writes. | No |

Attack findings are only reported if the symptom was **not** already present before the
attack, so a page that is broken at baseline produces one baseline finding, not thirty.

## Detectors

### page-error (high)
An uncaught exception or unhandled promise rejection in the browser.

- **Usually:** reading a property of `undefined` after a failed or empty fetch
  (`data.items.map` when `data` is an error body), or `await fetch()` with no `try/catch`.
- **False alarm:** errors thrown by browser extensions or third-party scripts (analytics,
  chat widgets). Check the stack: if no frame is in the project's code, drop it or
  downgrade it.
- **Fix:** check `res.ok` before using the body, wrap the call in `try/catch`, render an
  error state. In React, an error boundary stops one component taking the page down.

### blank-screen (high)
The page has no text and no visible images or controls.

- **Usually:** a render crash in a single-page app with no error boundary.
- **False alarm:** a page that is legitimately a canvas or map still mounting; look at
  the screenshot.

### error-overlay / error-screen (high)
A framework dev overlay (Next.js, Vite, webpack) or raw text such as
"Internal Server Error", "Application error", "Cannot GET /x".

- **Note:** dev overlays only exist in development, but they stand in for what production
  shows instead: a generic crash page. Still a finding.

### http-5xx (high)
The server answered 500 or above. The evidence includes the start of the response body.

- **Usually:** unvalidated input reaching the database (too long for the column, wrong
  type, a negative where only positives make sense) or `JSON.parse` / `req.json()` on a
  bad body.
- **`leaksStack: true`:** the response includes a stack trace or file paths. That tells
  an attacker about the code layout; mention it and fix it with a generic error response.
- **`silent: true`:** the page also showed the user nothing.
- **Fix:** validate at the top of the handler (a schema library such as zod is the
  common choice) and return 400 with a message; catch and return a clean 500 for the rest.

### silent-failure (medium, or low when attacker-only)
The server rejected a submit (4xx), or the request never left the browser, and nothing on
the page changed: same text, same URL, no `role="alert"`, no `aria-invalid`.

- **Why it matters:** the user cannot tell whether it worked. They leave, or keep clicking.
- **Low severity variant:** the submit was only possible because the harness switched off
  the browser's built-in validation. Ordinary users are stopped earlier, so this is about
  robustness.
- **False alarm:** feedback that is purely visual (a red border via CSS, a toast that
  vanished within a second, an icon). Look at the screenshot and the component. If the
  only signal is colour, that is still an accessibility problem worth a mention.
- **Fix:** handle the non-OK branch: show the server's message near the field or in an
  alert region.

### double-submit (medium)
Double-clicking the submit control sent the same write request more than once.

- **Why it matters:** duplicate orders, duplicate signups, double charges.
- **False alarm:** the endpoint is idempotent (a search, a "save settings" that
  overwrites). Check the handler; if a second identical call changes nothing, drop it.
- **Fix:** disable the button while the request is pending, and for anything involving
  money or unique records, make the server reject duplicates too.

### xss (high)
A harmless test tag typed into a form ended up in the page as live HTML and its script
ran. "Stored XSS" means it was saved and ran later on another page.

- **False alarm:** essentially none. The canary only fires if script executed.
- **Usually:** `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `{@html}`, or a
  server template that interpolates without escaping.
- **Fix:** render user text as text. If rich text is truly needed, sanitise with a
  maintained library.
- **Note:** the test tag may now be sitting in the dev database. Tell the user; a page
  that renders it will keep "firing" until the data is cleaned or the bug is fixed.

### horizontal-overflow (medium)
At 375px wide the document is wider than the screen, so the page scrolls sideways. The
evidence names the widest offending elements.

- **Usually:** a fixed-width table or image, a long unbroken string, or a flex row that
  does not wrap.
- **False alarm:** an intentionally scrollable region that is not clipped properly is
  still a bug; a 1–3px overflow from a stray margin is real but minor, so downgrade to low.
- **One finding can cover many pages** (see "Also seen on") when the offender is in a
  shared layout.
- **Fix:** `max-width: 100%` on media, `overflow-x: auto` on a wrapper around wide
  tables, `flex-wrap`, `overflow-wrap: anywhere` for long strings.

### no-viewport-meta (medium)
No `<meta name="viewport">`. Phones render the desktop layout shrunk down.

- **Fix:** add `<meta name="viewport" content="width=device-width, initial-scale=1">`
  (in Next.js, the `viewport` export).

### api-open (needs triage; high if private-looking fields, else low)
An API route returned JSON to a request with no cookies.

- **Decide by reading the handler.** Public by design (product list, health check,
  feature flags): drop it and delete its test. Returns data belonging to users, or
  anything listed under `sensitiveFields`: this is the most serious class of finding.
- **Also check the neighbours:** if `GET /api/users` has no auth check, look at the
  write methods on the same route and at sibling routes. The harness only sends GETs and
  deliberately broken writes, so it will not have noticed an unprotected `DELETE`.
- **Supabase / Firebase apps:** the equivalent hole is in the database rules, not in a
  route. If the client talks to the database directly, read the row-level security
  policies or security rules; the harness cannot see those.
- **Fix:** check the session at the top of the handler (or in middleware), and scope
  queries to the logged-in user.

### api-5xx (high)
A request with no session, or with broken JSON, crashed the handler.

- **Usually:** `session.user.id` when `session` is null, or parsing the body without a
  `try/catch`.
- **Fix:** return 401 when there is no session and 400 when the body does not parse.

### broken-page / http-4xx / request-failed (medium, assets low)
A linked page 404s, a request the page depends on fails, or a request never completes.

- **False alarm:** 401/403 are already ignored. A 404 from an optional resource (a
  source map, an avatar that may not exist) can be dropped.
- **`request-failed` with connection refused** usually means the frontend expects a
  second service (an API on another port) that is not running. Start it and rerun, or
  report it as a setup gap rather than an app bug.

### console-error (low)
Something logged at error level during page load.

- **Triage up** when it is a hydration mismatch, a failed prop type, or a caught
  exception being swallowed: those are bugs. **Drop** routine framework warnings.

### load-failed (high)
The page did not respond within 20 seconds. Check the server log
(`.break-my-app/server.log`) for a hang or crash.

## Hostile inputs

Each form is submitted once per row, in this order:

| Name | What goes in | What it catches |
|---|---|---|
| required-only | Valid values in required fields, nothing else | Optional fields the server actually needs. The one ordinary users hit most. |
| empty | Nothing, with browser validation off | Server trusting the client to validate |
| whitespace | Three spaces | "Required" checks that accept blanks |
| long | 5,000 characters | Column limits, layout blowouts |
| markup | An HTML tag with a harmless script canary | XSS |
| unicode | Emoji, right-to-left override, zero-width space | Encoding and length bugs |
| negative | -1 | Quantity and price logic |
| huge | A 20-digit number | Integer overflow, numeric parsing |
| valid, double-click | Ordinary values, submit double-clicked | Double submits, and any crash on the happy path |

Number and date fields get type-appropriate versions; checkboxes are ticked; selects get
their second option; file inputs and custom widgets are left alone.
