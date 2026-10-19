// Category registry — the single validation gate for category values: URL
// segments (/<key>), feed-filter values, KV-key safety, and storage fallbacks
// all check against this record. Adding a category is registry-only.
//
// Discovery categories lead the rail and accept new model classifications.
// Hardware remains a supporting beat; every existing category URL is preserved.
// Web3 keeps the historical crypto key so stored rows and category URLs remain valid.
// A missing key cannot be stored or served, so the prompt and validator derive
// their allowed categories from this registry.
export interface Category {
  key: string; // URL first segment, e.g. 'accelerators'
  label: string; // display name
  group: CategoryGroupKey; // rail section, see CATEGORY_GROUPS
}

type CategoryGroupKey = 'hardware' | 'curated' | 'community';

/** Rail order: discovery and reading first, specialist hardware afterwards. */
export const CATEGORY_GROUPS: { key: CategoryGroupKey; label: string }[] = [
  { key: 'curated', label: 'Discover' },
  { key: 'community', label: 'Read & watch' },
  { key: 'hardware', label: 'Hardware' },
];

const category = (key: string, label: string, group: CategoryGroupKey): Category => ({
  key,
  label,
  group,
});

export const CATEGORIES: Record<string, Category> = {
  // —— The AI-hardware desk (our taxonomy) ——
  // Deliberately hub-sized beats, not product classes: an HBM shortage story is
  // `memory`, not a per-part category, and a full build is `systems`.
  accelerators: category('accelerators', 'Accelerators', 'hardware'),
  processors: category('processors', 'Processors', 'hardware'),
  systems: category('systems', 'Systems', 'hardware'),
  memory: category('memory', 'Memory', 'hardware'),
  datacenter: category('datacenter', 'Datacenter', 'hardware'),
  // Added after the first real curation run, from its own output: monitors and
  // desk gear were arriving on-beat, getting filed as cross-beat, and therefore
  // reaching the global board but no hub at all. Two of the first sixteen
  // curated stories were displays.
  peripherals: category('peripherals', 'Peripherals', 'hardware'),
  // —— Discovery, reading and community links ——
  tools: category('tools', 'Tools', 'curated'),
  design: category('design', 'Design', 'curated'),
  development: category('development', 'Development', 'curated'),
  models: category('models', 'Models', 'curated'),
  articles: category('articles', 'Articles', 'community'),
  social: category('social', 'Social', 'community'),
  media: category('media', 'Media', 'community'),
  crypto: category('crypto', 'Web3', 'community'),
  other: category('other', 'Other', 'community'),
};

/** Every registered category is available for new discoveries. */
export const CURATOR_CATEGORY_KEYS = Object.keys(CATEGORIES);

/** Label for a stored category key, falling back to the raw key when the
 *  registry has moved on (old rows must still render). */
export function categoryLabel(key: string | null): string {
  if (!key) return '';
  return CATEGORIES[key]?.label ?? key;
}
