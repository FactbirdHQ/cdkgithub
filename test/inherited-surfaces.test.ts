import { describe, expect, test } from 'bun:test';
import type { LiveTeam } from '../src/github/client.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

function team(overrides: Partial<LiveTeam> & Pick<LiveTeam, 'slug'>): LiveTeam {
  return {
    id: overrides.slug.length * 101,
    name: overrides.slug,
    description: null,
    privacy: 'closed',
    parentSlug: null,
    ...overrides,
  };
}

function desired(teams: DesiredState['teams']): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams };
}

describe('inherited rosters', () => {
  /**
   * GitHub reports a parent's members as including everyone in the teams below
   * it, marked as inherited. The child here declares no roster, and its roster
   * is still read, because it says who the child goes on holding.
   */
  test("a non-declaring child's members are not removals on the parent", async () => {
    const client = new FakeClient({
      teams: [team({ slug: 'platform' }), team({ slug: 'web', parentSlug: 'platform' })],
      teamMembers: {
        // As GitHub reports it: the parent's listing carries the child's member.
        platform: [
          { login: 'direct-member', role: 'member', inherited: false },
          { login: 'child-member', role: 'member', inherited: true },
        ],
        web: [{ login: 'child-member', role: 'member', inherited: false }],
      },
    });
    const definition = desired([
      {
        slug: 'platform',
        name: 'platform',
        privacy: 'closed',
        members: ['direct-member'],
      },
      // The child is declared but does not declare a roster.
      { slug: 'web', name: 'web', privacy: 'closed', parentSlug: 'platform' },
    ]);

    const live = await readLiveState(client, definition);
    // The child's roster was read even though it declares none.
    expect(live.teamMembers?.get('web')).toHaveLength(1);

    const changes = plan(definition, live);
    expect(changes.filter((c) => c.kind === 'remove-membership')).toEqual([]);
  });
});

describe('inherited grants', () => {
  /**
   * The mirror image: a child's repository listing carries its ancestors'
   * grants. The parent declares no access map, so its grants must be read
   * anyway to explain what the child merely inherits.
   */
  test("a non-declaring parent's grants are not removals on the child", async () => {
    const client = new FakeClient({
      teams: [team({ slug: 'platform' }), team({ slug: 'web', parentSlug: 'platform' })],
      teamRepositories: {
        platform: [{ name: 'infra', roleName: 'write' }],
        // As GitHub reports it: the child's listing carries the parent's grant.
        web: [
          { name: 'infra', roleName: 'write' },
          { name: 'site', roleName: 'write' },
        ],
      },
    });
    const definition = desired([
      // The parent is declared but does not declare access.
      { slug: 'platform', name: 'platform', privacy: 'closed' },
      {
        slug: 'web',
        name: 'web',
        privacy: 'closed',
        parentSlug: 'platform',
        repositories: { site: 'push' },
      },
    ]);

    const live = await readLiveState(client, definition);
    expect(live.teamRepositories?.get('platform')).toHaveLength(1);

    const changes = plan(definition, live);
    expect(changes.filter((c) => c.kind === 'remove-repo-access')).toEqual([]);
  });
});

describe('plan order', () => {
  test('a new repository precedes the grants and protection that name it', () => {
    const definition: DesiredState = {
      owner: 'acme',
      ownerType: 'organization',
      teams: [
        {
          slug: 'web',
          name: 'web',
          privacy: 'closed',
          repositories: { fresh: 'push' },
        },
      ],
      repositories: [{ name: 'fresh' }],
      branchProtection: [
        { repository: 'fresh', branch: 'main', enforceAdmins: true },
      ],
    };
    const changes = plan(definition, {
      teams: [team({ slug: 'web' })],
      teamRepositories: new Map([['web', []]]),
      repositories: [],
      branchProtection: [
        { repository: 'fresh', branch: 'main', enabled: false },
      ],
    });

    const order = changes.map((c) => c.kind);
    const repo = order.indexOf('create-repository');
    expect(repo).toBeGreaterThanOrEqual(0);
    expect(repo).toBeLessThan(order.indexOf('set-repo-access'));
    expect(repo).toBeLessThan(order.indexOf('branch-protection'));
  });
});
