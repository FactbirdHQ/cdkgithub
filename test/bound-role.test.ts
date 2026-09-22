import { describe, expect, test } from 'bun:test';
import { App, Organization, push, role, Team } from '../src/index.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

/** Named once, imported wherever it is granted. */
const MERGE_QUEUE_JUMPER = 'Merge Queue Jumper';
const mergeQueueJumper = role(MERGE_QUEUE_JUMPER);

describe('a custom role bound once', () => {
  test('grants through the binding', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'cloud', {
      repositories: [mergeQueueJumper('netcore'), push('fctl')],
    });

    expect(synthesize(app.node.root).teams[0]?.repositories).toEqual({
      netcore: 'Merge Queue Jumper',
      fctl: 'push',
    });
  });

  test('the binding keeps the literal type, so the name is checked', () => {
    const grant = mergeQueueJumper('netcore');
    const permission: typeof MERGE_QUEUE_JUMPER = grant.permission;
    expect(permission).toBe('Merge Queue Jumper');
  });
});
