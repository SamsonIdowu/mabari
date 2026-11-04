import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '@mabari/shared/tokens';

export const tokensCssPath = fileURLToPath(
  new URL('../apps/web/src/styles/tokens.css', import.meta.url),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(tokensCssPath, renderTokensCss());
  console.log(`Wrote ${tokensCssPath}`);
}
