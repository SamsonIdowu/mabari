// SPDX-License-Identifier: Apache-2.0
import type { Snapshot } from '../gen/models.ts';

/**
 * Home's way to get started on a fresh install: the same control the Agents page shows when no
 * account is connected. Nothing shows once an account is connected, or while agents are here.
 */
export function ConnectPrompt({ office }: { office: Snapshot }) {
  const connected = office.accounts.some((account) => account.status !== 'off');
  if (connected || office.agents.length) return null;
  return (
    <p id="homeConnect">
      <a className="btn primary" href="#accounts">
        Connect an account
      </a>
    </p>
  );
}
