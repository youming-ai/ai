# Render-performance harness

Five tools and the record of what they measured. They exist because every claim
about this app's performance should be reproducible by someone who does not
trust the prose — including the numbers below, which lived only in PR
descriptions until this file.

## The tools

| Command | What it does |
| --- | --- |
| `bun run perf:probe` | Real Chrome via CDP under a fixed CPU throttle and a Slow-4G profile. LCP, FCP, CLS, a TBT proxy, render-blocking resources, bytes by type, and the request list. `--scroll N --scroll-until 130` adds a long-board phase; `--override-css` A/Bs a rendering rule on one build; `--screenshot`/`--viewport` capture the page. |
| `bun run perf:budget` | Gzip budget for what a page **downloads**, computed by walking static imports from the page entries. Runs at the end of `bun run build`, so exceeding it fails the build. |
| `bun run perf:seed` | Seeds a deterministic 200-row board into the local D1 that the *built* worker reads. |
| `bun run perf:images` | Audits the live feed's card images through the real `parseRss`: total, median, largest, formats, and the fold's weight. |
| `bun run perf:transforms` | Re-checks every image host against the live feed for the free transform parameters `src/images.ts` relies on. `--all` reports the coverage those rules buy. |
| `bun run feeds:probe` | The source registry's own instrument, kept here rather than in `src/`: fetches every entry in `FEED_SOURCES` with the real `parseRss` and reports liveness, parsed vs kept item counts (the freshness window and the per-source cap), median text length, images and publisher categories. Run it before changing a source, a cap, or the parser — the registry is only as good as its last measurement. |

## Measuring, in order

```bash
bun run build                     # also runs the budget gate
bunx wrangler dev --config dist/server/wrangler.json --port 8787 --local &
bun run perf:seed                 # REQUIRED: the build regenerates wrangler.json,
                                  # and Miniflare then names its D1 file from it —
                                  # so every rebuild starts on an empty database
bun run perf:probe --runs 3 --cpu 4 --net slow4g
```

`perf:seed` is not optional and the failure it prevents is silent: without it the
board renders its empty state and the numbers describe a different corpus. This
was hit once.

## Recorded results

Environment: the **built** worker served by workerd on 127.0.0.1, 4× CPU throttle,
Slow-4G (1.6 Mbit/s, 150 ms RTT), median of 3 runs, 200-row seeded board. Local
loopback means TTFB is ~10 ms and is not meaningful; everything else is.

| | before | after | how |
| --- | --- | --- | --- |
| LCP | 3232 ms | **2340 ms** | `perf:probe` — self-hosted fonts removed a render-blocking third-party stylesheet (measured at 409 ms) |
| FCP | 468 ms | 516 ms | same runs; the delta is inside the before-arm's own spread |
| CLS | 0 | 0 | first paint |
| TBT | 0 | 0 | at 4× CPU. At 20× it is 25 ms with one long task, which is what says removing React was a bytes decision, not a speed one |
| downloaded JS | 50,486 gzip | **1,470 gzip** | `perf:budget` |
| HTML | 48,288 B | 32,740 B | the island's props JSON is gone |

Supporting A/Bs, each on one build so the bundle is not a variable:

| Change | Result | Verdict |
| --- | --- | --- |
| First-row image priority | LCP 3232 → 2908 ms, but the per-run spread overlaps the baseline (`[2860,3240,2908]` vs `[3568,3212,3232]`) | kept, **not claimed** |
| `content-visibility` on cards (`--override-css` disables it in the control arm) | layout 66 → 49 ms, style recalc 85 → 72 ms, CLS during scroll 1.42 → 0.66 | kept |
| Inlining the stylesheet (`build.inlineStylesheets: 'always'`) | FCP 516 → 308 ms, but LCP 2340 → 2412 ms | **rejected** — LCP is the metric being optimised |
| Preloading the fonts | FCP 516 → 652 ms | **rejected** — `font-display: swap` already paints text |

Image delivery, measured from real HTTP responses (`content-length` via ranged
GET) against the live feed — **not** from the render harness, whose fixture serves
its own images so the browser-side numbers stay hermetic:

| | before | after |
| --- | --- | --- |
| whole feed (49 images) | 13,271 KB | 11,515 KB (−13%) |
| first 10, the fold | 2,257 KB | **978 KB (−57%)** |

Only three hosts honour free transform parameters (`images.ctfassets.net`,
`pbs.twimg.com`, `cdn.shopify.com`); the largest images in the feed are on hosts
that do not, and are served 1:1. That residue is issue #158.

## What these numbers do not cover

- **Production images.** The render harness seeds `/og.png` so byte counts are
  stable; production cards load third-party images measured in megabytes. LCP in
  production is therefore governed by image delivery, not by anything in the
  table above.
- **Real devices and networks.** The throttle profiles are approximations, and
  local loopback removes the TLS and RTT costs a real visitor pays.
- **INP.** Nothing here measures interaction latency.
