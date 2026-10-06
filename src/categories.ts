// Category registry — the single validation gate for category values: URL
// segments (/<key>), feed-filter values, KV-key safety, and storage fallbacks
// all check against this record. Adding a category is registry-only.
//
// Two provenances live here now, and the difference matters:
//
//   - `hardware` is **our own** taxonomy, the hubs the AI-hardware desk is
//     organised around. `src/feeds/llm.ts` derives its prompt from exactly these
//     keys, so the model can never assign a category this record cannot serve.
//   - `curated` / `community` mirror the Poche Explore taxonomy one-for-one
//     (Articles, Crypto, Design, Development, Media, Other, Social, Tools).
//     They are kept because rows ingested before this pivot are still published
//     and must keep their hubs. The Poche source left the registry in the same
//     change, so no new row arrives carrying these values.
//
// A value missing from this record is stored as NULL and reaches no hub, which
// is why the curator's prompt is generated from here instead of restating the
// list — the drift that made a production row for `Crypto` invisible is exactly
// what that derivation prevents.
export interface Category {
  key: string; // URL first segment, e.g. 'accelerators'
  label: string; // display name
  group: CategoryGroupKey; // rail section, see CATEGORY_GROUPS
}

type CategoryGroupKey = 'hardware' | 'curated' | 'community';

/** Rail/navigation sections in display order. Hardware leads: it is the desk
 *  now, and the Poche groups are the archive. */
export const CATEGORY_GROUPS: { key: CategoryGroupKey; label: string }[] = [
  { key: 'hardware', label: 'Hardware' },
  { key: 'curated', label: 'Curated' },
  { key: 'community', label: 'Community' },
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
  // Last on purpose: `models` is the one beat that is not hardware, and it reads
  // better at the end of the desk's own group than in the middle of the silicon.
  models: category('models', 'Models', 'hardware'),

  // —— Poche Explore taxonomy (archive; no new rows) ——
  tools: category('tools', 'Tools', 'curated'),
  design: category('design', 'Design', 'curated'),
  development: category('development', 'Development', 'curated'),
  articles: category('articles', 'Articles', 'community'),
  social: category('social', 'Social', 'community'),
  media: category('media', 'Media', 'community'),
  crypto: category('crypto', 'Crypto', 'community'),
  other: category('other', 'Other', 'community'),
};

/** The keys the curator may assign — the desk's own taxonomy only. Derived from
 *  the record so an added category reaches the prompt automatically. */
export const CURATOR_CATEGORY_KEYS = Object.values(CATEGORIES)
  .filter((entry) => entry.group === 'hardware')
  .map((entry) => entry.key);

/** Label for a stored category key, falling back to the raw key when the
 *  registry has moved on (old rows must still render). */
export function categoryLabel(key: string | null): string {
  if (!key) return '';
  return CATEGORIES[key]?.label ?? key;
}
