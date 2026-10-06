/// <reference path=".astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />
/// <reference path="./worker-configuration.d.ts" />

// Manual declarations for astro check, which does not fully merge the
// generated __BaseEnv_Env extends chain in worker-configuration.d.ts. They must
// match the bindings in wrangler.toml. `ASSETS` is absent because nothing in
// `src/` reads it — the worker half declares it, and must, for its own tsconfig
// (see worker/env.d.ts).
//
// The LLM_* vars are restated with the *literal* types `wrangler types` emits
// for `[vars]` (see worker-configuration.d.ts): a hand-written `string` conflicts
// with the generated chain and the failure surfaces far from here, at
// `handle(request, env, ctx)`. `bindings.test.ts` pins all three declarations to
// wrangler.toml so the coupling cannot rot silently. LLM_API_KEY is the secret,
// optional because a local run without .dev.vars must degrade rather than fail
// to typecheck.
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
    DB: D1Database;
    LLM_BASE_URL: 'https://api.b.ai/v1';
    LLM_MODEL: 'mimo-v2.6-flash';
    LLM_API_KEY?: string;
  }
}

type Runtime = import('@astrojs/cloudflare').Runtime;

declare namespace App {
  interface Locals extends Runtime {}
}
