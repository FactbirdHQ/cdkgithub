import { describe, expect, test } from 'bun:test';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from '../src/github/client.ts';

/**
 * These tests pin the client's behavior at the HTTP boundary: what it does
 * with a 404, a paginated body, and a body of the wrong shape. The stub is the
 * third constructor argument, so no network and no plugins are involved.
 */
function clientWith(stub: unknown): OctokitGitHubClient {
  return new OctokitGitHubClient('token', undefined, stub as Octokit);
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

describe('getBranchProtection', () => {
  test('a 404 with the branch present means unprotected', async () => {
    const client = clientWith({
      rest: {
        repos: {
          getBranchProtection: async () => {
            throw notFound();
          },
          getBranch: async () => ({ data: { name: 'main' } }),
        },
      },
    });
    await expect(
      client.getBranchProtection('acme', 'app', 'main'),
    ).resolves.toEqual({ repository: 'app', branch: 'main', enabled: false });
  });

  test('a 404 with the branch also missing is a failure, not "unprotected"', async () => {
    const client = clientWith({
      rest: {
        repos: {
          getBranchProtection: async () => {
            throw notFound();
          },
          // The repo does not exist, the branch does not exist, or the token
          // cannot see it; GitHub answers 404 for all three.
          getBranch: async () => {
            throw notFound();
          },
        },
      },
    });
    await expect(
      client.getBranchProtection('acme', 'typo', 'main'),
    ).rejects.toThrow('repository or branch does not exist');
  });
});

describe('listExternalGroups', () => {
  test('reads past the first page', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      group_id: i,
      group_name: `group-${i}`,
    }));
    const requests: unknown[] = [];
    const client = clientWith({
      request: async (route: string, params: { page: number }) => {
        requests.push({ route, page: params.page });
        return {
          data: {
            groups:
              params.page === 1
                ? pageOne
                : [{ group_id: 100, group_name: 'group-100' }],
          },
        };
      },
    });

    const groups = await client.listExternalGroups('acme');
    expect(groups).toHaveLength(101);
    expect(groups.at(-1)).toEqual({ id: 100, name: 'group-100' });
    expect(requests).toHaveLength(2);
  });
});

describe('wrapped list responses', () => {
  test('a body without the expected array fails instead of reading as empty', async () => {
    const client = clientWith({
      request: async () => ({ data: { message: 'maintenance' } }),
    });
    await expect(client.listOrganizationRoles('acme')).rejects.toThrow(
      'expected an array under "roles"',
    );
    await expect(client.listCustomRepositoryRoles('acme')).rejects.toThrow(
      'expected an array under "custom_roles"',
    );
    await expect(client.listExternalGroups('acme')).rejects.toThrow(
      'expected an array under "groups"',
    );
  });
});

describe('updateTeam', () => {
  test("returns the slug GitHub derived, not the caller's guess", async () => {
    const client = clientWith({
      rest: {
        teams: {
          updateInOrg: async () => ({
            data: {
              id: 7,
              slug: 'infra-1',
              name: 'Infra',
              description: null,
              privacy: 'closed',
              parent: null,
            },
          }),
        },
      },
    });
    const team = await client.updateTeam('acme', 'platform', {
      name: 'Infra',
      privacy: 'closed',
    });
    expect(team.slug).toBe('infra-1');
  });
});

describe('createRuleset', () => {
  test('sends an empty list for each include or exclude the definition omits', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientWith({
      rest: {
        repos: {
          createOrgRuleset: async (params: Record<string, unknown>) => {
            sent.push(params);
            return { data: {} };
          },
        },
      },
    });
    await client.createRuleset('acme', {
      name: 'critical-default-branches',
      target: 'branch',
      enforcement: 'active',
      conditions: {
        refName: { include: ['~DEFAULT_BRANCH'] },
        repositoryProperty: {
          include: [{ name: 'critical', propertyValues: ['true'] }],
        },
      },
      rules: [],
    });
    expect(sent[0]?.conditions).toEqual({
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
      repository_property: {
        include: [{ name: 'critical', property_values: ['true'] }],
        exclude: [],
      },
    });
  });
});

