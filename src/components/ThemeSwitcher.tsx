import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';

function detectTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* private mode / storage disabled */
  }
  return 'dark';
}

/** The theme currently in force, per the document — the one place every
 *  instance reads from. Falls back to storage only when the attribute is
 *  missing, which is the case when the inline script in Layout has not run
 *  (tests, or a document that never booted it). */
function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  if (applied === 'dark' || applied === 'light') return applied;
  return detectTheme();
}

// `theme` starts null so the server and the first client render agree on an
// icon-less button: this renders inside an SSR'd `client:load` island, so
// reading localStorage during render would be a hydration mismatch. The
// inline script in Layout has already painted the right theme by then —
// this only catches the button up.
//
// There is more than one instance now (the rail renders the controls on both
// the desktop column and the mobile disclosure), so `data-theme` is the shared
// source of truth rather than this component's state: whichever button is
// clicked updates the attribute, and the observer is what brings the other
// instance — and any future one — along with it.
export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const initial = currentTheme();
    // Adopt it once so the attribute is always set for the observers to see.
    if (root.dataset.theme !== initial) root.dataset.theme = initial;
    setTheme(initial);

    // Sets state only — writing the attribute from here would re-enter the
    // observer, since setAttribute queues a record even for an unchanged value.
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const cycle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled */
    }
    document.documentElement.dataset.theme = next;
    // Optimistic, so this instance's own label turns over in the same tick.
    setTheme(next);
  };

  const label = theme === 'dark' ? 'Dark theme' : theme === 'light' ? 'Light theme' : 'Theme';

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className="flex min-h-9 min-w-9 items-center justify-center rounded-pill text-chalkdim transition-colors hover:bg-overlay/10 hover:text-chalk ds-press"
    >
      {/* Inline moon/sun (lucide paths) — two icons don't justify a dependency. */}
      {theme === 'dark' ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      ) : theme === 'light' ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : null}
    </button>
  );
}
