import { describe, expect, test } from 'bun:test';
import type { LiveEnvironment } from '../src/github/client.ts';
import {
  ActionsSecret,
  ActionsVariable,
  App,
  Environment,
  Organization,
  Repository,
} from '../src/index.ts';
import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

function liveEnvironment(overrides: Partial<LiveEnvironment> = {}): LiveEnvironment {
  return {
    repository: 'flight-deck',
    name: 'production',
    deploymentBranchPolicy: 'all',
    branchPolicies: [],
    reviewers: { teams: [], users: [] },
    preventSelfReview: false,
    waitTimer: 0,
    ...overrides,
  };
}

/** An app declaring flight-deck's production environment with the given settings. */
function definition(props: ConstructorParameters<typeof Environment>[2] = {}) {
  const app = new App();
  const org = new Organization(app, 'acme', { login: 'acme' });
  const deck = new Repository(org, 'flight-deck');
  new Environment(deck, 'production', props);
  return { app, deck };
}

describe('synthesis', () => {
  test('refuses what GitHub would refuse', () => {
    expect(() =>
      synthesize(definition({ reviewers: { users: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }).app),
    ).toThrow('GitHub allows six');
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
          repository: 'flight-deck',
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
        repo: 'flight-deck',
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
      { repo: 'flight-deck', environment: 'production', name: 'main', type: 'branch' },
    ]);
  });

  test('keeps what the declaration leaves out, and removes a pattern it no longer lists', async () => {
    const { app } = definition({ deploymentBranchPolicy: { branches: ['main'] } });
    const state = synthesize(app);
    const client = new FakeClient({
      environments: {
        'flight-deck': {
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
        repository: 'flight-deck',
        environment: 'production',
        policy: { id: 2, name: 'release/*', type: 'branch' },
      },
    ]);

    // A field change rewrites the rules, and the undeclared ones go back as they were.
    const retimed = synthesize(definition({ deploymentBranchPolicy: 'protected' }).app);
    await apply(client, 'acme', plan(retimed, await readLiveState(client, retimed)), await readLiveState(client, retimed));
    expect(client.callsTo('putEnvironment')).toEqual([
      {
        repo: 'flight-deck',
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
    new ActionsSecret(deck, 'prod-TOKEN', { name: 'TOKEN', environment: 'production', valueFrom: 'ENVIRONMENTS_TEST_TOKEN' });
    new ActionsVariable(deck, 'prod-REGION', { name: 'REGION', environment: 'production', value: 'eu' });
    const state = synthesize(app);
    const client = new FakeClient({ environmentSecrets: { 'flight-deck': { staging: [{ name: 'OLD' }] } } });
    const changes = plan(state, await readLiveState(client, state));

    // The fake starts with no repositories, so flight-deck is created first.
    expect(changes.map((c) => c.kind)).toEqual([
      'create-repository',
      'put-environment',
      'create-variable',
      'put-secret',
      'delete-secret',
    ]);
    expect(changes.at(-1)).toEqual({ kind: 'delete-secret', name: 'OLD', repository: 'flight-deck', environment: 'staging' });

    process.env.ENVIRONMENTS_TEST_TOKEN = 'hunter2';
    await apply(client, 'acme', changes, await readLiveState(client, state), { allowDelete: true });
    expect(client.callsTo('putEnvironmentSecret')).toEqual([
      { repo: 'flight-deck', environment: 'production', name: 'TOKEN', value: 'hunter2' },
    ]);
    expect(client.callsTo('deleteEnvironmentSecret')).toEqual([
      { repo: 'flight-deck', environment: 'staging', name: 'OLD' },
    ]);
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
    new Repository(new Organization(asProps, 'acme', { login: 'acme' }), 'flight-deck', {
      variables: { REGION: 'eu' },
      secrets: { NPM_TOKEN: {} },
      environments: {
        production: {
          deploymentBranchPolicy: { branches: ['main'] },
          variables: { ROLE_ARN: 'arn:prod' },
          secrets: { SENTRY_DSN: { valueFrom: 'PROD_SENTRY_DSN' } },
        },
      },
    });

    const asMethods = new App();
    const deck = new Repository(new Organization(asMethods, 'acme', { login: 'acme' }), 'flight-deck');
    deck.addVariable('REGION', 'eu');
    deck.addSecret('NPM_TOKEN');
    const production = deck.addEnvironment('production', { deploymentBranchPolicy: { branches: ['main'] } });
    production.addVariable('ROLE_ARN', 'arn:prod');
    production.addSecret('SENTRY_DSN', { valueFrom: 'PROD_SENTRY_DSN' });

    const asConstructs = new App();
    const repo = new Repository(new Organization(asConstructs, 'acme', { login: 'acme' }), 'flight-deck');
    new ActionsVariable(repo, 'REGION', { value: 'eu' });
    new ActionsSecret(repo, 'NPM_TOKEN');
    const env = new Environment(repo, 'production', { deploymentBranchPolicy: { branches: ['main'] } });
    new ActionsVariable(env, 'ROLE_ARN', { value: 'arn:prod' });
    new ActionsSecret(env, 'SENTRY_DSN', { valueFrom: 'PROD_SENTRY_DSN' });

    const expected = declared(asConstructs);
    expect(expected.repositories).toEqual([{ name: 'flight-deck' }]);
    expect(expected.environments).toEqual([
      { repository: 'flight-deck', name: 'production', deploymentBranchPolicy: { branches: ['main'] } },
    ]);
    expect(expected.variables).toContainEqual({
      name: 'ROLE_ARN',
      value: 'arn:prod',
      repository: 'flight-deck',
      environment: 'production',
    });
    expect(declared(asMethods)).toEqual(expected);
    expect(sortedBy(declared(asProps))).toEqual(sortedBy(expected));
  });

  test('a variable cannot sit in one environment and name another', () => {
    const app = new App();
    const deck = new Repository(new Organization(app, 'acme', { login: 'acme' }), 'flight-deck');
    new ActionsVariable(deck.addEnvironment('production'), 'X', { value: '1', environment: 'staging' });
    expect(() => synthesize(app)).toThrow('sits in environment "production" but names environment "staging"');
  });
});

/** Props create the environment before the repository-wide entries, so compare order-free. */
function sortedBy<T extends Record<string, unknown[] | undefined>>(state: T): T {
  const key = (x: unknown) => JSON.stringify(x);
  return Object.fromEntries(
    Object.entries(state).map(([k, v]) => [k, v ? [...v].sort((a, b) => key(a).localeCompare(key(b))) : v]),
  ) as T;
}
