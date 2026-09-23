import { describe, expect, test } from 'bun:test';
import { apply, describeChange } from '../src/reconcile/applier.ts';
import {
  type Change,
  DELETE_SCOPES,
  DESTRUCTIVE_KINDS,
  isDestructive,
} from '../src/reconcile/changes.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { renderPlan, summarize } from '../src/reconcile/render.ts';
import { FakeClient, type FakeClientState } from './fake-client.ts';

/**
 * One representative change per kind. A kind added to the union without a row
 * here fails the completeness test below, which is the point: every kind must
 * render in the plan, describe itself in the journal, and count in the summary.
 */
const SAMPLES: Record<Change['kind'], Change> = {
  create: {
    kind: 'create',
    team: { slug: 'new-team', name: 'New Team', privacy: 'closed' },
  },
  update: {
    kind: 'update',
    slug: 'old',
    team: { slug: 'old', name: 'Old', privacy: 'closed' },
    fields: [{ field: 'name', from: 'a', to: 'Old' }],
  },
  delete: {
    kind: 'delete',
    live: {
      id: 1,
      slug: 'gone',
      name: 'Gone',
      description: null,
      privacy: 'closed',
      parentSlug: null,
    },
  },
  'set-repo-access': {
    kind: 'set-repo-access',
    slug: 'team',
    repository: 'repo',
    permission: 'push',
  },
  'remove-repo-access': {
    kind: 'remove-repo-access',
    slug: 'team',
    repository: 'repo',
    from: 'push',
  },
  'set-membership': {
    kind: 'set-membership',
    slug: 'team',
    username: 'octocat',
    role: 'member',
  },
  'remove-membership': {
    kind: 'remove-membership',
    slug: 'team',
    username: 'octocat',
    from: 'member',
  },
  'link-group': {
    kind: 'link-group',
    slug: 'team',
    group: { id: 42, name: 'Team Group' },
  },
  'org-settings': {
    kind: 'org-settings',
    settings: { membersCanCreateRepositories: false },
    fields: [{ field: 'membersCanCreateRepositories', from: true, to: false }],
  },
  'actions-policy': {
    kind: 'actions-policy',
    policy: { allowedActions: 'local_only' },
    fields: [{ field: 'allowedActions', from: 'all', to: 'local_only' }],
  },
  'create-ruleset': {
    kind: 'create-ruleset',
    ruleset: {
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      rules: [{ type: 'deletion' }],
    },
  },
  'update-ruleset': {
    kind: 'update-ruleset',
    id: 7,
    ruleset: {
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      rules: [],
    },
    fields: [{ field: 'enforcement', from: 'evaluate', to: 'active' }],
  },
  'delete-ruleset': {
    kind: 'delete-ruleset',
    live: {
      id: 7,
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      rules: [],
      bypassActors: [],
      sourceType: 'Organization',
    },
  },
  'create-repo-ruleset': {
    kind: 'create-repo-ruleset',
    repository: 'app',
    ruleset: {
      name: 'merge-queue',
      target: 'branch',
      enforcement: 'active',
      rules: [{ type: 'deletion' }],
    },
  },
  'update-repo-ruleset': {
    kind: 'update-repo-ruleset',
    repository: 'app',
    id: 8,
    ruleset: {
      name: 'merge-queue',
      target: 'branch',
      enforcement: 'active',
      rules: [],
    },
    fields: [{ field: 'enforcement', from: 'evaluate', to: 'active' }],
  },
  'delete-repo-ruleset': {
    kind: 'delete-repo-ruleset',
    repository: 'app',
    live: {
      id: 8,
      name: 'merge-queue',
      target: 'branch',
      enforcement: 'active',
      rules: [],
      bypassActors: [],
      sourceType: 'Repository',
    },
  },
  'create-runner-group': {
    kind: 'create-runner-group',
    group: {
      name: 'deploy-runners',
      visibility: 'selected',
      selectedRepositories: ['app'],
    },
  },
  'update-runner-group': {
    kind: 'update-runner-group',
    id: 5,
    group: { name: 'deploy-runners', visibility: 'private' },
    fields: [{ field: 'visibility', from: 'all', to: 'private' }],
  },
  'delete-runner-group': {
    kind: 'delete-runner-group',
    live: {
      id: 5,
      name: 'deploy-runners',
      visibility: 'all',
      isDefault: false,
      allowsPublicRepositories: false,
      restrictedToWorkflows: false,
      selectedWorkflows: [],
    },
  },
  'create-variable': {
    kind: 'create-variable',
    variable: { name: 'REGION', value: 'eu-west-1', visibility: 'all' },
  },
  'update-variable': {
    kind: 'update-variable',
    variable: { name: 'REGION', value: 'eu-west-1', repository: 'app' },
    fields: [{ field: 'value', from: 'us-east-1', to: 'eu-west-1' }],
  },
  'delete-variable': {
    kind: 'delete-variable',
    name: 'REGION',
    repository: 'app',
  },
  'put-secret': {
    kind: 'put-secret',
    secret: {
      name: 'NPM_TOKEN',
      valueFrom: 'CDKGITHUB_TEST_SECRET',
      visibility: 'private',
    },
    fields: [],
    exists: false,
  },
  'delete-secret': {
    kind: 'delete-secret',
    name: 'NPM_TOKEN',
  },
  'create-security-config': {
    kind: 'create-security-config',
    config: { name: 'baseline', description: 'Baseline' },
  },
  'update-security-config': {
    kind: 'update-security-config',
    id: 9,
    config: { name: 'baseline', description: 'Baseline' },
    fields: [{ field: 'secretScanning', from: 'disabled', to: 'enabled' }],
  },
  'delete-security-config': {
    kind: 'delete-security-config',
    live: { id: 9, name: 'baseline' },
  },
  'default-security-config': {
    kind: 'default-security-config',
    configName: 'baseline',
    scope: 'all',
  },
  'attach-security-config': {
    kind: 'attach-security-config',
    configName: 'baseline',
    scope: 'all',
  },
  'create-property': {
    kind: 'create-property',
    property: { name: 'tier', valueType: 'string' },
  },
  'update-property': {
    kind: 'update-property',
    property: { name: 'tier', valueType: 'string' },
    fields: [{ field: 'required', from: false, to: true }],
  },
  'delete-property': {
    kind: 'delete-property',
    live: { name: 'tier', valueType: 'string' },
  },
  'property-values': {
    kind: 'property-values',
    propertyName: 'tier',
    values: { app: 'tier-1' },
  },
  'branch-protection': {
    kind: 'branch-protection',
    protection: { repository: 'app', branch: 'main', requiredSignatures: true },
    fields: [{ field: 'enforceAdmins', from: false, to: true }],
  },
  'remove-branch-protection': {
    kind: 'remove-branch-protection',
    repository: 'app',
    branch: 'main',
  },
  'create-repository': {
    kind: 'create-repository',
    repository: { name: 'new-repo' },
  },
  'create-repo-role': {
    kind: 'create-repo-role',
    role: {
      name: 'Deployer',
      description: 'Deploys',
      baseRole: 'read',
      permissions: ['deployments'],
    },
  },
  'update-repo-role': {
    kind: 'update-repo-role',
    id: 3,
    role: {
      name: 'Deployer',
      description: 'Deploys',
      baseRole: 'read',
      permissions: ['deployments'],
    },
    fields: [{ field: 'baseRole', from: 'write', to: 'read' }],
  },
  'delete-repo-role': {
    kind: 'delete-repo-role',
    live: { id: 3, name: 'Deployer', baseRole: 'read', permissions: [] },
  },
  'assign-org-role': {
    kind: 'assign-org-role',
    role: 'all_repo_read',
    roleId: 11,
    subject: 'team',
    name: 'auditors',
  },
  'revoke-org-role': {
    kind: 'revoke-org-role',
    role: 'all_repo_read',
    roleId: 11,
    subject: 'team',
    name: 'auditors',
  },
};

