import { SITE_ORIGIN } from './site';

// The upstream feed hosts some of its images on its own CDN. Those URLs would
// otherwise appear in card markup, the island's hydration payload, the RSS,
// and og:image — every one of them naming the upstream origin. Images on that
// host are therefore served from ours through the `/media/<file>` route.
//
// Only that one origin is proxied, and only its storage ids; everything else is
// passed through untouched.
const UPSTREAM_MEDIA_ORIGIN = 'https://cloud.poche.app';

const UPSTREAM_MEDIA_PATH = '/api/storage/';

/** Public path prefix served by `serveMedia`. */
export const MEDIA_PATH = '/media/';

/** Upstream storage ids look like a UUID. The route accepts a file name and
 *  never a URL, so this pattern is what stops `/media/` from becoming an open
 *  proxy: no absolute URLs, no `..`, no other host, no query string. */
const MEDIA_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `file` is an upstream storage id — the only thing `/media/` serves. */
function isStorageId(file: string): boolean {
  return MEDIA_FILE_RE.test(file);
}

// Extensions a browser can play in a <video> element. Checked on the pathname
// only, so a query string or fragment cannot sneak past the check.
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov|ogv)$/i;

/** Feeds sometimes hand us a video file where a thumbnail belongs — a site's
 *  hero video, for instance. That cannot render in an <img>, and worse, the
 *  browser downloads the whole file before failing to decode it, so such URLs
 *  are detected and routed to a <video> element instead. */
export function isVideoMediaUrl(url: string): boolean {
  try {
    return VIDEO_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Point a <video> at `url` near its start, so a metadata-only preload paints a
 *  first frame. Any fragment the URL already carries is replaced — a second `#`
 *  would leave the browser applying neither seek. */
export function withTemporalFragment(url: string): string {
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  return `${base}#t=0.1`;
}

/** The upstream storage id behind `url`, or null when it is not ours to proxy. */
export function mediaFile(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== UPSTREAM_MEDIA_ORIGIN) return null;
    if (!parsed.pathname.startsWith(UPSTREAM_MEDIA_PATH)) return null;
    const file = parsed.pathname.slice(UPSTREAM_MEDIA_PATH.length);
    return isStorageId(file) ? file : null;
  } catch {
    return null;
  }
}

/** Whether `url` points at the proxied origin, whatever its path. */
function isUpstreamHost(url: string): boolean {
  try {
    return new URL(url).origin === UPSTREAM_MEDIA_ORIGIN;
  } catch {
    return false;
  }
}

/** Rewrite an upstream-hosted image to our own origin. Absolute on purpose —
 *  og:image and JSON-LD both need a full URL, and this value reaches markup,
 *  the island payload, and the RSS alike.
 *
 *  A third-party image is returned untouched. An unrecognised URL *on the
 *  proxied origin* is dropped instead of passed through: the whole point of
 *  this module is that the upstream host never reaches markup, so silently
 *  forwarding a path shape we do not recognise would defeat it. A missing
 *  image is the cheaper failure, and today no such URL exists. */
export function proxiedImageUrl(url: string): string {
  const file = mediaFile(url);
  if (file) return `${SITE_ORIGIN}${MEDIA_PATH}${file}`;
  return isUpstreamHost(url) ? '' : url;
}

/** The same-origin path for a URL that points at our own media route, or the URL
 *  unchanged when it does not.
 *
 *  Asset URLs must not carry the canonical origin. `SITE_ORIGIN` answers "where
 *  should this site live" for canonical/og:image/sitemap/RSS; the page may be
 *  served from somewhere else — a custom domain, a preview URL, a second
 *  hostname on the same Worker — and an `<img>` pinned to the canonical host
 *  breaks wherever the two differ. Not hypothetical: this shipped with
 *  `SITE_ORIGIN` still on a domain that has no DNS record, so every proxied card
 *  image 404'd on the live site while the identical path on the serving host
 *  answered 200. A root-relative path is served by whoever served the page. */
export function sameOriginAsset(url: string): string {
  const prefix = `${SITE_ORIGIN}${MEDIA_PATH}`;
  return url.startsWith(prefix) ? url.slice(SITE_ORIGIN.length) : url;
}

