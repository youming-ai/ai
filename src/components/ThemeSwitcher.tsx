// The theme control, server-rendered only.
//
// It used to be a hydrated island that read localStorage in an effect to decide
// which icon to show. Now the markup ships both icons hidden and no label beyond
// "Theme", and `src/scripts/board.ts` reveals the right one after paint — which
// also fixes something the island had to work around: the rail renders this
// control twice (desktop column and mobile disclosure), and two instances with
// their own state could disagree. There is one source of truth now, `data-theme`
// on the root element, which the inline script in Layout.astro reads as well.
//
// Rendering an icon at all is deferred because the server cannot know the
// reader's choice: showing one unconditionally would be a lie until the script
// runs, and `hidden` keeps the button's box (min-w/min-h) stable meanwhile.
export default function ThemeSwitcher() {
  return (
    <button
      type="button"
      data-theme-toggle
      aria-label="Theme"
      title="Theme"
      className="flex min-h-9 min-w-9 items-center justify-center rounded-pill text-chalkdim transition-colors hover:bg-overlay/10 hover:text-chalk ds-press"
    >
      {/* Inline moon/sun (lucide paths) — two icons don't justify a dependency.
          Hidden with an inline style rather than the `hidden` attribute: that
          attribute is defined for HTML elements, React's SVG props don't even
          accept it, and `board.ts` reveals one of the two after paint. */}
      <svg
        data-theme-icon="dark"
        style={{ display: 'none' }}
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
      <svg
        data-theme-icon="light"
        style={{ display: 'none' }}
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
    </button>
  );
}
