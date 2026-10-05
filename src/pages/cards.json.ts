import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getExploreFeed, exploreQueryFromUrl } from '../data/api';
import { renderExploreCards } from '../data/exploreCards';

export const prerender = false;

// `/cards.json` — the next page of cards, already rendered to HTML.
//
// This is what lets the board append rows without a renderer in the browser:
// the client fetches this, gets markup produced by the same components the first
// page uses, and appends it. It is an Astro page endpoint rather than a route in
// `worker/index.ts` because the dispatcher's TypeScript program has no DOM lib
// (Workers types plus `lib.dom` collide), and the card components are DOM-typed.
//
// `view` is untrusted input and only ever selects a wrapper element, so an
// unrecognised value falls back to the grid: a stale link should render cards,
// not an error. Everything else goes through `exploreQueryFromUrl`, so the KV
// path, the keyset cursor and the category validation are the API's, not a
// second implementation of them.
export const GET: APIRoute = async ({ url, locals }) => {
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  const feed = await getExploreFeed(
    exploreQueryFromUrl(url),
    env,
    locals.cfContext as ExecutionContext,
  );
  // A failed page must be a failure, not an empty success: the board would
  // otherwise append nothing and report the feed as finished.
  if (feed.unavailable) {
    return new Response('{"error":"unavailable"}', {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(
    JSON.stringify({
      html: renderExploreCards(feed.items, view),
      nextCursor: feed.nextCursor,
      count: feed.items.length,
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
};
