// SPDX-License-Identifier: Apache-2.0
import { playSample, useOfficeSound } from '../office/officeSound.ts';

/**
 * The sound of the office, off until you turn it on: a soft room tone with the tap of keys that
 * rises with how many agents are working, and silence when none are. The choice and the volume
 * are kept in this browser, because they are about the speakers it plays through.
 */
export function OfficeSoundCard() {
  const on = useOfficeSound((state) => state.on);
  const volume = useOfficeSound((state) => state.volume);
  const percent = Math.round(volume * 100);
  return (
    <div className="card" id="officeSound">
      <h2>Office sound</h2>
      <div className="kv">
        <span className="flabel">Room sound</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={on}
              onChange={(event) => useOfficeSound.getState().setOn(event.target.checked)}
            />
            Play the sound of the office
          </label>
          <span className="help">
            A soft room tone with the tap of keys, made on this device, no sound files. It gets
            fuller as more agents work, and with none working it is silent. It also plays a chime
            when a project ships. Kept in this browser.
          </span>
        </div>
        <span className="flabel" id="officeSoundVolumeLabel">
          Volume
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            type="range"
            className="volume"
            min={0}
            max={100}
            step={1}
            value={percent}
            disabled={!on}
            aria-labelledby="officeSoundVolumeLabel"
            aria-valuetext={`${percent} percent`}
            onChange={(event) =>
              useOfficeSound.getState().setVolume(Number(event.target.value) / 100)
            }
          />
          <span className="num help" aria-hidden="true" style={{ minWidth: 36 }}>
            {percent}%
          </span>
          <button type="button" className="btn sm" disabled={!on} onClick={playSample}>
            Hear it
          </button>
        </div>
      </div>
    </div>
  );
}
