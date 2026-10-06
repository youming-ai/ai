// @vitest-environment node
// The media proxy relays an upstream image under our own origin, so these tests
// care about two things: which URLs get rewritten, and that `/media/<file>`
// can never be steered at a host we did not choose.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_PATH,
  sameOriginAsset,
  isVideoMediaUrl,
  mediaFile,
  mediaRequest,
  proxiedImageUrl,
  serveMedia,
  upstreamMediaUrl,
  withTemporalFragment,
} from './media';
import { SITE_ORIGIN } from './site';

const ID = '437e368b-c40c-4e02-8e06-2ca5bbcb8055';
const UPSTREAM = `https://cloud.poche.app/api/storage/${ID}`;

describe('isVideoMediaUrl', () => {
  it('recognises the extensions a browser can play', () => {
    for (const url of [
      'https://x.test/video.mp4',
      'https://x.test/video.webm',
      'https://x.test/video.m4v',
      'https://x.test/video.MOV',
      'https://x.test/video.ogv',
    ]) {
      expect(isVideoMediaUrl(url), url).toBe(true);
    }
  });

  it('is case-insensitive and ignores query strings and fragments', () => {
    expect(isVideoMediaUrl('https://x.test/v.MP4?token=1')).toBe(true);
    expect(isVideoMediaUrl('https://x.test/v.mp4#t=10')).toBe(true);
  });

  it('does not mistake images or pages for videos', () => {
    for (const url of [
      'https://x.test/og.png',
      'https://x.test/og.jpg?w=1200',
      'https://x.test/page',
      'https://x.test/video.mp4.txt',
      '',
    ]) {
      expect(isVideoMediaUrl(url), url).toBe(false);
    }
  });

  it('survives a value that is not a URL', () => {
    expect(isVideoMediaUrl('not a url')).toBe(false);
  });
});

describe('withTemporalFragment', () => {
  it('appends the seek hint', () => {
    expect(withTemporalFragment('https://x.test/v.mp4')).toBe('https://x.test/v.mp4#t=0.1');
  });

  it('replaces a fragment the URL already carries', () => {
    // A second `#` would leave the browser honouring neither seek.
    expect(withTemporalFragment('https://x.test/v.mp4#t=30')).toBe('https://x.test/v.mp4#t=0.1');
  });
});

describe('mediaFile', () => {
  it('extracts the storage id from an upstream image URL', () => {
    expect(mediaFile(UPSTREAM)).toBe(ID);
    expect(mediaFile(`https://cloud.poche.app/api/storage/${ID.toUpperCase()}`)).toBe(
      ID.toUpperCase(),
    );
  });

  it('ignores images that are not on the proxied origin', () => {
    expect(mediaFile('https://threejs.paris/og-image.jpg')).toBeNull();
    expect(mediaFile('https://pbs.twimg.com/media/HR.jpg')).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    expect(mediaFile(`https://cloud.poche.app.evil.test/api/storage/${ID}`)).toBeNull();
    expect(mediaFile(`https://evil.test/cloud.poche.app/api/storage/${ID}`)).toBeNull();
  });

  it('rejects upstream paths that are not storage ids', () => {
    expect(mediaFile(`https://cloud.poche.app/api/other/${ID}`)).toBeNull();
    expect(mediaFile('https://cloud.poche.app/api/storage/not-a-uuid')).toBeNull();
    expect(mediaFile(`https://cloud.poche.app/api/storage/${ID}/extra`)).toBeNull();
    expect(mediaFile('https://cloud.poche.app/api/storage/../secret')).toBeNull();
  });

  it('returns null for values that are not absolute URLs', () => {
    expect(mediaFile(`${MEDIA_PATH}${ID}`)).toBeNull();
    expect(mediaFile('')).toBeNull();
  });
});

