// SPDX-License-Identifier: Apache-2.0
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  chatApi,
  useAsks,
  useSaved,
  type Attachment,
  type ChatCommand,
  type ChatFile,
  type Subject,
} from '../data/chatApi.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Project, Snapshot } from '../gen/models.ts';
import { useVoice } from '../office/voiceStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { Modal } from '../shell/Modal.tsx';
import { useEscape } from '../shell/useEscape.ts';
import {
  agentSuggestions,
  canSendNow,
  deliveryOf,
  loadDraft,
  mentionedIds,
  mentionFile,
  modelSwitch,
  planNote,
  recall,
  replaceTrigger,
  saveDraft,
  slashSuggestions,
  triggerAt,
  type Draft,
  type RecallState,
  type Suggestion,
  type Trigger,
} from './composerModel.ts';

export type ComposerTarget =
  { kind: 'agent'; agent: LiveAgent } | { kind: 'project'; project: Project; agents: LiveAgent[] };

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

interface Props {
  target: ComposerTarget;
  office: Snapshot;
  /** What was sent here before, oldest first, for the Up arrow. */
  history: string[];
}

interface Upload {
  /** The page's own number until the server has one. */
  local: string;
  name: string;
  size: number;
  status: 'sending' | 'ready' | 'failed';
  file?: Attachment;
  problem?: string;
}

const BOX_MAX_PX = 180;
const FILES_MAX = 8;
const SEARCH_DELAY_MS = 120;
const DRAFT_DELAY_MS = 250;

const toast = (text: string) => useOfficeStore.getState().toast(text);

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const subjectOf = (target: ComposerTarget): Subject =>
  target.kind === 'agent' ? { agent: target.agent.id } : { project: target.project.id };

