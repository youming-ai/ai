import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import config from '../tailwind.config.js';
import { SITE_VERSION } from './site';

// Compile the real config so contrast checks cover the emitted theme, not a
// second handwritten palette. cwd-relative paths also work in jsdom.
const sourceCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const compiler = await compile('@config "../tailwind.config.js"; @tailwind utilities;', {
  loadModule: async () => ({
    path: resolve(process.cwd(), 'tailwind.config.js'),
    base: process.cwd(),
    module: config,
  }),
});
const css = compiler.build([
  'text-pitch',
  'bg-panel/70',
  'text-lead',
  'font-display',
  'font-body',
  'font-mono',
  'shadow-float',
]);

function hexFromChannels(channels: string): string {
  const [r, g, b] = channels
    .trim()
    .split(/\s+/)
    .map((v) => Number(v));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Extract the `--c-*` channel triplets from one compiled theme block. */
function cssColorBlock(theme: 'dark' | 'light'): Record<string, string> {
  const selector = theme === 'dark' ? ':root, [data-theme="dark"]' : '[data-theme="light"]';
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
  it('connects the stylesheet to generated theme variables and utilities', () => {
    expect(sourceCss).toContain("@config '../tailwind.config.js'");
    expect(css).toContain('color: rgb(var(--c-pitch) / 1)');
    expect(css).toContain('font-size: var(--text-lead)');
    expect(css).toContain('font-family: Oswald, system-ui, sans-serif');
    expect(css).toContain('font-family: Inter, system-ui, sans-serif');
    expect(css).toContain('font-family: IBM Plex Mono, ui-monospace');
    expect(css).toContain('--tw-shadow: var(--shadow-float)');
    expect(css).not.toContain('undefined');
  });

  const dark = cssColorBlock('dark');
  const light = cssColorBlock('light');

  it('keeps the theme-color meta in sync with the dark --c-bg', () => {
    // Layout.astro is the one place --c-bg is copied as a literal: the browser
    // chrome color has to be in the markup before the stylesheet resolves.
    // Pinned the way PRUNE_CRON is pinned to void.config.ts, since the dark
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
    const scriptTheme = layout.match(/dark:\s*'rgb\(([^)]+)\)',\s*light:\s*'rgb\(([^)]+)\)'/);
    expect(scriptTheme, 'theme literals in the Layout theme script').not.toBeNull();
    expect(scriptTheme![1].trim()).toBe(darkChannels.join(' '));
    const lightHex = light.bg;
    expect(lightHex, '--c-bg in the light block').toBeDefined();
    const lightChannels = [1, 3, 5].map((i) => Number.parseInt(lightHex!.slice(i, i + 2), 16));
    expect(scriptTheme![2].trim()).toBe(lightChannels.join(' '));
  });
  it('keeps the accent readable where it actually renders, in both themes', () => {
    // The 15%-fill active rail row is the dimmest surface pitch text sits on;
    // a token test on the page alone would pass while the real row fails. Both
    // themes, because the risk moved: the old green was in danger on the light
    // ground, while #5200ff reads ~2.6:1 on the dark one — the default theme.
    for (const [name, theme, other] of [
      ['dark', dark, dark],
      ['light', light, dark],
    ] as const) {
      const page = token(theme, other, 'bg');
      const card = mix(token(theme, other, 'surface'), page, 0.7);
      const pitch = token(theme, other, 'pitch');
      const rowFill = mix(pitch, page, 0.15);
      // 11px caption text needs 4.5:1; no large-text exemption applies.
      expect(contrast(pitch, rowFill), `${name}: pitch on active rail row`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(pitch, page), `${name}: pitch on page`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pitch, card), `${name}: pitch on card`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token(theme, other, 'live'), page),
        `${name}: live on page`,
      ).toBeGreaterThanOrEqual(4.5);
    }
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
    const rule = sourceCss.match(/\.ds-card\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, '.ds-card rule in index.css').not.toBe('');
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
    // Nothing else pins this: generating matching CSS values alone does not guarantee legibility.
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
});

describe('the reported version', () => {
  it('matches the one in package.json', () => {
    // /api/health reports a version a Worker cannot import — package.json is not
    // in its bundle — so the constant is duplicated, and pinned here.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    expect(pkg.version, 'version in package.json').toBeDefined();
    expect(SITE_VERSION, 'SITE_VERSION in src/site.ts').toBe(pkg.version);
  });
});
