#!/usr/bin/env node
// Setup doctor CLI: `npm run doctor`. Verifies the configuration LIVE against
// Stripe and Discord, prints a pass/fail table where every failure states the
// exact fix, and exits non-zero if anything fails. Secrets are never printed —
// only masked prefixes. Same module as GET /api/setup-check.

import { runDoctor } from '../src/services/doctor.js';

const ICON = { pass: '✓', fail: '✗', warn: '!', skip: '–' };

const { ok, checks } = await runDoctor();

console.log('\nTRADELEAKS SETUP DOCTOR\n');
for (const c of checks) {
  console.log(`  ${ICON[c.status]} [${c.status.toUpperCase().padEnd(4)}] ${c.name}`);
  console.log(`             ${c.detail}`);
  if (c.fix) console.log(`             ↳ FIX: ${c.fix}`);
}

const counts = checks.reduce((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
console.log(
  `\n  ${counts.pass ?? 0} passed, ${counts.fail ?? 0} failed, ${counts.warn ?? 0} warnings, ${counts.skip ?? 0} skipped`,
);
if (ok) {
  console.log('  Setup looks healthy — safe to take payments.\n');
} else {
  console.log('  DO NOT take payments until the failures above are fixed:');
  console.log('  buyers would be charged and the role grant would fail.\n');
}
process.exit(ok ? 0 : 1);
