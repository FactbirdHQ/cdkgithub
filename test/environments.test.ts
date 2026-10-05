import { describe, expect, test } from 'bun:test';

import type { LiveEnvironment } from '../src/github/client.ts';
import { ActionsSecret, ActionsVariable, App, Environment, Organization, Repository } from '../src/index.ts';
import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import { renderPlan } from '../src/reconcile/render.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

function liveEnvironment(overrides: Partial<LiveEnvironment> = {}): LiveEnvironment {
  return {
    repository: 'flow-portal',
    name: 'production',
    deploymentBranchPolicy: 'all',
    branchPolicies: [],
    reviewers: { teams: [], users: [] },
    preventSelfReview: false,
    waitTimer: 0,
    ...overrides,
  };
}

/** An app declaring flow-portal's production environment with the given settings. */
function definition(props: ConstructorParameters<typeof Environment>[2] = {}) {
  const app = new App();
  const org = new Organization(app, 'acme', { login: 'acme' });
  const deck = new Repository(org, 'flow-portal');
  new Environment(deck, 'production', props);
  return { app, deck };
}

describe('synthesis', () => {
  test('refuses what GitHub would refuse', () => {
    expect(() => synthesize(definition({ reviewers: { users: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }).app)).toThrow(
      'GitHub allows six',
    );
    expect(() => synthesize(definition({ waitTimer: 43201 }).app)).toThrow('0 to 43200');

    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsSecret(org, 'TOKEN', { visibility: 'all', environment: 'production' });
    expect(() => synthesize(app)).toThrow('but no repository');
  });
});

describe('plan and apply', () => {
  test('creates a missing environment limited to main, with its pattern', async () => {
    const { app } = definition({
      deploymentBranchPolicy: { branches: ['main'] },
      reviewers: { teams: ['platform'] },
    });
    const state = synthesize(app);
    const client = new FakeClient({
      teams: [{ id: 42, slug: 'platform', name: 'Platform', description: null, privacy: 'closed', parentSlug: null }],
    });
    const changes = plan(state, await readLiveState(client, state)).filter((c) => c.kind.includes('environment'));

    expect(changes).toEqual([
      {
        kind: 'put-environment',
        environment: {
          repository: 'flow-portal',
          name: 'production',
          deploymentBranchPolicy: { branches: ['main'] },
          reviewers: { teams: ['platform'] },
        },
        current: undefined,
        fields: [
          { field: 'deploymentBranchPolicy', from: 'all', to: 'custom' },
          { field: 'reviewers', from: [], to: ['team platform'] },
          { field: 'patterns', from: [], to: ['branch main'] },
        ],
        addPolicies: [{ name: 'main', type: 'branch' }],
      },
    ]);

    await apply(client, 'acme', changes, await readLiveState(client, state));
    expect(client.callsTo('putEnvironment')).toEqual([
      {
        repo: 'flow-portal',
        name: 'production',
        settings: {
          deploymentBranchPolicy: 'custom',
          reviewers: [{ type: 'Team', id: 42 }],
          preventSelfReview: false,
          waitTimer: 0,
        },
      },
    ]);
    expect(client.callsTo('createEnvironmentBranchPolicy')).toEqual([
      { repo: 'flow-portal', environment: 'production', name: 'main', type: 'branch' },
    ]);
  });

  test('keeps what the declaration leaves out, and removes a pattern it no longer lists', async () => {
    const { app } = definition({ deploymentBranchPolicy: { branches: ['main'] } });
    const state = synthesize(app);
    const client = new FakeClient({
      environments: {
        'flow-portal': {
          production: liveEnvironment({
            deploymentBranchPolicy: 'custom',
            branchPolicies: [
              { id: 1, name: 'main', type: 'branch' },
              { id: 2, name: 'release/*', type: 'branch' },
            ],
            reviewers: { teams: [], users: ['casey'] },
            waitTimer: 5,
          }),
        },
      },
    });

    const changes = plan(state, await readLiveState(client, state)).filter((c) => c.kind.includes('environment'));
    expect(changes).toEqual([
      {
        kind: 'delete-environment-branch-policy',
        repository: 'flow-portal',
        environment: 'production',
        policy: { id: 2, name: 'release/*', type: 'branch' },
      },
    ]);

    // A field change rewrites the rules, and the undeclared ones go back as they were.
    const retimed = synthesize(definition({ deploymentBranchPolicy: 'protected' }).app);
    await apply(
      client,
      'acme',
      plan(retimed, await readLiveState(client, retimed)),
      await readLiveState(client, retimed),
    );
    expect(client.callsTo('putEnvironment')).toEqual([
      {
        repo: 'flow-portal',
        name: 'production',
        settings: {
          deploymentBranchPolicy: 'protected',
          reviewers: [{ type: 'User', id: expect.any(Number) }],
          preventSelfReview: false,
          waitTimer: 5,
        },
      },
    ]);
  });

  test('puts secrets and variables into an environment declared in the same run', async () => {
    const { app, deck } = definition({ deploymentBranchPolicy: 'protected' });
    new ActionsSecret(deck, 'prod-TOKEN', {
      name: 'TOKEN',
      environment: 'production',
      valueFrom: 'ENVIRONMENTS_TEST_TOKEN',
    });
    new ActionsVariable(deck, 'prod-REGION', { name: 'REGION', environment: 'production', value: 'eu' });
    const state = synthesize(app);
    const client = new FakeClient({ environmentSecrets: { 'flow-portal': { staging: [{ name: 'OLD' }] } } });
    const changes = plan(state, await readLiveState(client, state));

    // The fake starts with no repositories, so flow-portal is created first.
    expect(changes.map((c) => c.kind)).toEqual([
      'create-repository',
      'put-environment',
      'create-variable',
      'put-secret',
      'delete-secret',
      'delete-environment',
    ]);
    expect(changes.slice(-2)).toEqual([
      { kind: 'delete-secret', name: 'OLD', repository: 'flow-portal', environment: 'staging' },
      // staging is not declared, and flow-portal declares an environment.
      { kind: 'delete-environment', repository: 'flow-portal', name: 'staging', secrets: 1, variables: 0 },
    ]);

    process.env.ENVIRONMENTS_TEST_TOKEN = 'hunter2';
    await apply(client, 'acme', changes, await readLiveState(client, state), { allowDelete: true });
    expect(client.callsTo('putEnvironmentSecret')).toEqual([
      { repo: 'flow-portal', environment: 'production', name: 'TOKEN', value: 'hunter2' },
    ]);
    expect(client.callsTo('deleteEnvironmentSecret')).toEqual([
      { repo: 'flow-portal', environment: 'staging', name: 'OLD' },
    ]);
    expect(client.callsTo('deleteEnvironment')).toEqual([{ repo: 'flow-portal', environment: 'staging' }]);
  });
});

describe('undeclared environments', () => {
  /** acme with flow-portal and fctl, where flow-portal declares only production. */
  function owned() {
    const { app } = definition();
    new Repository(app.node.findChild('acme') as Organization, 'fctl');
    const state = synthesize(app);
    const client = new FakeClient({
      repositories: [
        { id: 1, name: 'flow-portal' },
        { id: 2, name: 'fctl' },
      ],
      environments: {
        'flow-portal': { production: liveEnvironment(), Staging: liveEnvironment({ name: 'Staging' }) },
        fctl: { production: liveEnvironment({ repository: 'fctl' }) },
      },
      environmentVariables: { 'flow-portal': { Staging: [{ name: 'REGION', value: 'eu' }] } },
    });
    return { state, client };
  }

  test('are deleted from a repository that declares one, and kept on one that declares none', async () => {
    const { state, client } = owned();
    const deletes = plan(state, await readLiveState(client, state)).filter((c) => c.kind === 'delete-environment');
    expect(deletes).toEqual([
      { kind: 'delete-environment', repository: 'flow-portal', name: 'Staging', secrets: 0, variables: 1 },
    ]);
  });

  test('match a declaration whatever the case of the name', async () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Environment(new Repository(org, 'flow-portal'), 'STAGING');
    const state = synthesize(app);
    const client = new FakeClient({
      repositories: [{ id: 1, name: 'flow-portal' }],
      environments: { 'flow-portal': { staging: liveEnvironment({ name: 'staging' }) } },
    });
    const changes = plan(state, await readLiveState(client, state));
    expect(changes.filter((c) => c.kind === 'delete-environment')).toEqual([]);
  });

  test('are deleted only under --allow-delete=environments', async () => {
    const { state, client } = owned();
    const changes = plan(state, await readLiveState(client, state));
    await apply(client, 'acme', changes, await readLiveState(client, state), {
      allowDelete: new Set(['delete-variable']),
    });
    expect(client.callsTo('deleteEnvironment')).toEqual([]);

    await apply(client, 'acme', changes, await readLiveState(client, state), {
      allowDelete: new Set(['delete-environment']),
    });
    expect(client.callsTo('deleteEnvironment')).toEqual([{ repo: 'flow-portal', environment: 'Staging' }]);
  });
});

