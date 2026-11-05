// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Project } from '../gen/models.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';

const COLOURS = [
  '#FF6B9A',
  '#48DBFB',
  '#FFB547',
  '#3FD07F',
  '#FF8A5B',
  '#2DE1C2',
  '#B892FF',
  '#B5E35B',
];

/**
 * Edit a project: its name, colour, instructions and the folder on this computer it works in.
 * Attaching a folder brings in the sessions already working there and the agents it keeps in
 * .claude/agents and .codex/agents.
 */
export function ProjectDialog({ project, close }: { project: Project; close: () => void }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [instructions, setInstructions] = useState(project.instructions);
  const [folder, setFolder] = useState(project.repository?.path ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(close);
  const browse = () =>
    api
      .pickFolder()
      .then(({ path }) => setFolder(path))
      .catch((failure: Error) => setError(failure.message));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const patch: { name: string; color: string; instructions: string; folder?: string } = {
        name: name.trim(),
        color,
        instructions,
      };
      if (folder.trim() && folder.trim() !== (project.repository?.path ?? '')) {
        patch.folder = folder.trim();
      }
      await api.updateProject(project.id, patch);
      useOfficeStore.getState().toast(`${name.trim()} is saved`);
      close();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="scrim">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pjTitle"
        autoComplete="off"
        onSubmit={(event) => void submit(event)}
      >
        <div className="dhd">
          <div>
            <h2 id="pjTitle" style={{ fontSize: 20 }}>
              Edit {project.name}
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              Attach the folder or repository the project works in, so Claude Code opens there and
              its agents load.
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div className="field">
          <label htmlFor="pjName">Name</label>
          <input
            className="in"
            id="pjName"
            maxLength={28}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pjFolder">Folder</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="in mono"
              id="pjFolder"
              placeholder="~/code/shop"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
          <span className="help">A folder on this computer. It must already exist.</span>
        </div>
        <div className="field">
          <label htmlFor="pjInstr">Instructions</label>
          <textarea
            className="in"
            id="pjInstr"
            rows={4}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </div>
        <div className="field">
          <span className="flabel">Colour</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {COLOURS.map((colour) => (
              <button
                type="button"
                key={colour}
                className={color === colour ? 'swatch on' : 'swatch'}
                style={{ ['--sw' as string]: colour }}
                aria-label={`Colour ${colour}`}
                aria-pressed={color === colour}
                onClick={() => setColor(colour)}
              />
            ))}
          </div>
        </div>
        {error ? (
          <p className="help" role="alert" style={{ color: 'var(--red)', fontWeight: 700 }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving || !name.trim()}>
            Save project
          </button>
        </div>
      </form>
    </div>
  );
}
