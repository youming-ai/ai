import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_VERSION } from './site';

// Design-token source-of-truth check: design-tokens/tokens.json (the Figma
// import source) must stay in sync with the runtime values in src/index.css.
// The palette drifted once (the dark values diverged silently); this test is
// the CI tripwire so it can't happen again unnoticed.

// cwd-relative: vitest's jsdom environment mangles import.meta.url schemes.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const tokens = JSON.parse(
  readFileSync(resolve(process.cwd(), 'design-tokens/tokens.json'), 'utf8'),
) as {
  color: Record<string, { $value: { dark?: string; light?: string } }>;
  radius: Record<string, { $value: string }>;
  spacing: Record<string, { $value: string }>;
  typography: Record<string, { $value: string }>;
  shadow: Record<string, { $value: { dark?: string; light?: string } }>;
  component: Record<string, unknown>;
};

// tokens.json uses semantic names; index.css uses --c-* vars. This is the
// same bridge tailwind.config.js builds (`c('--c-bg')` → color "night").
const CSS_VAR: Record<string, string> = {
  night: 'bg',
  panel: 'surface',
  panel2: 'surface2',
  line: 'line',
  chalk: 'text',
  chalkdim: 'muted',
  pitch: 'pitch',
  live: 'live',
  amber: 'amber',
  overlay: 'overlay',
};

