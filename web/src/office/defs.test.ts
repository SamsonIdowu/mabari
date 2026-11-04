// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../gen/models.ts';
import { blankDef, defMarkdown, defTitle, draftFrom, improve, slug } from './defs.ts';

const reviewer = (): AgentDef => ({
  ...blankDef(1),
  name: 'code-reviewer',
  description: 'Use after any change: review it for bugs.',
  model: 'sonnet',
  tools: ['Read', 'Grep', 'Glob'],
  skills: ['agent-improver'],
  instructions: 'You are a careful senior reviewer.\n\nNever edit files.',
});

describe('agent files', () => {
  // internal/agentdefs TestRenderAndParseRoundTrip writes exactly this.
  it('previews the file exactly as the server writes it', () => {
    expect(defMarkdown(reviewer())).toBe(
      '---\nname: code-reviewer\ndescription: "Use after any change: review it for bugs."\ntools: Read, Grep, Glob\n' +
        'model: sonnet\nskills: agent-improver\ncolor: blue\n---\n\nYou are a careful senior reviewer.\n\nNever edit files.\n',
    );
  });

  it('names and titles agents', () => {
    expect(slug('  Review PRs, fast! ')).toBe('review-prs-fast');
    expect(defTitle({ name: 'flaky-test-hunter' })).toBe('Flaky Test Hunter');
  });
});

describe('Mabari drafts an agent', () => {
  it('matches a known kind of work', () => {
    const draft = draftFrom('review pull requests for security problems');
    expect(draft.name).toBe('code-reviewer');
    expect(draft.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(draft.instructions).toContain('Focus: review pull requests for security problems');
  });

  it('names anything else after its key words', () => {
    expect(draftFrom('translate the release notes').name).toBe('translate-release-helper');
  });
});

describe('Mabari improves an agent', () => {
  it('suggests each change with a reason, and changes nothing it does not explain', () => {
    const tester: AgentDef = {
      ...reviewer(),
      name: 'test-writer',
      description: 'Writes tests for new code.',
      tools: ['Read', 'Edit'],
      instructions: 'Write tests.',
    };
    const { def, changes } = improve(tester, [{ state: 'error' }]);
    expect(def.description).toBe('Use for writes tests for new code.');
    expect(def.tools).toEqual(['Read', 'Edit', 'Bash']);
    expect(def.instructions).toContain('If a command fails twice, stop');
    expect(def.instructions).toContain('Keep each change small');
    expect(def.instructions).toContain('short summary');
    expect(def.instructions).toContain('check the project');
    expect(changes).toHaveLength(6);
    expect(tester.tools).toEqual(['Read', 'Edit']);
  });

  it('says so when an agent already looks solid', () => {
    const solid: AgentDef = {
      ...reviewer(),
      instructions: 'Review the change and report a short summary of findings.',
    };
    expect(improve(solid, []).changes).toEqual([]);
  });
});
