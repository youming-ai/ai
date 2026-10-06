import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURATOR_CATEGORY_KEYS } from '../categories';
import {
  CuratorTimeoutError,
  __promptInternals,
  enrichBatchWithLLM,
  enrichWithLLM,
  parseEnrichment,
} from './llm';
import type { CuratorArticle } from './llm';
import { ARTICLE_TYPES } from './types';

// The curator's transport and its validators. The client itself was written for
// the pre-Poche pipeline and is recovered here, so what these tests protect is
// the contract the desk now depends on: a strict payload or a retry, never a
// coerced guess written to D1 as if a human had chosen it.

afterEach(() => {
  vi.unstubAllGlobals();
});

const story: CuratorArticle = {
  id: 'fp-1',
  sourceName: 'TechPowerUp News',
  title: 'HBM4 pricing climbs as suppliers sell out',
  description: 'Three suppliers are reported sold out through 2027, with pricing up sharply.',
  url: 'https://example.com/hbm4',
};

const enrichment = {
  isOnTopic: true,
  category: 'memory',
  articleType: 'analysis',
  tags: ['hbm', 'supply'],
  summary: 'HBM4 supply is sold out through 2027 and prices are rising.',
  blurb: 'Three suppliers are reported sold out of HBM4 through 2027, and pricing is climbing.',
  qualityScore: 78,
};

const BASE_URL = 'https://api.example.com/v1';
const MODEL = 'test-model';

function openAIResponse(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status },
  );
}

describe('parseEnrichment', () => {
  it('accepts a contract-conforming payload', () => {
    expect(parseEnrichment(enrichment)).toEqual(enrichment);
  });

  it('rejects a category the registry cannot serve', () => {
    // The failure this prevents: the model invents a hub ("gpu"), the row is
    // stored with a category no route serves, and the story is only reachable
    // from the global board — the same shape as the production `Crypto` row that
    // migration 0009 was written for.
    expect(() => parseEnrichment({ ...enrichment, category: 'gpu' })).toThrow(
      /category outside the registry/,
    );
    expect(() => parseEnrichment({ ...enrichment, category: 'Memory' })).toThrow(
      /category outside the registry/,
    );
  });

  it('accepts an empty category for cross-beat stories', () => {
    expect(parseEnrichment({ ...enrichment, category: '' }).category).toBe('');
  });

  it('rejects each field outside its documented range', () => {
    expect(() => parseEnrichment({ ...enrichment, isOnTopic: 'yes' })).toThrow(/isOnTopic/);
    expect(() => parseEnrichment({ ...enrichment, articleType: 'editorial' })).toThrow(
      /articleType/,
    );
    expect(() => parseEnrichment({ ...enrichment, tags: 'hbm' })).toThrow(/tags/);
    expect(() => parseEnrichment({ ...enrichment, tags: Array(9).fill('x') })).toThrow(/tags/);
    expect(() => parseEnrichment({ ...enrichment, summary: '' })).toThrow(/summary/);
    expect(() => parseEnrichment({ ...enrichment, summary: 'x'.repeat(281) })).toThrow(/summary/);
    expect(() => parseEnrichment({ ...enrichment, blurb: 'x'.repeat(701) })).toThrow(/blurb/);
    expect(() => parseEnrichment({ ...enrichment, qualityScore: 101 })).toThrow(/qualityScore/);
    expect(() => parseEnrichment({ ...enrichment, qualityScore: 87.5 })).toThrow(/qualityScore/);
    expect(() => parseEnrichment(null)).toThrow(/invalid enrichment/);
  });
});