describe('props and methods', () => {
  /** The environment-related parts of a definition, for comparing two spellings of it. */
  function declared(app: App) {
    const state = synthesize(app);
    return {
      repositories: state.repositories,
      environments: state.environments,
      variables: state.actionsVariables,
      secrets: state.actionsSecrets,
    };
  }

  test('props, methods and nested constructs declare the same thing', () => {
    const asProps = new App();
    new Repository(new Organization(asProps, 'acme', { login: 'acme' }), 'flow-portal', {
      variable: { REGION: 'eu' },
      secret: { NPM_TOKEN: {} },
      environment: {
        production: {
          deploymentBranchPolicy: { branches: ['main'] },
          variable: { ROLE_ARN: 'arn:prod' },
          secret: { SENTRY_DSN: { valueFrom: 'PROD_SENTRY_DSN' } },
        },
      },
    });

    const asMethods = new App();
    const deck = new Repository(new Organization(asMethods, 'acme', { login: 'acme' }), 'flow-portal');
    deck.addVariable('REGION', 'eu');
    deck.addSecret('NPM_TOKEN');
    const production = deck.addEnvironment('production', { deploymentBranchPolicy: { branches: ['main'] } });
    production.addVariable('ROLE_ARN', 'arn:prod');
    production.addSecret('SENTRY_DSN', { valueFrom: 'PROD_SENTRY_DSN' });

    const asConstructs = new App();
    const repo = new Repository(new Organization(asConstructs, 'acme', { login: 'acme' }), 'flow-portal');
    new ActionsVariable(repo, 'REGION', { value: 'eu' });
    new ActionsSecret(repo, 'NPM_TOKEN');
    const env = new Environment(repo, 'production', { deploymentBranchPolicy: { branches: ['main'] } });
    new ActionsVariable(env, 'ROLE_ARN', { value: 'arn:prod' });
    new ActionsSecret(env, 'SENTRY_DSN', { valueFrom: 'PROD_SENTRY_DSN' });

    const expected = declared(asConstructs);
    expect(expected.repositories).toEqual([{ name: 'flow-portal' }]);
    expect(expected.environments).toEqual([
      { repository: 'flow-portal', name: 'production', deploymentBranchPolicy: { branches: ['main'] } },
    ]);
    expect(expected.variables).toContainEqual({
      name: 'ROLE_ARN',
      value: 'arn:prod',
      repository: 'flow-portal',
      environment: 'production',
    });
    expect(declared(asMethods)).toEqual(expected);
    expect(sortedBy(declared(asProps))).toEqual(sortedBy(expected));
  });

  test('a variable cannot sit in one environment and name another', () => {
    const app = new App();
    const deck = new Repository(new Organization(app, 'acme', { login: 'acme' }), 'flow-portal');
    new ActionsVariable(deck.addEnvironment('production'), 'X', { value: '1', environment: 'staging' });
    expect(() => synthesize(app)).toThrow('sits in environment "production" but names environment "staging"');
  });
});

