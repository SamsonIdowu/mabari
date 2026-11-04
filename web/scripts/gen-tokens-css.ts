// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/shared/tokens.ts';

export const tokensCssPath = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(tokensCssPath, renderTokensCss());
  console.log(`Wrote ${tokensCssPath}`);
}
