// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { renderTokensCss } from '../src/shared/tokens.ts';
import { tokensCssPath } from './gen-tokens-css.ts';

it('tokens.css is up to date with tokens.ts (run `pnpm tokens` if this fails)', () => {
  expect(readFileSync(tokensCssPath, 'utf8')).toBe(renderTokensCss());
});
