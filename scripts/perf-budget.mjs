// Byte budget for the client payload, enforced after every build.
//
// Why a gate and not a dashboard: the two changes that produced the current
// numbers (self-hosted variable fonts, image priority) are exactly the kind a
// later edit quietly undoes — a new weight, a new dependency, a React bump.
// Nothing else in this repo would notice, because none of it changes a test.
//
// Budgets are the measured values plus a deliberate ~5% of headroom, so a real
// addition has to be argued for rather than absorbed. Gzip, because that is what
// crosses the wire.
//
// Run: node scripts/perf-budget.mjs   (wired into `bun run build`)
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CLIENT_DIR = 'dist/client';

/** Each budget names the thing it is protecting, so a failure reads as a
 *  sentence rather than a number. */
const BUDGETS = [
  {
    key: 'hydration runtime',
    match: (rel) => /^_astro\/client\..*\.js$/.test(rel),
    limit: 45_000,
    why: 'React itself, shipped so the board can append a page. The single biggest client asset, and the one a React upgrade moves.',
  },
  {
    key: 'island code',
    match: (rel) => /^_astro\/ExploreView\..*\.js$/.test(rel),
    limit: 6_000,
    why: 'The board island: infinite scroll, layout toggle, cards.',
  },
  {
    key: 'all client JS',
    match: (rel) => /^_astro\/.*\.js$/.test(rel),
    limit: 52_500,
    why: 'Every script the browser downloads on a cold first visit.',
  },
  {
    key: 'client CSS',
    match: (rel) => /^_astro\/.*\.css$/.test(rel),
    limit: 6_000,
    why: 'The stylesheet is render-blocking, so it is on the critical path.',
  },
  {
    key: 'font payload',
    match: (rel) => /^fonts\/.*\.woff2$/.test(rel),
    limit: 120_000,
    why: 'Three latin-subset variable faces. Adding a family or a non-variable weight shows up here.',
  },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

let clientDir;
try {
  clientDir = statSync(CLIENT_DIR).isDirectory() ? CLIENT_DIR : null;
} catch {
  clientDir = null;
}
if (!clientDir) {
  // Not a skip: a budget that silently passes when there is nothing to measure
  // is worse than no budget, because it reads as assurance.
  console.error(`perf-budget: ${CLIENT_DIR} not found — run \`bun run build\` first.`);
  process.exit(1);
}

const assets = walk(clientDir).map((path) => {
  const rel = relative(clientDir, path).split('\\').join('/');
  const bytes = readFileSync(path);
  return { rel, gzip: gzipSync(bytes).length };
});

const failures = [];
const rows = [];
for (const budget of BUDGETS) {
  const matched = assets.filter((a) => budget.match(a.rel));
  const total = matched.reduce((sum, a) => sum + a.gzip, 0);
  const over = total > budget.limit;
  if (over) failures.push({ ...budget, total, files: matched.map((m) => m.rel) });
  rows.push({ ...budget, total, files: matched.length, over });
}

const width = Math.max(...rows.map((r) => r.key.length));
console.log('\nclient byte budget (gzip)');
console.log('─'.repeat(width + 34));
for (const row of rows) {
  const pct = Math.round((row.total / row.limit) * 100);
  const bar = row.over ? 'OVER' : `${pct}%`;
  console.log(
    `  ${row.key.padEnd(width)}  ${String(row.total).padStart(7)} / ${String(row.limit).padStart(7)}  ${bar.padStart(5)}  (${row.files} file${row.files === 1 ? '' : 's'})`,
  );
}
console.log('─'.repeat(width + 34));

if (failures.length > 0) {
  console.error('\nperf-budget: over budget\n');
  for (const f of failures) {
    console.error(`  ${f.key}: ${f.total} > ${f.limit} gzip (+${f.total - f.limit})`);
    console.error(`    protects: ${f.why}`);
    console.error(`    files: ${f.files.join(', ')}`);
  }
  console.error('\nEither bring the payload back down, or raise the budget in this');
  console.error('file and say why in the commit — the point is that it is a decision.');
  process.exit(1);
}
console.log('perf-budget: all budgets met\n');
