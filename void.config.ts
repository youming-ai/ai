import { defineConfig } from 'void/config';

// The Worker's Cloudflare configuration. Void generates `.void-wrangler.jsonc`
// from this for the Astro adapter and for `void deploy`, and records resource
// IDs in `void.lock.json` (committed). This replaced wrangler.toml.
export default defineConfig({
  // Nothing is prerendered, so no ISR cache. Answered here because `void deploy`
  // asks otherwise, and CI cannot answer a prompt.
  routing: { isr: false },
  cloudflare: {
    // Astro SSR on Workers: a discovery desk with a D1-backed feed and a KV SWR
    // cache in front of it. The cron pulls Poche Explore's RSS into D1; `/media/*`
    // is relayed by the entrypoint before Astro sees the request.
    name: 'ai',
    compatibility_date: '2026-07-17',
    compatibility_flags: ['nodejs_compat'],
    // Our own entry: it answers /media/<id> ahead of Astro and handles both
    // cron schedules (told apart by controller.cron).
    main: './worker/entrypoint.ts',

    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: true, persist: true, head_sampling_rate: 1 },
    },

    assets: { directory: './dist', binding: 'ASSETS' },

    kv_namespaces: [{ binding: 'CACHE', id: 'b5d6927aea7345efaddf56bcc2878e89' }],

    d1_databases: [
      {
        binding: 'DB',
        database_name: 'umuo-content',
        // Required for remote deploys — database_name alone does not resolve.
        // Primary region is APAC; D1 cannot be moved without recreating it.
        database_id: '3d229c09-2965-4dbd-a17d-b4e43b15c86d',
        // `void deploy` applies pending migrations from here, after saving a
        // D1 Time Travel restore point.
        migrations_dir: 'migrations',
      },
    ],

    // No Durable Objects on purpose: a pending DO migration cannot be staged
    // for a preview upload.
    //
    // Two schedules, told apart by controller.cron in worker/entrypoint.ts:
    // */15 ingests, 17 3 sweeps. The daily string is duplicated in PRUNE_CRON
    // (src/feeds/retention.ts) because the Worker cannot read this file at
    // runtime; retention.cron.test.ts asserts the two stay identical.
    triggers: { crons: ['*/15 * * * *', '17 3 * * *'] },
  },
});
