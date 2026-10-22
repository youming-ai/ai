# AI Desk

A discovery board for tools, design, development and AI, powered by [Poche Explore](https://poche.app/explore). Updates every 15 minutes, with category pages and RSS feeds. Selection comes from Poche; no AI model is used.

Built with Astro, Cloudflare Workers, D1 and KV.

## Development

Requires Bun ≥ 1.4.2 and Node.js ≥ 22.23.4.

```sh
bun install
bun run dev
```

The local database starts empty. See [scripts/README.md](./scripts/README.md) for database setup and local ingest.

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

Deploys through Void and applies pending D1 migrations. Cloudflare Workers Builds deploys `main` using `bun run build` followed by `bun run deploy`.

See [AGENTS.md](./AGENTS.md) for contributor guidelines.

## License

[MIT](./LICENSE)
