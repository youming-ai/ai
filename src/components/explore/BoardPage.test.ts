// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest does not compile Astro. Pin route composition here;
// `bun run build` checks the actual Astro compilation and client script output.
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const home = source('src/pages/index.astro');
const category = source('src/pages/[category]/index.astro');
const board = source('src/components/explore/BoardPage.astro');
const layout = source('src/layouts/Layout.astro');

describe('shared Astro board page wiring', () => {
  it('keeps fetching, URL view selection and server-only rendering in one module', () => {
    expect(board).toContain("import { env } from 'cloudflare:workers'");
    expect(board).toContain('const ctx = Astro.locals.cfContext');
    expect(board).toContain('await Promise.all([');
    expect(board).toContain('getExploreFeed(category ? { category } : {}, env, ctx)');
    expect(board).toContain('getExploreFilters(env, ctx)');
    expect(board).toContain("parseView(Astro.url.searchParams.get('view'))");
    expect(board).toMatch(
      /set:html=\{ExploreView\(\{\s*initialData,\s*initialFilters,\s*initialCategory: category,\s*initialView,\s*\}\)\.value\}/,
    );
    for (const route of [home, category]) {
      expect(route).toContain('import BoardPage from ');
      expect(route).not.toMatch(/getExploreFeed|getExploreFilters|initialView|ExploreView/);
    }
  });

  it('shares the accessible shell, with processed route scripts and no hydration or footer', () => {
    expect(board.match(/<main>/g)).toHaveLength(1);
    expect(board).toContain('<h1 class="sr-only">{title}</h1>');
    expect(board).toContain('href="#explore-results"');
    expect(source('src/components/explore/ExploreView.ts')).toContain('id="explore-results"');
    expect(board).not.toContain('<script');
    for (const route of [home, category]) {
      expect(route).not.toMatch(/<main>|Skip to links/);
      expect(route).toMatch(/<script>\s*import '(?:\.\.\/)+scripts\/board';\s*<\/script>/);
      expect(route.match(/scripts\/board/g)).toHaveLength(1);
    }
    for (const file of [home, category, board, layout]) {
      expect(file).not.toMatch(/client:|<Footer|<footer/);
    }
  });

  it('leaves global title, WebSite JSON-LD and default RSS discovery on the home route', () => {
    expect(home).toContain('<Layout title={SITE_TITLE}>');
    expect(home).toContain('<BoardPage title={SITE_TITLE} />');
    expect(home).toContain("'@type': 'WebSite'");
    expect(home).toContain('set:html={JSON.stringify(websiteJsonLd)}');
    expect(layout).toContain("feedPath = '/rss.xml'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin quotes Astro source that itself interpolates
    expect(layout).toContain('href={`${SITE_ORIGIN}${feedPath}`}');
  });

  it('validates categories before board rendering and retains category metadata and RSS', () => {
    expect(category).toContain('!category || !Object.hasOwn(CATEGORIES, category)');
    expect(category).toContain("return new Response('Not found', { status: 404 })");
    expect(category.indexOf("return new Response('Not found'")).toBeLessThan(
      category.indexOf('<BoardPage'),
    );
    expect(category).toContain('const match = CATEGORIES[category]!');
    expect(category).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin quotes Astro source that itself interpolates
      '<BoardPage title={`${SITE_NAME} — ${match.label} links`} category={category} />',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin quotes Astro source that itself interpolates
    expect(category).toContain('title={`${SITE_NAME} — ${match.label} links`}');
    expect(category).toContain('description={description}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin quotes Astro source that itself interpolates
    expect(category).toContain('const feedPath = `/${category}/rss.xml`');
    expect(category).toContain('feedPath={feedPath}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin quotes Astro source that itself interpolates
    expect(category).toContain('feedTitle={`${SITE_NAME} — ${match.label} links`}');
    expect(category).toContain("'@type': 'CollectionPage'");
    expect(category).toContain("'@type': 'BreadcrumbList'");
    expect(category).toContain('set:html={JSON.stringify(jsonLd)}');
  });
});
