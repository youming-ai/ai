// Category registry — the single validation gate for category values: URL
// segments (/<key>), feed-filter values, KV-key safety, and storage fallbacks
// all check against this record. Adding a category is registry-only.
//
// The keys mirror Poche Explore's category labels (see categories.test.ts): a
// label missing here leaves the story uncategorised, so it reaches no hub. Web3
// keeps the historical crypto key so category URLs remain valid.
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

/** Label for a category key, falling back to the raw key when the registry
 *  has moved on (a cached snapshot must still render). */
export function categoryLabel(key: string | null): string {
  if (!key) return '';
  return CATEGORIES[key]?.label ?? key;
}

/** Resolve a publisher category (Poche's `· Category` footer) to a registry
 *  key, by key or by label. Unknown values are null: the story still reaches
 *  the global board, just no hub. */
export function canonicalCategory(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim().toLowerCase();
  if (Object.hasOwn(CATEGORIES, candidate)) return candidate;
  const byLabel = Object.values(CATEGORIES).find(
    (category) => category.label.toLowerCase() === candidate,
  );
  return byLabel ? byLabel.key : null;
}
