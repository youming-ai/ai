/// <reference types="@cloudflare/workers-types" />
export type Env = Cloudflare.Env;

interface Entry {
  body: string;
  at: number;
}

type CacheState = 'HIT' | 'MISS' | 'REVALIDATED' | 'STALE';

export interface CachedResult {
  body: string;
  status: number;
  cache: CacheState;
}

export function json(body: string, status: number, cache: CacheState): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': cache },
  });
}

const inflight = new Map<string, Promise<CachedResult>>();

export async function runCached(
  cacheKey: string,
  produce: () => Promise<string | null>,
  fresh: number,
  keep: number,
  env: Env,
  ctx: ExecutionContext,
): Promise<CachedResult> {
  let stored: Entry | null = null;
  try {
    stored = await env.CACHE.get<Entry>(cacheKey, 'json');
  } catch (err) {
    console.error(`[data] KV get failed for ${cacheKey}:`, err);
  }
  const now = Date.now();

  if (stored && now - stored.at < fresh * 1000) {
    return { body: stored.body, status: 200, cache: 'HIT' };
  }

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<CachedResult> => {
    try {
      const body = await produce();
      if (body === null) return { body: '{"error":"not found"}', status: 404, cache: 'MISS' };
      const producedAt = Date.now();
      // Fire-and-forget, and deliberately isolated from the response: this runs
      // inside the produce try, so a synchronously throwing put — or a
      // waitUntil that rejects because the context is already settled — used to
      // turn a perfectly good read into a 502. The put's own rejection is
      // caught too; nothing awaits it, so an unhandled rejection would surface
      // as a Worker error log with no request to attach it to.
      try {
        ctx.waitUntil(
          env.CACHE.put(cacheKey, JSON.stringify({ body, at: producedAt } satisfies Entry), {
            expirationTtl: keep,
          }).catch((err) => {
            console.error(`[data] KV put failed for ${cacheKey}:`, err);
          }),
        );
      } catch (err) {
        console.error(`[data] KV put could not be scheduled for ${cacheKey}:`, err);
      }
      return { body, status: 200, cache: stored ? 'REVALIDATED' : 'MISS' };
    } catch (err) {
      console.error(`[data] produce failed for ${cacheKey}:`, err);
      if (stored) return { body: stored.body, status: 200, cache: 'STALE' };
      return { body: '{"error":"upstream unavailable"}', status: 502, cache: 'MISS' };
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}
