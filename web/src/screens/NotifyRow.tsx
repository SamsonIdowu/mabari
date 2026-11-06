// SPDX-License-Identifier: Apache-2.0
import { useNotify } from '../office/notifications.ts';

/**
 * The switch for desktop notifications, in Settings. It is kept in this browser, because the
 * permission is the browser's. The browser is asked only when the switch is turned on, and if it
 * can't or won't, the switch stays off and says why beside it.
 */
export function NotifyRow() {
  const enabled = useNotify((state) => state.enabled);
  const problem = useNotify((state) => state.problem);
  return (
    <>
      <span className="flabel">Desktop notifications</span>
      <div className="field">
        <label className="switch">
          <input
            type="checkbox"
            id="pNotify"
            checked={enabled}
            aria-describedby="notifyHelp"
            onChange={(event) => {
              if (event.target.checked) void useNotify.getState().turnOn();
              else useNotify.getState().turnOff();
            }}
          />
          Notify me when an approval or error needs me
        </label>
        <span className="help" id="notifyHelp" role="status">
          {problem ||
            (enabled
              ? 'On in this browser. While this page is hidden, a notification names the agent and nothing else, and clicking it opens that agent. It has no buttons, so nothing can be approved from it. It also tells you when something you asked to be told about is done.'
              : 'Off. Turning it on asks your browser for permission. While this page is hidden, a notification names the agent and nothing else: never a command, a path or a task.')}
        </span>
      </div>
    </>
  );
}