describe('enrichWithLLM', () => {
  it('requests and validates structured JSON output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAIResponse(enrichment));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('secret', BASE_URL, MODEL, story)).resolves.toEqual(enrichment);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/chat/completions`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      }),
    );
  });

  it('tolerates a trailing slash on the configured base URL', async () => {
    // LLM_BASE_URL is a human-edited var; both spellings have to work or the
    // desk goes quiet on a trailing slash.
    const fetchMock = vi.fn().mockResolvedValue(openAIResponse(enrichment));
    vi.stubGlobal('fetch', fetchMock);

    await enrichWithLLM('secret', `${BASE_URL}/`, MODEL, story);

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE_URL}/chat/completions`);
  });

  it('caps the reply so a batch cannot be cut off mid-JSON', async () => {
    // Observed once at the production batch size: a provider default truncated
    // the JSON, which the validator can only see as an unparseable reply.
    const fetchMock = vi.fn().mockResolvedValue(openAIResponse(enrichment));
    vi.stubGlobal('fetch', fetchMock);

    await enrichWithLLM('secret', BASE_URL, MODEL, story);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it('sends response_format json_object, the model, and the story text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAIResponse(enrichment));
    vi.stubGlobal('fetch', fetchMock);

    await enrichWithLLM('secret', BASE_URL, MODEL, story);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.model).toBe(MODEL);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain(story.title);
    expect(prompt).toContain(story.description);
    expect(prompt).toContain(story.url);
    expect(prompt).toContain(story.sourceName);
  });

  it('refuses to call without a key, rather than sending an empty bearer token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('', BASE_URL, MODEL, story)).rejects.toThrow(
      /LLM_API_KEY is not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a server error and succeeds on the attempt that works', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(openAIResponse(enrichment));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('secret', BASE_URL, MODEL, story)).resolves.toEqual(enrichment);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after its attempts and surfaces the status', async () => {
    // Two attempts, not three: at the current model's measured latency a third
    // one cannot fit in a cron tick, and the next tick retries anyway.
    const fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('secret', BASE_URL, MODEL, story)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('separates a timeout from a contract failure', async () => {
    // The curator treats these differently: a slow model is retried whole on the
    // next tick, an incoherent one is retried story by story. Losing this
    // distinction sent eight stories through eight ~25s calls for nothing.
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('secret', BASE_URL, MODEL, story)).rejects.toBeInstanceOf(
      CuratorTimeoutError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a payload that fails validation, then throws it', async () => {
    // A 200 whose body is not the contract is a failure, not a success with
    // missing fields — the difference is a row written with an invented hub.
    // A fresh Response per attempt: `mockResolvedValue` would hand every retry
    // the same already-consumed body, which is a test artefact — real fetch
    // returns a new response each call.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => openAIResponse({ ...enrichment, category: 'gpu' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichWithLLM('secret', BASE_URL, MODEL, story)).rejects.toThrow(
      /category outside the registry/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('enrichBatchWithLLM', () => {
  it('asks once for the whole batch and preserves order', async () => {
    const second = { ...enrichment, category: 'datacenter', qualityScore: 61 };
    const fetchMock = vi.fn().mockResolvedValue(openAIResponse({ results: [enrichment, second] }));
    vi.stubGlobal('fetch', fetchMock);

    const stories = [story, { ...story, id: 'fp-2', title: 'A rack-scale story' }];
    await expect(enrichBatchWithLLM('secret', BASE_URL, MODEL, stories)).resolves.toEqual([
      enrichment,
      second,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages[0].content;
    expect(prompt).toContain('STORY 1');
    expect(prompt).toContain('STORY 2');
  });

  it('rejects a batch whose result count does not match the input', async () => {
    // Without this, a model that dropped one story would shift every later
    // enrichment onto the wrong article.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => openAIResponse({ results: [enrichment] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      enrichBatchWithLLM('secret', BASE_URL, MODEL, [
        story,
        { ...story, id: 'fp-2', title: 'Second' },
      ]),
    ).rejects.toThrow(/1 results for 2 stories/);
  });

  it('does not call at all for an empty batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichBatchWithLLM('secret', BASE_URL, MODEL, [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('prompt contract', () => {
  // Exactly how promptFor/promptForBatch compose it: the rules carry the policy,
  // JSON_FIELDS carries the field list and the article-type vocabulary.
  const prompt = `${__promptInternals.CLASSIFIER_RULES}\n${__promptInternals.JSON_FIELDS}`;

  it('names every category the curator may assign', () => {
    // Derived from the registry, not restated: a category added to
    // src/categories.ts must reach the model, or the desk grows a hub nothing
    // can be filed under.
    expect(CURATOR_CATEGORY_KEYS.length).toBeGreaterThan(0);
    for (const key of CURATOR_CATEGORY_KEYS) {
      expect(prompt, `prompt names ${key}`).toContain(key);
    }
  });

  it('keeps the controlled vocabulary in the shape article tags are stored in', () => {
    // The card renders these inline and the RSS emits them as terms, so a tag
    // with a space or a capital would be visible immediately.
    for (const tag of __promptInternals.CONTROLLED_TAGS) {
      expect(tag, `${tag} is lowercase hyphenated`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(new Set(__promptInternals.CONTROLLED_TAGS).size).toBe(
      __promptInternals.CONTROLLED_TAGS.length,
    );
  });

  it('files the product beats that had no home', () => {
    // Added after the first real curation run: monitors and mini PCs arrived
    // on-beat, were left unfiled, and so reached the board but no hub. These
    // two mappings are the fix, and they are prompt-level — the registry grows a
    // hub (peripherals) but the model has to be told which stories belong there.
    expect(CURATOR_CATEGORY_KEYS).toContain('peripherals');
    expect(prompt).toContain('a monitor, keyboard or mouse is `peripherals`');
    expect(prompt).toContain('a mini PC, laptop, workstation or server is `systems`');
    expect(prompt).toContain('a CPU, SoC, process node or packaging story is `processors`');
  });

  it('separates "cannot file it" from "has no hardware substance"', () => {
    // The rule that keeps the board clean without over-rejecting: a cross-beat
    // story is still worth storing, a deals round-up is not.
    expect(prompt).toContain('not automatically off-beat');
    expect(prompt).toContain('deals round-up');
    expect(prompt).toContain('storing it with no category puts it on the board and in no hub');
    expect(prompt).toContain('Leave category empty only for a story that genuinely spans beats');
  });

  it('tells the model never to repeat the category as a tag', () => {
    // Migration 0012 exists because the category was mirrored into
    // article_tags; the prompt-side half of that guard is this sentence, and the
    // write-side half is in applyEnrichment.
    expect(prompt).toContain('Never repeat the category as a tag');
  });

  it('keeps the article-type list in step with the stored vocabulary', () => {
    for (const type of ARTICLE_TYPES) {
      expect(prompt, `prompt names ${type}`).toContain(type);
    }
  });

  it('carries the off-beat examples the gate depends on', () => {
    // The desk's feeds are broad (The Verge, TechCrunch publish EVs and game
    // studios), so rejecting them is the prompt's job.
    expect(prompt).toContain('isOnTopic=false');
  });
});
