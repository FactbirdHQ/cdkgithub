import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importOrganization } from '../src/import/import-org.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

/** An organization with one of everything the importer covers. */
function orgClient(): FakeClient {
  return new FakeClient({
    teams: [
      {
        id: 1,
        slug: 'engineering',
        name: 'Engineering',
        description: 'All engineers',
        privacy: 'closed',
        parentSlug: null,
      },
      {
        id: 2,
        slug: 'platform',
        name: 'Platform',
        description: null,
        privacy: 'closed',
        parentSlug: 'engineering',
      },
    ],
    teamRepositories: {
      engineering: [{ name: 'nest', roleName: 'write' }],
      platform: [{ name: 'flight-deck', roleName: 'Merge Queue Jumper' }],
    },
    teamMembers: {
      // ada is really platform's; GitHub reports her on the parent too.
      engineering: [
        { login: 'casey', role: 'maintainer', inherited: false },
        { login: 'ada', role: 'member', inherited: false },
      ],
      platform: [{ login: 'ada', role: 'member', inherited: false }],
    },
    settings: { defaultRepositoryPermission: 'read' },
    actions: {
      enabledRepositories: 'all',
      allowedActions: 'local_only',
      defaultWorkflowPermissions: 'read',
      canApprovePullRequestReviews: false,
    },
    customRepositoryRoles: [
      {
        id: 3,
        name: 'Merge Queue Jumper',
        baseRole: 'write',
        description: 'Jumps the queue',
        permissions: ['jump_merge_queue'],
      },
    ],
    organizationRoles: [
      { id: 11, name: 'security_manager', permissions: [] },
      { id: 12, name: 'unassigned_role', permissions: [] },
    ],
    roleAssignments: {
      11: { teams: ['platform'], users: ['casey'] },
      12: { teams: [], users: [] },
    },
    rulesets: [
      {
        id: 7,
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'deletion' }],
        bypassActors: [
          { actorType: 'Team', actorId: 2, bypassMode: 'always' },
          { actorType: 'Integration', actorId: 99, bypassMode: 'always' },
        ],
        sourceType: 'Organization',
      },
      {
        id: 8,
        name: 'from-enterprise',
        target: 'branch',
        enforcement: 'active',
        rules: [],
        bypassActors: [],
        sourceType: 'Enterprise',
      },
    ],
    appInstallations: [{ id: 1, appId: 99, slug: 'renovate', repositorySelection: 'all' }],
    securityConfigurations: [
      {
        id: 20,
        name: 'baseline',
        description: 'Baseline',
        secretScanning: 'enabled',
        targetType: 'organization',
      },
      { id: 21, name: 'GitHub recommended', targetType: 'global' },
    ],
    defaultSecurityConfigurations: [
      { defaultForNewRepos: 'all', configurationId: 20, configurationName: 'baseline' },
    ],
    customProperties: [
      {
        name: 'tier',
        valueType: 'single_select',
        required: false,
        allowedValues: ['tier-1', 'tier-2'],
      },
    ],
    repositoryProperties: [
      { repository: 'flight-deck', properties: { tier: 'tier-1' } },
      { repository: 'nest', properties: { tier: null } },
    ],
    issueFields: [
      {
        id: 4,
        name: 'Priority',
        dataType: 'single_select',
        description: null,
        visibility: 'organization_members_only',
        options: [
          { id: 40, name: 'P0', description: 'Drop everything', color: 'red' },
          { id: 41, name: 'P1', description: null, color: 'gray' },
        ],
      },
    ],
    runnerGroups: [
      {
        id: 5,
        name: 'deploy-runners',
        visibility: 'selected',
        isDefault: false,
        allowsPublicRepositories: false,
        restrictedToWorkflows: false,
        selectedWorkflows: [],
        selectedRepositories: ['flight-deck'],
      },
    ],
    orgVariables: [
      { name: 'REGION', value: 'eu-west-1', visibility: 'all' },
    ],
    orgSecrets: [{ name: 'NPM_TOKEN', visibility: 'private' }],
  });
}

