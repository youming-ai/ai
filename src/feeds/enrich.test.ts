// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { categoryLabel } from '../categories';
import type { Env } from '../data/api';
import { canonicalCategory, storeArticle } from './enrich';
import type { RawArticle } from './types';

const ARTICLE: RawArticle = {
  sourceId: 'poche-explore',
  sourceName: 'Poche Explore',
  category: 'design',
  title: 'thonik – Home',
  description: 'Dutch studio thonik.',
  url: 'https://thonik.nl/',
  canonicalUrl: 'https://thonik.nl/',
  imageUrl: 'https://example.com/img.png',
  imageWidth: 0,
  imageHeight: 0,
  publishedAt: 1_780_000_000_000,
  fetchedAt: 1_780_000_000_000,
  fingerprint: 'fp-1',
};

function makeStoreEnv() {
  const bound: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...params: unknown[]) => {
        bound.push(params);
        return { run: async () => ({ meta: { changes: 1 } }) };
      },
    }),
    batch: async () => [],
  };
  return { env: { DB: db } as unknown as Env, bound };
}

describe('storeArticle', () => {
  it('stores the row with its registry category', async () => {
    const { env, bound } = makeStoreEnv();
    await storeArticle(env, ARTICLE);
    expect(bound[0][0]).toBe('fp-1'); // id
    expect(bound[0][11]).toBe('design'); // category
  });

  it('writes no topic tag for the category', async () => {
    const { env, bound } = makeStoreEnv();
    await storeArticle(env, ARTICLE);
    // article_tags holds publisher topic tags and the Poche feed has none.
    // Mirroring the category there made the card render "Development ·
    // development" and the RSS emit both a category: and a tag: entry.
    expect(bound).toHaveLength(1);
  });
});

describe('canonicalCategory', () => {
  it('resolves direct category keys and labels', () => {
    expect(canonicalCategory('design')).toBe('design');
    expect(canonicalCategory('Design')).toBe('design');
    expect(canonicalCategory('Tools')).toBe('tools');
    expect(canonicalCategory('Development')).toBe('development');
  });

  it('shows Web3 while preserving the historical crypto key and label', () => {
    expect(canonicalCategory('Web3')).toBe('crypto');
    expect(canonicalCategory('web3')).toBe('crypto');
    expect(canonicalCategory('Crypto')).toBe('crypto');
    expect(categoryLabel('crypto')).toBe('Web3');
  });

  it('returns null for unknown values so they fall through to the global board', () => {
    expect(canonicalCategory('unknown-tech')).toBeNull();
    expect(canonicalCategory(null)).toBeNull();
  });
});

describe('Poche taxonomy coverage', () => {
  // Every category the Poche Explore feed actually publishes, as seen in its
  // byline (`<small>domain · Category</small>`) and in stored rows. The registry
  // must accept all of them: an unlisted value is stored as NULL, so the story
  // never reaches a hub and is invisible except on the global board. `Crypto`
  // was missing until it was found mis-categorised in production.
  const POCHE_CATEGORIES = [
    'Articles',
    'Crypto',
    'Design',
    'Development',
    'Media',
    'Other',
    'Social',
    'Tools',
  ];

  it('accepts every category the upstream feed emits', () => {
    for (const label of POCHE_CATEGORIES) {
      expect(canonicalCategory(label), label).not.toBeNull();
      expect(canonicalCategory(label.toLowerCase()), label).not.toBeNull();
    }
  });

  it('maps each Poche label to the matching registry key', () => {
    for (const label of POCHE_CATEGORIES) {
      expect(canonicalCategory(label)).toBe(label.toLowerCase());
    }
  });
});
