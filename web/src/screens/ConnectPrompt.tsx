// SPDX-License-Identifier: Apache-2.0
import { agentsCanRun } from '../data/accountInfo.ts';
import type { Snapshot } from '../gen/models.ts';

/**
 * Home's way to get started on a fresh install: the same control the Agents page shows when no
 * account that can run agents is connected, so a saved API key alone, which can't run them, still
 * shows it (RT-4). Nothing shows once such an account is connected, or while agents are here.
 */
export function ConnectPrompt({ office }: { office: Snapshot }) {
  if (agentsCanRun(office.accounts) || office.agents.length) return null;
  return (
    <p id="homeConnect">
      <a className="btn primary" href="#accounts">
        Connect an account
      </a>
    </p>
  );
}
