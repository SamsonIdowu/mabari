// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Account, AccountKind } from '../gen/models.ts';
import {
  ACCOUNT_LABEL,
  DEFAULTS_KEY,
  chooseableModels,
  connectedModels,
  defaultModel,
  modelOptions,
} from './accountInfo.ts';

const account = (kind: AccountKind, status: Account['status'], models: string[]) =>
  ({ id: kind, kind, status, models }) as Account;

describe('the default model for an account', () => {
  const settings = {
    defaults: {
      claude: 'claude-haiku-4-5',
      codex: 'gpt-5',
      anthropic: 'claude-sonnet-5-5',
      openai: 'gpt-5-mini',
    },
  };

  it('is found by the settings key, which is not the account kind', () => {
    // The dialog once looked up `defaults['claude_code']`, which isn't a key, and fell back to the
    // first, most expensive model.
    expect(defaultModel(settings, 'claude_code')).toBe('claude-haiku-4-5');
    expect(defaultModel(settings, 'anthropic_key')).toBe('claude-sonnet-5-5');
    expect(defaultModel(settings, 'openai_key')).toBe('gpt-5-mini');
    expect(defaultModel(settings, 'codex')).toBe('gpt-5');
  });

  it('is empty for an account with no default, and for none', () => {
    expect(defaultModel(settings, 'hub')).toBe('');
    expect(defaultModel(settings, '')).toBe('');
  });

  it('has a settings key and a name for every account that runs a model', () => {
    for (const kind of ['claude_code', 'codex', 'anthropic_key', 'openai_key'] as const) {
      expect(DEFAULTS_KEY[kind]).toBeTruthy();
      expect(ACCOUNT_LABEL[kind]).toBeTruthy();
    }
  });
});

describe('models that can be chosen', () => {
  it('leaves out the hub, whose entry stands for whatever an app reports', () => {
    expect(chooseableModels(account('hub', 'connected', ['any model your app reports']))).toEqual(
      [],
    );
    expect(
      connectedModels({
        accounts: [
          account('hub', 'connected', ['any model your app reports']),
          account('claude_code', 'connected', ['claude-haiku-4-5']),
          account('codex', 'off', ['gpt-5']),
        ],
      }),
    ).toEqual(['claude-haiku-4-5']);
  });

  it('lists each model once', () => {
    expect(
      connectedModels({
        accounts: [
          account('codex', 'connected', ['gpt-5', 'gpt-5-mini']),
          account('openai_key', 'connected', ['gpt-5', 'gpt-4.1']),
        ],
      }),
    ).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-4.1']);
  });
});

describe('the options of a model select', () => {
  it('always include the stored value, so the select shows what is in use', () => {
    // Stored gpt-5-mini with only Claude Code connected used to show claude-opus-4-1.
    const options = modelOptions(['claude-opus-4-1', 'claude-haiku-4-5'], 'gpt-5-mini');
    expect(options[0]).toEqual({
      value: 'gpt-5-mini',
      label: "gpt-5-mini (its account isn't connected)",
    });
    expect(options.map((option) => option.value)).toContain('claude-opus-4-1');
  });

  it('list a stored value that is on offer once, as itself', () => {
    expect(modelOptions(['a', 'b'], 'b')).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ]);
  });

  it('are empty, and add nothing, with nothing stored and nothing offered', () => {
    expect(modelOptions([], '')).toEqual([]);
  });
});
