// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bindings are written three times — once as config and twice as types —
// because neither TypeScript program can read wrangler.toml and `astro check`
// does not merge the generated `__BaseEnv_Env` chain (see the comments in
// env.d.ts and worker/env.d.ts). Both .d.ts files say "must match the bindings
// in wrangler.toml" and AGENTS.md calls ASSETS's placement load-bearing, but
// nothing read them: a dropped binding typechecked, and a binding renamed in
// wrangler.toml alone would have surfaced as a runtime `undefined` in
// production. This is the same shape as retention.cron.test.ts, which holds
// PRUNE_CRON and the wrangler `crons` array together.
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

/** The member names of the hand-written `Cloudflare.Env` in a .d.ts file. */
function declaredBindings(file: string): string[] {
  const block = read(file).match(/interface Env \{([^}]*)\}/)?.[1] ?? '';
  return [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]!);
}

const toml = tomlBindings();
const app = declaredBindings('env.d.ts');
const worker = declaredBindings('worker/env.d.ts');

describe('binding declarations', () => {
  it('parses the three files it is meant to be comparing', () => {
    // Guards the parsers themselves: a regex that matched nothing would make
    // every assertion below vacuously true, which is how a pin like this rots.
    expect([...toml].sort()).toEqual(['ASSETS', 'CACHE', 'DB']);
    expect(app.length).toBeGreaterThan(0);
    expect(worker.length).toBeGreaterThan(0);
  });

  it('declares in the worker half exactly what wrangler.toml binds', () => {
    // A new binding in wrangler.toml fails here until worker/env.d.ts declares
    // it, which is the whole point: the Worker program is where `handle()` and
    // the entrypoint see their env.
    expect([...worker].sort()).toEqual([...toml].sort());
  });

  it('declares in the app half exactly what wrangler.toml binds, minus ASSETS', () => {
    const missing = toml.filter((binding) => !app.includes(binding));
    expect(missing).toEqual(['ASSETS']);
  });

  it('never declares a binding wrangler.toml does not bind', () => {
    // The other direction: a renamed or deleted binding left behind in a .d.ts
    // would typecheck while being undefined at runtime.
    expect(app.filter((binding) => !toml.includes(binding))).toEqual([]);
    expect(worker.filter((binding) => !toml.includes(binding))).toEqual([]);
  });
});
