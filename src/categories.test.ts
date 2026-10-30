import { describe, expect, it } from 'vitest';
import { canonicalCategory, categoryLabel } from './categories';

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
  // byline (`<small>domain · Category</small>`). The registry
  // must accept all of them: an unlisted value has no category, so the story
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
