import { describe, expect, test } from 'bun:test';

import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { planRepositories } from '../src/reconcile/plan-repositories.ts';
import { FakeClient } from './fake-client.ts';

const live: LiveState = {
  teams: [],
  repositories: [
    { id: 1, name: 'netcore' },
    { id: 2, name: 'Flow-Portal' },
  ],
};

describe('planning repositories', () => {
  test('declaring nothing leaves the surface alone', () => {
    expect(planRepositories(undefined, live)).toEqual([]);
  });

  test('one GitHub already has is adopted, not changed', () => {
    expect(planRepositories([{ name: 'netcore', description: 'different' }], live)).toEqual([]);
  });

  test('matching ignores case, because GitHub does', () => {
    // A create for `flow-portal` beside a live `Flow-Portal` is a 422.
    expect(planRepositories([{ name: 'flow-portal' }], live)).toEqual([]);
  });

  test('one GitHub does not have is created', () => {
    expect(planRepositories([{ name: 'brand-new' }], live)).toEqual([
      { kind: 'create-repository', repository: { name: 'brand-new' } },
    ]);
  });

  test('a declaration removed proposes nothing at all', () => {
    // `netcore` is live and undeclared: adoption has no opposite.
    expect(planRepositories([{ name: 'brand-new' }], live)).not.toContainEqual(
      expect.objectContaining({ kind: 'delete-repository' }),
    );
  });
});

describe('visibility', () => {
  test('public is never inferred, only asked for', () => {
    const [change] = planRepositories([{ name: 'brand-new' }], live) as Array<{
      repository: { visibility?: string };
    }>;
    expect(change?.repository.visibility).toBeUndefined();
  });

  test('unset resolves to internal under an enterprise account', async () => {
    const client = new FakeClient({ internalRepositoriesAllowed: true });
    await apply(client, 'acme', [{ kind: 'create-repository', repository: { name: 'brand-new' } }], { teams: [] }, {});
    expect(client.callsTo('createRepository')).toEqual([{ name: 'brand-new', visibility: 'internal' }]);
  });

  test('unset resolves to private without one', async () => {
    const client = new FakeClient({ internalRepositoriesAllowed: false });
    await apply(client, 'acme', [{ kind: 'create-repository', repository: { name: 'brand-new' } }], { teams: [] }, {});
    expect(client.callsTo('createRepository')).toEqual([{ name: 'brand-new', visibility: 'private' }]);
  });

  test('an explicit visibility is honoured, enterprise or not', async () => {
    const client = new FakeClient({ internalRepositoriesAllowed: true });
    await apply(
      client,
      'acme',
      [
        {
          kind: 'create-repository',
          repository: { name: 'the-blog', visibility: 'public' },
        },
      ],
      { teams: [] },
      {},
    );
    expect(client.callsTo('createRepository')).toEqual([{ name: 'the-blog', visibility: 'public' }]);
  });
});