describe('sameOriginAsset', () => {
  // The bug this exists for: card images were rewritten to
  // `${SITE_ORIGIN}/media/<id>`, and SITE_ORIGIN pointed at a domain with no DNS
  // record — so every proxied image on the live site was broken while the same
  // path on the serving host answered 200. An asset URL belongs to whoever
  // served the page.
  it('turns our own media URL into a root-relative path', () => {
    expect(sameOriginAsset(`${SITE_ORIGIN}/media/437e368b-c40c-4e02-8e06-2ca5bbcb8055`)).toBe(
      '/media/437e368b-c40c-4e02-8e06-2ca5bbcb8055',
    );
  });

  it('leaves a third-party image alone, absolute', () => {
    for (const url of [
      'https://images.ctfassets.net/a/b/photo.png',
      'https://pbs.twimg.com/media/abc.jpg?format=webp&name=small',
      'https://example.com/photo.png',
      '',
    ]) {
      expect(sameOriginAsset(url), url).toBe(url);
    }
  });

  it('does not touch another path on our own origin', () => {
    // Only the media route is ours to re-point; a canonical or og URL must keep
    // the canonical origin.
    for (const url of [`${SITE_ORIGIN}/og.png`, `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/tools`]) {
      expect(sameOriginAsset(url), url).toBe(url);
    }
  });
});

describe('proxiedImageUrl', () => {
  it('rewrites an upstream image onto our own origin, absolutely', () => {
    expect(proxiedImageUrl(UPSTREAM)).toBe(`${SITE_ORIGIN}${MEDIA_PATH}${ID}`);
  });

  it('leaves third-party images untouched', () => {
    for (const url of ['https://pbs.twimg.com/media/HR.jpg', 'https://www.vals.ai/og.jpg', '']) {
      expect(proxiedImageUrl(url)).toBe(url);
    }
  });

  it('drops an unrecognised path on the proxied origin rather than leaking the host', () => {
    // Unreachable today (every stored URL is a storage id), but a future path
    // shape must not silently pass the upstream host through to markup.
    expect(proxiedImageUrl('https://cloud.poche.app/api/storage/nope')).toBe('');
    expect(proxiedImageUrl('https://cloud.poche.app/some/new/thing.png')).toBe('');
  });
});

describe('upstreamMediaUrl', () => {
  it('builds the upstream URL for a storage id', () => {
    expect(upstreamMediaUrl(ID)).toBe(UPSTREAM);
  });

  it('refuses anything that is not a storage id', () => {
    for (const file of [
      '',
      'nope',
      '../../etc/passwd',
      'https://evil.test/x.png',
      `${ID}/../other`,
      `${ID}?x=1`,
    ]) {
      expect(upstreamMediaUrl(file), file).toBeNull();
    }
  });
});

