import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../data/api';
import {
  CURATION_BATCH_SIZE,
  CURATION_LEASE_MS,
  CURATION_LIMIT,
  curatePending,
  MAX_CURATION_ATTEMPTS,
  pendingCurationCount,
} from './curate';
import { CURATION_BUDGET_MS } from './curationPolicy';
import { MIN_CURATOR_TEXT_CHARS } from './llm';

// The curator's policy, pinned without a model: which rows it picks, what it
// writes for an on-beat story, what it does with an off-beat one, and what
// happens to the ones it cannot judge. Every assertion is on the SQL that
// reached D1 rather than on the report, because the report is what the code
// claims and the statements are what the database got.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The retry backoff is 500ms then 1000ms per story; a rejected batch that falls
// back to per-story calls would spend seconds of real time here, and what these
// tests pin is which calls happen, not how long the client waits between them.
vi.mock('../utils/coerce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/coerce')>()),
  sleep: vi.fn(async () => {}),
}));

interface Statement {
  sql: string;
  params: unknown[];
}

const isClaim = (statement: Statement) => statement.sql.includes("'processing'");
/** An outcome row (stored/filtered/skipped/failed), as opposed to a claim. */
const isOutcome = (statement: Statement) =>
  statement.sql.includes('INSERT INTO agent_runs') && !isClaim(statement);

/** The D1 surface the curator touches: the queue read, per-statement run()
 *  (claims and failures), and batch() (article, tags, and completion outcome).
 *  `wins` decides each claim, keyed by article id — the claim binds the id
 *  fourth — so a race another invocation won can be modelled. */
function curateDb(rows: Record<string, unknown>[], wins: (id: unknown) => boolean = () => true) {
  const ran: Statement[] = [];
  const batched: Statement[][] = [];
  const bound: Statement[] = [];
  const prepare = vi.fn((sql: string) => {
    const withParams = (params: unknown[]) => ({
      sql,
      params,
      all: async () => ({
        // Only the queue read returns rows; every other all() is a lookup.
        results: sql.includes('FROM articles a') ? rows : [],
      }),
      run: async () => {
        ran.push({ sql, params });
        const won = !isClaim({ sql, params }) || wins(params[3]);
        return { meta: { changes: won ? 1 : 0 } };
      },
      first: async () => ({ pending: rows.length }),
    });
    return {
      bind: (...params: unknown[]) => {
        bound.push({ sql, params });
        return withParams(params);
      },
      ...withParams([]),
    };
  });
  const db = {
    prepare,
    batch: vi.fn(async (statements: Statement[]) => {
      batched.push(statements);
      return [];
    }),
  };
  return { db: db as unknown as D1Database, ran, batched, bound, prepare };
}

function envWith(db: D1Database, configured = true): Env {
  return {
    DB: db,
    ...(configured
      ? {
          LLM_API_KEY: 'test-key',
          LLM_BASE_URL: 'https://api.example.com/v1',
          LLM_MODEL: 'test-model',
        }
      : {}),
  } as unknown as Env;
}

function pendingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fp-1',
    source_id: 'toms-hardware',
    source_name: "Tom's Hardware",
    title: 'HBM4 pricing climbs',
    description: 'A long enough report that the curator has something to judge on.',
    url: 'https://example.com/hbm4',
    ...overrides,
  };
}

const enrichment = {
  isOnTopic: true,
  category: 'memory',
  articleType: 'analysis',
  tags: ['hbm', 'supply'],
  summary: 'HBM4 supply is sold out through 2027.',
  blurb: 'Three suppliers are reported sold out of HBM4 through 2027, and prices are climbing.',
  qualityScore: 78,
};

function llmResponse(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status },
  );
}

/** The endpoint as the client uses it: a batch request answers
 *  `{"results": [...]}` with one entry per story in the prompt, a single-story
 *  request answers the bare object. Modelling that is what keeps a batch that
 *  legitimately matches its input from looking like a rejected one. */
