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
  fg: '#EDEDEE',
  fg2: '#C4C4C7',
  muted: '#9A9A9F',
  accent: '#FFFFFF',
  'accent-fg': '#000000',
  'accent-soft': '#232326',
  query: '#7CCFE0',
  'query-soft': '#14272C',
  claude: '#E8894A',
  openai: '#3FB97A',
  custom: '#5B9BF0',
  'claude-ink': '#F0A26F',
  'openai-ink': '#5CCB92',
  'custom-ink': '#86B6F5',
  red: '#F0585B',
  // Decision 36 again, for the dark theme: `red` is light enough to read as text on black, but
  // white on it measures 3.36:1, under AA for 9 to 11 px badges. Anything filled red with white
  // text uses this, the same red the light theme's `red` already is (white on it: 5.4:1).
  'red-fill': '#C33437',
  'red-soft': '#3A1719',
  amber: '#F2B33D',
  'amber-fg': '#1C1300',
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
  bg: '#EDEDEE',
  surface: '#FFFFFF',
  surface2: '#F5F5F6',
  surface3: '#E6E6E8',
  line: '#DEDEE0',
  line2: '#BCBCBC',
  fg: '#0C0C0C',
  fg2: '#3A3A3C',
  muted: '#646468',
  accent: '#0C0C0C',
  'accent-fg': '#FFFFFF',
  'accent-soft': '#E4E4E6',
  query: '#0E7489',
  'query-soft': '#E3F4F7',
  'claude-ink': '#B85A1E',
  'openai-ink': '#1A784A',
  'custom-ink': '#2B66C4',
  red: '#C33437',
  'red-soft': '#FCE8E8',
  amber: '#955E00',
  'amber-fg': '#FFFFFF',
  'amber-soft': '#FCF1DA',
  ok: '#1A784A',
  'ok-soft': '#E3F4EA',
  'code-bg': '#F5F5F6',
  shadow: '0 12px 32px rgba(0,0,0,.08)',
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
  '#FFB8A0',
  '#4FB3FF',
  '#B5E35B',
  '#FF8A5B',
  '#FF8FCF',
  '#3FD07F',
  '#FFD84D',
  '#7FA8FF',
  '#FF6F61',
  '#2DE1C2',
  '#F8A5C2',
] as const;

export const decisionColors = {
  goal: '#4FB3FF',
  think: '#7CCFE0',
  read_file: '#6EA8FF',
  edit_file: '#FF9F43',
  run_shell: '#FF6FA8',
  web_search: '#48DBFB',
  spawn_agent: '#1DD1A1',
  handoff: '#1DD1A1',
  approval: '#FF6B6B',
  instruction: '#BDBDC2',
  finish: '#2ECC71',
  start: '#2ECC71',
  ok: '#2ECC71',
  bad: '#FF4757',
  retry: '#FECA57',
  interrupt: '#FECA57',
  now: '#8E8E93',
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
  '#4FB3FF',
  '#FF9F43',
] as const;

/**
 * The motion language, the same in both themes. Things arriving ease out, fast and then settling;
 * things leaving ease in. `fast` is for hover and press, `dur` for everything that comes and goes:
 * a change of screen, panels, dialogs, toasts and cards. All of it is short, and none of it moves
 * layout: only opacity and a few pixels of travel. Reduced motion switches every animation and
 * transition off.
 */
export const motion = {
  ease: 'cubic-bezier(.2,.7,.2,1)',
  'ease-in': 'cubic-bezier(.4,0,1,1)',
  'dur-fast': '120ms',
  dur: '200ms',
} as const;

/** CSS custom property declarations, in token order. */
export function toCssVariables(tokens: Partial<Record<string, string>>): string[] {
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
    ...toCssVariables(motion),
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