describe('the same pattern elsewhere', () => {
  test('repository rulesets and branch protection, as props or methods', () => {
    const rules = [{ type: 'deletion' as const }];

    const asProps = new App();
    new Repository(new Organization(asProps, 'acme', { login: 'acme' }), 'flow-portal', {
      ruleset: { Default: { rules } },
      branchProtection: { main: { enabled: false } },
    });

    const asMethods = new App();
    const deck = new Repository(new Organization(asMethods, 'acme', { login: 'acme' }), 'flow-portal');
    deck.addRuleset('Default', { rules });
    deck.addBranchProtection('main', { enabled: false });

    const props = synthesize(asProps);
    expect(props.repositories).toEqual([{ name: 'flow-portal' }]);
    expect(props.repositoryRulesets).toEqual([
      expect.objectContaining({ name: 'Default', repository: 'flow-portal', rules }),
    ]);
    expect(props.branchProtection).toEqual([
      expect.objectContaining({ repository: 'flow-portal', branch: 'main', enabled: false }),
    ]);
    const methods = synthesize(asMethods);
    expect(methods.repositoryRulesets).toEqual(props.repositoryRulesets);
    expect(methods.branchProtection).toEqual(props.branchProtection);
  });

  test('every organization-scoped construct, as props or methods', () => {
    const asProps = new App();
    new Organization(asProps, 'acme', {
      login: 'acme',
      variable: { REGION: { value: 'eu', visibility: 'all' } },
      secret: { NPM_TOKEN: { visibility: 'private' } },
      ruleset: { guard: { rules: [{ type: 'deletion' }] } },
      runnerGroup: { deploy: { visibility: 'selected', selectedRepositories: ['flow-portal'] } },
      customProperty: { tier: { valueType: 'string' } },
      codeSecurityConfiguration: { baseline: { description: 'Baseline' } },
      organizationRole: { all_repo_read: { teams: ['auditors'] } },
      customRepositoryRole: {
        Jumper: { baseRole: 'push', description: 'Jumps the queue', permissions: ['jump_merge_queue'] },
      },
    });

    const asMethods = new App();
    const org = new Organization(asMethods, 'acme', { login: 'acme' });
    org.addVariable('REGION', { value: 'eu', visibility: 'all' });
    org.addSecret('NPM_TOKEN', { visibility: 'private' });
    org.addRuleset('guard', { rules: [{ type: 'deletion' }] });
    org.addRunnerGroup('deploy', { visibility: 'selected', selectedRepositories: ['flow-portal'] });
    org.addCustomProperty('tier', { valueType: 'string' });
    org.addCodeSecurityConfiguration('baseline', { description: 'Baseline' });
    org.addOrganizationRole('all_repo_read', { teams: ['auditors'] });
    org.addCustomRepositoryRole('Jumper', {
      baseRole: 'push',
      description: 'Jumps the queue',
      permissions: ['jump_merge_queue'],
    });

    const props = synthesize(asProps);
    for (const collection of [
      'actionsVariables',
      'actionsSecrets',
      'rulesets',
      'runnerGroups',
      'customProperties',
      'codeSecurityConfigurations',
      'organizationRoles',
      'customRepositoryRoles',
    ] as const) {
      expect(props[collection]).toHaveLength(1);
    }
    expect(synthesize(asMethods)).toEqual(props);
  });
});

