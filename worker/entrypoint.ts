/// <reference types="@cloudflare/workers-types" />

import { handle } from '@astrojs/cloudflare/handler';
import type { Env } from '../src/data/api';
import { mediaRequest } from '../src/media';

const entrypoint: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    // `/media/<id>` is resolved here, ahead of Astro: it is a binary relay, and
    // Astro only mounts the worker dispatcher at `/api/*`, so a media request
    // that reached it would match no route and 404 against ASSETS.
    const media = mediaRequest(request, new URL(request.url));
    if (media) return media;
    return handle(request, env, ctx);
  },
};

export default entrypoint;
