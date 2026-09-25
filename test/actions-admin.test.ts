import { describe, expect, test } from 'bun:test';
import {
  ActionsSecret,
  ActionsVariable,
  App,
  Organization,
  Repository,
  RunnerGroup,
  UserAccount,
} from '../src/index.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { missingSecretValues } from '../src/cli.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams: [], ...overrides };
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return { teams: [], ...overrides };
}

describe('synthesis', () => {
  test('scopes variables and secrets by nesting or by name', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsVariable(org, 'REGION', {
      value: 'eu-west-1',
      visibility: 'all',
    });
    const deck = new Repository(org, 'flow-portal');
    new ActionsVariable(deck, 'SENTRY_PROJECT', { value: 'deck' });
    new ActionsSecret(org, 'NPM_TOKEN', { visibility: 'private' });
    new ActionsSecret(org, 'DECK_DSN', {
      name: 'SENTRY_DSN',
      repository: 'flow-portal',
    });

    const state = synthesize(app);

    expect(state.actionsVariables).toEqual([
      { name: 'REGION', value: 'eu-west-1', visibility: 'all', repository: undefined },
      { name: 'SENTRY_PROJECT', value: 'deck', repository: 'flow-portal', visibility: undefined },
    ]);
    expect(state.actionsSecrets).toEqual([
      {
        name: 'NPM_TOKEN',
        valueFrom: 'NPM_TOKEN',
        visibility: 'private',
        repository: undefined,
      },
      {
        name: 'SENTRY_DSN',
        valueFrom: 'SENTRY_DSN',
        repository: 'flow-portal',
        visibility: undefined,
      },
    ]);
  });

  test('an organization variable must say who reads it', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsVariable(org, 'REGION', { value: 'eu-west-1' });
    expect(() => synthesize(app)).toThrow('declares no visibility');
  });

  test('a repository secret takes no visibility', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const deck = new Repository(org, 'flow-portal');
    new ActionsSecret(deck, 'SENTRY_DSN', { visibility: 'all' });
    expect(() => synthesize(app)).toThrow('only its own repository reads it');
  });

  test('names collide case-insensitively within a scope', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsSecret(org, 'token', { visibility: 'all' });
    new ActionsSecret(org, 'TOKEN', { visibility: 'all' });
    expect(() => synthesize(app)).toThrow('Duplicate secret');
  });

  test('the same name on different scopes is no collision', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsSecret(org, 'NPM_TOKEN', { visibility: 'all' });
    const deck = new Repository(org, 'flow-portal');
    new ActionsSecret(deck, 'NPM_TOKEN', {});
    expect(() => synthesize(app)).not.toThrow();
  });

  test('a personal account takes repository scopes and refuses the rest', () => {
    const app = new App();
    const me = new UserAccount(app, 'casey', { login: 'casey' });
    const dotfiles = new Repository(me, 'dotfiles');
    new ActionsSecret(dotfiles, 'HOMEBREW_TOKEN', {});
    expect(() => synthesize(app)).not.toThrow();

    const orgScoped = new App();
    const me2 = new UserAccount(orgScoped, 'casey', { login: 'casey' });
    new Repository(me2, 'dotfiles');
    new ActionsSecret(me2, 'NPM_TOKEN', { visibility: 'all' });
    new RunnerGroup(me2, 'runners');
    expect(() => synthesize(orgScoped)).toThrow(
      'RunnerGroup, organization ActionsSecret',
    );
  });
});

