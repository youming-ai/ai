import { defineConfig } from 'void/config';

// The Worker's Cloudflare configuration. Void generates `.void-wrangler.jsonc`
// from this for the Astro adapter and for `void deploy`, and records resource
// IDs in `void.lock.json` (committed). This replaced wrangler.toml.
export default defineConfig({
  // Nothing is prerendered, so no ISR cache. Answered here so `void deploy`
  // does not ask on every machine.
  routing: { isr: false },
  cloudflare: {
    // Astro SSR on Workers: a discovery desk with a D1-backed feed and a KV SWR
    // cache in front of it. The cron pulls Poche Explore's RSS into D1; `/media/*`
    // is relayed by the entrypoint before Astro sees the request.
    name: 'ai',
    compatibility_date: '2026-07-17',
    compatibility_flags: ['nodejs_compat'],
    // Our own entry: it answers /media/<id> ahead of Astro.
    main: './worker/entrypoint.ts',

    // Where the Worker is reachable, as it was configured in the dashboard
    // before Void deployed it. Void republishes these on every deploy and
    // refuses to deploy over dashboard-managed values it cannot see, so they
    // must stay explicit here.
    routes: [{ pattern: 'ai.um1ng.me', custom_domain: true }],
    workers_dev: true,
    preview_urls: true,

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
        migrations_dir: './db/migrations',
      },
    ],

    // No Durable Objects on purpose: a pending DO migration cannot be staged
    // for a preview upload.
    //
    // No `triggers` either: Void ignores them and installs cron schedules only
    // from the job files in crons/ (see crons/desk.ts).
  },
});
