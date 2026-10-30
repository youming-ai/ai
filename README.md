# AI Desk

A discovery board for tools, design, development and AI, powered by [Poche Explore](https://poche.app/explore), with category pages and RSS feeds. The board is Poche's current feed, refreshed about every 10 minutes. Selection comes from Poche; no AI model is used.

Built with Astro, Cloudflare Workers and KV. There is no database: the feed is fetched on demand and cached in KV.

## Development

Requires Bun ≥ 1.4.2 and Node.js ≥ 22.23.4.

```sh
bun install
bun run dev
```

The dev server fetches the live Poche feed on the first request.

```sh
bunx vitest run       # Tests
bun run lint         # Lint
bun run build        # Type checks, production build and byte budgets
bun run feeds:probe  # Check the source feed
```

## Configuration

- `src/site.ts` — site name and origin
- `src/categories.ts` — categories
- `src/feeds/sources.ts` — feed source
- `void.config.ts` — Cloudflare resources; use your own IDs for a separate deployment

## Deployment

```sh
bun run deploy
```

Deploys through Void. Cloudflare Workers Builds deploys `main` using `bun run build` followed by `bun run deploy`.

See [AGENTS.md](./AGENTS.md) for contributor guidelines.

## License

[MIT](./LICENSE)
