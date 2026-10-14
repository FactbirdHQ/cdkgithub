import { describe, expect, test } from 'bun:test';

import type { LiveRepositoryMergeSettings } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import { type LiveState, readLiveState } from '../src/reconcile/live.ts';
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

  test('one GitHub already has keeps the description it has', () => {
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

const squashOnly = { allowMergeCommit: false, allowSquashMerge: true, allowRebaseMerge: false };

function liveWith(settings: Partial<LiveRepositoryMergeSettings> & { repository: string }): LiveState {
  return {
    ...live,
    repositoryMergeSettings: [
      {
        archived: false,
        allowMergeCommit: true,
        allowSquashMerge: true,
        allowRebaseMerge: true,
        deleteBranchOnMerge: false,
        ...settings,
      },
    ],
  };
}

describe('merge settings on an existing repository', () => {
  test('a declared setting that differs is planned, with only the fields that differ', () => {
    expect(
      planRepositories(
        [{ name: 'netcore', ...squashOnly, deleteBranchOnMerge: true }],
        liveWith({ repository: 'netcore' }),
      ),
    ).toEqual([
      {
        kind: 'repository-merge-settings',
        repository: 'netcore',
        settings: { ...squashOnly, deleteBranchOnMerge: true },
        fields: [
          { field: 'allowMergeCommit', from: true, to: false },
          { field: 'allowRebaseMerge', from: true, to: false },
          { field: 'deleteBranchOnMerge', from: false, to: true },
        ],
      },
    ]);
  });

  test('a setting left undeclared is not compared', () => {
    expect(
      planRepositories([{ name: 'netcore', allowSquashMerge: true }], liveWith({ repository: 'netcore' })),
    ).toEqual([]);
  });

  test('an archived repository is read-only, so nothing is planned for it', () => {
    expect(
      planRepositories(
        [{ name: 'netcore', deleteBranchOnMerge: true }],
        liveWith({ repository: 'netcore', archived: true }),
      ),
    ).toEqual([]);
  });

  test('the live repository is matched case-insensitively and patched by its own name', () => {
    expect(
      planRepositories([{ name: 'flow-portal', deleteBranchOnMerge: true }], liveWith({ repository: 'Flow-Portal' })),
    ).toEqual([expect.objectContaining({ kind: 'repository-merge-settings', repository: 'Flow-Portal' })]);
  });

  test('only the repositories declaring a setting are read', async () => {
    const client = new FakeClient({ repositories: live.repositories });
    await readLiveState(client, {
      owner: 'acme',
      ownerType: 'organization',
      teams: [],
      repositories: [{ name: 'netcore', deleteBranchOnMerge: true }, { name: 'Flow-Portal' }],
    });
    expect(client.callsTo('listRepositoryMergeSettings')).toEqual([['netcore']]);
  });

  test('apply writes the declared settings', async () => {
    const client = new FakeClient();
    await apply(
      client,
      'acme',
      [
        {
          kind: 'repository-merge-settings',
          repository: 'netcore',
          settings: { deleteBranchOnMerge: true },
          fields: [{ field: 'deleteBranchOnMerge', from: false, to: true }],
        },
      ],
      { teams: [] },
      {},
    );
    expect(client.callsTo('updateRepositoryMergeSettings')).toEqual([
      { repo: 'netcore', settings: { deleteBranchOnMerge: true } },
    ]);
  });
});
