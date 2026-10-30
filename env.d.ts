/// <reference path=".astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />
/// <reference path="./worker-configuration.d.ts" />

// Manual declarations for astro check, which does not fully merge the
// generated __BaseEnv_Env extends chain in worker-configuration.d.ts. They must
// match the bindings in void.config.ts. `ASSETS` is absent because nothing in
// `src/` reads it — the worker half declares it, and must, for its own tsconfig
// (see worker/env.d.ts).
//
// Any future `[vars]` must be restated with the *literal* types `wrangler types`
// emits: a hand-written `string` conflicts with the generated chain and the
// failure surfaces at `handle(request, env, ctx)`. `bindings.test.ts` pins all
// three declarations to void.config.ts.
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
  }
}

type Runtime = import('@astrojs/cloudflare').Runtime;

declare namespace App {
  interface Locals extends Runtime {}
}
