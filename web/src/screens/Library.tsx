// SPDX-License-Identifier: Apache-2.0
import sheet from './library.html?raw';
import { useLibrary, type LibraryTab } from '../office/libraryStore.ts';
import { StatusGrid } from './StatusScreens.tsx';

const TABS: [LibraryTab, string][] = [
  ['states', 'Status screens'],
  ['components', 'Components'],
];

/**
 * The Library: what people see when something is missing or wrong, and every component in the
 * app as identical tiles. Status screens is the first tab and opens by default.
 */
export function Library() {
  const tab = useLibrary((state) => state.tab);
  const set = useLibrary((state) => state.set);
  return (
    <section data-screen="components">
      <div className="page">
        <div className="phead">
          <div>
            <h1>Library</h1>
            <p id="libSub">
              The building blocks of Mabari, and what people see when something is missing or wrong.
            </p>
          </div>
          <div className="seg" role="tablist" aria-label="Library" id="libTabs">
            {TABS.map(([id, label]) => (
              <button
                type="button"
                role="tab"
                key={id}
                id={`libtab-${id}`}
                aria-controls={id === 'states' ? 'statesPane' : 'compPage'}
                className={tab === id ? 'on' : ''}
                aria-selected={tab === id}
                onClick={() => set(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'states' ? (
          <div id="statesPane" role="tabpanel" aria-labelledby="libtab-states">
            <StatusGrid />
          </div>
        ) : (
          <div
            id="compPage"
            role="tabpanel"
            aria-labelledby="libtab-components"
            dangerouslySetInnerHTML={{ __html: sheet }}
          />
        )}
      </div>
    </section>
  );
}
