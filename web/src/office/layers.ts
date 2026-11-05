// SPDX-License-Identifier: Apache-2.0
// Noise filters for the office: what to show on and around the agents. Quiet mode hides
// everything but what needs you. Choices are remembered in this browser only.
import { create } from 'zustand';

export type Layer = 'bub' | 'meta' | 'msg' | 'link' | 'tags';

export const LAYERS: [layer: Layer, label: string, icon: string][] = [
  ['bub', 'Speech bubbles', 'M4 5h16v11H9l-5 4z'],
  ['meta', 'Model and time left on name tags', 'M3 12l9-9h8v8l-9 9zM15.5 8.5h.01'],
  ['msg', 'Messages between agents', 'M3 6h18v12H3zM3 6l9 7 9-7'],
  [
    'link',
    'Connections between agents',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8.2 16.1C11 14 13 11 15.8 7.9',
  ],
  ['tags', 'Name tags', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0'],
];

const KEY = 'mabari.layers';

export type Layers = Record<Layer, boolean>;

const ALL_ON: Layers = { bub: true, meta: true, msg: true, link: true, tags: true };

function load(): Layers {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Layers> | null;
    // A choice saved before the connections layer existed keeps quiet mode quiet.
    if (saved && !('link' in saved)) {
      saved.link = !(
        saved.bub === false &&
        saved.meta === false &&
        saved.msg === false &&
        saved.tags === false
      );
    }
    return { ...ALL_ON, ...(saved ?? {}) };
  } catch {
    return { ...ALL_ON };
  }
}

function save(layers: Layers) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layers));
  } catch {
    // Private windows can refuse storage. The choice still holds until the page reloads.
  }
}

export const isQuiet = (layers: Layers) => LAYERS.every(([layer]) => !layers[layer]);

/** The classes that hide each layer that is off, for the overlay that holds tags and bubbles. */
export function hiddenClasses(layers: Layers): string {
  return LAYERS.filter(([layer]) => !layers[layer])
    .map(([layer]) => `hide-${layer}`)
    .join(' ');
}

interface LayerStore {
  layers: Layers;
  toggle: (layer: Layer) => void;
  /** Quiet mode on hides every layer; off shows them all again. */
  quiet: () => void;
}

export const useLayers = create<LayerStore>((set, get) => ({
  layers: typeof localStorage === 'undefined' ? { ...ALL_ON } : load(),
  toggle: (layer) => {
    const layers = { ...get().layers, [layer]: !get().layers[layer] };
    save(layers);
    set({ layers });
  },
  quiet: () => {
    const on = isQuiet(get().layers);
    const layers = Object.fromEntries(LAYERS.map(([layer]) => [layer, on])) as Layers;
    save(layers);
    set({ layers });
  },
}));
