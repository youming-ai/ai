// The append path. ssr.test.tsx renders this island to a string, which cannot
// reach a fetch — so before this file the pagination the island exists for was
// untested, and the state it needs (cursor vs. loaded page) could be rewritten
// freely. This drives the real component: the button is the keyboard/no-IO
// path, the observer callback is the scroll path.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExploreArticle, ExploreFeed } from '../../types';
import ExploreView from './ExploreView';

/** The observer callbacks the island installed, so a test can fire an
 *  intersection the way a scroll would. jsdom has no IntersectionObserver. */
const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

class FakeIntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds = [];
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function card(id: string, title: string): ExploreArticle {
  return {
    id,
    title,
    description: '',
    summary: '',
    blurb: '',
    url: `https://example.com/${id}`,
    imageUrl: '',
    isVideo: false,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    tags: ['tools'],
    qualityScore: 82,
    freshnessScore: 60,
  };
}

function feed(items: ExploreArticle[], nextCursor: string | null): ExploreFeed {
  return { items, nextCursor };
}

function ok(body: ExploreFeed): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The page every test starts from: SSR handed over one card and a cursor. */
function mount(options: { category?: string } = {}): ReturnType<typeof render> {
  return render(
    <ExploreView
      initialData={feed([card('a', 'first story')], 'cur-1')}
      initialFilters={{ categories: [] }}
      initialCategory={options.category}
    />,
  );
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExploreView pagination', () => {
  it('does not fetch on mount — the SSR payload is page one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(feed([], null)));
    vi.stubGlobal('fetch', fetchMock);

    mount();

    // A fetch here would replace page one with a duplicate of itself, and it is
    // what the `cursor === ''` guard exists to prevent.
    expect(screen.getByText('first story')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the cursor page from the button and appends it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(feed([card('b', 'second story')], null)));
    vi.stubGlobal('fetch', fetchMock);

    mount();
    fireEvent.click(screen.getByRole('button', { name: /load more stories/i }));

    await waitFor(() => expect(screen.getByText('second story')).toBeInTheDocument());
    // Appended, not replaced: both pages are on screen.
    expect(screen.getByText('first story')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('cursor=cur-1');
    expect(screen.queryByRole('button', { name: /load more stories/i })).toBeNull();
  });

  it('loads the same page from the sentinel, which is the scroll path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(feed([card('b', 'second story')], 'cur-2')));
    vi.stubGlobal('fetch', fetchMock);

    mount();
    const intersect = observers.at(-1);
    expect(intersect, 'an observer was installed for the sentinel').toBeDefined();
    await act(async () => {
      intersect?.([{ isIntersecting: true }]);
    });

    await waitFor(() => expect(screen.getByText('second story')).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('cursor=cur-1');
  });

  it('scopes the cursor request to the hub the page is for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(feed([card('b', 'second story')], null)));
    vi.stubGlobal('fetch', fetchMock);

    mount({ category: 'tools' });
    fireEvent.click(screen.getByRole('button', { name: /load more stories/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('category=tools');
    expect(url).toContain('cursor=cur-1');
  });

  it('retries the same page when the reader asks again after a failure', async () => {
    // Regression: the button used to set the cursor to the value it already
    // held, and React bails on an identical state update — so the effect never
    // re-ran and a transient failure left "Load more" looking live but inert
    // until a reload. The scroll path had the same hole.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 502 }))
      .mockResolvedValueOnce(ok(feed([card('b', 'second story')], null)));
    vi.stubGlobal('fetch', fetchMock);

    mount();
    const button = screen.getByRole('button', { name: /load more stories/i });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /load more stories/i }));

    await waitFor(() => expect(screen.getByText('second story')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the page and reports the failure when an append fails', async () => {
    // A failed page must not empty the board or be reported as an exhausted
    // feed: the reader keeps what they had and is told what happened.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));

    mount();
    fireEvent.click(screen.getByRole('button', { name: /load more stories/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('first story')).toBeInTheDocument();
  });
});
