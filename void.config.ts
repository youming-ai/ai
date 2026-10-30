import { defineConfig } from 'void/config';

// The Worker's Cloudflare configuration. Void generates `.void-wrangler.jsonc`
// from this for the Astro adapter and for `void deploy`, and records resource
// IDs in `void.lock.json` (committed). This replaced wrangler.toml.
export default defineConfig({
  // Nothing is prerendered, so no ISR cache. Answered here so `void deploy`
  // does not ask on every machine.
  routing: { isr: false },
  cloudflare: {
    // Astro SSR on Workers: a discovery desk over Poche Explore's RSS, fetched on
    // demand and held as one KV snapshot (SWR). No database and no cron;
    // `/media/*` is relayed by the entrypoint before Astro sees the request.
    name: 'ai',
    compatibility_date: '2026-07-17',
    compatibility_flags: ['nodejs_compat'],
    // Our own entry: it answers /media/<id> ahead of Astro.
    main: './worker/entrypoint.ts',

    // Reachable only at its own domain: no workers.dev name and no per-version
    // preview URLs, which would be further public origins over the production
    // KV. Void republishes these on every deploy, so they stay explicit.
    routes: [{ pattern: 'ai.um1ng.me', custom_domain: true }],
    workers_dev: false,
    preview_urls: false,

    // 自动 spans 包含 URL / KV key；查询串脱敏，Traces 只采样 1%。
    observability: {
      enabled: true,
      redact_query_string: true,
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },

    assets: { directory: './dist', binding: 'ASSETS' },

    kv_namespaces: [{ binding: 'CACHE', id: 'b5d6927aea7345efaddf56bcc2878e89' }],

    // No Durable Objects on purpose: a pending DO migration cannot be staged
    // for a preview upload.
    //
    // No cron either: Void installs schedules only from job files in crons/,
    // and there are none, so a deploy publishes an empty schedule.
  },
});
