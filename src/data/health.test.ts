import { describe, expect, it, vi } from 'vitest';
import { SITE_VERSION } from '../site';
import type { Env } from './api';
import { healthReport } from './health';

// A monitor reads two things: the status code and, when something is wrong,
// which dependency failed. Both are pinned here, including that a Worker which
// cannot reach its data does not report itself healthy.

function envWith(overrides: Partial<{ db: unknown; cache: unknown }> = {}): Env {
  // Present-key checks, not `??`: one case needs the binding genuinely absent,
  // and a falsy fallback would hand it the default stub instead.
  const db = 'db' in overrides ? overrides.db : undefined;
  const cache = 'cache' in overrides ? overrides.cache : undefined;
  return {
    DB:
      db ??
      ({
        prepare: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [{ ok: 1 }] })),
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
      },
    });
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
      },
    });
  });
});
