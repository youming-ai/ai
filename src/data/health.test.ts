import { describe, expect, it, vi } from 'vitest';
import { CURATION_LIMIT } from '../feeds/curate';
import { SITE_VERSION } from '../site';
import type { Env } from './api';
import { healthReport } from './health';

// A monitor reads two things: the status code and, when something is wrong,
// which dependency failed. Both are pinned here, including that a Worker which
// cannot reach its data does not report itself healthy.
//
// The curation block is the third thing, and it is deliberately not part of
// `status`: a queue that only grows means stories are serving with their raw
// feed teaser, which is a degraded desk rather than a broken deployment.

const CONFIGURED = {
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: 'https://api.example.com/v1',
  LLM_MODEL: 'test-model',
} as unknown as Env;

function envWith(overrides: Partial<{ db: unknown; cache: unknown; llm: unknown }> = {}): Env {
  // Present-key checks, not `??`: one case needs the binding genuinely absent,
  // and a falsy fallback would hand it the default stub instead.
  const db = 'db' in overrides ? overrides.db : undefined;
  const cache = 'cache' in overrides ? overrides.cache : undefined;
  const llm = 'llm' in overrides ? overrides.llm : CONFIGURED;
  return {
    ...(llm as object),
    DB:
      db ??
      ({
        prepare: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [{ ok: 1 }] })),
          first: vi.fn(async () => ({ pending: 0 })),
        })),
      } as unknown),
    CACHE: cache ?? { get: vi.fn(), put: vi.fn() },
  } as unknown as Env;
}

/** The one case where the binding has to be missing rather than stubbed. */
function envWithoutCache(): Env {
  const env = envWith() as unknown as Record<string, unknown>;
  delete env.CACHE;
  return env as unknown as Env;
}

describe('healthReport', () => {
  it('reports ok, with the version, when both dependencies answer', async () => {
    const res = await healthReport(envWith());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      version: SITE_VERSION,
      checks: {
        d1: 'ok',
        cache: 'present',
        curation: { configured: true, pending: 0, batch: CURATION_LIMIT },
      },
    });
  });

  it('reports a growing queue without calling the deployment unhealthy', async () => {
    // The failure this is for: without an LLM key the desk still answers 200 on
    // every path while every card shows the publisher's teaser, so the queue is
    // the only symptom a monitor can see.
    const res = await healthReport(
      envWith({
        db: {
          prepare: vi.fn(() => ({
            all: vi.fn(async () => ({ results: [{ ok: 1 }] })),
            first: vi.fn(async () => ({ pending: 137 })),
          })),
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: { curation: Record<string, unknown> } };
    expect(body.checks.curation).toEqual({
      configured: true,
      pending: 137,
      batch: CURATION_LIMIT,
    });
  });

  it('says the curator is unconfigured when the secret is absent', async () => {
    const res = await healthReport(envWith({ llm: {} }));
    const body = (await res.json()) as { status: string; checks: { curation: unknown } };
    // Still ok: ingest, hubs and RSS all work without the model.
    expect(res.status).toBe(200);
    expect(body.checks.curation).toEqual({
      configured: false,
      pending: 0,
      batch: CURATION_LIMIT,
    });
  });

  it('reports a null queue rather than a false zero when the count fails', async () => {
    // "Could not count" and "nothing waiting" are different facts, and a monitor
    // that conflated them would read a broken queue probe as a drained queue.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await healthReport(
      envWith({
        db: {
          prepare: vi.fn(() => ({
            all: vi.fn(async () => ({ results: [{ ok: 1 }] })),
            first: vi.fn(async () => {
              throw new Error('no such column: enriched_at');
            }),
          })),
        },
      }),
    );

    const body = (await res.json()) as {
      status: string;
      checks: { curation: { pending: unknown } };
    };
    expect(res.status).toBe(200);
    expect(body.checks.curation.pending).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('degrades when D1 cannot be queried, and still says which half failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await healthReport(
      envWith({
        db: {
          prepare: vi.fn(() => ({
            all: vi.fn(async () => {
              throw new Error('D1 down');
            }),
          })),
        },
      }),
    );

    // 503, not 200 with a sad field: whatever is watching has to see the outage.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'degraded',
      version: SITE_VERSION,
      checks: {
        d1: 'error',
        cache: 'present',
        curation: { configured: true, pending: null, batch: CURATION_LIMIT },
      },
    });
    expect(error).toHaveBeenCalled();
  });

  it('degrades when the cache binding is absent', async () => {
    const res = await healthReport(envWithoutCache());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'degraded',
      version: SITE_VERSION,
      checks: {
        d1: 'ok',
        cache: 'missing',
        curation: { configured: true, pending: 0, batch: CURATION_LIMIT },
      },
    });
  });
});
