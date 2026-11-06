// SPDX-License-Identifier: Apache-2.0
// What only Mabari's own page can do: turn on auto approve, trust a folder, wipe, decide an
// approval. The server wants the page's Origin for these, which a browser sends by itself and
// Playwright's request context doesn't.
import type { APIRequestContext } from '@playwright/test';

export const fromPage = {
  Origin: `http://localhost:${process.env.MABARI_WEB_PORT ?? '4317'}`,
};

/** Wipes the test server, as the button in Settings does. */
export function wipe(request: APIRequestContext) {
  return request.post('/api/wipe', { data: { confirm: true }, headers: fromPage });
}
