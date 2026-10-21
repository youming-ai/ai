import { CATEGORIES } from '../categories';
import type { Env } from '../data/api';
import type { RawArticle } from './types';

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
  // ai_summary/ai_blurb are NOT NULL leftovers of the retired curator; nothing
  // reads them. Every other unread column takes its schema default.
  const result = await env.DB.prepare(
    `INSERT INTO articles (
           id, source_id, canonical_url, fingerprint, title, description, ai_summary, ai_blurb,
           image_url, image_width, image_height, published_at, fetched_at, category,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, 'published', ?, ?)
         ON CONFLICT DO NOTHING`,
  )
    .bind(
      article.fingerprint,
      article.sourceId,
      article.canonicalUrl,
      article.fingerprint,
      article.title,
      article.description,
      article.imageUrl,
      article.imageWidth,
      article.imageHeight,
      article.publishedAt,
      article.fetchedAt,
      canonicalCategory(article.category),
      now,
      now,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
