// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  decisionColors,
  identityHues,
  projectColors,
  providers,
  renderTokensCss,
  themeOverrides,
  themes,
  toCssVariables,
} from './tokens.ts';

describe('tokens', () => {
  it('matches spot values from the prototype', () => {
    expect(themes.dark.bg).toBe('#000000');
    expect(themes.dark.accent).toBe('#FFFFFF');
    expect(themes.light.bg).toBe('#EDEDEE');
    expect(themes.light.accent).toBe('#0C0C0C');
    expect(providers.claude.color).toBe('#E8894A');
    expect(decisionColors.run_shell).toBe('#FF6FA8');
    expect(identityHues).toHaveLength(14);
    expect(projectColors).toHaveLength(6);
  });

  it('shares provider base colours between themes but not their inks', () => {
    expect(themes.light.claude).toBe(themes.dark.claude);
    expect(themes.light.openai).toBe(themes.dark.openai);
    expect(themes.light.custom).toBe(themes.dark.custom);
    expect(themes.light['claude-ink']).not.toBe(themes.dark['claude-ink']);
  });

  it('gives both themes the same set of tokens', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });
});

describe('toCssVariables', () => {
  it('writes custom property declarations', () => {
    expect(toCssVariables({ bg: '#000', 'accent-fg': '#fff' })).toEqual([
      '--bg:#000;',
      '--accent-fg:#fff;',
    ]);
  });
});

describe('themeOverrides', () => {
  it('has nothing to override for dark', () => {
    expect(themeOverrides('dark')).toEqual({});
  });

  it('leaves shared provider colours out of light', () => {
    const light = themeOverrides('light');
    expect(light).not.toHaveProperty('claude');
    expect(light).toHaveProperty('claude-ink', '#B85A1E');
  });
});

describe('renderTokensCss', () => {
  const css = renderTokensCss();

  it('keeps the three theme blocks from the prototype', () => {
    expect(css).toContain(':root{');
    expect(css).toContain('@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){');
    expect(css).toContain(':root[data-theme="light"]{');
  });

  it('sets the colour scheme for each theme', () => {
    expect(css).toContain('color-scheme:dark;');
    expect(css).toContain('color-scheme:light;');
  });
});
