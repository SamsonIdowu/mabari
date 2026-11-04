// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, SIGN_IN_EVENT } from '../data/api.ts';

/**
 * Shows the sign in instead of the app when Mabari asks for the access key: from another device,
 * through Docker, or on a shared computer where Settings asks for it here too.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  useEffect(() => {
    const recheck = () => void queryClient.invalidateQueries({ queryKey: ['session'] });
    window.addEventListener(SIGN_IN_EVENT, recheck);
    return () => window.removeEventListener(SIGN_IN_EVENT, recheck);
  }, [queryClient]);
  if (session.data?.needed) return <SignIn />;
  return <>{children}</>;
}

function SignIn() {
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    api
      .signIn(key)
      // A full reload starts the office afresh, with the new session cookie.
      .then(() => window.location.reload())
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setBusy(false));
  };
  return (
    <section data-screen="signin" className="signin">
      <form className="card" onSubmit={submit} aria-labelledby="signinTitle">
        <h1 id="signinTitle">Sign in to Mabari</h1>
        <p className="help" style={{ display: 'block' }}>
          Enter the access key. On the computer running Mabari, find it in Settings, or run{' '}
          <code>mabari access-key</code>.
        </p>
        <label className="flabel" htmlFor="accessKey">
          Access key
        </label>
        <input
          id="accessKey"
          className="in mono"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        {problem ? (
          <span role="alert" style={{ color: 'var(--red)' }}>
            {problem}
          </span>
        ) : null}
        <button type="submit" className="btn primary" disabled={!key.trim() || busy}>
          Sign in
        </button>
      </form>
    </section>
  );
}
