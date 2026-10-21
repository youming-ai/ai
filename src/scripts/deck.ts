// The swipe deck (`?view=deck`): one card at a time. Drag the top card right to
// save it, left to skip it, up to share it; tap it to open the link. The three
// buttons and the arrow keys do the same, so nothing here needs a pointer.
//
// The cards are server-rendered like every other view; this module only moves
// them. Saved links live in localStorage — this device only, which the panel
// says. ponytail: no undo and no cross-device sync; a swiped card is gone until
// the page reloads.

export type DeckAction = 'save' | 'skip' | 'share';

/** Where a released drag lands, or null to spring back. Pure, so the thresholds
 *  are testable without a pointer. Up wins only when the drag is mostly
 *  vertical: a sideways flick that drifts upward is still a save or a skip. */
export function decide(dx: number, dy: number, width: number, height: number): DeckAction | null {
  if (-dy > height * 0.25 && -dy > Math.abs(dx)) return 'share';
  if (Math.abs(dx) > width * 0.3) return dx > 0 ? 'save' : 'skip';
  return null;
}

interface SavedLink {
  id: string;
  title: string;
  url: string;
  domain: string;
  savedAt: number;
}

const SAVED_KEY = 'ai-desk:saved';
const SAVED_LIMIT = 200;

// Storage is the reader's own and can hold anything, so every entry is checked
// before it becomes an href: only http(s), which is all the server ever emits.
function isSavedLink(value: unknown): value is SavedLink {
  if (typeof value !== 'object' || value === null) return false;
  const link = value as Record<string, unknown>;
  return (
    typeof link.id === 'string' &&
    typeof link.title === 'string' &&
    typeof link.domain === 'string' &&
    typeof link.url === 'string' &&
    /^https?:\/\//.test(link.url)
  );
}

export function readSaved(): SavedLink[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedLink) : [];
  } catch {
    return [];
  }
}

function writeSaved(links: SavedLink[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(links.slice(0, SAVED_LIMIT)));
  } catch {
    // Private mode or a full quota: the swipe still works, it just isn't kept.
  }
}

/** Fetches the next page into the stack; null when the first page was the last. */
export interface DeckSource {
  load(): Promise<void>;
  hasMore(): boolean;
}

