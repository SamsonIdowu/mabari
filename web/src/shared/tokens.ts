// SPDX-License-Identifier: Apache-2.0
/**
 * Design tokens copied from design/mabari-prototype.html.
 * web/src/styles/tokens.css is generated from this file: run `pnpm tokens` after editing.
 */

const dark = {
  bg: '#000000',
  surface: '#0A0A0C',
  surface2: '#141417',
  surface3: '#1C1C20',
  line: '#202024',
  line2: '#303036',
  fg: '#ECEAF2',
  fg2: '#C7C4D2',
  muted: '#A19EAE',
  accent: '#A99CFF',
  'accent-fg': '#14112A',
  'accent-soft': '#1E1A38',
  query: '#7CCFE0',
  'query-soft': '#14272C',
  claude: '#E8894A',
  openai: '#3FB97A',
  custom: '#5B9BF0',
  'claude-ink': '#F0A26F',
  'openai-ink': '#5CCB92',
  'custom-ink': '#86B6F5',
  red: '#F0585B',
  'red-soft': '#3A1719',
  amber: '#F2B33D',
  'amber-soft': '#3A2B10',
  ok: '#5CCB92',
  'ok-soft': '#12291D',
  'code-bg': '#050506',
  shadow: '0 16px 40px rgba(0,0,0,.8),0 0 0 1px #24242A',
};

export type ThemeTokens = typeof dark;

/** Provider base colours are the same in both themes; only their `-ink` text colours change. */
const light: ThemeTokens = {
  ...dark,
  bg: '#F4F3F7',
  surface: '#FFFFFF',
  surface2: '#F3F2F7',
  surface3: '#E9E7F0',
  line: '#E2E0EA',
  line2: '#CDCAD8',
  fg: '#17151F',
  fg2: '#3A3647',
  muted: '#5E5A6B',
  accent: '#5B4BD6',
  'accent-fg': '#FFFFFF',
  'accent-soft': '#ECE9FC',
  query: '#0F7C92',
  'query-soft': '#E3F4F7',
  'claude-ink': '#B85A1E',
  'openai-ink': '#1C8250',
  'custom-ink': '#2B66C4',
  red: '#D93A3E',
  'red-soft': '#FCE8E8',
  amber: '#A86A00',
  'amber-soft': '#FCF1DA',
  ok: '#1C8250',
  'ok-soft': '#E3F4EA',
  'code-bg': '#F6F5FA',
  shadow: '0 16px 40px rgba(30,25,60,.14)',
};

export const themes = { dark, light } as const;
export type ThemeName = keyof typeof themes;

export const fonts = {
  ui: "'Nunito',ui-rounded,system-ui,-apple-system,'Segoe UI',sans-serif",
  mono: "'JetBrains Mono',ui-monospace,Menlo,monospace",
} as const;

export const radii = [6, 8, 10, 12, 14, 16, 18, 999] as const;

export const providers = {
  claude: { label: 'Claude', cssClass: 'p-claude', color: '#E8894A', dark: '#B5612A' },
  openai: { label: 'OpenAI', cssClass: 'p-openai', color: '#3FB97A', dark: '#24804F' },
  custom: { label: 'Custom', cssClass: 'p-custom', color: '#5B9BF0', dark: '#3468B8' },
} as const;
export type ProviderName = keyof typeof providers;

/** Each agent gets one of these, in order, so it can be told apart from others on the floor. */
export const identityHues = [
  '#FF6B9A',
  '#5CE1E6',
  '#FFB547',
  '#9D8CFF',
  '#4FB3FF',
  '#B5E35B',
  '#FF8A5B',
  '#E07BFF',
  '#3FD07F',
  '#FFD84D',
  '#7FA8FF',
  '#FF6F61',
  '#2DE1C2',
  '#F8A5C2',
] as const;

export const decisionColors = {
  goal: '#B794F6',
  think: '#7CCFE0',
  read_file: '#6EA8FF',
  edit_file: '#FF9F43',
  run_shell: '#F368E0',
  web_search: '#48DBFB',
  spawn_agent: '#1DD1A1',
  handoff: '#1DD1A1',
  approval: '#FF6B6B',
  instruction: '#C8B6FF',
  finish: '#2ECC71',
  start: '#2ECC71',
  ok: '#2ECC71',
  bad: '#FF4757',
  retry: '#FECA57',
  interrupt: '#FECA57',
  now: '#A99CFF',
} as const;
export type DecisionKind = keyof typeof decisionColors;

export const decisionFallbackColor = '#9AA0AE';

export const decisionLabels = {
  goal: 'Goal',
  think: 'Plan',
  read_file: 'Read',
  edit_file: 'Edit',
  run_shell: 'Shell',
  web_search: 'Browse',
  spawn_agent: 'Subagent',
  approval: 'Approval',
  instruction: 'Your instruction',
  ok: 'Success',
  bad: 'Failure',
  retry: 'Retry',
  now: 'Now',
} as const;

export const projectColors = [
  '#FF6B9A',
  '#48DBFB',
  '#FECA57',
  '#1DD1A1',
  '#B794F6',
  '#FF9F43',
] as const;

/** CSS custom property declarations, in token order. */
export function toCssVariables(tokens: Partial<ThemeTokens>): string[] {
  return Object.entries(tokens).map(([name, value]) => `--${name}:${value};`);
}

/** The tokens a theme changes compared with dark, which is the `:root` default. */
export function themeOverrides(name: ThemeName): Partial<ThemeTokens> {
  const entries = Object.entries(themes[name]).filter(
    ([key, value]) => value !== dark[key as keyof ThemeTokens],
  );
  return Object.fromEntries(entries);
}

const HEADER =
  '/* Generated from web/src/shared/tokens.ts by `pnpm tokens`. Do not edit by hand. */';

/** Keeps the prototype's three blocks: dark root, system light when unset, explicit light. */
export function renderTokensCss(): string {
  const indent = (lines: string[]) => lines.map((line) => `  ${line}`).join('\n');
  const root = [
    ...toCssVariables(dark),
    `--ui:${fonts.ui};`,
    `--mono:${fonts.mono};`,
    'color-scheme:dark;',
  ];
  const lightBody = indent([...toCssVariables(themeOverrides('light')), 'color-scheme:light;']);
  return [
    HEADER,
    `:root{\n${indent(root)}\n}`,
    `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){\n${lightBody}\n}}`,
    `:root[data-theme="light"]{\n${lightBody}\n}`,
    '',
  ].join('\n');
}
