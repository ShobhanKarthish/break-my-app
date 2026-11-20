# Contributing

Thanks for helping break more apps.

## Run the self-test

```bash
node evals/selftest.mjs
```

It copies `evals/fixtures/broken-app` to a temporary folder, installs Playwright there,
starts the app, runs the full harness and checks two things: every planted bug is found,
and the clean `/ok` page is not flagged. It takes a couple of minutes the first time
(Playwright may download a browser) and about a minute after that.

Run it before opening a pull request. If you change what the harness reports, update the
expectations at the top of `evals/selftest.mjs` in the same change.

## Where things live

| To change | Edit |
|---|---|
| What the agent is told to do | `SKILL.md` |
| What counts as a symptom | `scripts/lib/probe.mjs` |
| Hostile inputs, form discovery | `scripts/lib/forms.mjs` |
| Attack packs | `scripts/lib/packs.mjs` |
| Generated tests | `scripts/lib/repro.mjs` |
| The raw report | `scripts/lib/report.mjs` |
| Triage guidance for the agent | `references/detectors.md` |

## Adding a detector or a hostile input

1. Plant the bug in `evals/fixtures/broken-app/server.js` first, and note it in the
   comment at the top of that file. A detector with no fixture cannot be tested.
2. Add the detection, and make sure the finding carries a `repro` the test generator
   understands, so it comes with a failing test.
3. Add it to the expectations in `evals/selftest.mjs`.
4. Document it in `references/detectors.md`: what it means, when it is a false alarm,
   and the usual fix. The agent relies on that file to triage.

## Ground rules

- **No dependencies beyond Playwright.** The scripts run on plain Node so the skill
  installs by copying a folder.
- **Deterministic.** The same app should produce the same findings on every run. No
  randomness, no model calls inside the harness.
- **False alarms cost more than misses.** A report people stop trusting is worthless.
  Only report a symptom during an attack if it was not already there before it.
- **Localhost only, and safe by default.** Do not weaken the target check, the
  third-party write block, or the skipping of payment and destructive controls.
- **Plain language** in finding titles and details. Say what the user of the app would
  experience, then the technical cause.

## Reporting how it did on your app

Reports from real projects are especially useful while the skill is young. Open an issue
with the framework and version, what it caught, what it missed, and any false alarms.
Please do not paste secrets, private URLs or real user data from your report.

## Security

The skill is meant for apps you own, running on your own machine. If you find a way to
make the harness target something else, or a flaw in its safety checks, please open an
issue.