/** Handle a request for `/media/<file>`, or return null when the path is not
 *  ours so the caller can continue to its normal routing.
 *
 *  This is called from `worker/entrypoint.ts` *before* Astro's handler. Astro
 *  only mounts the worker dispatcher at `/api/*` (`src/pages/api/[...route].ts`),
 *  so a `/media/` request that reached Astro would match no page and fall
 *  through to ASSETS, 404ing every proxied image. Keep the call there. */
export function mediaRequest(request: Request, url: URL): Promise<Response> | null {
  if (!url.pathname.startsWith(MEDIA_PATH)) return null;

  let file: string;
  try {
    file = decodeURIComponent(url.pathname.slice(MEDIA_PATH.length));
  } catch {
    // Malformed percent-encoding (`/media/%`, `/media/%E0%A4%A`) is client
    // input, not a server fault. Without this the URIError escapes to the
    // entrypoint's catch-all and becomes a 500 plus an error log line.
    return Promise.resolve(new Response('Bad request', { status: 400 }));
  }

  // Claim only what this route can actually serve. `/media/` is also the path
  // of the `media` category hub, so claiming the whole prefix swallowed
  // `/media/rss.xml` — the hub's own feed — and answered 404 for a URL the
  // sitemap advertises. Anything that is not a storage id belongs to the app.
  if (!isStorageId(file)) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Promise.resolve(new Response('Method not allowed', { status: 405 }));
  }

  const served = serveMedia(file);
  if (request.method !== 'HEAD') return served;
  // HTTP requires a HEAD response to carry the headers of the equivalent GET
  // and no body, so the relayed body is dropped rather than sent.
  return served.then(
    (response) => new Response(null, { status: response.status, headers: response.headers }),
  );
}

/** The upstream URL for a `/media/<file>` request, or null when `file` is not a
 *  storage id. Callers must treat null as 404 — never as "fetch it anyway". */
export function upstreamMediaUrl(file: string): string | null {
  return isStorageId(file) ? `${UPSTREAM_MEDIA_ORIGIN}${UPSTREAM_MEDIA_PATH}${file}` : null;
}

/** Stream one proxied image. The upstream body is relayed rather than buffered
 *  so a large image never has to be held whole, and the long `max-age` plus the
 *  edge cache keeps repeat views off the upstream entirely. */
export async function serveMedia(file: string): Promise<Response> {
  const upstream = upstreamMediaUrl(file);
  if (!upstream) return new Response('Not found', { status: 404 });

  try {
    // Same ceiling the feed fetch uses: without it a hanging upstream holds the
    // reader's request until the platform gives up, and the card shows nothing
    // for the whole wait.
    const response = await fetch(upstream, {
      cf: { cacheEverything: true, cacheTtl: 86_400 },
      signal: AbortSignal.timeout(10_000),
    });
    // `fetch` follows redirects by default, which would let the relayed bytes
    // come from a host we did not pin. A same-origin redirect is fine; anything
    // else is refused rather than relayed blind. Guarded on `redirected` so the
    // common no-redirect path never parses a URL.
    if (response.redirected && new URL(response.url).origin !== UPSTREAM_MEDIA_ORIGIN) {
      return new Response('Upstream unavailable', { status: 502 });
    }
    // 404 is the upstream saying the file is gone — a permanent answer, and the
    // one worth caching as such. Anything else non-ok (5xx, 429) is transient,
    // so it must not be reported as a missing image.
    if (response.status === 404) return new Response('Not found', { status: 404 });
    if (!response.ok) return new Response('Upstream unavailable', { status: 502 });

    // The bytes are served from OUR origin, so the upstream's declared type
    // decides what a browser does with them: an HTML object in the storage
    // bucket would render as markup under umuo.app. This is the gate the
    // previous proxy carried and its reasoning still holds — only images pass,
    // and SVG is excluded because it is a scripting context when navigated to
    // directly, which `nosniff` cannot prevent.
    //
    // Compared lowercased: MIME type tokens are case-insensitive, so a
    // `image/SVG+xml` would otherwise satisfy the first test and slip past the
    // second. The upstream's own spelling is what gets sent on.
    const contentType = response.headers.get('content-type') ?? '';
    const type = contentType.toLowerCase();
    if (!type.startsWith('image/') || type.startsWith('image/svg')) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(response.body, {
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[media] upstream fetch failed:', error);
    return new Response('Upstream unavailable', { status: 502 });
  }
}
