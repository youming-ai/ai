import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getSitemapNews } from '../data/api';
import { renderSitemap, sitemapEntries } from '../sitemap';

export const prerender = false;

// Glue only. The paths + XML live in src/sitemap.ts (pure, testable); the hub
// lookup lives in src/data/api.ts behind the same KV cache.
export const GET: APIRoute = async ({ locals }) => {
  const data = await getSitemapNews(env, locals.cfContext as ExecutionContext);
  // A cold cache plus a failing lookup used to render an empty <urlset> with a
  // 200: a valid document that tells a crawler the site holds nothing. A 5xx is
  // the honest answer — crawlers keep the last sitemap they could read, rather
  // than replacing it with emptiness — and it is what a probe should see.
  if (data.unavailable) {
    return new Response('Sitemap temporarily unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '300' },
    });
  }
  return new Response(renderSitemap(sitemapEntries(data)), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