describe('serveMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('404s without fetching when the file name is not a storage id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await serveMedia('../../etc/passwd');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays the upstream body with a long-lived cache header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/webp' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const res = await serveMedia(ID);
    expect(fetchMock).toHaveBeenCalledWith(
      UPSTREAM,
      expect.objectContaining({ cf: expect.objectContaining({ cacheEverything: true }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    // Our origin serves the bytes, so the type must not be sniffed away from it.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('image-bytes');
  });

  it('gives the upstream fetch a deadline', async () => {
    // Without one, a hanging upstream holds the reader's request until the
    // platform gives up — nothing in the card, for the whole wait. The feed
    // fetch has carried the same 10s ceiling since it was written.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('bytes', { status: 200, headers: { 'content-type': 'image/webp' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    // Spying on the factory rather than inspecting the signal: any duration,
    // or a controller that never aborts, satisfies "an AbortSignal was passed",
    // so the deadline itself is what has to be pinned.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await serveMedia(ID);

    expect(timeout).toHaveBeenCalledWith(10_000);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal, 'abort signal passed to the upstream fetch').toBeInstanceOf(AbortSignal);
  });

  it('refuses a non-image type rather than serving markup from our own origin', async () => {
    // An HTML object in the upstream store would otherwise render as markup
    // under umuo.app — same-origin XSS, and `nosniff` does not help when the
    // declared type *is* HTML.
    for (const type of ['text/html', 'application/octet-stream', 'text/html; charset=utf-8']) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('<script>alert(1)</script>', {
          status: 200,
          headers: { 'content-type': type },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      expect((await serveMedia(ID)).status, type).toBe(404);
    }
  });

  it('refuses a response that declares no type at all', async () => {
    // A byte body, not a string: Node's undici infers `text/plain;charset=UTF-8`
    // for a string body and Bun infers nothing, so a string fixture would mean
    // different things on different runtimes — this case would quietly stop
    // testing a missing header under Node.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([60, 104, 116, 109, 108]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await serveMedia(ID)).status).toBe(404);
  });

  it('refuses SVG, which is a scripting context when navigated to directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<svg onload="alert(1)"/>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await serveMedia(ID)).status).toBe(404);
  });

  it('404s when the upstream reports a miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    expect((await serveMedia(ID)).status).toBe(404);
  });

  it('502s on an upstream 5xx, so a transient fault is not read as a missing image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    expect((await serveMedia(ID)).status).toBe(502);
  });

  it('refuses a followed redirect that lands off the pinned origin', async () => {
    // `fetch` follows redirects by default; relaying whatever host it landed on
    // would defeat pinning only one origin.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        redirected: true,
        url: 'https://evil.test/x.png',
        headers: new Headers({ 'content-type': 'image/png' }),
        body: null,
      }),
    );
    expect((await serveMedia(ID)).status).toBe(502);
  });

  it('allows a same-origin redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        redirected: true,
        url: UPSTREAM,
        headers: new Headers({ 'content-type': 'image/png' }),
        body: null,
      }),
    );
    expect((await serveMedia(ID)).status).toBe(200);
  });

  it('502s when the upstream fetch throws', async () => {
    // The catch path logs; silence it so a green run stays quiet.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await serveMedia(ID)).status).toBe(502);
  });
});

describe('mediaRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for paths that are not ours, so routing continues', () => {
    for (const path of ['/', '/api/explore', '/media', '/a/x']) {
      const url = new URL(`https://x${path}`);
      expect(mediaRequest(new Request(url), url), path).toBeNull();
    }
  });

  it('serves a storage id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
        ),
    );
    const url = new URL(`https://x/media/${ID}`);
    expect((await mediaRequest(new Request(url), url))?.status).toBe(200);
  });

  it('leaves a /media/ path that is not a storage id to the rest of the app', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // `/media/rss.xml` is the `media` category hub's own feed: claiming the whole
    // prefix answered 404 for a URL the sitemap advertises. Non-ids must fall
    // through, as must a smuggled URL.
    for (const rest of [
      'rss.xml',
      'not-a-uuid',
      'https:%2F%2Fevil.test%2Fx.png',
      '..%2F..%2Fsecret',
      '',
    ]) {
      const url = new URL(`https://x/media/${rest}`);
      expect(mediaRequest(new Request(url), url), rest || '(empty)').toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s malformed percent-encoding instead of throwing into the catch-all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // `decodeURIComponent` throws URIError on these; left unhandled it escapes
    // to the entrypoint's catch-all and becomes a 500 plus an error log.
    for (const bad of ['%', '%zz', '%E0%A4%A']) {
      const url = new URL(`https://x/media/${bad}`);
      expect((await mediaRequest(new Request(url), url))?.status, bad).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips the body for HEAD while keeping the headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
        ),
    );
    const url = new URL(`https://x/media/${ID}`);
    const res = await mediaRequest(new Request(url, { method: 'HEAD' }), url);
    // HTTP requires HEAD to mirror the GET headers with no body.
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('image/png');
    expect(await res?.text()).toBe('');
  });

  it('rejects a non-GET/HEAD without touching the upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const url = new URL(`https://x/media/${ID}`);
    expect((await mediaRequest(new Request(url, { method: 'POST' }), url))?.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
