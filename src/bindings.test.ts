// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The env surface is written three times — once as config and twice as types —
// because neither TypeScript program can read wrangler.toml and `astro check`
// does not merge the generated `__BaseEnv_Env` chain (see the comments in
// env.d.ts and worker/env.d.ts). Both .d.ts files say "must match wrangler.toml"
// and AGENTS.md calls ASSETS's placement load-bearing, but nothing read them: a
// dropped binding typechecked, and a binding renamed in wrangler.toml alone
// would have surfaced as a runtime `undefined` in production. This is the same
// shape as retention.cron.test.ts, which holds PRUNE_CRON and the wrangler
// `crons` array together.
//
// The `[vars]` are the part that bites hardest now: `wrangler types` emits them
// as *literal* types, so a hand-written `string` in the .d.ts conflicts with the
// generated chain and the error lands at `handle(request, env, ctx)` in
// worker/entrypoint.ts rather than anywhere near the declaration. Pinning the
// literal values here is what keeps that failure a test failure.
//
// The generated worker-configuration.d.ts is deliberately not checked: it is
// derived from wrangler.toml by `wrangler types`, so it cannot drift.

// cwd-relative: vitest's jsdom environment mangles import.meta.url schemes.
function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

/** Every `binding = "X"` in the config: KV, D1, assets. */
function tomlBindings(): string[] {
  return [...read('wrangler.toml').matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map(
    (match) => match[1]!,
  );
}

/** Every `KEY = "value"` inside the `[vars]` table, in file order. Line-based on
 *  purpose: a lookahead that can match at any line end stops the block after its
 *  first entry, which is exactly how a version of this parser found one var of
 *  two and made four assertions below vacuously wrong. */
function tomlVars(): { key: string; value: string }[] {
  const lines = read('wrangler.toml').split('\n');
  const start = lines.findIndex((line) => line.trim() === '[vars]');
  if (start === -1) return [];
  const vars: { key: string; value: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/);
    if (match) vars.push({ key: match[1]!, value: match[2]! });
  }
  return vars;
}

/** The member names of the hand-written `Cloudflare.Env`, with optionality. */
function declaredEnv(file: string): { name: string; optional: boolean }[] {
  const block = read(file).match(/interface Env \{([^}]*)\}/)?.[1] ?? '';
  return [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(\??):/gm)].map((match) => ({
    name: match[1]!,
    optional: match[2] === '?',
  }));
}

/** The members declared with a string-literal type, which are exactly the vars
 *  `wrangler types` would generate for `[vars]`. */
function declaredVarLiterals(file: string): Record<string, string> {
  const block = read(file).match(/interface Env \{([^}]*)\}/)?.[1] ?? '';
  const literals: Record<string, string> = {};
  for (const match of block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*'([^']*)'/gm)) {
    literals[match[1]!] = match[2]!;
  }
  return literals;
}

const toml = tomlBindings();
const vars = tomlVars();
const varNames = new Set(vars.map((entry) => entry.key));
const app = declaredEnv('env.d.ts');
const worker = declaredEnv('worker/env.d.ts');
// Required members are bindings and vars; optional ones are the secrets, which
// are the only thing that may legitimately be unset at runtime. Deriving the
// partition from optionality rather than a hardcoded list means a new secret
// cannot slip past the binding assertions below by being added as `string`.
const appBindings = app
  .filter((member) => !member.optional && !varNames.has(member.name))
  .map((member) => member.name);
const workerBindings = worker
  .filter((member) => !member.optional && !varNames.has(member.name))
  .map((member) => member.name);
const appSecrets = app.filter((member) => member.optional).map((member) => member.name);
const workerSecrets = worker.filter((member) => member.optional).map((member) => member.name);

describe('binding declarations', () => {
  it('parses the three files it is meant to be comparing', () => {
    // Guards the parsers themselves: a regex that matched nothing would make
    // every assertion below vacuously true, which is how a pin like this rots.
    expect([...toml].sort()).toEqual(['ASSETS', 'CACHE', 'DB']);
    expect(vars.map((entry) => entry.key)).toEqual(['LLM_BASE_URL', 'LLM_MODEL']);
    expect(appBindings.length).toBeGreaterThan(0);
    expect(workerBindings.length).toBeGreaterThan(0);
  });

  it('declares in the worker half exactly what wrangler.toml binds', () => {
    // A new binding in wrangler.toml fails here until worker/env.d.ts declares
    // it, which is the whole point: the Worker program is where `handle()` and
    // the entrypoint see their env.
    expect([...workerBindings].sort()).toEqual([...toml].sort());
  });

  it('declares in the app half exactly what wrangler.toml binds, minus ASSETS', () => {
    const missing = toml.filter((binding) => !appBindings.includes(binding));
    expect(missing).toEqual(['ASSETS']);
  });

  it('never declares a binding wrangler.toml does not bind', () => {
    // The other direction: a renamed or deleted binding left behind in a .d.ts
    // would typecheck while being undefined at runtime.
    expect(appBindings.filter((binding) => !toml.includes(binding))).toEqual([]);
    expect(workerBindings.filter((binding) => !toml.includes(binding))).toEqual([]);
  });

  it('restates every [vars] entry as the literal type wrangler types emits', () => {
    const expected = Object.fromEntries(vars.map((entry) => [entry.key, entry.value]));
    expect(declaredVarLiterals('env.d.ts')).toEqual(expected);
    expect(declaredVarLiterals('worker/env.d.ts')).toEqual(expected);
  });

  it('keeps the secret out of the config and optional in both halves', () => {
    // LLM_API_KEY must never reach wrangler.toml (it is set with
    // `wrangler secret put`), and it must be optional: a local run without
    // .dev.vars has to degrade to an uncurated desk, not fail to boot.
    expect(appSecrets).toEqual(['LLM_API_KEY']);
    expect(workerSecrets).toEqual(['LLM_API_KEY']);
    expect(read('wrangler.toml')).not.toMatch(/^\s*LLM_API_KEY\s*=/m);
  });
});
