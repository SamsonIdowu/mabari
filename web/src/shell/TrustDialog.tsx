// SPDX-License-Identifier: Apache-2.0
import { useTrust } from '../data/trust.ts';
import { Modal } from './Modal.tsx';

/** Asks whether a folder can run what it brings, as Claude Code does in a terminal. */
export function TrustDialog() {
  const asking = useTrust((state) => state.asking);
  const answer = useTrust((state) => state.answer);
  if (!asking) return null;
  return (
    <Modal>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="trustTitle">
        <h2 id="trustTitle">Do you trust this folder?</h2>
        <p className="help">
          <span className="mono">{asking.folder}</span> has its own Claude Code settings. Anything
          in them runs on this computer as soon as a session starts here, and a hook in them could
          approve actions without asking you. Only go on if you know where this folder came from.
        </p>
        <ul data-testid="trustFound">
          {asking.found.map((path) => (
            <li className="mono" key={path}>
              {path}
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => answer(false)}>
            Don&apos;t start
          </button>
          <button type="button" className="btn primary" onClick={() => answer(true)}>
            Trust this folder and start
          </button>
        </div>
      </div>
    </Modal>
  );
}
