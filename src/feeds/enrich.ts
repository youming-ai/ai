import { CATEGORIES } from '../categories';
import type { Env } from '../data/api';
import type { ArticleEnrichment, RawArticle } from './types';

/** Quality score when the source declares no authority rating. */
const DEFAULT_QUALITY_SCORE = 50;

export function canonicalCategory(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim().toLowerCase();
  if (Object.hasOwn(CATEGORIES, candidate)) return candidate;
  const byLabel = Object.values(CATEGORIES).find(
    (category) => category.label.toLowerCase() === candidate,
  );
  if (byLabel) return byLabel.key;
  return null;
}

/** Cross-source dedup key: lowercase Unicode letters/numbers, no punctuation. */
export function normalizeTitle(value: string): string {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
  return normalized || value.toLowerCase();
}

/** Persist one article directly: the article row.
 *
 *  Deliberately writes no `article_tags` row. The Poche feed carries no topic
 *  tags, and mirroring `category` into that table made the card render
 *  "Development · development" and the RSS emit both `category:development`
 *  and `tag:development`. The category already lives in `articles.category`,
 *  and nothing joins that table to read a category back. */
/** Returns whether a row was actually inserted. The statement is
 *  `ON CONFLICT DO NOTHING`, so a duplicate resolved at insert time — a race
 *  with the previous tick, or a repeat inside one batch — changes nothing, and
 *  the caller has to know that to report what it stored. */
export async function storeArticle(env: Env, article: RawArticle): Promise<boolean> {
  const now = Date.now();
  const category = canonicalCategory(article.category);
  const articleId = article.fingerprint;
  // ponytail: summary and blurb duplicate description to populate legacy D1 columns (ai_summary/ai_blurb)
  const summary = article.description || article.title;
  const blurb = summary;
  // Single curated source today, so the score is the source's authority
  // rating; cards render it as the "Curated signal" meter. Falls back to a
  // neutral midpoint when no authority is declared.
  const qualityScore = article.sourceAuthority || DEFAULT_QUALITY_SCORE;

  const result = await env.DB.prepare(
    `INSERT INTO articles (
           id, source_id, canonical_url, fingerprint, title, title_norm, description, ai_summary, ai_blurb,
           image_url, image_width, image_height, published_at, fetched_at, category, article_type, is_on_topic,
           quality_score, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
  )
    .bind(
      articleId,
      article.sourceId,
      article.canonicalUrl,
      article.fingerprint,
      article.title,
      normalizeTitle(article.title),
      article.description,
      summary,
      blurb,
      article.imageUrl,
      article.imageWidth,
      article.imageHeight,
      article.publishedAt,
      article.fetchedAt,
      category,
      'link',
      1,
      qualityScore,
      'published',
      now,
      now,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Apply one validated curation result to a stored row.
 *
 *  This is the only place `ai_summary`, `ai_blurb`, `quality_score`,
 *  `article_type`, `category` and `is_on_topic` are set from a model, and the
 *  only place `article_tags` rows are written at all.
 *
 *  Two decisions worth keeping:
 *
 *  - `status = 'filtered'` is how an off-beat story leaves the board. The row
 *    stays: deleting it would drop the `fingerprint`/`canonical_url` dedupe
 *    guards and the next tick would ingest the same story again. Every read path
 *    already filters on `status = 'published'`.
 *  - Tags are *replaced*, and a tag identical to the assigned category is
 *    dropped before the write. Mirroring the category into `article_tags` is the
 *    exact defect migration 0012 had to purge — cards rendered
 *    "Development · development" and the RSS emitted the term as both a category
 *    and a tag. The guard lives here so a caller cannot reintroduce it. */
export async function applyEnrichment(
  env: Env,
  articleId: string,
  enrichment: ArticleEnrichment,
): Promise<void> {
  const category = canonicalCategory(enrichment.category);
  const tags = [
    ...new Set(
      enrichment.tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag !== category),
    ),
  ].slice(0, 8);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE articles SET
         ai_summary = ?, ai_blurb = ?, quality_score = ?, category = ?, article_type = ?,
         is_on_topic = ?, status = ?, enriched_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      enrichment.summary,
      enrichment.blurb,
      enrichment.qualityScore,
      category,
      enrichment.articleType,
      enrichment.isOnTopic ? 1 : 0,
      enrichment.isOnTopic ? 'published' : 'filtered',
      now,
      now,
      articleId,
    ),
    env.DB.prepare('DELETE FROM article_tags WHERE article_id = ?').bind(articleId),
    ...tags.map((tag) =>
      env.DB.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag) VALUES (?, ?)').bind(
        articleId,
        tag,
      ),
    ),
  ]);
}

/** Take a story out of the curation queue without judging it: too little text
 *  for the model to work with. `enriched_at` is still set, otherwise the story
 *  would be re-selected every tick and counted as pending forever; it keeps the
 *  deck `storeArticle` wrote from the feed teaser. */
export async function markCurationSkipped(env: Env, articleId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('UPDATE articles SET enriched_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, articleId)
    .run();
}
