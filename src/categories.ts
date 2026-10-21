// Category registry — the single validation gate for category values: URL
// segments (/<key>), feed-filter values, KV-key safety, and storage fallbacks
// all check against this record. Adding a category is registry-only.
//
// The keys mirror Poche Explore's category labels (see enrich.test.ts): a label
// missing here is stored as NULL and reaches no hub. Web3 keeps the historical
// crypto key so stored rows and category URLs remain valid.
export interface Category {
  key: string; // URL first segment, e.g. 'design'
  label: string; // display name
  group: CategoryGroupKey; // rail section, see CATEGORY_GROUPS
}

type CategoryGroupKey = 'curated' | 'community';

/** Rail order: discovery first, then reading. */
export const CATEGORY_GROUPS: { key: CategoryGroupKey; label: string }[] = [
  { key: 'curated', label: 'Discover' },
  { key: 'community', label: 'Read & watch' },
];

const category = (key: string, label: string, group: CategoryGroupKey): Category => ({
  key,
  label,
  group,
});

export const CATEGORIES: Record<string, Category> = {
  tools: category('tools', 'Tools', 'curated'),
  design: category('design', 'Design', 'curated'),
  development: category('development', 'Development', 'curated'),
  articles: category('articles', 'Articles', 'community'),
  social: category('social', 'Social', 'community'),
  media: category('media', 'Media', 'community'),
  crypto: category('crypto', 'Web3', 'community'),
  other: category('other', 'Other', 'community'),
};

/** Label for a stored category key, falling back to the raw key when the
 *  registry has moved on (old rows must still render). */
export function categoryLabel(key: string | null): string {
  if (!key) return '';
  return CATEGORIES[key]?.label ?? key;
}
