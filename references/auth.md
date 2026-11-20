# Testing behind a login

Most of an app's real surface is behind the login. Without a session the harness tests
the landing page, the login form and whatever the API hands to strangers, which is useful
but is not the whole job.

## 1. Find a test account

Look, in this order:

1. Seed scripts and fixtures (`seed.ts`, `prisma/seed.*`, `db/seeds.rb`, `fixtures/`).
2. `.env.example`, the README, or test helpers that mention a demo user.
3. A signup page: creating a throwaway account on the local app is fine
   (`bma.test@example.test`, a made-up password). Record it in the report so the user
   knows it exists.

Use only accounts that exist for testing. If the only credentials around are a real
person's (a personal email in `.env`, the user's own Google login), do not use them: ask
the user to create a test account, or run anonymously and say what was not covered.
OAuth-only logins (Google, GitHub) cannot be automated this way; ask the user whether the
app has a dev login bypass.

## 2. Save a logged-in session

Write a short script in `.break-my-app/` (it resolves Playwright the same way the tests
do) and run it. Adjust the selectors to the app's login form:

```js
// .break-my-app/login.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000/login');
await page.getByLabel('Email').fill(process.env.BMA_USER);
await page.getByLabel('Password').fill(process.env.BMA_PASS);
await page.getByRole('button', { name: /log in|sign in/i }).click();
await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 15000 });
await page.context().storageState({ path: new URL('./auth.json', import.meta.url).pathname });
await browser.close();
```

```bash
BMA_USER='…' BMA_PASS='…' node .break-my-app/login.mjs
```

Pass the credentials through the environment as shown, so they do not end up written into
a file or repeated in the report. If the project has its own `@playwright/test`, the
`require` above finds it; otherwise it finds the private copy `setup.mjs` installed.

## 3. Use it

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness.mjs" --url <url> --project . \
  --routes-file .break-my-app/routes.json --storage-state .break-my-app/auth.json
```

The generated tests pick up the same saved session through
`.break-my-app/playwright.config.mjs`.

## What changes when logged in

- **The API sweep still runs with no session**, on purpose: its question is "what can a
  stranger reach?". Routes the logged-in browser was seen calling are added to the sweep
  automatically, which is how private endpoints with no auth check get caught.
- **Fuzzing now writes as that user.** Use an account whose data does not matter.
- **Sessions expire.** If a later run suddenly finds nothing, check `redirects` in the
  harness output; the session probably ran out and every page bounced to the login.
- **Roles:** v0 tests one account. If the app has admin and member roles, the interesting
  bug is a member reaching admin routes. Run once per role, and compare which API routes
  answer for each; say in the report that cross-role access was only checked this far.
