/// <reference types="@cloudflare/workers-types" />

// Manual declarations for the worker tsconfig, which does not include the root
// env.d.ts (whose Env is what `/src/data/api` exports). They must match the
// bindings in wrangler.toml.
//
// `ASSETS` is genuinely needed here, not descriptive: removing it makes
// `handle(request, env, ctx)` in entrypoint.ts fail to typecheck, because the
// generated chain does not supply it inside this program. That is the same
// reason the whole file exists rather than relying on worker-configuration.d.ts.
//
// The `[vars]` are restated with the literal types `wrangler types` emits, for
// the same reason as the root file: a `string` here conflicts with the generated
// chain, and the error lands at `handle(request, env, ctx)` instead of at the
// declaration. LLM_API_KEY is the secret wrangler cannot generate.
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
    DB: D1Database;
    ASSETS: Fetcher;
    LLM_BASE_URL: 'https://api.b.ai/v1';
    LLM_MODEL: 'mimo-v2.6-flash';
    LLM_API_KEY?: string;
  }
}
