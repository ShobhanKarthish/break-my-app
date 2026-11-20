---
name: break-my-app
description: Attack a locally running web app the way real users and strangers on the internet will, then prove every failure with a screenshot and a failing Playwright test. Starts the dev server, crawls the pages, fuzzes forms with hostile input, double-clicks submits, kills the API mid-flow, checks phone-width layout, and calls API routes with no login. Use when the user asks to break, stress, attack, fuzz, QA or bug-hunt their app, asks "is this ready to ship / launch / show users?", wants to know what breaks before real users find it, or has just finished building a web app and wants it checked beyond the happy path. Not for unit tests, code review of a diff, or testing a deployed production site.
argument-hint: "[http://localhost:PORT] [--quick]"
license: MIT
compatibility: Requires Node.js 18+ and a shell (macOS or Linux). Installs Playwright on first run.
---

# break-my-app

Apps built on the happy path look fine until a real person uses them: someone double-clicks
Submit, leaves a field blank, opens the page on a phone, loses signal on the train, or pokes
at `/api/users` with curl. This skill does all of that on purpose, on the user's own machine,
and turns each failure into evidence the user can act on.

The work is split in two. A bundled harness does the attacking, because attacks should be
identical every run and cheap to repeat. You do what a script cannot: read the repo to find
what to attack, judge which findings are real, trace each to its cause in the code, and
explain it in plain language.

`${CLAUDE_SKILL_DIR}` below is the directory this file lives in.

## Ground rules

- **Localhost only.** The harness refuses any other target. If the user asks to run it
  against a deployed URL, explain that fuzzing writes junk data and can break things for
  real users, and offer to run it against the same app locally.
- **Never use real credentials.** Log in only with test accounts found in the repo's seed
  or example files, or ones the user types in for this purpose.
- **Don't change source code during the run.** This skill reports and proves. Fixing comes
  after the user has seen the report and said which findings to fix.
- The harness itself skips payment forms and anything labelled delete / remove / log out,
  and blocks writes to third-party services from the browser. It cannot stop what the
  app's *server* does in response (sending an email, charging a test card), which is why
  step 1 matters.

## Workflow

### 1. Look before you attack

Read enough of the project to answer:

- What starts it? (`package.json` scripts, or a Makefile / `manage.py` / `bin/dev` for
  non-Node apps.)
- **Where does its data go?** Check `.env*` and config for the database and service URLs.
  The inputs pack submits forms dozens of times with junk. Against a local or disposable
  dev database that is the point. If the dev server is wired to a hosted or shared
  database (a remote Postgres host, a Supabase/Firebase project URL, anything that looks
  like production), stop and ask before running the `inputs` pack; the other packs
  (`mobile,network,api`) only read and are safe to run meanwhile.
- Is there a login, and are most pages behind it?

Then tell the user in a sentence or two what you are about to do and that test data will
be written to their dev database. Don't wait for a reply unless the database question
above applies.

### 2. Get the tools ready

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" --project .
```

This reuses the project's own `@playwright/test` if it has one, otherwise installs a
private copy into `.break-my-app/` (git-ignored, so `package.json` and the lockfile are
untouched). The first run may download a browser; give it a few minutes.

### 3. Start the app

If the user passed a localhost URL in `$ARGUMENTS`, use it and skip this step. Otherwise:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/server.mjs" start --project .
```

It picks the dev script and package manager, waits for the port, and prints
`{ "url": ..., "reused": ... }`. For anything it cannot guess, pass
`--cmd "<command>"` and, if needed, `--port N`. If the server dies on startup the script
prints the tail of its log: fix the obvious (missing install, missing `.env`) or report it,
since an app that does not start is the first finding.

### 4. Tell the harness what exists

The crawler only finds pages that are linked and API routes the browser happens to call.
The repo knows more. Write `.break-my-app/routes.json`:

```json
{
  "pages": ["/settings", "/orders/1"],
  "api": [
    { "path": "/api/users", "methods": ["GET"] },
    { "path": "/api/orders", "methods": ["GET", "POST"] }
  ]
}
```

List every API route you can find in the source, and any page that is not reachable by
links from the home page. Replace dynamic segments with a value that exists (an id from
the seed data); skip routes you cannot give a real value. See
`references/route-discovery.md` for where routes live in each framework.

### 5. Log in, if the app needs it

If most of the app is behind a login, anonymous crawling only tests the login page. Follow
`references/auth.md` to save a logged-in browser state using a test account, and pass it
with `--storage-state`. If there is no test account to be found, run anonymously and say
clearly in the report what was not reached.

