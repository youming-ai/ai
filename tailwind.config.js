import plugin from 'tailwindcss/plugin';
import tokens from './design-tokens/tokens.json' with { type: 'json' };

// The names used by existing markup stay stable; values live only in tokens.json.
const colorNames = {
  night: 'bg',
  panel: 'surface',
  line: 'line',
  chalk: 'text',
  chalkdim: 'muted',
  pitch: 'pitch',
  live: 'live',
  overlay: 'overlay',
};
const map = (group, value) =>
  Object.fromEntries(Object.entries(group).map(([name, token]) => [name, value(name, token)]));
const variables = (group, prefix) => map(group, (name) => `var(--${prefix}-${name})`);
const sizes = Object.fromEntries(
  Object.entries(tokens.typography).filter(([, token]) => token.$type === 'dimension'),
);
const fonts = Object.fromEntries(
  Object.entries(tokens.typography)
    .filter(([, token]) => token.$type === 'fontFamily')
    .map(([name, token]) => [name.replace('font-', ''), token.$value]),
);

export default {
  // Tests name classes in assertions that should never become shipped CSS.
  content: ['./src/**/*.{astro,js,ts,jsx,tsx}', '!./src/**/*.test.ts'],
  theme: {
    extend: {
      colors: map(tokens.color, (name) => `rgb(var(--c-${colorNames[name]}) / <alpha-value>)`),
      borderRadius: variables(tokens.radius, 'r'),
      fontSize: map(sizes, (name) => [
        `var(--text-${name})`,
        { lineHeight: `var(--leading-${name === 'micro' ? 'caption' : name})` },
      ]),
      lineHeight: variables(tokens.leading, 'leading'),
      letterSpacing: map(tokens.tracking, (_, token) => token.$value),
      boxShadow: variables(tokens.shadow, 'shadow'),
      transitionTimingFunction: variables(tokens.easing, 'ease'),
      fontFamily: fonts,
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      const themed = (theme) => ({
        ...Object.fromEntries(
          Object.entries(tokens.color).map(([name, token]) => [
            `--c-${colorNames[name]}`,
            token.$value[theme]
              .slice(1)
              .match(/../g)
              .map((channel) => Number.parseInt(channel, 16))
              .join(' '),
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(tokens.shadow).map(([name, token]) => [
            `--shadow-${name}`,
            token.$value[theme],
          ]),
        ),
        'color-scheme': theme,
      });
      const values = (group, prefix) =>
        Object.fromEntries(
          Object.entries(group).map(([name, token]) => [`--${prefix}-${name}`, token.$value]),
        );
      addBase({
        ':root, [data-theme="dark"]': {
          ...themed('dark'),
          ...values(tokens.radius, 'r'),
          ...values(sizes, 'text'),
          ...values(tokens.leading, 'leading'),
          ...values(tokens.easing, 'ease'),
        },
        '[data-theme="light"]': themed('light'),
      });
    }),
  ],
};
