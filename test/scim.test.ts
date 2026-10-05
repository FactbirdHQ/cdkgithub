import { describe, expect, test } from 'bun:test';

import type {
  EntraClient,
  EntraGroupAssignment,
  EntraServicePrincipal,
  EntraSynchronizationJob,
} from '../src/entra/graph.ts';
import { setUpScimProvisioning } from '../src/entra/scim-setup.ts';
import { App, Organization, ScimProvisioning, Team, UserAccount } from '../src/index.ts';
import type { ScimProvisioningManifest } from '../src/synth/scim.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

describe('synthesis', () => {
  test('derives the group list from the teams and fills the defaults', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'engineering', { externalGroup: { name: 'GH-Engineering' } });
    new Team(org, 'platform', { externalGroup: { name: 'GH-Platform' } });
    new Team(org, 'unbound', {});
    new ScimProvisioning(org, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
    });

    expect(synthesize(app).scim).toEqual({
      tenantId: 'contoso.onmicrosoft.com',
      applicationDisplayName: 'GitHub SCIM (acme)',
      tokenFrom: 'GITHUB_SCIM_TOKEN',
      groups: ['GH-Engineering', 'GH-Platform'],
    });
  });

  test('explicit groups override the derived list', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'engineering', { externalGroup: { name: 'GH-Engineering' } });
    new ScimProvisioning(org, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
      groups: ['GH-Everyone'],
    });
    expect(synthesize(app).scim?.groups).toEqual(['GH-Everyone']);
  });

  test('a declaration that provisions nothing is an error', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'engineering', {});
    new ScimProvisioning(org, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
    });
    expect(() => synthesize(app)).toThrow('resolves to no groups');
  });

  test('one application provisions the organization', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'engineering', { externalGroup: { name: 'GH-Engineering' } });
    new ScimProvisioning(org, 'a', { tenantId: 't' });
    new ScimProvisioning(org, 'b', { tenantId: 't' });
    expect(() => synthesize(app)).toThrow('at most one ScimProvisioning');
  });

  test('a personal account has no organization to provision into', () => {
    const app = new App();
    const me = new UserAccount(app, 'casey', { login: 'casey' });
    new ScimProvisioning(me, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
      groups: ['GH-Everyone'],
    });
    expect(() => synthesize(app)).toThrow('ScimProvisioning');
  });

  test('the manifest names the token source and never a token', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'engineering', { externalGroup: { name: 'GH-Engineering' } });
    new ScimProvisioning(org, 'entra', {
      tenantId: 'contoso.onmicrosoft.com',
      tokenFrom: 'ACME_SCIM_PAT',
    });
    const scim = synthesize(app).scim!;
    expect(scim.tokenFrom).toBe('ACME_SCIM_PAT');
    expect(Object.keys(scim)).not.toContain('token');
  });
});

// ---------------------------------------------------------------------------
// The setup run
// ---------------------------------------------------------------------------

/** In-memory Entra: reads answer from state, writes are recorded. */
class FakeEntra implements EntraClient {
  tenant = { id: 'tenant-guid', domains: ['contoso.onmicrosoft.com'] };
  servicePrincipals: EntraServicePrincipal[] = [];
  jobs: Record<string, EntraSynchronizationJob[]> = {};
  groups: Record<string, string> = {};
  assignments: Record<string, EntraGroupAssignment[]> = {};
  calls: Array<{ method: string; args: unknown }> = [];

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  mutations(): string[] {
    const reads = new Set([
      'describeTenant',
      'findServicePrincipal',
      'listSynchronizationJobs',
      'findGroupId',
      'listAssignedGroups',
    ]);
    return this.calls.map((c) => c.method).filter((m) => !reads.has(m));
  }

  async describeTenant() {
    this.record('describeTenant', {});
    return this.tenant;
  }

  async findServicePrincipal(displayName: string) {
    this.record('findServicePrincipal', displayName);
    return this.servicePrincipals[0];
  }

