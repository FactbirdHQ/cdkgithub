import { describe, expect, test } from 'bun:test';
import {
  App,
  Organization,
  Repository,
  RepositoryRuleset,
  UserAccount,
} from '../src/index.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type {
  DesiredState,
  RepositoryRulesetManifest,
} from '../src/synth/manifest.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams: [], ...overrides };
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return { teams: [], ...overrides };
}

const mergeQueue: RepositoryRulesetManifest = {
  repository: 'flow-portal',
  name: 'merge-queue',
  target: 'branch',
  enforcement: 'active',
  conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
  rules: [{ type: 'required_linear_history' }],
};

describe('synthesis', () => {
  test('finds its repository by nesting and defaults like an org ruleset', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const deck = new Repository(org, 'flow-portal');
    new RepositoryRuleset(deck, 'merge-queue', {
      rules: [{ type: 'required_linear_history' }],
    });

    const state = synthesize(app);
    expect(state.repositoryRulesets).toEqual([
      {
        name: 'merge-queue',
        repository: 'flow-portal',
        target: 'branch',
        enforcement: 'active',
        conditions: undefined,
        rules: [{ type: 'required_linear_history' }],
        bypassActors: undefined,
      },
    ]);
  });

  test('with no repository to be found, synthesis fails', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new RepositoryRuleset(org, 'merge-queue', { rules: [] });
    expect(() => synthesize(app)).toThrow('names no repository');
  });

  test('a personal account can declare them', () => {
    const app = new App();
    const me = new UserAccount(app, 'casey', { login: 'casey' });
    const dotfiles = new Repository(me, 'dotfiles');
    new RepositoryRuleset(dotfiles, 'protect-main', {
      rules: [{ type: 'deletion' }],
    });
    expect(() => synthesize(app)).not.toThrow();
  });
});

describe('planning', () => {
  test('creates on a repository with nothing live', () => {
    const changes = plan(desired({ repositoryRulesets: [mergeQueue] }), live());
    expect(changes).toEqual([
      {
        kind: 'create-repo-ruleset',
        repository: 'flow-portal',
        ruleset: {
          name: 'merge-queue',
          target: 'branch',
          enforcement: 'active',
          conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
          rules: [{ type: 'required_linear_history' }],
        },
      },
    ]);
  });

  test('prunes only on the repositories the definition declares', () => {
    const changes = plan(
      desired({ repositoryRulesets: [mergeQueue] }),
      live({
        repositoryRulesets: [
          {
            repository: 'flow-portal',
            id: 8,
            name: 'merge-queue',
            target: 'branch',
            enforcement: 'active',
            conditions: {
              refName: { include: ['~DEFAULT_BRANCH'], exclude: [] },
            },
            rules: [{ type: 'required_linear_history' }],
            bypassActors: [],
            sourceType: 'Repository',
          },
          {
            repository: 'flow-portal',
            id: 9,
            name: 'stray',
            target: 'branch',
            enforcement: 'active',
            rules: [],
            bypassActors: [],
            sourceType: 'Repository',
          },
        ],
      }),
    );

    expect(changes).toEqual([
      {
        kind: 'delete-repo-ruleset',
        repository: 'flow-portal',
        live: expect.objectContaining({ name: 'stray' }),
      },
    ]);
  });

  test('an OrganizationAdmin bypass matches the null actor id the repository endpoint reports', () => {
    // The org endpoints report OrganizationAdmin as actor_id 1; the repository
    // endpoints report null for the same actor. The plan must settle anyway.
    const changes = plan(
      desired({
        repositoryRulesets: [
          {
            ...mergeQueue,
            bypassActors: [
              { actorType: 'OrganizationAdmin', bypassMode: 'always' },
            ],
          },
        ],
      }),
      live({
        repositoryRulesets: [
          {
            repository: 'flow-portal',
            id: 8,
            name: 'merge-queue',
            target: 'branch',
            enforcement: 'active',
            conditions: {
              refName: { include: ['~DEFAULT_BRANCH'], exclude: [] },
            },
            rules: [{ type: 'required_linear_history' }],
            bypassActors: [
              {
                actorType: 'OrganizationAdmin',
                actorId: null,
                bypassMode: 'always',
              },
            ],
            sourceType: 'Repository',
          },
        ],
      }),
    );

    expect(changes).toEqual([]);
  });

  test('resolves a team bypass actor against the live org', () => {
    const changes = plan(
      desired({
        repositoryRulesets: [
          {
            ...mergeQueue,
            bypassActors: [{ actorType: 'Team', team: 'platform' }],
          },
        ],
      }),
      live({
        teams: [
          {
            id: 42,
            slug: 'platform',
            name: 'Platform',
            description: null,
            privacy: 'closed',
            parentSlug: null,
          },
        ],
      }),
    );
    // The undeclared live team also plans as a delete; the ruleset is what
    // this test is about.
    const change = changes.find((c) => c.kind === 'create-repo-ruleset');
    if (!change) throw new Error('no create-repo-ruleset planned');
    expect(change.ruleset.bypassActors).toEqual([
      { actorType: 'Team', actorId: 42, bypassMode: undefined },
    ]);
  });

  test('reads only the declared repositories, tolerating one being created', async () => {
    const client = new FakeClient({
      repositoryRulesets: { 'flow-portal': [] },
    });
    const state = desired({
      repositories: [{ name: 'brand-new' }],
      repositoryRulesets: [
        mergeQueue,
        { ...mergeQueue, repository: 'brand-new' },
      ],
    });
    // The fake returns [] for unknown repositories rather than a 404, so this
    // asserts the shape of the read, not the 404 path: one entry per repo.
    const liveState = await readLiveState(client, state);
    expect(liveState.repositoryRulesets).toEqual([]);
  });
});

