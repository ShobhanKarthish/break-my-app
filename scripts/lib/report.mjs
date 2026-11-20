// Write the human-readable report. The harness produces the raw version; the
// agent running the skill then triages it against the source code.
import fs from 'node:fs';
import path from 'node:path';

const RANK = { high: 0, medium: 1, low: 2 };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function sortFindings(list) {
  return [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.seq - b.seq);
}

export function writeReport(outDir, run) {
  const { findings, eye } = run;
  const L = [];
  const n = (sev) => findings.filter((f) => f.severity === sev).length;

  L.push('# break-my-app report', '');
  L.push(`- **Target:** ${run.url}`);
  L.push(`- **Run:** ${run.startedAt} (${Math.round(run.durationMs / 1000)}s)`);
  L.push(`- **Covered:** ${run.pages.length} page(s), ${run.stats.formsAttacked} form(s) attacked, ${run.stats.apiProbed} API route(s) probed`);
  L.push(`- **Packs:** ${run.packs.join(', ')}`);
  L.push(`- **Findings:** ${findings.length} (${n('high')} high, ${n('medium')} medium, ${n('low')} low)`);
  L.push('', '> Raw harness output. Findings marked *needs triage* have not been checked against the code yet.', '');

  if (!findings.length) {
    L.push('No failures detected by the automated packs. That is not proof the app is solid: see "Not covered" below.', '');
  } else {
    L.push('| ID | Severity | What breaks | Where | Test |', '|---|---|---|---|---|');
    for (const f of findings) {
      L.push(`| ${f.id} | ${f.severity} | ${cell(f.title)}${f.needsTriage ? ' *(needs triage)*' : ''} | ${cell(f.where || f.path)} | \`${f.reproFile}\` |`);
    }
    L.push('');
    for (const f of findings) {
      L.push(`## ${f.id} · ${f.severity} · ${f.title}`, '');
      L.push(f.detail, '');
      if (f.needsTriage) L.push(`**Needs triage:** ${f.triageNote}`, '');
      if (f.paths.length > 1) L.push(`**Also seen on:** ${f.paths.slice(1, 8).join(', ')}`, '');
      if (f.variants.length > 1) L.push(`**Triggered by:** ${f.variants.join(', ')} (steps below use the first)`, '');
      L.push('**Steps to reproduce**', '');
      f.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
      L.push('');
      const ev = Object.entries(f.evidence || {}).filter(([, v]) => v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && !v.length));
      if (ev.length) {
        L.push('**Evidence**', '', '```json', JSON.stringify(Object.fromEntries(ev), null, 2), '```', '');
      }
      if (f.shot) L.push(`![${f.id}](${f.shot})`, '');
      L.push(`**Reproduction test:** \`${f.reproFile}\``, '');
    }
  }

  if (eye.length) {
    L.push('## Look at these by eye', '');
    L.push('These pages did not crash when the API failed, but a script cannot tell a helpful error message from an endless spinner. Open each screenshot and judge.', '');
    for (const e of eye) L.push(`- \`${e.path}\` while ${e.fault}: [${e.shot}](${e.shot})`);
    L.push('');
  }

  L.push('## Coverage', '');
  L.push('| Page | Status | Forms found | Browser API calls on load |', '|---|---|---|---|');
  for (const p of run.pages) {
    const forms = p.forms.map((f) => (f.skip ? `${f.name} (skipped: ${f.skip})` : f.name)).join(', ') || 'none';
    L.push(`| ${p.path} | ${p.status ?? '?'} | ${cell(forms)} | ${p.apiOnLoad.length} |`);
  }
  L.push('');
  if (run.apiRoutes.length) L.push(`API routes probed without a session: ${run.apiRoutes.map((r) => `\`${r.path}\``).join(', ')}`, '');
  if (run.blockedExternal.length) L.push(`Blocked writes to outside services (never sent): ${[...new Set(run.blockedExternal)].slice(0, 10).join(', ')}`, '');

  L.push('## Not covered', '');
  L.push('- Pages only reachable after logging in, unless a saved login was supplied.');
  L.push('- Data fetched on the server (server components, SSR loaders): network faults are injected in the browser only.');
  L.push('- Flows that need several steps in a row (checkout, onboarding wizards), and anything behind a destructive or payment control, which is skipped on purpose.');
  L.push('- Visual polish, copy, accessibility, performance and real mobile browsers (this run used Chromium at phone size).');
  L.push('');

  L.push('## Run the reproduction tests', '');
  L.push('```bash', run.reproCommand, '```', '');
  L.push('Every test should fail now. After a fix, the matching test should pass.', '');

  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));
}