function hexFromChannels(channels: string): string {
  const [r, g, b] = channels
    .trim()
    .split(/\s+/)
    .map((v) => Number(v));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Extract the `--c-*` channel triplets from one theme block of index.css. */
function cssColorBlock(theme: 'dark' | 'light'): Record<string, string> {
  const selector = theme === 'dark' ? ":root,\n[data-theme='dark']" : "[data-theme='light']";
  const start = css.indexOf(selector);
  expect(start, `${theme} block selector`).toBeGreaterThan(-1);
  const body = css.slice(start + selector.length, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[match[1]] = hexFromChannels(`${match[2]} ${match[3]} ${match[4]}`);
  }
  return out;
}

type Rgb = [number, number, number];

/** Channel triple from a `#rrggbb` token value. */
function channels(hex: string): Rgb {
  expect(hex, 'parsed hex').toMatch(/^#[0-9a-fA-F]{6}$/);
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** A token's value in one theme, falling back to dark where light inherits. */
function token(theme: Record<string, string>, other: Record<string, string>, name: string): Rgb {
  const v = theme[name] ?? other[name];
  expect(v, `--c-${name} parsed`).toBeDefined();
  return channels(v!);
}

const toHex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Composite `fg` over `bg` at `alpha`, the way the CSS alpha utilities do. */
function mix(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as Rgb;
}

const channelLuminance = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x contrast ratio between two opaque colours. */
function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb): number =>
    0.2126 * channelLuminance(c[0]) +
    0.7152 * channelLuminance(c[1]) +
    0.0722 * channelLuminance(c[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  const dark = cssColorBlock('dark');
  const light = cssColorBlock('light');

  it('keeps every tokens.json color in sync with index.css (dark + light)', () => {
    for (const [name, token] of Object.entries(tokens.color)) {
      const cssName = CSS_VAR[name];
      expect(cssName, `mapping for ${name}`).toBeDefined();
      if (token.$value.dark) {
        expect(dark[cssName]?.toLowerCase(), `${name} dark`).toBe(token.$value.dark.toLowerCase());
      }
      if (token.$value.light) {
        // A token the light block does not override inherits the dark value.
        const lightValue = light[cssName] ?? dark[cssName];
        expect(lightValue?.toLowerCase(), `${name} light`).toBe(token.$value.light.toLowerCase());
      }
    }
  });

  it('keeps every tokens.json radius in sync with index.css --r-*', () => {
    // Radius lives in both tokens.json and src/index.css --r-*. The color sync
    // test above exists because the palette drifted once; radius has the same
    // drift risk and no other guard, so this mirrors it. Values are dimensions
    // ("0px", "16px"); compare numerically so "0" and "0px" both read as 0.
    const toPx = (v: string) => Number.parseFloat(v.replace(/px/i, '').trim());
    for (const [name, token] of Object.entries(tokens.radius)) {
      const match = css.match(new RegExp(`--r-${name}:\\s*([^;]+);`));
      expect(match, `--r-${name} present in index.css`).not.toBeNull();
      expect(toPx(match![1])).toBe(toPx(token.$value));
    }
  });

  it('keeps the theme-color meta in sync with the dark --c-bg', () => {
    // Layout.astro is the one place --c-bg is copied as a literal: the browser
    // chrome color has to be in the markup before the stylesheet resolves.
    // Pinned the way PRUNE_CRON is pinned to wrangler.toml, since the dark
    // ground changing would otherwise silently leave the mobile chrome wrong.
    const layout = readFileSync(resolve(process.cwd(), 'src/layouts/Layout.astro'), 'utf8');
    const meta = layout.match(/name="theme-color"\s+content="rgb\(([^)]+)\)"/);
    expect(meta, 'theme-color meta in Layout.astro').not.toBeNull();

    const hex = dark.bg;
    expect(hex, '--c-bg in the dark block').toBeDefined();
    const darkChannels = [1, 3, 5].map((i) => Number.parseInt(hex!.slice(i, i + 2), 16));
    expect(meta![1].trim()).toBe(darkChannels.join(' '));

    // The inline theme script sets the SAME literal per branch before CSSOM
    // exists, so first paint already carries the right chrome in either theme.
    // This test pins the pair: pick them out of the script's theme record.
    const scriptTheme = layout.match(/dark:\s*'rgb\(10 14 12\)',\s*light:\s*'rgb\(([^)]+)\)'/);
    expect(scriptTheme, 'theme literals in the Layout theme script').not.toBeNull();
    const lightHex = light.bg;
    expect(lightHex, '--c-bg in the light block').toBeDefined();
    const lightChannels = [1, 3, 5].map((i) => Number.parseInt(lightHex!.slice(i, i + 2), 16));
    expect(scriptTheme![1].trim()).toBe(lightChannels.join(' '));
  });
  it('keeps the light accent readable where it actually renders', () => {
    // The 15%-fill active rail row is the dimmest surface pitch text sits on;
    // a token test on white alone would pass while the real row fails.
    const page = token(light, dark, 'bg');
    const card = channels(toHex(mix(channels('#ffffff'), page, 0.7)));
    const pitch = token(light, dark, 'pitch');
    const rowFill = channels(toHex(mix(pitch, page, 0.15)));
    // 11px caption text needs 4.5:1; no large-text exemption applies.
    expect(contrast(pitch, rowFill), 'pitch on active rail row').toBeGreaterThanOrEqual(4.5);
    expect(contrast(pitch, page), 'pitch on page').toBeGreaterThanOrEqual(4.5);
    expect(contrast(pitch, card), 'pitch on card').toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(light, dark, 'live'), page), 'live on page').toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the off-screen card skip in place', () => {
    // Not decoration, and nothing else here would notice its removal: the board
    // renders identically with or without it. Measured on the perf harness at a
    // fixed 130-card board, A/B on one build — removing these two declarations
    // costs 85ms of style recalculation against 72ms, and 66ms of layout
    // against 49ms, and doubles CLS during scroll (1.42 against 0.66).
    // `contain-intrinsic-size` is half the fix: without a fallback near the real
    // card height the document comes out short and the scrollbar jitters as
    // cards render.
    const rule = css.match(/\.ds-signal\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, '.ds-signal rule in index.css').not.toBe('');
    expect(rule).toContain('content-visibility: auto');
    expect(rule).toMatch(/contain-intrinsic-size:\s*auto\s+\d+px/);
  });

  it('keeps caption text legible on the surfaces it sits on', () => {
    // This began as the *input boundary* check, because `--c-muted` was the
    // border of `.ds-input` and SC 1.4.11 asks 3:1 for a non-text boundary. The
    // last `<input>` went with the header's search box, so the token's only
    // remaining job is `text-chalkdim` — 11px caption text on the page and on
    // the 70%-panel surfaces — which needs 4.5:1. Left at 3:1 under the old name
    // it would have passed while caption text dropped to the boundary minimum.
    // Nothing else pins this: the token-sync test above compares tokens.json
    // with index.css by value, not by legibility.
    for (const [name, theme, other] of [
      ['dark', dark, dark],
      ['light', light, dark],
    ] as const) {
      const page = token(theme, other, 'bg');
      const text = token(theme, other, 'muted');
      const fill = mix(token(theme, other, 'surface'), page, 0.7);
      expect(contrast(text, page), `${name}: caption text on page`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, fill), `${name}: caption text on panel`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every tokens.json spacing in sync with index.css --space-*', () => {
    // Same dimension comparison as radius: values may be px or rem; 1rem = 16px.
    const toPx = (v: string): number =>
      v.trim().endsWith('rem')
        ? Number.parseFloat(v) * 16
        : Number.parseFloat(v.replace(/px/i, ''));
    for (const [name, token] of Object.entries(tokens.spacing)) {
      const match = css.match(new RegExp(`--space-${name}:\\s*([^;]+);`));
      expect(match, `--space-${name} present in index.css`).not.toBeNull();
      expect(toPx(match![1]), name).toBe(toPx(token.$value));
    }
  });

  it('keeps every tokens.json typography size in sync with index.css', () => {
    // These had already drifted: tokens said micro 9px / caption 10px while the
    // stylesheet had moved to 10px / 11px, and nothing noticed because only
    // colour and radius were pinned. The captions carry source names, dates and
    // every rail row, so the size is load-bearing rather than decorative.
    //
    // Sizes only. The three font families are `$type: fontFamily` entries with
    // no CSS var behind them; the next test holds those to tailwind.config.js,
    // which is where they are actually declared.
    const toPx = (v: string): number =>
      v.trim().endsWith('rem')
        ? Number.parseFloat(v) * 16
        : Number.parseFloat(v.replace(/px/i, ''));
    let sizes = 0;
    for (const [name, token] of Object.entries(tokens.typography)) {
      if (!/^\d/.test(token.$value)) continue;
      sizes += 1;
      const match = css.match(new RegExp(`--text-${name}:\\s*([^;]+);`));
      expect(match, `--text-${name} present in index.css`).not.toBeNull();
      expect(toPx(match![1]), name).toBe(toPx(token.$value));
    }
    // Guards against the loop silently iterating nothing after a rename.
    expect(sizes).toBe(6);
  });

  it('keeps every tokens.json font family in sync with tailwind.config.js', () => {
    // The families live in the Tailwind config as the font-display/body/mono
    // utilities, not as CSS vars, so that file is where they can drift. Several
    // are multi-word and quoted for CSS; the token names the family itself.
    const tailwind = readFileSync(resolve(process.cwd(), 'tailwind.config.js'), 'utf8');
    const start = tailwind.indexOf('fontFamily:');
    const block = tailwind.slice(start, tailwind.indexOf('borderRadius:', start));
    expect(block.length, 'fontFamily block in tailwind.config.js').toBeGreaterThan(0);

    let families = 0;
    for (const [name, token] of Object.entries(tokens.typography)) {
      if (/^\d/.test(token.$value)) continue;
      families += 1;
      const key = name.replace(/^font-/, '');
      const match = block.match(new RegExp(`${key}:\\s*\\[\\s*'([^']+)'`));
      expect(match, `fontFamily.${key} in tailwind.config.js`).not.toBeNull();
      expect(match![1].replace(/"/g, ''), name).toBe(token.$value);
    }
    expect(families).toBe(3);
  });

  it('keeps every tokens.json shadow in sync with index.css --shadow-*', () => {
    // The two files write the same shadow in different notations —
    // `rgba(0,0,0,0.08)` against `rgb(0 0 0 / 0.08)` — so compare normalised.
    // panel.light had drifted (blur 4px→6px, alpha .08→.1) unnoticed.
    const normalise = (value: string): string =>
      value
        .replace(/rgb\(([\d\s]+?)\s*\/\s*([\d.]+)\)/g, (_m, rgb: string, a: string) => {
          return `rgba(${rgb.trim().split(/\s+/).join(',')},${a})`;
        })
        .replace(/rgba\(([^)]+)\)/g, (_m, inner: string) => {
          return `rgba(${inner
            .split(',')
            .map((part) => part.trim())
            .join(',')})`;
        })
        .replace(/\s+/g, ' ')
        .trim();

    for (const [name, token] of Object.entries(tokens.shadow)) {
      for (const theme of ['dark', 'light'] as const) {
        const expected = token.$value[theme];
        if (!expected) continue;
        const block =
          theme === 'dark'
            ? css.slice(css.indexOf(':root,'), css.indexOf("[data-theme='light']"))
            : css.slice(css.indexOf("[data-theme='light']"));
        const match = block.match(new RegExp(`--shadow-${name}:\\s*([^;]+);`));
        expect(match, `--shadow-${name} in the ${theme} block`).not.toBeNull();
        expect(normalise(match![1]), `${name} ${theme}`).toBe(normalise(expected));
      }
    }
  });

  it('only names component tokens for classes the stylesheet declares', () => {
    // The orphan check: ds-page, ds-page-inner, ds-glass, ds-glass-hero and
    // ds-chip described recipes for markup that no longer exists, and nothing
    // said so. Any token added here has to name a real rule.
    for (const name of Object.keys(tokens.component)) {
      expect(css, `.${name} declared in index.css`).toContain(`.${name}`);
    }
  });
});

describe('the reported version', () => {
  it('matches the one in package.json', () => {
    // /api/health reports a version a Worker cannot import — package.json is not
    // in its bundle — so the constant is duplicated, and pinned here the way
    // retention.cron.test.ts pins PRUNE_CRON to wrangler.toml.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    expect(pkg.version, 'version in package.json').toBeDefined();
    expect(SITE_VERSION, 'SITE_VERSION in src/site.ts').toBe(pkg.version);
  });
});