describe('listTeamMembers', () => {
  test('marks a member missing from the immediate listing as inherited', async () => {
    const edges = {
      ALL: [
        { role: 'MAINTAINER', node: { login: 'lead' } },
        { role: 'MEMBER', node: { login: 'dev' } },
      ],
      IMMEDIATE: [{ role: 'MAINTAINER', node: { login: 'lead' } }],
    };
    const client = clientWith({
      graphql: async (_query: string, vars: { membership: 'ALL' | 'IMMEDIATE' }) => ({
        organization: {
          team: {
            members: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: edges[vars.membership],
            },
          },
        },
      }),
    });
    await expect(client.listTeamMembers('acme', 'engineering')).resolves.toEqual([
      { login: 'lead', role: 'maintainer', inherited: false },
      { login: 'dev', role: 'member', inherited: true },
    ]);
  });

  test('a team GitHub does not return fails with a 404', async () => {
    const client = clientWith({
      graphql: async () => ({ organization: { team: null } }),
    });
    await expect(client.listTeamMembers('acme', 'gone')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('listRepositoryCollaborators', () => {
  test('reads the role granted on the repository, not the highest one', async () => {
    const pages = [
      {
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
        edges: [
          {
            node: { login: 'MonaAH' },
            permissionSources: [
              { permission: 'READ', roleName: null, source: { __typename: 'Organization' } },
              {
                permission: 'READ',
                roleName: 'read',
                source: { __typename: 'Repository', nameWithOwner: 'acme/afterkit' },
              },
              { permission: 'WRITE', roleName: 'write', source: { __typename: 'Team' } },
            ],
          },
        ],
      },
      {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          {
            node: { login: 'ahmed' },
            permissionSources: [
              {
                permission: 'WRITE',
                roleName: 'Merge Queue Jumper',
                source: { __typename: 'Repository', nameWithOwner: 'Acme/Afterkit' },
              },
            ],
          },
          {
            // Reached only through a team: not a direct collaborator.
            node: { login: 'teamonly' },
            permissionSources: [
              { permission: 'WRITE', roleName: 'write', source: { __typename: 'Team' } },
            ],
          },
        ],
      },
    ];
    const cursors: unknown[] = [];
    const client = clientWith({
      graphql: async (_query: string, vars: { after: string | null }) => {
        cursors.push(vars.after);
        return { repository: { collaborators: pages[cursors.length - 1] } };
      },
      paginate: async () => [],
      rest: { repos: { listInvitations: () => undefined } },
    });
    await expect(
      client.listRepositoryCollaborators('acme', 'afterkit'),
    ).resolves.toEqual([
      { login: 'MonaAH', permission: 'pull' },
      { login: 'ahmed', permission: 'Merge Queue Jumper' },
    ]);
    expect(cursors).toEqual([null, 'c1']);
  });
});

describe('listEnvironmentsOfRepositories', () => {
  const graphqlError = (data: unknown, errors: Array<{ type: string }>) =>
    Object.assign(new Error('partial'), { name: 'GraphqlResponseError', data, errors });

  test('asks for fifty repositories a query and leaves out the missing ones', async () => {
    const repositories = Array.from({ length: 51 }, (_, i) => `repo-${i}`);
    const batches: string[][] = [];
    const client = clientWith({
      graphql: async (_query: string, vars: Record<string, string>) => {
        const names = Object.entries(vars)
          .filter(([key]) => key !== 'owner')
          .map(([, name]) => name);
        batches.push(names);
        const data = Object.fromEntries(
          names.map((name, i) => [
            `r${i}`,
            name === 'repo-3'
              ? null
              : { environments: { pageInfo: { hasNextPage: false }, nodes: [{ name: `${name}-prod` }] } },
          ]),
        );
        if (names.includes('repo-3')) throw graphqlError(data, [{ type: 'NOT_FOUND' }]);
        return data;
      },
    });

    const found = await client.listEnvironmentsOfRepositories('acme', repositories);
    expect(batches.map((b) => b.length)).toEqual([50, 1]);
    expect(found.size).toBe(50);
    expect(found.has('repo-3')).toBe(false);
    expect(found.get('repo-50')).toEqual(['repo-50-prod']);
  });

  test('an error other than NOT_FOUND still fails the read', async () => {
    const client = clientWith({
      graphql: async () => {
        throw graphqlError({ r0: null }, [{ type: 'FORBIDDEN' }]);
      },
    });
    await expect(
      client.listEnvironmentsOfRepositories('acme', ['deck']),
    ).rejects.toThrow('partial');
  });
});
