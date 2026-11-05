// SPDX-License-Identifier: Apache-2.0
import type { Account, AccountKind, Settings, Snapshot } from '../gen/models.ts';

/**
 * The key each account kind has in `Settings.defaults`. The kinds and the keys differ
 * (`claude_code` and `claude`), so every page asks here, never by the kind itself. Mirrors
 * `models.DefaultsKey` in Go.
 */
export const DEFAULTS_KEY: Partial<Record<AccountKind, string>> = {
  claude_code: 'claude',
  codex: 'codex',
  anthropic_key: 'anthropic',
  openai_key: 'openai',
};

/** How the pages name each account. Mirrors `models.AccountLabel` in Go. */
export const ACCOUNT_LABEL: Partial<Record<AccountKind, string>> = {
  claude_code: 'Claude Code',
  codex: 'ChatGPT (Codex)',
  anthropic_key: 'Anthropic API key',
  openai_key: 'OpenAI API key',
};

/** The model new agents on this account use unless one is picked, from Settings, or undefined. */
export function defaultModel(settings: Pick<Settings, 'defaults'>, kind: AccountKind | ''): string {
  const key = kind ? DEFAULTS_KEY[kind] : undefined;
  return (key && settings.defaults[key]) || '';
}

/**
 * The models an account really gives. The hub's one entry is a placeholder for whatever an app
 * reports, so it is never a model someone can choose.
 */
export function chooseableModels(account: Pick<Account, 'kind' | 'models'>): string[] {
  return account.kind === 'hub' ? [] : account.models;
}

/** Every model the connected accounts give, once each, for the Settings select. */
export function connectedModels(office: Pick<Snapshot, 'accounts'>): string[] {
  const models = office.accounts
    .filter((account) => account.status === 'connected')
    .flatMap(chooseableModels);
  return [...new Set(models)];
}

/**
 * The options for a model select: the models on offer, and the stored value too when it isn't one
 * of them. A select must show the value that is stored, never another one, so a stored model that
 * isn't on offer is listed and says why, in `why`.
 */
export function modelOptions(
  offered: string[],
  stored: string,
  why = "its account isn't connected",
): { value: string; label: string }[] {
  const options = offered.map((value) => ({ value, label: value }));
  if (stored && !offered.includes(stored)) {
    options.unshift({ value: stored, label: `${stored} (${why})` });
  }
  return options;
}

const isKey = (account: Pick<Account, 'kind'>) =>
  account.kind === 'anthropic_key' || account.kind === 'openai_key';

/**
 * Whether an account that can run agents is on: any account that is not off, other than an API key,
 * which can't run agents yet (decision 6 of the first UX round). Saving only a key leaves this
 * false, so the pages say what to connect instead of treating the office as ready.
 */
export function agentsCanRun(accounts: Pick<Account, 'kind' | 'status'>[]): boolean {
  return accounts.some((account) => account.status !== 'off' && !isKey(account));
}

/** Whether something is saved, but only API keys, which can't run agents. */
export function onlyApiKeys(accounts: Pick<Account, 'kind' | 'status'>[]): boolean {
  const live = accounts.filter((account) => account.status !== 'off');
  return live.length > 0 && live.every(isKey);
}