const ALL_CHANGES = Object.values(SAMPLES);

// The put-secret sample reads its value from the environment at apply time,
// which is the design under test: the value exists nowhere in the change.
process.env.CDKGITHUB_TEST_SECRET = 'shh';

/** State that lets every sample execute against the fake. */
function stateForApply(): FakeClientState {
  return {
    teams: [
      {
        id: 1,
        slug: 'gone',
        name: 'Gone',
        description: null,
        privacy: 'closed',
        parentSlug: null,
      },
    ],
    repositories: [{ id: 100, name: 'app' }],
    securityConfigurations: [{ id: 9, name: 'baseline' }],
    internalRepositoriesAllowed: false,
  };
}

function liveFor(client: FakeClient): LiveState {
  return { teams: client.teams };
}

describe('every change kind', () => {
  test('renders at least one plan line', () => {
    for (const change of ALL_CHANGES) {
      const rendered = renderPlan([change]);
      expect(rendered.split('\n')[0]!.trim()).not.toBe('');
    }
  });

  test('is counted by exactly one summary bucket', () => {
    const counts = summarize(ALL_CHANGES);
    expect(counts.create + counts.update + counts.delete + counts.link).toBe(
      ALL_CHANGES.length,
    );
  });

  test('is marked "(requires --allow-delete)" exactly when destructive', () => {
    for (const change of ALL_CHANGES) {
      const marked = renderPlan([change]).includes('requires --allow-delete');
      expect(`${change.kind}: ${marked}`).toBe(
        `${change.kind}: ${isDestructive(change)}`,
      );
    }
  });

  test('describes itself for the journal, without the fallback', () => {
    for (const change of ALL_CHANGES) {
      const description = describeChange(change);
      expect(description).not.toBe(change.kind);
      expect(description).not.toBe(`delete ${change.kind}`);
    }
  });

  test('every destructive kind has an --allow-delete scope', () => {
    expect(new Set(Object.values(DELETE_SCOPES))).toEqual(
      new Set(DESTRUCTIVE_KINDS),
    );
  });
});

