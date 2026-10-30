/// <reference types="@cloudflare/workers-types" />

import {
  type Env,
  exploreQueryFromUrl,
  healthReport,
  serveExplore,
  serveExploreFilters,
} from '../src/data/api';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        return healthReport(env, ctx);
      }
      if (url.pathname === '/api/explore') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        return serveExplore(exploreQueryFromUrl(url), env, ctx);
      }
      if (url.pathname === '/api/explore/filters') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        // The rail's options are global; `?category` was accepted and ignored,
        // so it is no longer read.
        return serveExploreFilters(env, ctx);
      }
      // /media/* is deliberately absent: Astro only mounts this dispatcher at
      // /api/*, so it is unreachable for media. That route lives in
      // worker/entrypoint.ts, ahead of Astro.

      // Everything else is a 404. Static assets never reach here: Astro mounts
      // this dispatcher at `/api/*` only, so the ASSETS fallthrough that used to
      // sit here was reachable for the bare `/api` path alone — where it also
      // just 404'd, since no asset lives there. There is no SPA to fall back to
      // in a server-rendered app.
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('[worker] unhandled error:', err);
      return new Response('{"error":"internal"}', {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
