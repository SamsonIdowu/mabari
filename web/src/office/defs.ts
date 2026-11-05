// SPDX-License-Identifier: Apache-2.0
// The agent builder's rules, from design/mabari-prototype.html: how an agent file reads, how
// Mabari drafts a new agent from a request, and how it suggests improvements to one. The server
// writes the files; this only fills in the form for the person to check and save.
import type { AgentDef, LiveAgent } from '../gen/models.ts';

export const DEF_TOOLS: [tool: string, label: string][] = [
  ['Read', 'Read files'],
  ['Grep', 'Search code'],
  ['Glob', 'Find files'],
  ['Edit', 'Edit files'],
  ['Write', 'Create files'],
  ['Bash', 'Run commands'],
  ['WebSearch', 'Search the web'],
  ['WebFetch', 'Read web pages'],
  ['Task', 'Start subagents'],
];

export const DEF_MODELS: [model: string, label: string][] = [
  ['inherit', 'Same as the session'],
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
  ['haiku', 'Haiku'],
];

/** Codex models an agent file may name. "inherit" uses the session's model. */
export const DEF_CODEX_MODELS: [model: string, label: string][] = [
  ['inherit', 'Same as the session'],
  ['gpt-5-codex', 'gpt-5-codex'],
  ['gpt-5', 'gpt-5'],
  ['gpt-5-mini', 'gpt-5-mini'],
];

export const DEF_COLORS = [
  '#FF6B9A',
  '#4FB3FF',
  '#FFB547',
  '#3FD07F',
  '#FF8A5B',
  '#2DE1C2',
  '#FF8FCF',
  '#B5E35B',
];

const COLOUR_NAMES: Record<string, string> = {
  '#FF6B9A': 'pink',
  '#4FB3FF': 'blue',
  '#FFB547': 'orange',
  '#3FD07F': 'green',
  '#FF8A5B': 'red',
  '#2DE1C2': 'cyan',
  '#FF8FCF': 'purple',
  '#B5E35B': 'yellow',
};

export const MABARI_SKILLS = [
  {
    name: 'agent-creator',
    title: 'Create agents',
    desc: 'Drafts a new agent from a plain request: name, when to use it, tools, model and instructions. Shows you the file and saves it only after you say yes.',
  },
  {
    name: 'agent-improver',
    title: 'Improve agents',
    desc: "Reviews an agent's runs, retries, errors and approvals, then suggests clearer instructions and the right tools. Shows the changes and saves only after you say yes.",
  },
];

export const MABARI_ID = 'account:mabari';

