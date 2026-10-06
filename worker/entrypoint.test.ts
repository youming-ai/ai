/// <reference types="@cloudflare/workers-types" />
// @vitest-environment node
// The deployed fetch handler is this entrypoint, not worker/index.ts: Astro only
// mounts that dispatcher at /api/*, so a /media/ route placed there is
// unreachable and every proxied image 404s against ASSETS. These tests pin the
// wiring — media is answered *before* Astro's handler is consulted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/data/api';
import { PRUNE_CRON } from '../src/feeds/retention';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('@astrojs/cloudflare/handler', () => ({ handle }));

// The sweep is chosen by comparing controller.cron against PRUNE_CRON, and a
// drift there once ran a second full ingest for weeks with nothing failing
// loudly. Pinning the two strings in wrangler.toml (retention.cron.test.ts) does
// not cover the comparison itself, so these tests drive it directly.
const { ingestAllSources, pruneOldRecords, curatePending } = vi.hoisted(() => ({
  ingestAllSources: vi.fn(),
  pruneOldRecords: vi.fn(),
  curatePending: vi.fn(),
}));
vi.mock('../src/feeds/ingest', () => ({ ingestAllSources }));
vi.mock('../src/feeds/curate', async (importOriginal) => ({
  // CURATION_LIMIT is a real value the health check reports; only the pass is
  // mocked. Mocking the whole module would hand the import a limit of undefined.
  ...(await importOriginal<typeof import('../src/feeds/curate')>()),
  curatePending,
}));
vi.mock('../src/feeds/retention', async (importOriginal) => ({
  // PRUNE_CRON stays real: the comparison under test must use the same constant
  // the wrangler.toml binding test pins.
  ...(await importOriginal<typeof import('../src/feeds/retention')>()),
  pruneOldRecords,
}));

import entrypoint from './entrypoint';

type EntryRequest = Parameters<NonNullable<typeof entrypoint.fetch>>[0];

/** ExportedHandler types `fetch` with Cloudflare's incoming-request generics,
 *  which a plain `new Request()` does not satisfy. Cast in one place. */
function request(url: string, init?: RequestInit): EntryRequest {
  return new Request(url, init) as unknown as EntryRequest;
}

const ENV = {} as unknown as Env;
const ID = '437e368b-c40c-4e02-8e06-2ca5bbcb8055';

function mockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {},
  } as unknown as ExecutionContext;
}

