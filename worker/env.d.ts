/// <reference types="@cloudflare/workers-types" />

// Manual declarations for the worker tsconfig, which does not include the root
// env.d.ts (whose Env is what `/src/data/api` exports). They must match the
// bindings in void.config.ts.
//
// `ASSETS` is genuinely needed here, not descriptive: removing it makes
// `handle(request, env, ctx)` in entrypoint.ts fail to typecheck, because the
// generated chain does not supply it inside this program. That is the same
// reason the whole file exists rather than relying on worker-configuration.d.ts.
//
// Any future `[vars]` follow the root file's rule: restate the literal type.
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
    ASSETS: Fetcher;
  }
}