describe('runner groups', () => {
  const group = {
    name: 'deploy-runners',
    visibility: 'selected' as const,
    selectedRepositories: ['flow-portal'],
    allowsPublicRepositories: false,
  };

  test('creates, updates, and prunes, sparing the default group', () => {
    const changes = plan(
      desired({ runnerGroups: [group] }),
      live({
        runnerGroups: [
          {
            id: 1,
            name: 'Default',
            visibility: 'all',
            isDefault: true,
            allowsPublicRepositories: false,
            restrictedToWorkflows: false,
            selectedWorkflows: [],
          },
          {
            id: 2,
            name: 'legacy-runners',
            visibility: 'all',
            isDefault: false,
            allowsPublicRepositories: true,
            restrictedToWorkflows: false,
            selectedWorkflows: [],
          },
        ],
      }),
    );

    expect(changes).toEqual([
      { kind: 'create-runner-group', group },
      {
        kind: 'delete-runner-group',
        live: expect.objectContaining({ name: 'legacy-runners' }),
      },
    ]);
  });

  test('diffs the repository list as a set, and writes it separately', async () => {
    const current = {
      id: 5,
      name: 'deploy-runners',
      visibility: 'selected' as const,
      isDefault: false,
      allowsPublicRepositories: false,
      restrictedToWorkflows: false,
      selectedWorkflows: [],
      selectedRepositories: ['netcore'],
    };
    const changes = plan(
      desired({ runnerGroups: [group] }),
      live({ runnerGroups: [current] }),
    );
    expect(changes).toEqual([
      {
        kind: 'update-runner-group',
        id: 5,
        group,
        fields: [
          {
            field: 'selectedRepositories',
            from: ['netcore'],
            to: ['flow-portal'],
          },
        ],
      },
    ]);

    const client = new FakeClient({
      repositories: [{ id: 77, name: 'flow-portal' }],
    });
    await apply(client, 'acme', changes, live());
    expect(client.callsTo('setRunnerGroupRepositories')).toEqual([
      { id: 5, repositoryIds: [77] },
    ]);
    // The group itself was PATCHed too, since update covers the rest.
    expect(client.callsTo('updateRunnerGroup')).toHaveLength(1);
  });

  test('a matching group is no change', () => {
    const changes = plan(
      desired({ runnerGroups: [group] }),
      live({
        runnerGroups: [
          {
            id: 5,
            name: 'deploy-runners',
            visibility: 'selected',
            isDefault: false,
            allowsPublicRepositories: false,
            restrictedToWorkflows: false,
            selectedWorkflows: [],
            selectedRepositories: ['flow-portal'],
          },
        ],
      }),
    );
    expect(changes).toEqual([]);
  });
});

describe('variables', () => {
  test('the organization scope creates, updates, and prunes by upper-cased name', () => {
    const changes = plan(
      desired({
        actionsVariables: [
          { name: 'region', value: 'eu-west-1', visibility: 'all' },
          { name: 'STAGE', value: 'prod', visibility: 'private' },
        ],
      }),
      live({
        actionsVariables: [
          { name: 'REGION', value: 'us-east-1', visibility: 'all' },
          { name: 'LEGACY', value: 'x', visibility: 'all' },
        ],
      }),
    );

    expect(changes).toEqual([
      {
        kind: 'update-variable',
        variable: { name: 'region', value: 'eu-west-1', visibility: 'all' },
        fields: [{ field: 'value', from: 'us-east-1', to: 'eu-west-1' }],
      },
      {
        kind: 'create-variable',
        variable: { name: 'STAGE', value: 'prod', visibility: 'private' },
      },
      { kind: 'delete-variable', name: 'LEGACY' },
    ]);
  });

  test('a repository scope owns only its own repository', () => {
    const changes = plan(
      desired({
        actionsVariables: [
          { name: 'SENTRY_PROJECT', value: 'deck', repository: 'flow-portal' },
        ],
      }),
      live({
        repositoryVariables: [
          {
            repository: 'flow-portal',
            name: 'OLD_FLAG',
            value: 'on',
          },
        ],
      }),
    );

    expect(changes).toEqual([
      {
        kind: 'create-variable',
        variable: {
          name: 'SENTRY_PROJECT',
          value: 'deck',
          repository: 'flow-portal',
        },
      },
      { kind: 'delete-variable', name: 'OLD_FLAG', repository: 'flow-portal' },
    ]);
  });

  test('an organization owns its variables and secrets with none declared', async () => {
    const client = new FakeClient({
      orgVariables: [{ name: 'REGION', value: 'eu', visibility: 'all' }],
      orgSecrets: [{ name: 'LEGACY', visibility: 'all' }],
    });
    const state = desired();
    expect(plan(state, await readLiveState(client, state))).toEqual([
      { kind: 'delete-variable', name: 'REGION' },
      { kind: 'delete-secret', name: 'LEGACY' },
    ]);
  });

  test('a declared repository owns its secrets once the last one is removed', async () => {
    const client = new FakeClient({
      repositorySecrets: {
        'flow-portal': [{ name: 'SENTRY_DSN' }],
        dotfiles: [{ name: 'HOMEBREW_TOKEN' }],
      },
    });
    // flow-portal is declared and names no secret; dotfiles is not declared.
    const state = desired({ repositories: [{ name: 'flow-portal' }] });
    const liveState = await readLiveState(client, state);
    expect(liveState.repositorySecrets).toEqual([
      { repository: 'flow-portal', name: 'SENTRY_DSN' },
    ]);
    expect(plan(state, liveState).filter((c) => c.kind === 'delete-secret')).toEqual([
      { kind: 'delete-secret', name: 'SENTRY_DSN', repository: 'flow-portal' },
    ]);
  });

  test('apply resolves an organization variable through its endpoints', async () => {
    const changes = plan(
      desired({
        actionsVariables: [
          {
            name: 'REGION',
            value: 'eu-west-1',
            visibility: 'selected',
            selectedRepositories: ['flow-portal'],
          },
        ],
      }),
      live(),
    );
    const client = new FakeClient({
      repositories: [{ id: 77, name: 'flow-portal' }],
    });
    await apply(client, 'acme', changes, live());
    expect(client.callsTo('createOrgVariable')).toEqual([
      {
        name: 'REGION',
        value: 'eu-west-1',
        visibility: 'selected',
        selectedRepositoryIds: [77],
      },
    ]);
  });
});

