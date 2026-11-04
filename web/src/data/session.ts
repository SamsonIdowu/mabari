// SPDX-License-Identifier: Apache-2.0

// The session from signing in with the access key. It lives in this origin's localStorage and
// goes out as a Bearer token, not a cookie, because browsers send cookies to every port on a
// host, where another local server could collect it.
const KEY = 'mabari.session';

export function sessionToken(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function keepSession(token: string): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the page signs in again after a reload.
  }
}

/** Headers that carry the session, if there is one. */
export function sessionHeaders(): Record<string, string> {
  const token = sessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** WebSocket protocols: "mabari", and the session, since a browser can't send headers there. */
export function socketProtocols(): string[] {
  const token = sessionToken();
  return token ? ['mabari', `mabari.session.${token}`] : ['mabari'];
}
