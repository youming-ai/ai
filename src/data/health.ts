import { CURATION_LIMIT, pendingCurationCount } from '../feeds/curate';
import { SITE_VERSION } from '../site';
import type { Env } from './api';

/** Shape returned by /api/health. `status` is the only field a monitor needs. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  checks: {
    d1: 'ok' | 'error';
    cache: 'present' | 'missing';
    /** The curator's own state, deliberately outside `status`: a growing queue
     *  is a degraded *desk* (stories are serving with their raw feed teaser), not
     *  a broken deployment — and a monitor paging on it would page every time the
     *  model endpoint hiccups. `pending` is null when the count itself could not
     *  be read, which is different from a queue that is empty. */
    curation: { configured: boolean; pending: number | null; batch: number };
  };
}

/**
 * Liveness plus the things worth knowing before blaming the app: whether a query
 * reaches D1, whether the cache binding exists, and whether the curator is
 * configured and how far behind its queue is.
 *
 * The D1 probe is a real statement rather than a binding check, because a
 * binding that exists and cannot query is exactly the state this is for. Cache
 * is checked by presence only — reading it would spend an operation per probe
 * to learn something a missing binding already tells us.
 *
 * The curation block exists because the pipeline stores first and curates
 * second: without it, a missing LLM key looks identical to a working desk over
 * HTTP, and the only symptom is that every card shows the publisher's teaser.
 */
export async function healthReport(env: Env): Promise<Response> {
  let d1: 'ok' | 'error' = 'error';
  try {
    await env.DB.prepare('SELECT 1 AS ok').all();
    d1 = 'ok';
  } catch (error) {
    console.error('[health] D1 probe failed:', error);
  }

  const configured = Boolean(env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL);
  let pending: number | null = null;
  if (d1 === 'ok') {
    try {
      pending = await pendingCurationCount(env);
    } catch (error) {
      console.error('[health] curation queue probe failed:', error);
    }
  }

  const cache = typeof env.CACHE?.get === 'function' ? 'present' : 'missing';
  // Not merely "is it up": a Worker that cannot reach its data is not healthy,
  // and answering 200 would hide an outage from whatever is watching.
  const report: HealthReport = {
    status: d1 === 'ok' && cache === 'present' ? 'ok' : 'degraded',
    version: SITE_VERSION,
    checks: {
      d1,
      cache,
      curation: { configured, pending, batch: CURATION_LIMIT },
    },
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