describe('importOrganization', () => {
  test('round-trips through synth into a manifest that mirrors the live org', async () => {
    const code = await importOrganization(orgClient(), 'acme');

    // The generated file targets examples/; retarget its import and outdir so
    // it synthesizes here, into a scratch directory.
    const dir = mkdtempSync(join(tmpdir(), 'cdkgithub-import-'));
    const indexUrl = pathToFileURL(
      join(import.meta.dir, '../src/index.ts'),
    ).href;
    const definition = code
      .replace('"../src/index.ts"', JSON.stringify(indexUrl))
      .replace('new App()', `new App({ outdir: ${JSON.stringify(dir)} })`);
    const file = join(dir, 'acme.ts');
    writeFileSync(file, definition);
    await import(pathToFileURL(file).href);

    const state = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as DesiredState;

    expect(state.owner).toBe('acme');
    expect(state.settings).toEqual({ defaultRepositoryPermission: 'read' });

    // The hierarchy nests, the roster narrows to direct members, and the
    // friendly role names come back as the permissions the API takes.
    expect(state.teams).toEqual([
      expect.objectContaining({
        slug: 'engineering',
        maintainers: ['casey'],
        repositories: { nest: 'push' },
      }),
      expect.objectContaining({
        slug: 'platform',
        parentSlug: 'engineering',
        members: ['ada'],
        repositories: { 'flight-deck': 'Merge Queue Jumper' },
      }),
    ]);

    expect(state.actions).toEqual(
      expect.objectContaining({ allowedActions: 'local_only' }),
    );
    expect(state.customRepositoryRoles).toEqual([
      expect.objectContaining({ name: 'Merge Queue Jumper', baseRole: 'push' }),
    ]);
    expect(state.organizationRoles).toEqual([
      { name: 'security_manager', teams: ['platform'], users: ['casey'] },
    ]);

    // One ruleset: the enterprise one is inherited, not declared, and the
    // bypass actors come back as names.
    expect(state.rulesets).toEqual([
      expect.objectContaining({
        name: 'protect-main',
        bypassActors: [
          { actorType: 'Team', team: 'platform', bypassMode: 'always' },
          { actorType: 'Integration', app: 'renovate', bypassMode: 'always' },
        ],
      }),
    ]);

    expect(state.codeSecurityConfigurations).toEqual([
      expect.objectContaining({
        name: 'baseline',
        secretScanning: 'enabled',
        defaultForNewRepos: 'all',
      }),
    ]);
    expect(state.customProperties).toEqual([
      expect.objectContaining({
        name: 'tier',
        values: { 'flight-deck': 'tier-1' },
      }),
    ]);
    expect(state.issueFields).toEqual([
      {
        name: 'Priority',
        dataType: 'single_select',
        visibility: 'organization_members_only',
        options: [
          { name: 'P0', description: 'Drop everything', color: 'red' },
          { name: 'P1' },
        ],
      },
    ]);
    expect(state.runnerGroups).toEqual([
      expect.objectContaining({
        name: 'deploy-runners',
        visibility: 'selected',
        selectedRepositories: ['flight-deck'],
      }),
    ]);
    expect(state.actionsVariables).toEqual([
      expect.objectContaining({ name: 'REGION', value: 'eu-west-1' }),
    ]);
    expect(state.actionsSecrets).toEqual([
      expect.objectContaining({
        name: 'NPM_TOKEN',
        valueFrom: 'NPM_TOKEN',
        visibility: 'private',
      }),
    ]);
  });

  test('an unreadable surface is skipped and named, not fatal', async () => {
    const client = orgClient();
    client.listRunnerGroups = async () => {
      throw new Error('Runner groups require a paid plan');
    };
    const code = await importOrganization(client, 'acme');
    expect(code).toContain('runner groups (Runner groups require a paid plan)');
    expect(code).not.toContain('new RunnerGroup');
  });

  test('walks the repositories only when asked, and round-trips them', async () => {
    const client = orgClient();
    client.repositories = [
      { id: 1, name: 'flight-deck' },
      { id: 2, name: 'nest' },
      { id: 3, name: 'empty-repo' },
    ];
    client.repositoryRulesets = {
      'flight-deck': [
        {
          id: 30,
          name: 'merge-queue',
          target: 'branch',
          enforcement: 'active',
          conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
          rules: [{ type: 'required_linear_history' }],
          bypassActors: [{ actorType: 'Team', actorId: 2, bypassMode: 'always' }],
          sourceType: 'Repository',
        },
      ],
    };
    client.repositoryVariables = {
      nest: [{ name: 'SENTRY_PROJECT', value: 'nest' }],
    };
    client.repositorySecrets = {
      nest: [{ name: 'SENTRY_DSN' }],
    };

    const withoutWalk = await importOrganization(client, 'acme');
    expect(withoutWalk).not.toContain('new Repository(');

    const code = await importOrganization(client, 'acme', {
      repositories: true,
    });
    // A repository with nothing of its own stays out of the file.
    expect(code).not.toContain('empty-repo');

    const dir = mkdtempSync(join(tmpdir(), 'cdkgithub-import-'));
    const indexUrl = pathToFileURL(
      join(import.meta.dir, '../src/index.ts'),
    ).href;
    const file = join(dir, 'acme.ts');
    writeFileSync(
      file,
      code
        .replace('"../src/index.ts"', JSON.stringify(indexUrl))
        .replace('new App()', `new App({ outdir: ${JSON.stringify(dir)} })`),
    );
    await import(pathToFileURL(file).href);
    const state = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as DesiredState;

    expect(state.repositories).toEqual([
      { name: 'flight-deck' },
      { name: 'nest' },
    ]);
    expect(state.repositoryRulesets).toEqual([
      expect.objectContaining({
        repository: 'flight-deck',
        name: 'merge-queue',
        bypassActors: [
          { actorType: 'Team', team: 'platform', bypassMode: 'always' },
        ],
      }),
    ]);
    expect(state.actionsVariables).toEqual([
      expect.objectContaining({ name: 'REGION', value: 'eu-west-1' }),
      expect.objectContaining({
        name: 'SENTRY_PROJECT',
        value: 'nest',
        repository: 'nest',
      }),
    ]);
    expect(state.actionsSecrets).toEqual([
      expect.objectContaining({ name: 'NPM_TOKEN' }),
      expect.objectContaining({
        name: 'SENTRY_DSN',
        valueFrom: 'SENTRY_DSN',
        repository: 'nest',
      }),
    ]);
  });

  test('a repository list scopes the walk to the named ones', async () => {
    const client = orgClient();
    client.repositories = [
      { id: 1, name: 'flight-deck' },
      { id: 2, name: 'nest' },
    ];
    client.repositoryVariables = {
      'flight-deck': [{ name: 'A', value: '1' }],
      nest: [{ name: 'B', value: '2' }],
    };
    const code = await importOrganization(client, 'acme', {
      repositories: ['flight-deck'],
    });
    expect(code).toContain('new Repository(org, "flight-deck")');
    expect(code).not.toContain('new Repository(org, "nest")');
  });

  test('a surface a repository refuses is reported once, naming the repositories', async () => {
    const client = orgClient();
    client.repositories = [
      { id: 1, name: 'flight-deck' },
      { id: 2, name: 'nest' },
    ];
    client.repositoryVariables = {
      'flight-deck': [{ name: 'A', value: '1' }],
    };
    client.listRepositorySecrets = async () => {
      throw new Error('needs the secrets scope');
    };
    const code = await importOrganization(client, 'acme', {
      repositories: true,
    });
    expect(code).toContain(
      'repository secrets on flight-deck, nest (needs the secrets scope)',
    );
    // The other surfaces still land.
    expect(code).toContain('new ActionsVariable(flightDeck, "A"');
  });

  test('a team slug that collides with a keyword still emits legal code', async () => {
    const client = new FakeClient({
      teams: [
        {
          id: 1,
          slug: 'new',
          name: 'New',
          description: null,
          privacy: 'closed',
          parentSlug: null,
        },
        {
          id: 2,
          slug: 'child',
          name: 'Child',
          description: null,
          privacy: 'closed',
          parentSlug: 'new',
        },
      ],
    });
    const code = await importOrganization(client, 'acme');
    expect(code).toContain('const teamNew = new Team(org, "new"');
    expect(code).toContain('new Team(teamNew, "child"');
  });
});
