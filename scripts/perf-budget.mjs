// Byte budget for the client payload, enforced after every build.
//
// Why a gate and not a dashboard: every win here — self-hosted variable fonts,
// image priority, content-visibility, and now the removal of the React island —
// is the kind a later edit quietly undoes (a new dependency, a re-added
// `client:load`, a React bump). Nothing else in this repo would notice, because
// none of it changes a test.
//
// **What is measured: what a page downloads.** Not what sits in `dist/client`.
// Those differ, and not by a little: `@astrojs/react` still emits React's DOM
// renderer into `dist/client` even when no island hydrates, so measuring the
// directory would count 141KB no reader ever fetches — and would hide that our
// own client code is now 3KB. The reachable set is computed by walking static
// imports from the page script entries. Leftovers are reported underneath rather
// than budgeted.
//
// Gzip, because that is what crosses the wire.
//
// Run: node scripts/perf-budget.mjs   (wired into `bun run build`)
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

const CLIENT_DIR = 'dist/client';

/** Each budget names the thing it is protecting, so a failure reads as a
 *  sentence rather than a number. */
const BUDGETS = [
  {
    key: 'board script',
    match: (rel) => /_astro\/board\..*\.js$/.test(rel),
    limit: 8_000,
    why: 'The client code the markup hooks: append a page, switch the theme, start the video previews.',
  },
  {
    key: 'page bootstrap entries',
    match: (rel) => /astro_type_script.*\.js$/.test(rel),
    limit: 1_000,
    why: 'One small entry per page that imports the board. Growth here means logic moved into the page instead of the shared script.',
  },
  {
    key: 'all downloaded client JS',
    match: (rel) => rel.endsWith('.js'),
    limit: 12_000,
    why: 'Every script a cold first visit fetches. The React island made this ~50KB gzip.',
  },
  {
    key: 'client CSS',
    match: (rel) => rel.endsWith('.css'),
    limit: 6_000,
    why: 'The stylesheet is render-blocking, so it is on the critical path.',
  },
  {
    key: 'font payload',
    match: (rel) => rel.endsWith('.woff2'),
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

const all = walk(clientDir).map((path) => {
  const rel = relative(clientDir, path).split('\\').join('/');
  const bytes = readFileSync(path);
  return { rel, gzip: gzipSync(bytes).length };
});
const byRel = new Map(all.map((a) => [a.rel, a]));

// Page script entries are what Astro emits for a `<script>` in a page. If the
// naming ever changes this must fail loudly rather than measure an empty set.
const entries = all.filter((a) => /astro_type_script.*\.js$/.test(a.rel));
if (entries.length === 0) {
  console.error('perf-budget: no page script entries found in dist/client.');
  console.error('  The entry naming changed, so the downloaded-JS figure would be');
  console.error('  meaningless. Failing instead of reporting a small number.');
  process.exit(1);
}

const reachable = new Set(entries.map((e) => e.rel));
const queue = [...entries];
while (queue.length > 0) {
  const current = queue.pop();
  const source = readFileSync(join(clientDir, current.rel), 'utf8');
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    // Asset URLs, so posix join — never the filesystem's.
    const resolved = posix.join(posix.dirname(current.rel), match[1]);
    const found = byRel.get(resolved);
    if (found && !reachable.has(resolved)) {
      reachable.add(resolved);
      queue.push(found);
    }
  }
}

// CSS and fonts are referenced from HTML rather than from JS, so they are taken
// wholesale: there is one stylesheet, and the fonts are referenced by it.
const downloaded = all.filter(
  (a) => reachable.has(a.rel) || a.rel.endsWith('.css') || a.rel.endsWith('.woff2'),
);

const failures = [];
const rows = [];
for (const budget of BUDGETS) {
  const matched = downloaded.filter((a) => budget.match(a.rel));
  const total = matched.reduce((sum, a) => sum + a.gzip, 0);
  const over = total > budget.limit;
  if (over) failures.push({ ...budget, total, files: matched.map((m) => m.rel) });
  rows.push({ ...budget, total, files: matched.length, over });
}

// Only build output counts here. Plain static assets (`favicon.svg`, `og.png`,
// `robots.txt`, the OFL licences, `_headers`) are reached from HTML, meta tags
// and crawlers rather than from JS, so calling them unreachable would be wrong —
// and would bury the one file that genuinely is dead.
const leftovers = all.filter((a) => a.rel.endsWith('.js') && !reachable.has(a.rel));
const leftoverBytes = leftovers.reduce((sum, a) => sum + a.gzip, 0);
const width = Math.max(...rows.map((r) => r.key.length));

console.log('\nclient byte budget (gzip, downloaded)');
console.log('─'.repeat(width + 34));
for (const row of rows) {
  const pct = Math.round((row.total / row.limit) * 100);
  const state = row.over ? 'OVER' : `${pct}%`;
  console.log(
    `  ${row.key.padEnd(width)}  ${String(row.total).padStart(7)} / ${String(row.limit).padStart(7)}  ${state.padStart(5)}  (${row.files} file${row.files === 1 ? '' : 's'})`,
  );
}
console.log('─'.repeat(width + 34));
if (leftovers.length > 0) {
  console.log(
    `  emitted but unreachable from any page: ${leftovers.length} file(s), ${leftoverBytes} gzip`,
  );
  for (const leftover of leftovers) console.log(`    ${leftover.rel}`);
}

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
