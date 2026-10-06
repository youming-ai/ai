// Asking the publisher's own CDN for a smaller image, for free.
//
// The paid resizing entitlement was declined, which leaves the fact that most of
// these hosts ship their own transform parameters. Measured against the live
// feed (`bun run perf:transforms`, and `--all` for coverage), which imports the
// table below rather than restating it — the two had already drifted once:
//
//   whole feed    13,271 KB -> 11,515 KB   (-13%)
//   first 10       2,257 KB ->    978 KB   (-57% of the fold)
//   images touched           7 of 49
//
// A minority of images, but the fold is where LCP lives, so that is the number
// that matters.
//
// Three things make this safe rather than clever:
//
//  1. **Only measured rules.** Each entry was confirmed against a real URL, and
//     the comment records what it returned. Nothing is inferred from a host
//     matching a pattern.
//  2. **A wrong parameter errors, it does not degrade.** Measured: `?width=900`
//     on pbs.twimg.com answers 404 and on images.ctfassets.net answers 400. So
//     the card keeps the original URL in `data-original-src` and
//     src/scripts/board.ts retries it once before giving up — a rotted rule
//     costs one wasted request, not a missing image.
//  3. **An unknown host is left exactly as it was.** This is a table, not a
//     general-purpose rewriter, and the default is "do nothing".
//
// Re-verify the table before trusting a change to it: the conventions belong to
// someone else and can change without notice.

interface Transform {
  /** Suffix match, so `images.ctfassets.net` and any subdomain work. */
  host: string;
  /** Appended to the URL. */
  params: string;
  /** What it did when measured, so the next person can tell if it still does. */
  measured: string;
}

const TRANSFORMS: Transform[] = [
  {
    // Contentful. `fm=webp&q=75` is what makes it dramatic: `?w=900` alone
    // returned 665 KB PNG, the same w= with webp 533 KB, and all three together
    // 58 KB. A `?width=` spelling is rejected outright with a 400.
    host: 'ctfassets.net',
    params: 'w=900&fm=webp&q=75',
    measured: '1241 KB PNG -> 58 KB webp',
  },
  {
    // Shopify. Width only, deliberately: adding `&height=` crops to 106 KB
    // against 122 KB, and a card that letterboxes is not worth 16 KB.
    host: 'shopify.com',
    params: 'width=900',
    measured: '406 KB jpeg -> 122 KB jpeg',
  },
  {
    // Twitter/X. Named variants rather than widths, and every width-shaped
    // parameter tested answers 404 here.
    host: 'twimg.com',
    params: 'format=webp&name=small',
    measured: '44 KB jpeg -> 9 KB webp',
  },
];

/** The host's free-resize parameter string, or null when this URL is not one we
 *  have measured. Exported for the test that pins the table. */
export function feedImageTransform(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = TRANSFORMS.find(
    (t) => parsed.hostname === t.host || parsed.hostname.endsWith(`.${t.host}`),
  );
  return match ? match.params : null;
}

/** The URL to actually ask for, at the width the card slot renders.
 *
 *  Deliberately not applied to video: a `?w=` on an .mp4 is meaningless, and the
 *  card hands those to `<video>` instead. Also note this runs *after*
 *  `proxiedImageUrl` for images on the origin we proxy — those arrive as
 *  `/media/<id>`, which matches no host here, which is correct: that CDN has no
 *  transform of its own. */
export function transformedFeedImage(url: string): string {
  const params = feedImageTransform(url);
  if (!params) return url;
  // Idempotent: handing it an already-transformed URL returns that URL, so a
  // caller that renders the same article twice (the first page and an appended
  // fragment) cannot stack the parameters into something the host rejects.
  if (url.includes(params)) return url;
  // A URL that already carries a query needs `&`, and one that does not must not
  // get a stray `?`. Feed URLs routinely carry tracking parameters.
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params}`;
}