describe('secrets', () => {
  test('diffs existence and visibility, and never carries a value', () => {
    const changes = plan(
      desired({
        actionsSecrets: [
          { name: 'NPM_TOKEN', valueFrom: 'NPM_TOKEN', visibility: 'private' },
          { name: 'MATCHES', valueFrom: 'MATCHES', visibility: 'all' },
        ],
      }),
      live({
        actionsSecrets: [
          { name: 'NPM_TOKEN', visibility: 'all' },
          { name: 'MATCHES', visibility: 'all' },
          { name: 'LEGACY', visibility: 'all' },
        ],
      }),
    );

    expect(changes).toEqual([
      {
        kind: 'put-secret',
        secret: {
          name: 'NPM_TOKEN',
          valueFrom: 'NPM_TOKEN',
          visibility: 'private',
        },
        fields: [{ field: 'visibility', from: 'all', to: 'private' }],
        exists: true,
      },
      { kind: 'delete-secret', name: 'LEGACY' },
    ]);
    // The plan is what backups serialize, so this is a load-bearing absence.
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  test('an existing repository secret is a match, not a rewrite', () => {
    const changes = plan(
      desired({
        actionsSecrets: [
          {
            name: 'SENTRY_DSN',
            valueFrom: 'SENTRY_DSN',
            repository: 'flow-portal',
          },
        ],
      }),
      live({
        repositorySecrets: [
          { repository: 'flow-portal', name: 'SENTRY_DSN' },
        ],
      }),
    );
    expect(changes).toEqual([]);
  });

  test('apply reads the value from the declared environment variable', async () => {
    process.env.ACTIONS_ADMIN_TEST_TOKEN = 'hunter2';
    const changes = plan(
      desired({
        actionsSecrets: [
          {
            name: 'NPM_TOKEN',
            valueFrom: 'ACTIONS_ADMIN_TEST_TOKEN',
            visibility: 'private',
          },
        ],
      }),
      live(),
    );
    const client = new FakeClient();
    await apply(client, 'acme', changes, live());
    expect(client.callsTo('putOrgSecret')).toEqual([
      {
        name: 'NPM_TOKEN',
        value: 'hunter2',
        visibility: 'private',
        selectedRepositoryIds: undefined,
      },
    ]);
  });

  test('apply fails loudly on a missing environment variable', async () => {
    delete process.env.ACTIONS_ADMIN_TEST_MISSING;
    const client = new FakeClient();
    await expect(
      apply(
        client,
        'acme',
        [
          {
            kind: 'put-secret',
            secret: {
              name: 'NPM_TOKEN',
              valueFrom: 'ACTIONS_ADMIN_TEST_MISSING',
              visibility: 'all',
            },
            fields: [],
            exists: false,
          },
        ],
        live(),
      ),
    ).rejects.toThrow('$ACTIONS_ADMIN_TEST_MISSING');
    expect(client.callsTo('putOrgSecret')).toEqual([]);
  });

  test('missingSecretValues names every absent export once', () => {
    const changes = plan(
      desired({
        actionsSecrets: [
          { name: 'A', valueFrom: 'SHARED_EXPORT', visibility: 'all' },
          { name: 'B', valueFrom: 'SHARED_EXPORT', visibility: 'all' },
          { name: 'C', valueFrom: 'PRESENT_EXPORT', visibility: 'all' },
        ],
      }),
      live(),
    );
    expect(
      missingSecretValues(changes, { PRESENT_EXPORT: 'here' }),
    ).toEqual(['SHARED_EXPORT']);
  });
});
