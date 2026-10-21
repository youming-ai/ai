import { SITE_VERSION } from '../site';
import type { Env } from './api';

/** Shape returned by /api/health. `status` is the only field a monitor needs. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  checks: {
    d1: 'ok' | 'error';
    cache: 'present' | 'missing';
  };
}

/**
 * Liveness plus the things worth knowing before blaming the app: whether a query
 * reaches D1 and whether the cache binding exists.
 *
 * The D1 probe is a real statement rather than a binding check, because a
 * binding that exists and cannot query is exactly the state this is for. Cache
 * is checked by presence only — reading it would spend an operation per probe
 * to learn something a missing binding already tells us.
 */
export async function healthReport(env: Env): Promise<Response> {
  let d1: 'ok' | 'error' = 'error';
  try {
    await env.DB.prepare('SELECT 1 AS ok').all();
    d1 = 'ok';
  } catch (error) {
    console.error('[health] D1 probe failed:', error);
  }

  const cache = typeof env.CACHE?.get === 'function' ? 'present' : 'missing';
  // Not merely "is it up": a Worker that cannot reach its data is not healthy,
  // and answering 200 would hide an outage from whatever is watching.
  const report: HealthReport = {
    status: d1 === 'ok' && cache === 'present' ? 'ok' : 'degraded',
    version: SITE_VERSION,
    checks: { d1, cache },
  };

  return new Response(JSON.stringify(report), {
    status: report.status === 'ok' ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A monitor must never be told a stale verdict.
      'cache-control': 'no-store',
    },
  });
}
