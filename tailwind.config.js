/** @type {import('tailwindcss').Config} */

// Colors use CSS variable channels ("R G B") so alpha modifiers work:
// bg-panel/85, border-overlay/10, etc.
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  // Not the tests: they name classes in assertions and comments that no page
  // uses, and each became shipped CSS (`.container` brought a media query per
  // breakpoint). Tailwind 4 reads this glob as a source in its own right.
  content: ['./src/**/*.{astro,js,ts,jsx,tsx}', '!./src/**/*.test.ts'],
  theme: {
    extend: {
      colors: {
        night: c('--c-bg'),
        panel: c('--c-surface'),
        panel2: c('--c-surface2'),
        line: c('--c-line'),
        chalk: c('--c-text'),
        chalkdim: c('--c-muted'),
        pitch: c('--c-pitch'),
        live: c('--c-live'),
        amber: c('--c-amber'),
        overlay: c('--c-overlay'),
      },
      borderRadius: {
        micro: 'var(--r-micro)',
        'card-inset': 'var(--r-card-inset)',
        card: 'var(--r-card)',
        control: 'var(--r-control)',
        panel: 'var(--r-panel)',
        hero: 'var(--r-hero)',
        pill: 'var(--r-pill)',
      },
      spacing: {
        'page-x': 'var(--space-page-x)',
        'page-x-md': 'var(--space-page-x-md)',
        'page-y': 'var(--space-page-y)',
        'page-y-md': 'var(--space-page-y-md)',
        section: 'var(--space-section)',
        stack: 'var(--space-stack)',
        card: 'var(--space-card)',
        'card-inner': 'var(--space-card-inner)',
      },
      fontSize: {
        micro: ['var(--text-micro)', { lineHeight: 'var(--leading-caption)' }],
        caption: ['var(--text-caption)', { lineHeight: 'var(--leading-caption)' }],
        label: ['var(--text-label)', { lineHeight: 'var(--leading-label)' }],
        body: ['var(--text-body)', { lineHeight: 'var(--leading-body)' }],
        lead: ['var(--text-lead)', { lineHeight: 'var(--leading-lead)' }],
        hero: ['var(--text-hero)', { lineHeight: 'var(--leading-hero)' }],
      },
      lineHeight: {
        caption: 'var(--leading-caption)',
        label: 'var(--leading-label)',
        body: 'var(--leading-body)',
        lead: 'var(--leading-lead)',
        hero: 'var(--leading-hero)',
      },
      // Letter-spacing scale — one home for the broadcast-label tracking that
      // used to be hand-rolled per component (tracking-[0.15em] etc).
      letterSpacing: {
        display: '0.08em', // wordmark / display headings
        data: '0.12em', // card source rows, stat labels
        caption: '0.16em', // eyebrow / section captions
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        hero: 'var(--shadow-hero)',
        float: 'var(--shadow-float)',
      },
      transitionTimingFunction: {
        // Strong ease-out for UI motion; mirrors --ease-out in index.css.
        out: 'var(--ease-out)',
      },
      fontFamily: {
        display: ['Archivo', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