  async instantiateGalleryApplication(displayName: string) {
    this.record('instantiateGalleryApplication', displayName);
    const created: EntraServicePrincipal = {
      id: 'sp-1',
      appId: 'app-1',
      appRoles: [{ id: 'role-user', displayName: 'User', isEnabled: true }],
    };
    this.servicePrincipals.push(created);
    return created;
  }

  async listSynchronizationJobs(servicePrincipalId: string) {
    this.record('listSynchronizationJobs', servicePrincipalId);
    return this.jobs[servicePrincipalId] ?? [];
  }

  async createSynchronizationJob(servicePrincipalId: string) {
    this.record('createSynchronizationJob', servicePrincipalId);
    return { id: 'job-1' };
  }

  async setSynchronizationSecrets(servicePrincipalId: string, tenantUrl: string, secretToken: string) {
    this.record('setSynchronizationSecrets', {
      servicePrincipalId,
      tenantUrl,
      secretToken,
    });
  }

  async startSynchronizationJob(servicePrincipalId: string, jobId: string) {
    this.record('startSynchronizationJob', { servicePrincipalId, jobId });
  }

  async findGroupId(displayName: string) {
    this.record('findGroupId', displayName);
    return this.groups[displayName];
  }

  async listAssignedGroups(servicePrincipalId: string) {
    this.record('listAssignedGroups', servicePrincipalId);
    return this.assignments[servicePrincipalId] ?? [];
  }

  async assignGroup(servicePrincipal: EntraServicePrincipal, groupId: string) {
    this.record('assignGroup', {
      servicePrincipalId: servicePrincipal.id,
      appRoleId: servicePrincipal.appRoles[0]?.id,
      groupId,
    });
  }
}

const manifest: ScimProvisioningManifest = {
  tenantId: 'contoso.onmicrosoft.com',
  applicationDisplayName: 'GitHub SCIM (acme)',
  tokenFrom: 'SCIM_TEST_TOKEN',
  groups: ['GH-Engineering', 'GH-Platform'],
};

function options(overrides: { yes?: boolean; env?: Record<string, string | undefined> }) {
  return {
    yes: overrides.yes ?? false,
    env: overrides.env ?? {},
    log: () => {},
  };
}

/** An Entra that already matches the declaration end to end. */
function configuredEntra(): FakeEntra {
  const entra = new FakeEntra();
  entra.servicePrincipals = [{ id: 'sp-1', appId: 'app-1', appRoles: [] }];
  entra.jobs = { 'sp-1': [{ id: 'job-1', state: 'Active' }] };
  entra.groups = { 'GH-Engineering': 'g-eng', 'GH-Platform': 'g-plat' };
  entra.assignments = {
    'sp-1': [
      { groupId: 'g-eng', displayName: 'GH-Engineering' },
      { groupId: 'g-plat', displayName: 'GH-Platform' },
    ],
  };
  return entra;
}