/** Props create the environment before the repository-wide entries, so compare order-free. */
function sortedBy<T extends Record<string, unknown[] | undefined>>(state: T): T {
  const key = (x: unknown) => JSON.stringify(x);
  return Object.fromEntries(
    Object.entries(state).map(([k, v]) => [k, v ? [...v].sort((a, b) => key(a).localeCompare(key(b))) : v]),
  ) as T;
}

describe('reading the environments of owned repositories', () => {
  // Variables scoped by name own each repository's environments without
  // declaring the repository, which would mark it as one this run creates.
  function owning(repositories: string[]) {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    for (const name of repositories) {
      new ActionsVariable(org, `REGION_${name}`.replace(/-/g, '_'), {
        repository: name,
        value: 'eu-west-1',
      });
    }
    return synthesize(app);
  }

  test('lists them for every repository in one call', async () => {
    const client = new FakeClient({});
    await readLiveState(client, owning(['deck', 'pad']));
    expect(client.callsTo('listEnvironmentsOfRepositories')).toEqual([['deck', 'pad']]);
  });

  test('a repository GitHub does not find fails the read', async () => {
    const client = new FakeClient({ missingRepositories: ['typo'] });
    await expect(readLiveState(client, owning(['typo']))).rejects.toThrow('Repository "typo" was not found');
  });
});

describe('an environment delete in the plan', () => {
  const line = (secrets?: number, variables?: number) =>
    renderPlan([{ kind: 'delete-environment', repository: 'flow-portal', name: 'staging', secrets, variables }]).split(
      '\n',
    )[0];

  test('says what goes with it', () => {
    expect(line(2, 1)).toBe(
      '  - flow-portal environment staging, with 2 secrets and 1 variable   (requires --allow-delete)',
    );
    expect(line(0, 0)).toBe('  - flow-portal environment staging   (requires --allow-delete)');
  });

  test('names its secrets and variables without a count where they were not read', () => {
    expect(line(undefined, undefined)).toBe(
      '  - flow-portal environment staging, with its secrets and its variables   (requires --allow-delete)',
    );
  });
});
