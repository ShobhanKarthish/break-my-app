# break-my-app

An agent skill that attacks your local web app the way real users and strangers on the
internet will, then proves every failure with a screenshot and a failing Playwright test.

Your app looks fine. Then someone double-clicks Submit, leaves a field blank, opens it on a
phone, loses signal on the train, or pokes at `/api/users` with curl. This skill does all of
that on purpose, on your machine, before your users do.

```
> break my app

 BMA-001  high    Typed markup runs as code (XSS)                    /search
 BMA-002  high    API returns data to anyone, no login needed        GET /api/users
 BMA-003  high    Page crashes when the API fails                    /dashboard
 BMA-004  high    Server error 500 when a form gets 5,000 characters /signup
 BMA-005  medium  Double-click submits twice                         /signup
 BMA-006  medium  Form fails silently with optional fields blank     /signup
 BMA-007  medium  Page scrolls sideways on a phone                   /orders
 ...
 Each one: steps to reproduce, screenshot, root cause in your code, and a failing test.
```

## What it does

1. **Starts your app.** Finds the dev script and package manager, launches the server, waits for the port.
2. **Maps it.** The agent reads your repo for pages and API routes, including the ones nothing links to.
3. **Attacks it** in a headless browser with a deterministic harness:

   | Pack | What it tries |
   |---|---|
   | Hostile inputs | Empty, whitespace, 5,000 characters, HTML/script markup, emoji and right-to-left text, negative and absurd numbers, optional fields left blank |
   | Rapid clicks | Double-clicks every submit and counts the requests |
   | Network faults | Every API call returns 500, every API call drops, and forms submitted with the connection cut |
   | Phone layout | Each page at 375px wide: sideways scroll, missing viewport tag |
   | Logged-out API sweep | Every API route called with no session, plus broken JSON to anything that accepts writes |

4. **Detects** uncaught exceptions, blank screens, framework error overlays, 5xx responses, leaked stack traces, script injection (reflected and stored), silent form failures, duplicate submits, broken links and failed requests.
5. **Triages.** The agent reads the code behind each finding, drops false alarms, and traces the rest to a file and line.
6. **Proves it.** One self-contained Playwright test per finding. It fails now and passes when you have fixed the bug.

It reports and proves. It does not edit your source unless you then ask it to fix something.

## Install

Requires Node.js 18 or newer, on macOS or Linux. Playwright is installed on first run into a
git-ignored folder, so your `package.json` and lockfile are not touched.

**Claude Code**

```bash
git clone https://github.com/ShobhanKarthish/break-my-app.git ~/.claude/skills/break-my-app
```

**Other agents that support [Agent Skills](https://agentskills.io)**

```bash
npx skills add ShobhanKarthish/break-my-app
```

## Use

In your project, ask your agent:

```
break my app
```

or `/break-my-app`, or "is this ready to ship?". Add `--quick` for a read-only pass (crawl,
phone layout and API sweep; no form fuzzing, nothing written).

Results land in `.break-my-app/` inside your project:

```
.break-my-app/
├── report.md          what broke, how to reproduce it, why, and the fix
├── findings.json      the same, machine-readable
├── screenshots/       one per finding
└── repro/*.spec.ts    one failing Playwright test per finding
```

## Safety

- **Localhost only.** The harness refuses any other target. Fuzzing a deployed site writes
  junk data and can break things for real users.
- **It writes test data.** The inputs pack submits your forms dozens of times. Point your
  dev server at a local or disposable database. The skill checks your config and asks
  before fuzzing if the database looks hosted or shared.
- **It skips** payment forms and anything labelled delete, remove or log out, and blocks
  browser writes to third-party services. It cannot stop what your own server does in
  response to a form (sending an email, for example).
- **No real credentials.** It logs in only with test accounts from your seed files or ones
  you give it for the purpose.

Only run it against apps you own.

## Limits of v0

- Tested so far against a plain Node app. Next.js, Vite, SvelteKit and others should work
  but are not yet verified; issues with details are welcome.
- Network faults are injected in the browser, so data fetched on the server (server
  components, SSR loaders) is not fault-tested.
- No multi-step flows (checkout, onboarding wizards), file uploads or custom widgets.
- One login role per run. It will not catch a member reaching admin routes on its own.
- Supabase/Firebase rules are not inspected; the API sweep only sees your app's own routes.
- Chromium at phone size, not real mobile browsers.
- Windows is untested.

## Try it on the demo

The repo includes a deliberately broken app with one planted bug per detector:

```bash
node evals/selftest.mjs
```

This copies the demo to a temporary folder, starts it, runs the full harness, and checks
that every planted bug is found and the clean control page is not flagged.

## How it is built

```
SKILL.md                  the workflow the agent follows
scripts/
  setup.mjs               make Playwright available without touching the project
  server.mjs              start / stop the dev server
  harness.mjs             crawl, attack, detect, write report and tests
  lib/                    detectors, form fuzzing, attack packs, test generator
references/               triage guide, route discovery per framework, testing behind a login
evals/                    the broken demo app and the self-test
```

The attacking is done by a script rather than by the model clicking around, so runs are
repeatable, fast and cheap. The model does what a script cannot: read the repo, judge which
findings are real, and explain them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New detectors and hostile inputs are the most
useful contributions, along with reports of how it behaves on real frameworks.

## License

[MIT](LICENSE)