/** Saved instructions, kept in one place so any message can be turned into one and used anywhere. */
function SavedDialog({ close, insert }: { close: () => void; insert: (text: string) => void }) {
  const items = useSaved((state) => state.items);
  const remove = useSaved((state) => state.remove);
  useEscape(close);
  return (
    <Modal>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="savedTitle">
        <h2 id="savedTitle">Saved instructions</h2>
        <p className="help">
          Keep a message you send often. Save one from any message you have sent, and type / in a
          message box to find it.
        </p>
        {items.length ? (
          <ul className="savedlist">
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <b>{item.name}</b>
                  <span className="help">{item.text.replace(/\s+/g, ' ').slice(0, 140)}</span>
                </div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      insert(item.text);
                      close();
                    }}
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Delete ${item.name}`}
                    onClick={() =>
                      void remove(item.id).catch((error: Error) => toast(error.message))
                    }
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="help">Nothing saved yet.</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The message box, for an agent's thread and a project's alike: one component, so what you can do
 * in one you can do in the other. Files go in by drop, paste or picker. "@" completes a file in
 * the folder, or pulls in another agent's latest reply. "/" lists the commands and skills there
 * and the instructions you saved. Up brings back what you sent. Whatever is typed is kept, per
 * thread, through a reload.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { target, office, history },
  handle,
) {
  const id = useId();
  const key = target.kind === 'agent' ? `agent:${target.agent.id}` : `project:${target.project.id}`;
  const agent = target.kind === 'agent' ? target.agent : null;
  const subject = useMemo(() => subjectOf(target), [target]);
  const name = target.kind === 'agent' ? target.agent.name : target.project.name;

  const [draft] = useState<Draft>(() => loadDraft(key));
  const [text, setText] = useState(draft.text);
  const [plan, setPlan] = useState(draft.plan);
  const [uploads, setUploads] = useState<Upload[]>(() =>
    draft.files.map((file) => ({
      local: file.id,
      name: file.name,
      size: file.size,
      status: 'ready' as const,
      file,
    })),
  );
  const [model, setModel] = useState('');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState(false);
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState({ key: '', index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [found, setFound] = useState<{ at: number; files: ChatFile[] }>({ at: -1, files: [] });
  const commands = useRef<ChatCommand[] | null>(null);
  const [commandList, setCommandList] = useState<ChatCommand[]>([]);
  const savedItems = useSaved((state) => state.items);
  const picked = useRef<{ id: string; name: string }[]>([]);
  const recalling = useRef<RecallState>({ cursor: null, draft: '' });
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const listening = useVoice((state) => state.phase === 'listen');

  const trigger: Trigger | null = useMemo(() => triggerAt(text, caret), [text, caret]);
  const marked = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;

  // The saved instructions are loaded once, for every box.
  useEffect(() => {
    if (!useSaved.getState().loaded)
      void useSaved
        .getState()
        .load()
        .catch(() => undefined);
  }, []);

  // What a "/" lists is read from the folder and the account the first time it is asked for.
  const wantCommands = trigger?.kind === 'slash';
  useEffect(() => {
    if (!wantCommands || commands.current) return;
    commands.current = [];
    void chatApi
      .commands(subject)
      .then((reply) => {
        commands.current = reply.commands;
        setCommandList(reply.commands);
      })
      .catch(() => {
        commands.current = null;
      });
  }, [wantCommands, subject]);

  // Files in the folder, as the word after an "@" gets longer.
  const wantFiles = trigger?.kind === 'at' ? trigger.query : null;
  const wantAt = trigger?.start ?? -1;
  useEffect(() => {
    if (wantFiles === null) return undefined;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      chatApi
        .files(subject, wantFiles.replace(/^"/, ''), stop.signal)
        .then((files) => setFound({ at: wantAt, files }))
        .catch(() => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [wantFiles, wantAt, subject]);
  // What was found for another word is not offered for this one.

  const suggestions: Suggestion[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'slash') return slashSuggestions(commandList, savedItems, trigger.query);
    const others = target.kind === 'agent' ? office.agents : target.agents;
    return [
      ...agentSuggestions(others, trigger.query, agent?.id ?? ''),
      ...(found.at === wantAt ? found.files : []).map((file): Suggestion => ({
        id: `file:${file.path}`,
        kind: file.dir ? 'dir' : 'file',
        label: file.path,
        detail: file.dir ? 'Folder' : 'File',
        insert: file.dir ? `@${file.path}` : `${mentionFile(file.path)} `,
      })),
    ];
  }, [trigger, commandList, savedItems, found, wantAt, target, office.agents, agent?.id]);
  const open = suggestions.length > 0 && marked !== dismissed;

  // The first suggestion is the one ready to choose, until the arrows or the mouse move it.
  const active =
    cursor.key === marked ? Math.min(cursor.index, Math.max(0, suggestions.length - 1)) : 0;
  const setActive = (move: number | ((now: number) => number)) =>
    setCursor({ key: marked ?? '', index: typeof move === 'function' ? move(active) : move });

  // The box grows with what is typed, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, BOX_MAX_PX)}px`;
  }, [text]);

  // A draft is kept as it is typed, and once more as the page goes.
  const latest = useRef<Draft>(draft);
  useEffect(() => {
    latest.current = {
      text,
      plan,
      files: uploads.flatMap((upload) => (upload.file ? [upload.file] : [])),
    };
  });
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(key, latest.current), DRAFT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, text, plan, uploads]);
  useEffect(() => {
    const flush = () => saveDraft(key, latest.current);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [key]);

  const addFiles = useCallback((added: File[]) => {
    const room = FILES_MAX - latest.current.files.length;
    if (!added.length) return;
    if (room <= 0) {
      toast(`Up to ${FILES_MAX} files go with a message.`);
      return;
    }
    for (const file of added.slice(0, room)) {
      if (file.size > chatApi.maxFileBytes) {
        toast(`${file.name} is over 25 MB, which is the most Mabari keeps.`);
        continue;
      }
      const local = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploads((now) => [...now, { local, name: file.name, size: file.size, status: 'sending' }]);
      chatApi
        .attach(file)
        .then((stored) =>
          setUploads((now) =>
            now.map((upload) =>
              upload.local === local ? { ...upload, status: 'ready', file: stored } : upload,
            ),
          ),
        )
        .catch((error: Error) =>
          setUploads((now) =>
            now.map((upload) =>
              upload.local === local
                ? { ...upload, status: 'failed', problem: error.message }
                : upload,
            ),
          ),
        );
    }
    if (added.length > room) toast(`Up to ${FILES_MAX} files go with a message.`);
  }, []);

  useImperativeHandle(handle, () => ({ addFiles, focus: () => box.current?.focus() }), [addFiles]);

  // Where the caret goes once the text that was just set is in the box. It is set before the browser
  // paints and before the next key is handled, so typing straight on lands after what was chosen.
  const pendingCaret = useRef<number | null>(null);
  const placeCaret = (at: number) => {
    pendingCaret.current = at;
    setCaret(at);
  };
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !box.current) return;
    pendingCaret.current = null;
    box.current.focus();
    box.current.setSelectionRange(at, at);
  });

  const choose = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = replaceTrigger(text, trigger, suggestion.insert);
    setText(next.text);
    if (suggestion.kind === 'agent') {
      const found = (target.kind === 'agent' ? office.agents : target.agents).find(
        (other) => `agent:${other.id}` === suggestion.id,
      );
      if (found)
        picked.current = [
          ...picked.current.filter((entry) => entry.id !== found.id),
          { id: found.id, name: found.name },
        ];
    }
    setDismissed(null);
    placeCaret(next.caret);
  };

  const waiting = uploads.some((upload) => upload.status === 'sending');
  const ready = uploads.flatMap((upload) => (upload.file ? [upload.file.id] : []));
  const switchable = agent ? modelSwitch(agent) : { can: false, reason: '' };
  const models = useMemo(() => {
    if (!agent) return [];
    const listed = office.accounts.find((account) => account.kind === agent.account)?.models ?? [];
    return listed.includes(agent.model) ? listed : [agent.model, ...listed];
  }, [agent, office.accounts]);
  const chosenModel = model || agent?.model || '';
  const delivery = agent ? deliveryOf(agent) : null;
  const everyone =
    target.kind === 'project'
      ? target.agents.filter((entry) => !entry.leadId && !entry.leaving && entry.state !== 'error')
      : [];

  const send = async (how: { now?: boolean; everyone?: boolean } = {}) => {
    const message = text.trim();
    if (!message || sending || waiting) return;
    setSending(true);
    try {
      const result = await chatApi.send({
        ...(agent
          ? { agentId: agent.id }
          : { projectId: target.kind === 'project' ? target.project.id : '' }),
        text: message,
        plan,
        ...(agent && switchable.can && chosenModel !== agent.model ? { model: chosenModel } : {}),
        ...(how.now ? { now: true } : {}),
        ...(how.everyone ? { everyone: true } : {}),
        attachments: ready,
        mentions: mentionedIds(text, picked.current),
      });
      if (result.ask) useAsks.getState().add(result.ask);
      // The thread shows where it went. A toast is only for what the thread can't: nobody took it.
      if (!result.agentId && !result.opened && !result.ask) toast(result.notice);
      setText('');
      setPlan(false);
      setUploads([]);
      setModel('');
      picked.current = [];
      recalling.current = { cursor: null, draft: '' };
      saveDraft(key, { text: '', plan: false, files: [] });
      box.current?.focus();
    } catch (error) {
      // What was typed stays, so nothing has to be written again.
      toast((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      const last = suggestions.length - 1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((now) =>
          event.key === 'ArrowDown' ? (now >= last ? 0 : now + 1) : now <= 0 ? last : now - 1,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = suggestions[active];
        if (chosen) choose(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(marked);
        return;
      }
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const moved = recall(history, recalling.current, event.key, text);
      if (moved) {
        event.preventDefault();
        recalling.current = moved.state;
        setText(moved.text);
        placeCaret(moved.text.length);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    recalling.current = { cursor: null, draft: '' };
    setText(event.target.value);
    setCaret(event.target.selectionStart);
    setDismissed(null);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (!pasted.length) return;
    event.preventDefault();
    // A pasted picture has no name of its own.
    addFiles(
      pasted.map((file) =>
        file.name && file.name !== 'image.png'
          ? file
          : new File([file], `pasted-${Date.now()}.${file.type.split('/')[1] ?? 'bin'}`, {
              type: file.type,
            }),
      ),
    );
  };

  const dragged = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const popId = `${id}-pop`;
  const optionId = (index: number) => `${id}-opt-${index}`;

  return (
    <form
      className={dragging ? 'composer dragging' : 'composer'}
      aria-label={`Message ${name}`}
      autoComplete="off"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (!dragged(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!dragged(event)) return;
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {uploads.length ? (
        <ul className="cfiles" aria-label="Files that go with this message">
          {uploads.map((upload) => (
            <li className={`cfile ${upload.status}`} key={upload.local}>
              <Icon>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Icon>
              <span className="cfname" title={upload.file?.path}>
                {upload.name}
              </span>
              <span className="help">
                {upload.status === 'sending'
                  ? 'Adding…'
                  : upload.status === 'failed'
                    ? upload.problem
                    : sizeText(upload.size)}
              </span>
              <button
                type="button"
                className="linkbtn"
                aria-label={`Remove ${upload.name}`}
                onClick={() =>
                  setUploads((now) => now.filter((entry) => entry.local !== upload.local))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cbox">
        {open ? (
          <ul className="cpop" id={popId} role="listbox" aria-label="Suggestions">
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'on' : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(suggestion);
                }}
                onMouseMove={() => setActive(index)}
              >
                <span className="clabel mono">{suggestion.label}</span>
                <span className="cdetail">{suggestion.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="sr" htmlFor={`${id}-text`}>
          Message {name}
        </label>
        <textarea
          id={`${id}-text`}
          ref={box}
          rows={1}
          value={text}
          placeholder={agent ? `Tell ${agent.name} what to do` : `Tell ${name} what to do`}
          aria-autocomplete="list"
          aria-controls={open ? popId : undefined}
          aria-activedescendant={open ? optionId(active) : undefined}
          onChange={onChange}
          onKeyDown={onKey}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onPaste={onPaste}
        />
        <span className="sr" role="status">
          {open
            ? `${suggestions.length} ${suggestions.length === 1 ? 'suggestion' : 'suggestions'}. Up and down to move, Enter to choose, Escape to close.`
            : ''}
        </span>
      </div>
      <div className="cbar">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-label="Choose files to attach"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <button type="button" className="btn ghost sm" onClick={() => picker.current?.click()}>
          <Icon>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </Icon>
          Attach
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setSaved(true)}>
          Saved
        </button>
        <button
          type="button"
          className={plan ? 'btn sm on' : 'btn ghost sm'}
          aria-pressed={plan}
          title={planNote(agent)}
          onClick={() => setPlan((now) => !now)}
        >
          Plan first
        </button>
        {agent ? (
          <>
            <label className="sr" htmlFor={`${id}-model`}>
              Model for this message
            </label>
            <select
              id={`${id}-model`}
              className="in csel"
              value={chosenModel}
              disabled={!switchable.can}
              title={switchable.can ? 'Switches the model with this message' : switchable.reason}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <span className="cspace" />
        <button
          type="button"
          className={listening ? 'mic live' : 'mic'}
          aria-label="Hold to talk"
          onPointerDown={(event) => {
            event.preventDefault();
            useVoice.getState().start(office, (heard) => {
              setText((now) => (now ? `${now} ${heard}` : heard));
              box.current?.focus();
            });
          }}
        >
          <Icon>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </Icon>
        </button>
        {agent && canSendNow(agent) ? (
          <button
            type="button"
            className="btn sm"
            disabled={!text.trim() || sending || waiting}
            title={`Interrupts what ${agent.name} is doing, then sends this at once`}
            onClick={() => void send({ now: true })}
          >
            Interrupt and send now
          </button>
        ) : null}
        {target.kind === 'project' ? (
          <button
            type="button"
            className="btn sm"
            disabled={!text.trim() || sending || waiting || !everyone.length}
            title={
              everyone.length
                ? `Sends this to all ${everyone.length} agents on ${name} and shows their replies side by side`
                : `Nobody works on ${name} yet`
            }
            onClick={() => void send({ everyone: true })}
          >
            Ask everyone{everyone.length ? ` (${everyone.length})` : ''}
          </button>
        ) : null}
        <button
          type="submit"
          className="btn primary sm"
          disabled={!text.trim() || sending || waiting}
          data-testid="chatSend"
        >
          {delivery?.button ?? 'Send'}
        </button>
      </div>
      <p className="help cnote" data-testid="deliveryNote">
        {delivery
          ? delivery.note
          : `Mabari sends it to whoever on ${name} can take it, and says who answered.`}{' '}
        {plan
          ? planNote(agent)
          : 'Enter sends. Type @ for a file or another agent, / for a command.'}
        {waiting ? ' Waiting for files to finish adding.' : ''}
      </p>
      {saved ? (
        <SavedDialog
          close={() => setSaved(false)}
          insert={(saved) => {
            setText((now) => (now ? `${now}\n${saved}` : saved));
            requestAnimationFrame(() => box.current?.focus());
          }}
        />
      ) : null}
    </form>
  );
});