export function slug(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function defTitle(def: Pick<AgentDef, 'name'>): string {
  return (def.name || 'agent')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function modelLabel(model: string): string {
  return (
    DEF_MODELS.find(([value]) => value === model)?.[1] ??
    DEF_CODEX_MODELS.find(([value]) => value === model)?.[1] ??
    model
  );
}

export const isCodex = (def: Pick<AgentDef, 'kind'>) => def.kind === 'codex';

/** Where the agent's file goes: the Claude or Codex folder, for the account or a project. */
export function defFolderLabel(def: Pick<AgentDef, 'kind' | 'scope'>): string {
  const ai = isCodex(def) ? 'Codex' : 'Claude';
  return def.scope === 'account' ? `${ai} account · every project` : `${ai} · project`;
}

/** A one-line TOML string, as internal/agentdefs writes it. */
function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

/** A multi-line TOML string with every backslash and quote escaped, as the server writes it. */
function tomlBlock(value: string): string {
  const body = value.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"""\n${body}\n"""\n`;
}

/** A Codex agent file, as internal/agentdefs.RenderCodex writes it. */
export function defToml(def: Partial<AgentDef>): string {
  let text = `name = ${tomlString(def.name ?? '')}\ndescription = ${tomlString(def.description ?? '')}\n`;
  if (def.model && def.model !== 'inherit') text += `model = ${tomlString(def.model)}\n`;
  return `${text}developer_instructions = ${tomlBlock(def.instructions ?? '')}`;
}

/** The file as it will be written, in the agent's own format. */
export function defFile(def: Partial<AgentDef>): string {
  return def.kind === 'codex' ? defToml(def) : defMarkdown(def);
}

/** Quotes a front matter value the way the server does, when YAML would misread it. */
function yamlText(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const risky =
    !flat ||
    /^[!&*?|>'"%@`#{}[\],-]/.test(flat) ||
    flat.includes(': ') ||
    flat.includes(' #') ||
    flat.endsWith(':') ||
    /^(true|false|yes|no|on|off|null|~|[-+]?\d[\d.e+-]*)$/i.test(flat);
  return risky ? JSON.stringify(flat) : flat;
}

/** The file as it will be written, for the preview. internal/agentdefs.Render writes the same. */
export function defMarkdown(def: Partial<AgentDef>): string {
  const lines = [
    '---',
    `name: ${def.name ?? ''}`,
    `description: ${yamlText(def.description ?? '')}`,
    `tools: ${(def.tools ?? []).join(', ')}`,
    `model: ${def.model || 'inherit'}`,
  ];
  if (def.skills?.length) lines.push(`skills: ${def.skills.join(', ')}`);
  lines.push(`color: ${COLOUR_NAMES[def.color ?? ''] ?? 'blue'}`, '---', '');
  return `${lines.join('\n')}\n${(def.instructions ?? '').trim()}\n`;
}

export interface Draft {
  name: string;
  tools: string[];
  description: string;
  instructions: string;
}

const DRAFT_RULES: [
  words: string[],
  name: string,
  tools: string[],
  description: string,
  instructions: string,
][] = [
  [
    ['review', 'audit code'],
    'code-reviewer',
    ['Read', 'Grep', 'Glob'],
    'Use after changes to review them for bugs and risky code.',
    'Review the code you are given. List real problems first, then suggestions. Never edit files.',
  ],
  [
    ['security', 'vulnerab', 'secret'],
    'security-auditor',
    ['Read', 'Grep', 'Glob', 'Bash'],
    'Use to check code and configuration for security problems.',
    'Look for exposed secrets, injection risks, weak auth and unsafe dependencies. Explain each finding and how to fix it.',
  ],
  [
    ['test'],
    'test-writer',
    ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    'Use when code needs tests or tests are failing.',
    'Write focused tests, run them and report coverage and failures.',
  ],
  [
    ['doc', 'readme', 'write up'],
    'docs-writer',
    ['Read', 'Glob', 'Edit', 'Write'],
    'Use to write or update documentation.',
    'Write clear, plain documentation with tables and numbered steps.',
  ],
  [
    ['research', 'compare', 'look up', 'find out'],
    'researcher',
    ['Read', 'WebSearch', 'WebFetch'],
    'Use to research a question and recommend an option.',
    'Research the question, compare the options fairly and finish with a short recommendation.',
  ],
  [
    ['accessib', 'a11y', 'screen reader', 'contrast'],
    'accessibility-checker',
    ['Read', 'Grep', 'Glob', 'Bash'],
    'Use to check pages and components for accessibility problems.',
    'Check the pages you are given for missing labels, poor contrast, keyboard traps and wrong heading order. List each problem with the fix, most serious first.',
  ],
  [
    ['bug', 'debug', 'fix', 'error', 'crash'],
    'debugger',
    ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
    'Use when something is broken and needs to be found and fixed.',
    'Reproduce the problem, find the root cause, make the smallest fix and prove it with a test.',
  ],
];

const STOP_WORDS =
  /^(a|an|the|that|which|who|to|for|on|in|of|and|new|my|our|all|any|checks?|helps?|does|can|will|should|please|agent)$/i;

/** Mabari's agent-creator skill: a first draft of an agent from a plain request. */
export function draftFrom(text: string): Draft {
  const q = (text || '').toLowerCase();
  const asked = text.trim();
  for (const [words, name, tools, description, instructions] of DRAFT_RULES) {
    if (words.some((word) => q.includes(word))) {
      return {
        name,
        tools: [...tools],
        description,
        instructions: instructions + (asked ? `\n\nFocus: ${asked}` : ''),
      };
    }
  }
  const keywords = asked
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.test(word))
    .slice(0, 2);
  return {
    name: slug(`${keywords.join(' ')} helper`) || 'helper',
    tools: ['Read', 'Grep', 'Edit'],
    description: `Use when you need help with: ${asked}`,
    instructions: `Help with the following: ${asked}`,
  };
}

export interface Improvement {
  def: AgentDef;
  /** Each suggested change, explained in one sentence. Empty when the agent already looks solid. */
  changes: string[];
}

/** Mabari's agent-improver skill: suggested changes to an agent, for the person to review. */
export function improve(def: AgentDef, running: Pick<LiveAgent, 'state'>[]): Improvement {
  const next: AgentDef = { ...def, tools: [...def.tools] };
  const changes: string[] = [];
  let prompt = next.instructions || '';
  const description = (next.description || '').toLowerCase();
  const add = (line: string) => {
    prompt = `${prompt.replace(/\s+$/, '')}\n\n${line}`;
  };
  const lower = () => prompt.toLowerCase();
  if (!/^use\b/.test(description)) {
    next.description = `Use ${description.startsWith('to ') ? '' : 'for '}${next.description.charAt(0).toLowerCase()}${next.description.slice(1)}`;
    changes.push(
      'The description now starts with when to use it, so I route the right work to it.',
    );
  }
  const codex = next.kind === 'codex';
  if (!codex && /test/.test(description + lower()) && !next.tools.includes('Bash')) {
    next.tools.push('Bash');
    changes.push('Added Run commands so it can run the tests it works on.');
  }
  if (
    !codex &&
    /research|compare|look up|web/.test(description + lower()) &&
    !next.tools.includes('WebSearch')
  ) {
    next.tools.push('WebSearch', 'WebFetch');
    changes.push('Added web search and web pages for research.');
  }
  if ((codex || next.tools.includes('Bash')) && !lower().includes('fail')) {
    add('If a command fails twice, stop and explain what you tried instead of retrying.');
    changes.push("Added a stop rule for failing commands, so it doesn't loop and burn tokens.");
  }
  if (
    (codex || next.tools.includes('Edit') || next.tools.includes('Write')) &&
    !lower().includes('small')
  ) {
    add('Keep each change small and say why you made it.');
    changes.push('Asked for small, explained changes, which makes approvals faster.');
  }
  if (!lower().includes('summary') && !lower().includes('report')) {
    add('When you finish, reply with a short summary of what changed and anything still open.');
    changes.push('Asked for a short summary at the end, so I can report back to you clearly.');
  }
  if (running.some((agent) => agent.state === 'error')) {
    add("Before starting, read the files you will touch and check the project's test command.");
    changes.push(
      'One of its runs hit an error, so it now checks the files and test command first.',
    );
  }
  next.instructions = prompt;
  return { def: next, changes };
}

/** A blank definition for the build dialog. */
export function blankDef(count: number, projectId = ''): AgentDef {
  return {
    id: '',
    kind: 'claude',
    name: '',
    description: '',
    scope: projectId ? 'project' : 'account',
    projectId,
    model: 'inherit',
    tools: ['Read', 'Grep', 'Glob'],
    skills: [],
    instructions: '',
    color: DEF_COLORS[count % DEF_COLORS.length]!,
    enabled: true,
    runs: 0,
    updated: 0,
    path: '',
    system: false,
  };
}