describe('entrypoint fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh Response per call: a shared one has its body consumed by the first
    // reader.
    handle.mockImplementation(async () => new Response('astro', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers /media/<id> itself, without consulting Astro', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const res = await entrypoint.fetch!(request(`https://x/media/${ID}`), ENV, mockCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Pins the upstream the relay actually talks to, not just the status.
    expect(fetchMock).toHaveBeenCalledWith(
      `https://cloud.poche.app/api/storage/${ID}`,
      expect.objectContaining({ cf: expect.objectContaining({ cacheEverything: true }) }),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('delegates every other path to Astro', async () => {
    for (const path of ['/', '/a/abc', '/api/explore', '/rss.xml']) {
      const res = await entrypoint.fetch!(request(`https://x${path}`), ENV, mockCtx());
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe('astro');
    }
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it('hands a /media/ path that is not a storage id back to Astro', async () => {
    // Regression: `/media/rss.xml` is the `media` category hub's feed, and the
    // proxy used to claim the whole `/media/` prefix and answer 404 for it —
    // a URL /sitemap.xml advertises.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const rest of ['rss.xml', 'not-a-uuid']) {
      const res = await entrypoint.fetch!(request(`https://x/media/${rest}`), ENV, mockCtx());
      expect(res.status, rest).toBe(200);
      expect(await res.text(), rest).toBe('astro');
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-GET on /media/', async () => {
    const res = await entrypoint.fetch!(
      request(`https://x/media/${ID}`, { method: 'POST' }),
      ENV,
      mockCtx(),
    );
    expect(res.status).toBe(405);
    expect(handle).not.toHaveBeenCalled();
  });

  it('400s malformed percent-encoding instead of 500ing through the catch-all', async () => {
    // Left unhandled the URIError escapes to the entrypoint's catch, which
    // answers 500 and logs an unhandled error for what is client input.
    const res = await entrypoint.fetch!(request('https://x/media/%'), ENV, mockCtx());
    expect(res.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('entrypoint scheduled', () => {
  const report = {
    sources: 1,
    fetched: 3,
    trimmed: 0,
    skipped: 1,
    stored: 2,
    uncategorized: 0,
    unmappedCategories: [],
    failed: [],
  };

  const curation = {
    configured: true,
    selected: 0,
    curated: 0,
    filtered: 0,
    skipped: 0,
    failed: 0,
  };

  function controller(cron: string): ScheduledController {
    return { cron, scheduledTime: 0, noRetry: () => {} } as unknown as ScheduledController;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ingestAllSources.mockResolvedValue(report);
    pruneOldRecords.mockResolvedValue(undefined);
    curatePending.mockResolvedValue(curation);
  });

  it('runs the sweep on PRUNE_CRON and nothing else', async () => {
    await entrypoint.scheduled!(controller(PRUNE_CRON), ENV, mockCtx());
    expect(pruneOldRecords).toHaveBeenCalledOnce();
    expect(ingestAllSources).not.toHaveBeenCalled();
  });

  it('runs an ingest on the frequent tick and does not sweep', async () => {
    await entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx());
    expect(ingestAllSources).toHaveBeenCalledOnce();
    expect(curatePending).toHaveBeenCalledOnce();
    expect(pruneOldRecords).not.toHaveBeenCalled();
  });

  it('does not curate on the sweep tick', async () => {
    // The sweep is the one tick that touches the corpus by age; running the
    // curator there would spend model budget on the same schedule as a delete.
    await entrypoint.scheduled!(controller(PRUNE_CRON), ENV, mockCtx());
    expect(curatePending).not.toHaveBeenCalled();
  });

  it('treats an unrecognised schedule as an ingest tick', async () => {
    // Documented behaviour: anything that is not PRUNE_CRON is an ingest. A
    // third trigger added to wrangler.toml therefore fans out twice, which is
    // the failure retention.cron.test.ts pins the count to prevent.
    await entrypoint.scheduled!(controller('0 4 * * *'), ENV, mockCtx());
    expect(ingestAllSources).toHaveBeenCalledOnce();
    expect(pruneOldRecords).not.toHaveBeenCalled();
  });

  it('reports a scheduled failure instead of letting the tick vanish', async () => {
    // Cron invocations are not retried, so a throw escaping this handler means
    // the tick did not happen and nothing said so. Per-source and per-article
    // failures are handled inside ingest; this covers the setup failure.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ingestAllSources.mockRejectedValueOnce(new Error('D1 unavailable'));

    // The rejection has to escape: swallowing it reports a successful
    // invocation for a tick that never ran, and a scheduled event that rejects
    // is what follows the platform's retry path.
    await expect(entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx())).rejects.toThrow(
      'D1 unavailable',
    );

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('*/15 * * * * failed:'),
      expect.objectContaining({ message: 'D1 unavailable' }),
    );
  });

  it('names unmapped publisher categories at info level, and failed sources at error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ingestAllSources.mockResolvedValue({
      ...report,
      uncategorized: 2,
      unmappedCategories: ['Robotics'],
      failed: ['ServeTheHome'],
    });

    await entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx());

    // Failed sources stay at error — a source can fail every tick for a day with
    // nothing else noticing. An unmapped publisher category is info now: the
    // curator assigns the stored category from the story text, so the publisher's
    // own vocabulary is a hint we ignore rather than a hole in the board. It is
    // still logged, because the values are the only early signal that an upstream
    // feed changed shape.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('unregistered publisher category'),
      'Robotics',
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sources failed'), 'ServeTheHome');
  });

  it('reports the window and cap trimming at info level', async () => {
    // Not decoration: a publisher that switches to a full-archive feed shows up
    // here as a jump instead of as a silently longer tick.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ingestAllSources.mockResolvedValue({ ...report, trimmed: 1200 });

    await entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx());

    expect(log).toHaveBeenCalledWith(expect.stringContaining('trimmed 1200/1203'));
  });

  it('warns when the curator has no configuration and says nothing else about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    curatePending.mockResolvedValue({ ...curation, configured: false });

    await entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx());

    // The desk keeps collecting and serving; the queue is what grows, and
    // /api/health is where that is visible.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('curated '));
  });

  it('logs what the curator did, and errors when it failed on stories', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    curatePending.mockResolvedValue({
      configured: true,
      selected: 24,
      curated: 14,
      filtered: 7,
      skipped: 2,
      failed: 1,
    });

    await entrypoint.scheduled!(controller('*/15 * * * *'), ENV, mockCtx());

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('curated 14, filtered 7, skipped 2, failed 1 of 24'),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('curator failed on 1'));
  });
});
