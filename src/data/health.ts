import { SITE_VERSION } from '../site';
import type { Env } from './cache';
import { snapshotState } from './explore';

/** Shape returned by /api/health. `status` is the only field a monitor needs. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  checks: {
    /** `stale`: Poche is failing and the kept snapshot is being served. */
    feed: 'ok' | 'stale' | 'error';
    cache: 'present' | 'missing';
  };
}

/**
 * Liveness plus the things worth knowing before blaming the app: whether the
 * board's snapshot can be read (from KV, or fetched from Poche when it is
 * stale) and whether the cache binding exists.
 *
 * The feed probe goes through the same cached read the board uses, so a monitor
 * polling this costs at most one upstream fetch per freshness window.
 */
export async function healthReport(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = typeof env.CACHE?.get === 'function' ? 'present' : 'missing';
  const feed = cache === 'present' ? await snapshotState(env, ctx) : 'error';
  // Not merely "is it up": a Worker that cannot reach its data is not healthy,
  // and answering 200 would hide an outage from whatever is watching. A stale
  // snapshot still renders the board, so it stays 200 but reports `degraded`:
  // otherwise a Poche outage would be visible only as `x-cache: STALE`.
  const report: HealthReport = {
    status: feed === 'ok' ? 'ok' : 'degraded',
    version: SITE_VERSION,
    checks: { feed, cache },
  };

  return new Response(JSON.stringify(report), {
    status: feed === 'error' ? 503 : 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A monitor must never be told a stale verdict.
      'cache-control': 'no-store',
    },
  });
}
