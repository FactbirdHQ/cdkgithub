import { describe, expect, test } from 'bun:test';

import type { LiveState } from '../src/reconcile/live.ts';
import { planCustomRepositoryRoles } from '../src/reconcile/plan-custom-roles.ts';

/** As GitHub answers it: `write`, which a grant would write as `push`. */
const JUMPER = {
  id: 7,
  name: 'Merge Queue Jumper',
  baseRole: 'write',
  description: 'Write, plus jumping the merge queue.',
  permissions: ['jump_merge_queue'],
};

const LIVE: LiveState = { teams: [], customRepositoryRoles: [JUMPER] };

describe('planning custom repository roles', () => {
  test('declaring nothing leaves the surface alone', () => {
    expect(planCustomRepositoryRoles(undefined, LIVE)).toEqual([]);
  });

  test('a role that matches the live one is no change', () => {
    const changes = planCustomRepositoryRoles(
      [
        {
          name: 'Merge Queue Jumper',
          baseRole: 'push',
          description: 'Write, plus jumping the merge queue.',
          permissions: ['jump_merge_queue'],
        },
      ],
      LIVE,
    );
    expect(changes).toEqual([]);
  });

  test('permission order carries no meaning', () => {
    const live: LiveState = {
      teams: [],
      customRepositoryRoles: [{ ...JUMPER, permissions: ['manage_webhooks', 'jump_merge_queue'] }],
    };
    const changes = planCustomRepositoryRoles(
      [
        {
          name: 'Merge Queue Jumper',
          baseRole: 'push',
          description: 'Write, plus jumping the merge queue.',
          permissions: ['jump_merge_queue', 'manage_webhooks'],
        },
      ],
      live,
    );
    expect(changes).toEqual([]);
  });

  test('a new name is a create', () => {
    const changes = planCustomRepositoryRoles(
      [
        ...[],
        {
          name: 'Merge Queue Maintainer',
          baseRole: 'maintain',
          description: 'Maintain, plus jumping the merge queue.',
          permissions: ['jump_merge_queue'],
        },
      ],
      LIVE,
    );
    expect(changes[0]).toMatchObject({ kind: 'create-repo-role' });
    // The live one is now undeclared, so it is proposed for removal.
    expect(changes[1]).toMatchObject({
      kind: 'delete-repo-role',
      live: { name: 'Merge Queue Jumper' },
    });
  });

  test('a changed base role is an update, not a replacement', () => {
    const changes = planCustomRepositoryRoles(
      [
        {
          name: 'Merge Queue Jumper',
          baseRole: 'maintain',
          description: 'Write, plus jumping the merge queue.',
          permissions: ['jump_merge_queue'],
        },
      ],
      LIVE,
    );
    expect(changes).toEqual([
      {
        kind: 'update-repo-role',
        id: 7,
        role: expect.objectContaining({ baseRole: 'maintain' }),
        // Reported in the grant vocabulary, not the one GitHub answers in.
        fields: [{ field: 'baseRole', from: 'push', to: 'maintain' }],
      },
    ]);
  });
});
