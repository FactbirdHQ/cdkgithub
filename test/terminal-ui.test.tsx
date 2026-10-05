import { describe, expect, test } from 'bun:test';

import { render } from 'ink-testing-library';

import { RequestMeter } from '../src/github/meter.ts';
import { PLAIN } from '../src/reconcile/color.ts';
import { ApplyTasks, ApplyTasksView } from '../src/ui/apply-tasks.tsx';
import { ApprovalPrompt, answerFor } from '../src/ui/confirm.tsx';
import { budgetBar, ReadProgressView } from '../src/ui/read-progress.tsx';
import { interactive } from '../src/ui/terminal.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('when the screens run', () => {
  test('on a terminal, not in CI and not on a dumb one', () => {
    expect(interactive({ isTTY: true }, {})).toBe(true);
    expect(interactive({ isTTY: false }, {})).toBe(false);
    expect(interactive({ isTTY: true }, { CI: 'true' })).toBe(false);
    expect(interactive({ isTTY: true }, { CI: 'false' })).toBe(true);
    expect(interactive({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
  });
});

describe('the read screen', () => {
  test('shows what the read has asked for and the budget left', () => {
    const meter = new RequestMeter();
    const reset = 1_900_000_000;
    meter.record('GET /orgs/{org}/teams', {
      'x-ratelimit-remaining': '1250',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': String(reset),
    });
    const { lastFrame, unmount } = render(
      <ReadProgressView
        label="Reading live state"
        snapshot={meter.snapshot((reset - 60) * 1000)}
        elapsedMs={4_000}
        nowMs={(reset - 60) * 1000}
        palette={PLAIN}
      />,
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('Reading live state  1 REST request, 0 GraphQL queries · 4s');
    expect(frame).toContain(
      `API budget ${budgetBar({ remaining: 1250, limit: 5000, resetsAt: new Date() })} 1,250 of 5,000 left`,
    );
  });

  test('draws the budget left as a share of the limit', () => {
    const at = new Date();
    expect(budgetBar({ remaining: 5000, limit: 5000, resetsAt: at })).toBe(`▕${'█'.repeat(16)}▏`);
    expect(budgetBar({ remaining: 1250, limit: 5000, resetsAt: at })).toBe(`▕${'█'.repeat(4)}${'░'.repeat(12)}▏`);
    expect(budgetBar({ remaining: 0, limit: 5000, resetsAt: at })).toBe(`▕${'░'.repeat(16)}▏`);
  });
});

describe('the approval prompt', () => {
  test('approves on y and declines on anything that ends it otherwise', () => {
    expect(answerFor('y', {})).toBe(true);
    expect(answerFor('Y', {})).toBe(true);
    expect(answerFor('n', {})).toBe(false);
    expect(answerFor('', { return: true })).toBe(false);
    expect(answerFor('', { escape: true })).toBe(false);
    expect(answerFor('c', { ctrl: true })).toBe(false);
    expect(answerFor('x', {})).toBeUndefined();
  });

  test('says how many changes are destructive and records the answer', async () => {
    const answers: boolean[] = [];
    const { frames, lastFrame, stdin, unmount } = render(
      <ApprovalPrompt changes={12} destructive={2} palette={PLAIN} onAnswer={(a) => answers.push(a)} />,
    );
    expect(lastFrame()).toContain('12 changes to apply, 2 destructive.');
    expect(lastFrame()).toContain('Do you wish to apply these changes? (y/N)');
    await tick();
    stdin.write('y');
    await tick();
    expect(answers).toEqual([true]);
    expect(frames.join('\n')).toContain('Do you wish to apply these changes? yes');
    unmount();
  });
});

describe('the apply task list', () => {
  test('opens a task on progress, notes later messages, and ends it on the record', () => {
    const tasks = new ApplyTasks();
    tasks.progress('Renaming team cloud to platform');
    tasks.progress('Note: GitHub derived slug platform-1, not platform');
    expect(tasks.snapshot().running).toEqual({
      title: 'Renaming team cloud to platform',
      notes: ['Note: GitHub derived slug platform-1, not platform'],
      status: 'running',
    });
    tasks.record({ kind: 'update', description: 'rename cloud', status: 'applied' });
    expect(tasks.snapshot().running).toBeUndefined();
    expect(tasks.snapshot().done.map((t) => t.status)).toEqual(['applied']);
  });

  test('leaves a skipped change to the summary', () => {
    const tasks = new ApplyTasks();
    tasks.record({ kind: 'delete', description: 'delete team old', status: 'skipped' });
    expect(tasks.snapshot()).toEqual({ done: [] });
  });

  test('marks applied and failed changes and shows the one running', async () => {
    const tasks = new ApplyTasks();
    const { lastFrame, frames, unmount } = render(<ApplyTasksView tasks={tasks} palette={PLAIN} />);
    tasks.progress('Creating team platform');
    tasks.record({ kind: 'create', description: 'create platform', status: 'applied' });
    tasks.progress('Deleting ruleset "legacy"');
    tasks.record({ kind: 'delete-ruleset', description: 'delete legacy', status: 'failed', error: 'HTTP 403' });
    tasks.progress('Granting platform push on netcore');
    tasks.wait({ secondary: false, until: new Date(2026, 9, 4, 3, 16) });
    await tick();
    const output = frames.join('\n');
    const last = lastFrame() ?? '';
    unmount();
    expect(output).toContain('✔ Creating team platform');
    expect(output).toContain('✖ Deleting ruleset "legacy"');
    expect(output).toContain('HTTP 403');
    expect(last).toContain('Granting platform push on netcore');
    expect(last).toContain("waiting out GitHub's rate limit until 03:16");
  });
});