### 6. Attack

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness.mjs" --url <url> --project . --routes-file .break-my-app/routes.json
```

Allow up to ten minutes; a typical small app takes one to three. Useful flags:

| Flag | Use |
|---|---|
| `--quick` | Crawl, phone layout and API sweep only. No form fuzzing, nothing written. |
| `--packs mobile,network,inputs,api` | Choose packs. The baseline crawl always runs. |
| `--storage-state <file>` | Saved login from step 5. |
| `--max-pages N` / `--max-forms N` | Raise for bigger apps (defaults 15 and 3 per page). |

It writes into `.break-my-app/`: `findings.json` (everything, machine-readable),
`report.md` (raw report), `screenshots/`, and `repro/*.spec.ts` (one test per finding).
What each pack does and what each detector means is in `references/detectors.md`.

### 7. Triage: this is where you earn your keep

The harness reports symptoms. Read `findings.json`, and for each finding:

1. **Open the code** behind it and find the cause. A finding you can pin to a file and
   line is worth ten you cannot.
2. **Decide if it is real.** `references/detectors.md` lists the usual false alarms for
   each detector. Findings marked `needsTriage` always need a decision: an API route that
   answers without a login is a leak if it returns users' data and fine if it returns the
   product catalogue.
3. **Look at the screenshot** when the symptom is visual.
4. **Merge findings that share a cause.** One missing `try/catch` can produce a crash, a
   blank screen and a silent failure; the user needs to hear about it once.

Also open every screenshot under "Look at these by eye" in the raw report. Those are pages
that survived the API failing without crashing, and only eyes can tell a helpful error
message from a spinner that never stops. An endless spinner or a page that silently shows
no data is a finding; add it.

Delete the `repro/` test of any finding you drop, so the test folder matches the report.

### 8. Check the tests really fail

Run the `reproCommand` from `findings.json`. Every remaining test should fail, because
the bugs are still there. A test that passes means the finding does not reproduce
reliably: rerun it once, and if it still passes, drop the finding or mark it as
intermittent rather than presenting it as proven.

### 9. Report

Rewrite `.break-my-app/report.md` as the triaged report, then give the user the short
version in chat. Write for someone who built the app but may not know what a 500 is:
say what a user would experience, then the technical cause.

Use this structure for the report:

```markdown
# break-my-app report
**Verdict:** one sentence. Would you let real users in today?
**Covered:** pages, forms, API routes; what was not reached and why.

## Fix these first
### 1. <what the user experiences> (high)
- **Try it:** numbered steps a person can follow in a browser
- **Why:** the cause, with `path/to/file.ts:42`
- **Fix:** the specific change, in a sentence or a few lines of code
- **Proof:** screenshot and `repro/BMA-00X-….spec.ts`

## Worth fixing
## Minor
## Checked and fine
## Not covered
```

Order by what would hurt real users most, not by the harness's IDs. Data exposure and
script injection first, then crashes and lost input, then layout and polish. "Checked and
fine" matters: listing what held up tells the user the run was thorough and what they do
not need to worry about.

### 10. Wrap up

- Stop the server if this run started it (`reused` was `false`):
  `node "${CLAUDE_SKILL_DIR}/scripts/server.mjs" stop --project .`
- Offer the two natural next steps, and do neither unasked:
  - **Fix the findings.** Work one at a time: make the change, run that finding's test,
    and move on only when it passes. The test is the definition of done.
  - **Keep the tests.** `.break-my-app/` is git-ignored. To keep the tests as regression
    tests, copy them into the project's Playwright folder (they use relative URLs, so the
    project's `baseURL` applies). If the project has no Playwright setup, say so and offer
    to add one rather than silently adding a dependency.

## When things go wrong

- **Harness finds nothing on an app that obviously has pages:** the crawl probably got
  bounced to a login page. Check `redirects` in the output and go back to step 5.
- **Everything is a finding:** usually one shared cause (a broken layout component, an
  API that is down). Fix the understanding first; report the cause once.
- **Forms are skipped:** the report's Coverage table says why (payment, destructive,
  no visible fields). Multi-step forms and custom widgets (date pickers, rich text) are
  beyond v0; say so under "Not covered".
- **Server-rendered apps:** network faults are injected in the browser, so data fetched
  on the server is not affected. A page with zero "browser API calls on load" was not
  fault-tested; say so rather than implying it passed.