describe('setUpScimProvisioning', () => {
  test('a fresh tenant gets the whole plan, and a dry run writes nothing', async () => {
    const entra = new FakeEntra();
    entra.groups = { 'GH-Engineering': 'g-eng', 'GH-Platform': 'g-plat' };

    const result = await setUpScimProvisioning(entra, 'acme', manifest, options({}));

    expect(result.actions).toEqual([
      'create enterprise application "GitHub SCIM (acme)" from GitHub\'s gallery template',
      'create the provisioning job',
      'write its credentials: https://api.github.com/scim/v2/organizations/acme, token from $SCIM_TEST_TOKEN',
      'assign group "GH-Engineering" to the application',
      'assign group "GH-Platform" to the application',
      'start provisioning',
    ]);
    expect(result.notes).toEqual(['--yes will need $SCIM_TEST_TOKEN exported']);
    expect(entra.mutations()).toEqual([]);
  });

  test('--yes performs the plan in order, sealing the token out of the report', async () => {
    const entra = new FakeEntra();
    entra.groups = { 'GH-Engineering': 'g-eng', 'GH-Platform': 'g-plat' };

    const result = await setUpScimProvisioning(
      entra,
      'acme',
      manifest,
      options({ yes: true, env: { SCIM_TEST_TOKEN: 'ghp_secret' } }),
    );

    expect(entra.mutations()).toEqual([
      'instantiateGalleryApplication',
      'createSynchronizationJob',
      'setSynchronizationSecrets',
      'assignGroup',
      'assignGroup',
      'startSynchronizationJob',
    ]);
    expect(entra.callsTo('setSynchronizationSecrets')).toEqual([
      {
        servicePrincipalId: 'sp-1',
        tenantUrl: 'https://api.github.com/scim/v2/organizations/acme',
        secretToken: 'ghp_secret',
      },
    ]);
    // The group lands in the app's "User" role.
    expect(entra.callsTo('assignGroup')[0]).toEqual({
      servicePrincipalId: 'sp-1',
      appRoleId: 'role-user',
      groupId: 'g-eng',
    });
    // What the operator reads back never carries the token.
    expect(JSON.stringify(result)).not.toContain('ghp_secret');
  });

  test('--yes without the token refuses before writing anything', async () => {
    const entra = new FakeEntra();
    entra.groups = { 'GH-Engineering': 'g-eng', 'GH-Platform': 'g-plat' };
    await expect(setUpScimProvisioning(entra, 'acme', manifest, options({ yes: true }))).rejects.toThrow(
      '$SCIM_TEST_TOKEN',
    );
    expect(entra.mutations()).toEqual([]);
  });

  test('a configured tenant is zero actions, with the rotation note', async () => {
    const result = await setUpScimProvisioning(configuredEntra(), 'acme', manifest, options({}));
    expect(result.actions).toEqual([]);
    expect(result.notes).toEqual(['credentials kept as stored; export $SCIM_TEST_TOKEN to rotate them']);
  });

  test('an exported token on a configured tenant means rotation', async () => {
    const entra = configuredEntra();
    const result = await setUpScimProvisioning(
      entra,
      'acme',
      manifest,
      options({ yes: true, env: { SCIM_TEST_TOKEN: 'ghp_rotated' } }),
    );
    expect(result.actions).toEqual(['refresh the provisioning credentials from $SCIM_TEST_TOKEN']);
    expect(entra.mutations()).toEqual(['setSynchronizationSecrets']);
  });

  test('a paused job is started', async () => {
    const entra = configuredEntra();
    entra.jobs = { 'sp-1': [{ id: 'job-1', state: 'Paused' }] };
    const result = await setUpScimProvisioning(entra, 'acme', manifest, options({ yes: true }));
    expect(result.actions).toEqual(['start provisioning (job state is Paused)']);
    expect(entra.mutations()).toEqual(['startSynchronizationJob']);
  });

  test('a group Entra does not have fails whole, before any write', async () => {
    const entra = new FakeEntra();
    entra.groups = { 'GH-Engineering': 'g-eng' };
    await expect(
      setUpScimProvisioning(entra, 'acme', manifest, options({ yes: true, env: { SCIM_TEST_TOKEN: 'x' } })),
    ).rejects.toThrow('"GH-Platform"');
    expect(entra.mutations()).toEqual([]);
  });

  test('a group assigned outside the definition is reported, never removed', async () => {
    const entra = configuredEntra();
    entra.assignments['sp-1']!.push({
      groupId: 'g-extra',
      displayName: 'GH-Contractors',
    });
    const result = await setUpScimProvisioning(entra, 'acme', manifest, options({ yes: true }));
    expect(result.notes).toContain('assigned outside this definition, left alone: "GH-Contractors"');
    expect(entra.mutations()).toEqual([]);
  });

  test('the wrong tenant is a refusal, not a surprise', async () => {
    const entra = configuredEntra();
    entra.tenant = { id: 'other-tenant', domains: ['fabrikam.com'] };
    await expect(setUpScimProvisioning(entra, 'acme', manifest, options({ yes: true }))).rejects.toThrow(
      'fabrikam.com',
    );
    expect(entra.mutations()).toEqual([]);
  });
});
