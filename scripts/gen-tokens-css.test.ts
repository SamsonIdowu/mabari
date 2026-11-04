import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { renderTokensCss } from '@mabari/shared/tokens';
import { tokensCssPath } from './gen-tokens-css.ts';

it('tokens.css is up to date with tokens.ts (run `pnpm tokens` if this fails)', () => {
  expect(readFileSync(tokensCssPath, 'utf8')).toBe(renderTokensCss());
});