function stubLlm(
  options: { values?: Record<number, unknown>; raw?: Record<number, () => Response> } = {},
) {
  let call = 0;
  const mock = vi.fn(async (_url: string, init: { body: string }) => {
    call += 1;
    // `raw` replaces the whole response (to model a malformed or failing call);
    // `values` replaces the enrichment inside whatever shape the call has.
    const raw = options.raw?.[call];
    if (raw) return raw();
    const value = options.values?.[call] ?? enrichment;
    const prompt = JSON.parse(init.body).messages[0].content as string;
    const stories = prompt.match(/--- STORY /g)?.length ?? 0;
    if (stories === 0) return llmResponse(value);
    return llmResponse({ results: Array.from({ length: stories }, () => value) });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('curatePending', () => {
  it('rests when the model is not configured, and touches nothing', async () => {
    // The desk has to keep collecting and serving without a key; the queue is
    // what grows, and /api/health reports it.
    const { db, prepare, batched } = curateDb([pendingRow()]);
    const report = await curatePending(envWith(db, false));

    expect(report).toEqual({
      configured: false,
      selected: 0,
      curated: 0,
      filtered: 0,
      skipped: 0,
      failed: 0,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(batched).toHaveLength(0);
  });

  it('reads the queue with the attempt cap, the lease and the per-tick limit bound', async () => {
    const { db, bound } = curateDb([]);
    const before = Date.now();
    await curatePending(envWith(db));

    const queue = bound[0]!;
    expect(queue.sql).toContain('a.enriched_at IS NULL');
    expect(queue.sql).toContain("a.status = 'published'");
    expect(queue.sql).toContain('ORDER BY a.published_at DESC');
    // The attempt tally is what stops a permanently unjudgeable story from
    // spending a model call every 15 minutes forever; it counts claims.
    expect(queue.sql).toContain("r.status = 'processing'");
    expect(queue.params[0]).toBe(MAX_CURATION_ATTEMPTS);
    expect(queue.params[1]).toBeGreaterThanOrEqual(before - CURATION_LEASE_MS);
    expect(queue.params[1]).toBeLessThanOrEqual(Date.now() - CURATION_LEASE_MS);
    expect(queue.params[2]).toBe(CURATION_LIMIT);
  });

  it('claims a story before calling the model, so a killed tick still spends the attempt', async () => {
    // Outcomes are written after the model answers. A scheduled invocation the
    // platform kills (15-minute wall clock) mid-batch writes none, so if only
    // outcomes counted, the same story would be re-selected every tick forever.
    const { db, ran } = curateDb([pendingRow()]);
    const claimsAtCall: number[] = [];
    const answer = stubLlm();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        claimsAtCall.push(ran.filter(isClaim).length);
        return (answer as unknown as (u: string, i: { body: string }) => Promise<Response>)(
          url,
          init,
        );
      }),
    );

    await curatePending(envWith(db));

    expect(claimsAtCall).toEqual([1]);
    const claim = ran.find(isClaim)!;
    expect(claim.sql).toContain('INSERT INTO agent_runs');
    // Re-checked inside the INSERT, not trusted from the earlier SELECT: that is
    // what makes the claim atomic against a concurrent invocation.
    expect(claim.sql).toContain('a.enriched_at IS NULL');
    expect(claim.params.slice(1, 5)).toEqual([
      'test-model',
      expect.any(Number),
      'fp-1',
      MAX_CURATION_ATTEMPTS,
    ]);
    expect(claim.params[5]).toBe((claim.params[2] as number) - CURATION_LEASE_MS);
  });

  it('leaves a story another invocation claimed first', async () => {
    // Measured in production before claims existed: 21% of runs were a second,
    // concurrent judgement of the same story, and 8 stories ended with a
    // 'filtered' run on a row the later writer had published.
    const { db, ran, batched } = curateDb(
      [
        pendingRow(),
        pendingRow({ id: 'fp-2', title: 'Second story', url: 'https://example.com/2' }),
      ],
      (id) => id !== 'fp-1',
    );
    const fetchMock = stubLlm();

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ selected: 1, curated: 1, failed: 0 });
    const prompt = JSON.parse(fetchMock.mock.calls[0]![1].body).messages[0].content as string;
    expect(prompt).toContain('Second story');
    expect(prompt).not.toContain('HBM4 pricing climbs');
    expect(batched).toHaveLength(1);
    expect(ran.filter(isOutcome)).toEqual([]);
    expect(
      batched
        .flat()
        .filter(isOutcome)
        .map((statement) => statement.params[1]),
    ).toEqual(['fp-2']);
  });

  it('writes an on-beat story back and logs a stored run', async () => {
    const { db, ran, batched } = curateDb([pendingRow()]);
    stubLlm();

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ configured: true, selected: 1, curated: 1, failed: 0 });

    const statements = batched[0]!;
    const update = statements.find((statement) => statement.sql.includes('UPDATE articles SET'))!;
    expect(update.params).toEqual([
      enrichment.summary,
      enrichment.blurb,
      enrichment.qualityScore,
      'memory',
      'analysis',
      1,
      'published',
      expect.any(Number),
      expect.any(Number),
      'fp-1',
    ]);
    // Tags are replaced, never appended: the DELETE is what makes a retune of
    // the vocabulary not accumulate stale rows.
    expect(
      statements.some((statement) => statement.sql.startsWith('DELETE FROM article_tags')),
    ).toBe(true);
    const tagRows = statements
      .filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO article_tags'))
      .map((statement) => statement.params[1]);
    expect(tagRows).toEqual(['hbm', 'supply']);

    expect(batched).toHaveLength(1);
    expect(ran.filter(isOutcome)).toEqual([]);
    const run = statements.find(isOutcome)!;
    expect(run.params).toContain('stored');
    expect(run.params).toContain('test-model');
    // article_fingerprint and article_id are both the article id, because
    // storeArticle uses the fingerprint as the primary key.
    expect(run.params[1]).toBe('fp-1');
    expect(run.params[5]).toBe('fp-1');
  });

  it('drops a tag that repeats the category, and lowercases the rest', async () => {
    // The migration-0012 defect: mirroring the category into article_tags made
    // cards render "Development · development". The prompt asks the model not
    // to do it; this is the write-side guard that makes it impossible.
    const { db, batched } = curateDb([pendingRow()]);
    stubLlm({
      values: { 1: { ...enrichment, tags: ['Memory', 'hbm', 'memory', 'HBM', 'supply'] } },
    });

    await curatePending(envWith(db));

    const tagRows = batched[0]!
      .filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO article_tags'))
      .map((statement) => statement.params[1]);
    expect(tagRows).toEqual(['hbm', 'supply']);
  });

  it('filters an off-beat story without deleting it', async () => {
    const { db, ran, batched } = curateDb([pendingRow()]);
    stubLlm({ values: { 1: { ...enrichment, isOnTopic: false, category: '' } } });

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ curated: 0, filtered: 1 });
    const update = batched[0]!.find((statement) => statement.sql.includes('UPDATE articles SET'))!;
    // status='filtered' and is_on_topic=0; the row stays for its dedupe guards.
    expect(update.params[5]).toBe(0);
    expect(update.params[6]).toBe('filtered');
    expect(update.params[3]).toBeNull();
    expect(batched).toHaveLength(1);
    expect(ran.filter(isOutcome)).toEqual([]);
    expect(batched[0]!.find(isOutcome)!.params).toContain('filtered');
  });

  it('skips a story with too little text without spending a call', async () => {
    const { db, ran, batched } = curateDb([
      pendingRow({ description: 'x'.repeat(MIN_CURATOR_TEXT_CHARS - 1) }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ selected: 1, skipped: 1, curated: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    // enriched_at is still set, otherwise the story would be re-selected and
    // counted as pending on every tick forever.
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(ran.filter(isOutcome)).toEqual([]);
    expect(ran.every(isClaim)).toBe(true);
    const skip = batched[0]![0]!;
    expect(skip.sql).toContain('UPDATE articles SET enriched_at');
    expect(skip.params[2]).toBe('fp-1');
    expect(batched[0]![1]!.params.slice(1, 7)).toEqual([
      'fp-1',
      'toms-hardware',
      'skipped',
      'test-model',
      'fp-1',
      'too little text to curate',
    ]);
  });

  it('falls back to one call per story when the batch is rejected', async () => {
    // A reply whose result count does not match the input is retried as a batch
    // first — the model may simply have truncated — and only after those
    // attempts are exhausted does the batch degrade to per-story calls. One story
    // the model then refuses must still not cost the other one.
    const { db, ran, batched } = curateDb([
      pendingRow(),
      pendingRow({ id: 'fp-2', title: 'Second story', url: 'https://example.com/2' }),
    ]);
    const fetchMock = stubLlm({
      raw: {
        1: () => llmResponse({ results: [enrichment] }), // 2 stories, 1 result: rejected
        2: () => llmResponse({ results: [enrichment] }),
        4: () => new Response('down', { status: 500 }), // the second story, both attempts
        5: () => new Response('down', { status: 500 }),
      },
    });

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ selected: 2, curated: 1, failed: 1 });
    // 2 rejected batch attempts + 1 single success + 2 attempts for the story
    // that never answers.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const statuses = [...ran, ...batched.flat()]
      .filter(isOutcome)
      .map((statement) => statement.params[3]);
    expect(statuses.sort()).toEqual(['failed', 'stored']);
  });

  it('does not fan a timed-out batch out into one call per story', async () => {
    // The expensive mistake this pins: at this model's latency (25s for a single
    // story, 130s for eight) a per-story retry of a slow batch spends the whole
    // tick to learn nothing, and the next tick finds the queue unchanged.
    const { db, ran } = curateDb([
      pendingRow(),
      pendingRow({ id: 'fp-2', title: 'Second story', url: 'https://example.com/2' }),
    ]);
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await curatePending(envWith(db));

    // One batch attempt plus one retry — not 1 + 2 per story.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ selected: 2, curated: 0, failed: 2 });
    const statuses = ran.filter(isOutcome).map((statement) => statement.params[3]);
    expect(statuses).toEqual(['failed', 'failed']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('records a failure when the article write fails, leaving it in the queue', async () => {
    // enriched_at stays NULL on a write failure, so the next tick retries; the
    // claim already counted the attempt, so it cannot retry forever.
    const { db, ran } = curateDb([pendingRow()]);
    (db as unknown as { batch: unknown }).batch = vi.fn(async () => {
      throw new Error('D1 write failed');
    });
    stubLlm();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await curatePending(envWith(db));

    expect(report).toMatchObject({ curated: 0, failed: 1 });
    const run = ran.find(isOutcome)!;
    expect(run.params[3]).toBe('failed');
    expect(run.params[6]).toContain('D1 write failed');
    expect(error).toHaveBeenCalled();
  });

  it.each(['stored', 'filtered', 'skipped'] as const)(
    'does not report completion when the %s outcome rejects the batch',
    async (status) => {
      const { db, ran } = curateDb([pendingRow(status === 'skipped' ? { description: '' } : {})]);
      const submitted: Statement[][] = [];
      vi.mocked(db.batch).mockImplementation(async (statements) => {
        const batch = statements as unknown as Statement[];
        submitted.push(batch);
        // Model D1 rejecting the transaction at its outcome insert. This tests
        // composition/error handling; rollback itself is D1's batch contract.
        if (batch.some(isOutcome)) throw new Error('outcome insert failed');
        return [];
      });
      const fetchMock = stubLlm({
        values: { 1: { ...enrichment, isOnTopic: status !== 'filtered' } },
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const report = await curatePending(envWith(db));

      expect(report).toMatchObject({ selected: 1, curated: 0, filtered: 0, skipped: 0, failed: 1 });
      expect(submitted).toHaveLength(1);
      const batch = submitted[0]!;
      expect(batch[0]!.sql).toContain('UPDATE articles SET');
      expect(batch.filter(isOutcome)).toHaveLength(1);
      expect(batch.find(isOutcome)!.params[3]).toBe(status);
      expect(ran.filter(isClaim)).toHaveLength(1);
      expect(ran.every((statement) => isClaim(statement) || isOutcome(statement))).toBe(true);
      // Failure logging stays separate; it neither completes the story nor
      // erases the claim that spent this attempt. Skip failures retain the claim only.
      expect(ran.filter(isOutcome).map((statement) => statement.params[3])).toEqual(
        status === 'skipped' ? [] : ['failed'],
      );
      if (status === 'skipped') expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('sends the selected stories out in batches of CURATION_BATCH_SIZE', async () => {
    const rows = Array.from({ length: CURATION_LIMIT + 5 }, (_, index) =>
      pendingRow({ id: `fp-${index}`, url: `https://example.com/${index}` }),
    );
    const { db } = curateDb(rows);
    // The fake queue ignores LIMIT (that is D1's job, pinned separately in the
    // queue-read test), so this asserts the batching arithmetic and nothing else.
    const fetchMock = stubLlm();

    await curatePending(envWith(db));

    // Derived, not restated: the sizes have to follow the two constants or this
    // breaks every time the per-tick budget is retuned (it has been, twice).
    const selected = CURATION_LIMIT + 5;
    const expectedSizes = Array.from(
      { length: Math.ceil(selected / CURATION_BATCH_SIZE) },
      (_, index) => Math.min(CURATION_BATCH_SIZE, selected - index * CURATION_BATCH_SIZE),
    );
    expect(fetchMock).toHaveBeenCalledTimes(expectedSizes.length);
    const sizes = fetchMock.mock.calls.map(
      (call) => (JSON.parse(call[1].body).messages[0].content.match(/--- STORY /g) ?? []).length,
    );
    expect(sizes).toEqual(expectedSizes);
  });
});

describe('curation budget and claims', () => {
  function clock() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('does not claim candidates when selection consumes the budget', async () => {
    clock();
    const { db, ran, batched, prepare } = curateDb([pendingRow()]);
    const original = prepare.getMockImplementation()!;
    prepare.mockImplementation((sql) => {
      const statement = original(sql);
      if (sql.includes('ORDER BY')) vi.setSystemTime(CURATION_BUDGET_MS);
      return statement;
    });
    const fetchMock = stubLlm();
    await expect(curatePending(envWith(db))).resolves.toMatchObject({ selected: 0, failed: 0 });
    expect(ran).toEqual([]);
    expect(batched).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('audits a claim that consumed the budget without unclaiming or calling the model', async () => {
    clock();
    const { db, ran, batched } = curateDb([pendingRow(), pendingRow({ id: 'fp-2' })], () => {
      vi.setSystemTime(CURATION_BUDGET_MS);
      return true;
    });
    const fetchMock = stubLlm();
    const report = await curatePending(envWith(db));
    expect(report).toMatchObject({ selected: 1, failed: 1, curated: 0 });
    expect(ran.filter(isClaim)).toHaveLength(1);
    expect(ran.filter(isOutcome).map((row) => row.params.slice(1, 7))).toEqual([
      ['fp-1', 'toms-hardware', 'failed', 'test-model', 'fp-1', 'curation time budget exhausted'],
    ]);
    expect(ran.every((row) => isClaim(row) || isOutcome(row))).toBe(true);
    expect(batched).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares the deadline across batches and leaves later candidates unclaimed', async () => {
    clock();
    // Like the batching test, the fake ignores SQL LIMIT to exercise >1 batch
    // without changing the production cap of four.
    const rows = Array.from({ length: CURATION_BATCH_SIZE + 1 }, (_, i) =>
      pendingRow({ id: `fp-${i}` }),
    );
    const { db, ran, batched } = curateDb(rows);
    const answer = stubLlm();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        vi.setSystemTime(CURATION_BUDGET_MS - 1);
        return answer(url, init);
      }),
    );
    const batchWrite = vi.mocked(db.batch).getMockImplementation()!;
    vi.mocked(db.batch).mockImplementation(async (statements) => {
      const result = await batchWrite(statements);
      vi.setSystemTime(CURATION_BUDGET_MS);
      return result;
    });
    const report = await curatePending(envWith(db));
    expect(report).toMatchObject({
      selected: CURATION_BATCH_SIZE,
      curated: CURATION_BATCH_SIZE,
      failed: 0,
    });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(ran.filter(isClaim)).toHaveLength(CURATION_BATCH_SIZE);
    expect(batched.flat().filter(isOutcome)).toHaveLength(CURATION_BATCH_SIZE);
    expect(ran.some((row) => row.params.includes(`fp-${CURATION_BATCH_SIZE}`))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clamps fallback and audits every claimed story, including fallbacks never started', async () => {
    clock();
    const { db, ran, batched } = curateDb([
      pendingRow(),
      pendingRow({ id: 'fp-2' }),
      pendingRow({ id: 'fp-3' }),
    ]);
    let call = 0;
    let activeSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call <= 2) return llmResponse({ results: [] });
      if (call === 3) {
        vi.setSystemTime(CURATION_BUDGET_MS - 1000);
        return llmResponse(enrichment);
      }
      activeSignal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        activeSignal!.addEventListener('abort', () => reject(activeSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = curatePending(envWith(db));
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toBe(4); // two batch failures, one successful fallback, one pending
    await vi.advanceTimersByTimeAsync(999);
    expect(activeSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ selected: 3, curated: 1, failed: 2 });
    expect(activeSignal!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4); // no retry or third-story fallback
    expect(ran.filter(isClaim)).toHaveLength(3);
    expect(
      ran.filter(isOutcome).map((row) => [row.params[1], row.params[3], row.params[6]]),
    ).toEqual([
      ['fp-2', 'failed', 'curation time budget exhausted'],
      ['fp-3', 'failed', 'curation time budget exhausted'],
    ]);
    expect(batched).toHaveLength(1);
    expect(batched[0]!.find(isOutcome)!.params[3]).toBe('stored');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pendingCurationCount', () => {
  it('reports the queue length', async () => {
    const { db } = curateDb([pendingRow(), pendingRow({ id: 'fp-2' })]);
    expect(await pendingCurationCount(envWith(db))).toBe(2);
  });
});
