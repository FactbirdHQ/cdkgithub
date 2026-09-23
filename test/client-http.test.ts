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
