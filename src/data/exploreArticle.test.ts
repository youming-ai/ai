import { describe, expect, it } from 'vitest';
import { type ExploreRow, exploreArticle } from './exploreArticle';

describe('exploreArticle', () => {
  it('strips feed markup stored before the parser decoded escaped bodies', () => {
    const article = exploreArticle({
      id: 'a',
      description: '<p> Data pipelines </p> <p> <a href="https://x.test">Discussion</a> </p>',
      ai_summary: 'Use <dialog> for modals.',
      ai_blurb: '<p>Point at your screen</p>',
    } as unknown as ExploreRow);
    expect(article.description).toBe('Data pipelines Discussion');
    // A literal element name in prose is text, not stored markup.
    expect(article.summary).toBe('Use <dialog> for modals.');
    expect(article.blurb).toBe('Point at your screen');
  });
});