describe('destructive arms', () => {
  test('every destructive kind is skipped without the gate', async () => {
    const client = new FakeClient(stateForApply());
    const destructive = ALL_CHANGES.filter(isDestructive);
    const result = await apply(client, 'acme', destructive, liveFor(client), {
      enableScim: true,
    });

    expect(result.skipped).toHaveLength(DESTRUCTIVE_KINDS.length);
    expect(result.deleted).toBe(0);
    expect(result.governance).toBe(0);
    expect(client.calls).toEqual([]);
    // The team survives.
    expect(client.teams.map((t) => t.slug)).toEqual(['gone']);
  });

  test('every destructive kind executes with the gate', async () => {
    const client = new FakeClient(stateForApply());
    const destructive = ALL_CHANGES.filter(isDestructive);
    const result = await apply(client, 'acme', destructive, liveFor(client), {
      allowDelete: true,
      enableScim: true,
    });

    expect(result.skipped).toEqual([]);
    expect(client.teams).toEqual([]);
    expect(client.callsTo('removeRepoPermission')).toHaveLength(1);
    expect(client.callsTo('removeMembership')).toHaveLength(1);
    expect(client.callsTo('deleteRuleset')).toEqual([7]);
    expect(client.callsTo('deleteSecurityConfiguration')).toEqual([9]);
    expect(client.callsTo('deleteCustomProperty')).toEqual(['tier']);
    expect(client.callsTo('deleteBranchProtection')).toEqual([
      { repo: 'app', branch: 'main' },
    ]);
    expect(client.callsTo('deleteCustomRepositoryRole')).toEqual([
      { roleId: 3 },
    ]);
    expect(client.callsTo('removeRoleFromTeam')).toEqual([
      { roleId: 11, team: 'auditors' },
    ]);
  });

  test('a scoped gate lets only its own kind through', async () => {
    const client = new FakeClient(stateForApply());
    const changes = [SAMPLES.delete, SAMPLES['remove-membership']];
    const result = await apply(client, 'acme', changes, liveFor(client), {
      allowDelete: new Set(['delete'] as const),
    });

    expect(client.teams).toEqual([]);
    expect(client.callsTo('removeMembership')).toEqual([]);
    expect(result.skipped).toEqual([
      'remove octocat from team (use --allow-delete)',
    ]);
  });
});

describe('non-destructive arms', () => {
  test('every non-destructive kind executes on a plain apply', async () => {
    const client = new FakeClient(stateForApply());
    const constructive = ALL_CHANGES.filter((c) => !isDestructive(c));
    const result = await apply(client, 'acme', constructive, liveFor(client), {
      enableScim: true,
    });

    expect(result.skipped).toEqual([]);
    expect(result.created).toBe(1);
    expect(result.linked).toBe(1);
    // The new team, its (empty) surfaces, and every governance write landed.
    expect(client.teams.some((t) => t.slug === 'new-team')).toBe(true);
    expect(client.callsTo('updateOrgSettings')).toHaveLength(1);
    expect(client.callsTo('createRuleset')).toHaveLength(1);
    expect(client.callsTo('updateRuleset')).toHaveLength(1);
    expect(client.callsTo('createSecurityConfiguration')).toHaveLength(1);
    expect(client.callsTo('updateSecurityConfiguration')).toHaveLength(1);
    expect(client.callsTo('setSecurityConfigurationAsDefault')).toHaveLength(1);
    expect(client.callsTo('attachSecurityConfiguration')).toHaveLength(1);
    expect(client.callsTo('putCustomProperty')).toHaveLength(2);
    expect(client.callsTo('setRepositoryPropertyValues')).toHaveLength(1);
    expect(client.callsTo('putBranchProtection')).toHaveLength(1);
    expect(client.callsTo('setSignatureProtection')).toEqual([
      { repo: 'app', branch: 'main', required: true },
    ]);
    expect(client.callsTo('createRepository')).toHaveLength(1);
    expect(client.callsTo('createCustomRepositoryRole')).toHaveLength(1);
    expect(client.callsTo('updateCustomRepositoryRole')).toHaveLength(1);
    expect(client.callsTo('assignRoleToTeam')).toEqual([
      { roleId: 11, team: 'auditors' },
    ]);
  });

  test('journals each change as applied, skipped, or failed', async () => {
    const client = new FakeClient(stateForApply());
    const records: Array<{ kind: string; status: string }> = [];
    await apply(
      client,
      'acme',
      [SAMPLES['set-membership'], SAMPLES.delete],
      liveFor(client),
      { onRecord: (r) => records.push({ kind: r.kind, status: r.status }) },
    );
    expect(records).toEqual([
      { kind: 'set-membership', status: 'applied' },
      { kind: 'delete', status: 'skipped' },
    ]);
  });
});