describe('applying', () => {
  test('a create adopts an existing ruleset of the same name', async () => {
    const client = new FakeClient({
      repositoryRulesets: {
        'flow-portal': [
          {
            id: 8,
            name: 'merge-queue',
            target: 'branch',
            enforcement: 'evaluate',
            rules: [],
            bypassActors: [],
            sourceType: 'Repository',
          },
        ],
      },
    });
    const changes = plan(desired({ repositoryRulesets: [mergeQueue] }), live());
    await apply(client, 'acme', changes, live());

    expect(client.callsTo('createRepositoryRuleset')).toEqual([]);
    expect(client.callsTo('updateRepositoryRuleset')).toEqual([
      expect.objectContaining({ repo: 'flow-portal', id: 8 }),
    ]);
  });

  test('a delete is gated and scoped like the other removals', async () => {
    const stray = {
      repository: 'flow-portal',
      id: 9,
      name: 'stray',
      target: 'branch' as const,
      enforcement: 'active' as const,
      rules: [],
      bypassActors: [],
      sourceType: 'Repository',
    };
    const changes = plan(
      desired({ repositoryRulesets: [mergeQueue] }),
      live({
        repositoryRulesets: [
          {
            ...stray,
            id: 8,
            name: 'merge-queue',
            conditions: {
              refName: { include: ['~DEFAULT_BRANCH'], exclude: [] },
            },
            rules: [{ type: 'required_linear_history' as const }],
          },
          stray,
        ],
      }),
    );

    const ungated = new FakeClient();
    const skipped = await apply(ungated, 'acme', changes, live());
    expect(skipped.skipped).toEqual([
      'delete ruleset "stray" from flow-portal (use --allow-delete)',
    ]);
    expect(ungated.callsTo('deleteRepositoryRuleset')).toEqual([]);

    const gated = new FakeClient();
    await apply(gated, 'acme', changes, live(), {
      allowDelete: new Set(['delete-repo-ruleset'] as const),
    });
    expect(gated.callsTo('deleteRepositoryRuleset')).toEqual([
      { repo: 'flow-portal', id: 9 },
    ]);
  });
});

describe('app bypass actors', () => {
  const releaseBot = {
    id: 42,
    appId: 4345,
    slug: 'release-bot',
    repositorySelection: 'selected' as const,
  };
  const withBot: RepositoryRulesetManifest = {
    ...mergeQueue,
    bypassActors: [{ actorType: 'Integration', app: 'release-bot' }],
  };

  test('the live read lists the repositories a selected installation covers', async () => {
    const client = new FakeClient({
      appInstallations: [releaseBot],
      installationRepositories: { 42: ['launch-pad'] },
    });
    const state = await readLiveState(
      client,
      desired({ repositoryRulesets: [withBot] }),
    );
    expect(state.appInstallations).toEqual([
      { ...releaseBot, repositories: ['launch-pad'] },
    ]);
  });

  test('an app whose installation leaves the repository out fails the plan', () => {
    expect(() =>
      plan(
        desired({ repositoryRulesets: [withBot] }),
        live({
          repositoryRulesets: [],
          appInstallations: [{ ...releaseBot, repositories: ['launch-pad'] }],
        }),
      ),
    ).toThrow('the app is not installed on "flow-portal"');
  });

  test('a numeric app id is checked the same way', () => {
    expect(() =>
      plan(
        desired({
          repositoryRulesets: [
            {
              ...mergeQueue,
              bypassActors: [{ actorType: 'Integration', app: 4345 }],
            },
          ],
        }),
        live({
          repositoryRulesets: [],
          appInstallations: [{ ...releaseBot, repositories: ['launch-pad'] }],
        }),
      ),
    ).toThrow('lets app "release-bot" bypass it');
  });

  test('an installation on the repository, or on every repository, plans', () => {
    for (const installation of [
      { ...releaseBot, repositories: ['flow-portal'] },
      { ...releaseBot, repositorySelection: 'all' as const },
    ]) {
      const changes = plan(
        desired({ repositoryRulesets: [withBot] }),
        live({ repositoryRulesets: [], appInstallations: [installation] }),
      );
      expect(changes.map((c) => c.kind)).toContain('create-repo-ruleset');
    }
  });

  test('an installation the token cannot list is left for GitHub to judge', async () => {
    const client = new FakeClient({ appInstallations: [releaseBot] });
    const state = await readLiveState(
      client,
      desired({ repositoryRulesets: [withBot] }),
    );
    expect(state.appInstallations).toEqual([releaseBot]);
    const changes = plan(desired({ repositoryRulesets: [withBot] }), state);
    expect(changes.map((c) => c.kind)).toContain('create-repo-ruleset');
  });
});
