import { describe, expect, it } from 'vitest';
import { type ExploreRow, exploreArticle } from './exploreArticle';

describe('exploreArticle', () => {
  it('strips feed markup stored before the parser decoded escaped bodies', () => {
    const article = exploreArticle({
      id: 'a',
      description:
        '<p> Data pipelines </p> <p> <a href="https://x.test">Discussion</a> <dialog> </p>',
    } as unknown as ExploreRow);
    // A literal element name in prose is text, not stored markup.
    expect(article.description).toBe('Data pipelines Discussion <dialog>');
  });
});
