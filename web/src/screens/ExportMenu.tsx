// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { downloadActivity, type ActivityFilters, type ExportFormat } from '../data/catchUp.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import '../styles/catchup.css';

/**
 * Export on the Activity page: the log as CSV or JSON, narrowed by the filters the page has now.
 * The file is made by the server, which hides secrets, and downloaded here with the session.
 */
export function ExportMenu({ filters }: { filters: ActivityFilters }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes the list and gives focus back to where it began.
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const name = await downloadActivity(format, filters);
      useOfficeStore.getState().toast(`Saved ${name}`);
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      useOfficeStore.getState().toast((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="exportwrap" ref={wrap}>
      <button
        type="button"
        className="btn"
        ref={trigger}
        aria-expanded={open}
        aria-controls="exportList"
        onClick={() => setOpen(!open)}
      >
        Export
      </button>
      {open ? (
        <div className="exportmenu" id="exportList" role="group" aria-label="Export the log">
          <button
            type="button"
            className="btn sm"
            ref={first}
            disabled={busy !== null}
            onClick={() => void run('csv')}
          >
            Download CSV
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null}
            onClick={() => void run('json')}
          >
            Download JSON
          </button>
          <p className="help">Just what the filters show now. Secrets are hidden.</p>
        </div>
      ) : null}
    </div>
  );
}