export function initDeck(
  deck: HTMLElement,
  source: DeckSource | null,
  reducedMotion: () => boolean,
): void {
  const found = deck.querySelector<HTMLElement>('[data-deck-stack]');
  if (!found) return;
  // A non-nullable const, so the narrowing survives into the closures below.
  const stack: HTMLElement = found;
  const progress = deck.querySelector<HTMLElement>('[data-deck-progress]');
  const savedPanel = deck.querySelector<HTMLDetailsElement>('[data-deck-saved]');
  const savedCount = deck.querySelector<HTMLElement>('[data-deck-saved-count]');
  const savedList = deck.querySelector<HTMLElement>('[data-deck-saved-list]');
  const savedEmpty = deck.querySelector<HTMLElement>('[data-deck-saved-empty]');
  const done = deck.querySelector<HTMLElement>('[data-deck-done]');
  const status = deck.querySelector<HTMLElement>('[data-deck-status]');
  const total = Number(deck.dataset.total);
  let seen = 1;
  // A drag's release also fires a click on the link under it; this swallows it.
  let suppressClickUntil = 0;

  const cards = () => Array.from(stack.querySelectorAll<HTMLElement>('[data-deck-card]'));
  const announce = (text: string) => {
    if (status) status.textContent = text;
  };

  function refresh(): void {
    if (progress)
      progress.textContent = total > 0 ? `${Math.min(seen, total)} / ${total}` : `${seen}`;
    if (savedCount) savedCount.textContent = String(readSaved().length);
    const remaining = cards().length;
    if (remaining <= 3 && source?.hasMore()) {
      // Re-render only if cards arrived: a failed load must not loop straight
      // back into another one.
      void source.load().then(() => {
        if (cards().length > remaining) refresh();
      });
    }
    if (done) done.hidden = remaining > 0 || Boolean(source?.hasMore());
  }

  function save(card: HTMLElement): void {
    const link: SavedLink = {
      id: card.dataset.id ?? '',
      title: card.dataset.title ?? '',
      url: card.dataset.url ?? '',
      domain: card.dataset.domain ?? '',
      savedAt: Date.now(),
    };
    if (!isSavedLink(link)) return;
    writeSaved([link, ...readSaved().filter((saved) => saved.id !== link.id)]);
  }

  async function share(card: HTMLElement): Promise<void> {
    const url = card.dataset.url ?? '';
    try {
      if (navigator.share) {
        await navigator.share({ title: card.dataset.title ?? '', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      announce('Link copied.');
    } catch {
      // The share sheet was dismissed, or the clipboard is blocked.
    }
  }

  function springBack(card: HTMLElement): void {
    card.style.transform = '';
    delete card.dataset.lean;
  }

  function commit(card: HTMLElement, action: DeckAction): void {
    if (action === 'share') {
      springBack(card);
      void share(card);
      return;
    }
    if (action === 'save') {
      save(card);
      announce(`Saved: ${card.dataset.title ?? ''}`);
    } else {
      announce('Skipped.');
    }
    seen += 1;
    const leave = () => {
      // Removing the focused card would drop focus to the page, and the arrow
      // keys would stop reaching the deck.
      const hadFocus = card.contains(document.activeElement);
      card.remove();
      if (hadFocus) stack.focus();
      refresh();
    };
    if (reducedMotion()) {
      leave();
      return;
    }
    const direction = action === 'save' ? 1 : -1;
    card.style.transform = `translate(${direction * 150}%, 0) rotate(${direction * 30}deg)`;
    // A timer rather than `transitionend`, which never fires in a hidden tab.
    window.setTimeout(leave, 220);
  }

  let drag: {
    card: HTMLElement;
    pointer: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null = null;

  stack.addEventListener('pointerdown', (event) => {
    const card = cards()[0];
    if (!card || event.button !== 0 || !card.contains(event.target as Node)) return;
    drag = {
      card,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
    };
  });

  stack.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    // Under 8px is a tap with a shaky finger, and the link should still open.
    if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 8) return;
    const { card, dx, dy } = drag;
    // Captured only once it is a drag: capturing on pointerdown retargets a
    // plain mouse click to the card instead of its link, and the tap no longer
    // opens anything.
    if (!drag.moved) card.setPointerCapture?.(event.pointerId);
    drag.moved = true;
    card.dataset.dragging = 'true';
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
    const lean = decide(dx, dy, card.offsetWidth, card.offsetHeight);
    if (lean) card.dataset.lean = lean;
    else delete card.dataset.lean;
  });

  const release = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { card, moved, dx, dy } = drag;
    drag = null;
    delete card.dataset.dragging;
    if (!moved) return;
    suppressClickUntil = performance.now() + 400;
    const action =
      event.type === 'pointercancel' ? null : decide(dx, dy, card.offsetWidth, card.offsetHeight);
    if (action) commit(card, action);
    else springBack(card);
  };
  stack.addEventListener('pointerup', release);
  stack.addEventListener('pointercancel', release);
  stack.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressClickUntil) event.preventDefault();
    },
    true,
  );

  for (const button of deck.querySelectorAll<HTMLElement>('[data-deck-action]')) {
    button.addEventListener('click', () => {
      const card = cards()[0];
      const action = button.dataset.deckAction;
      if (card && (action === 'save' || action === 'skip' || action === 'share')) {
        commit(card, action);
      }
    });
  }

  const KEYS: Record<string, DeckAction> = {
    ArrowLeft: 'skip',
    ArrowRight: 'save',
    ArrowUp: 'share',
  };
  stack.addEventListener('keydown', (event) => {
    const action = KEYS[event.key];
    const card = cards()[0];
    if (!action || !card) return;
    event.preventDefault();
    commit(card, action);
  });

  // The saved list is built from storage with textContent only: what is stored
  // is the reader's, and none of it is ever parsed as markup.
  savedPanel?.addEventListener('toggle', () => {
    if (!savedPanel.open || !savedList) return;
    const links = readSaved();
    savedList.replaceChildren(
      ...links.map((link) => {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.className = 'block rounded-card-inset p-2 hover:bg-overlay/5';
        const title = document.createElement('span');
        title.className = 'block text-chalk';
        title.textContent = link.title;
        const domain = document.createElement('span');
        domain.textContent = link.domain;
        anchor.appendChild(title);
        anchor.appendChild(domain);
        item.appendChild(anchor);
        return item;
      }),
    );
    if (savedEmpty) savedEmpty.hidden = links.length > 0;
  });

  refresh();
}
