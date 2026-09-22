import { describe, expect, test } from 'bun:test';
import type {
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
} from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

function team(slug: string, parentSlug: string | null = null): LiveTeam {
  return {
    id: slug.length * 100,
    slug,
    name: slug,
    description: null,
    privacy: 'closed',
    parentSlug,
  };
}

function manifest(
  slug: string,
  overrides: Partial<TeamManifest> = {},
): TeamManifest {
  return { slug, name: slug, privacy: 'closed', ...overrides };
}

function desired(teams: TeamManifest[]): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams };
}

function live(
  teams: LiveTeam[],
  overrides: Partial<LiveState> = {},
): LiveState {
  return { teams, ...overrides };
}

function repos(
  entries: Record<string, LiveTeamRepository[]>,
): Map<string, LiveTeamRepository[]> {
  return new Map(Object.entries(entries));
}

function members(
  entries: Record<string, LiveTeamMember[]>,
): Map<string, LiveTeamMember[]> {
  return new Map(Object.entries(entries));
}

describe('repository access', () => {
  test('is left alone by a team that declares no access map', () => {
    const changes = plan(
      desired([manifest('cloud')]),
      live([team('cloud')], {
        teamRepositories: repos({
          cloud: [{ name: 'netcore', roleName: 'write' }],
        }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('grants a repository the team cannot reach', () => {
    const changes = plan(
      desired([manifest('cloud', { repositories: { netcore: 'push' } })]),
      live([team('cloud')], { teamRepositories: repos({ cloud: [] }) }),
    );
    expect(changes).toEqual([
      {
        kind: 'set-repo-access',
        slug: 'cloud',
        repository: 'netcore',
        permission: 'push',
        from: undefined,
      },
    ]);
  });

  test("reads GitHub's role names in the vocabulary the grant is written in", () => {
    // `write` back and `push` out are the same permission, so a definition that
    // already matches must not report drift on every run.
    const changes = plan(
      desired([
        manifest('cloud', { repositories: { netcore: 'push', docs: 'pull' } }),
      ]),
      live([team('cloud')], {
        teamRepositories: repos({
          cloud: [
            { name: 'netcore', roleName: 'write' },
            { name: 'docs', roleName: 'read' },
          ],
        }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('removes a grant the access map does not carry, gated by --allow-delete', async () => {
    const changes = plan(
      desired([manifest('cloud', { repositories: { netcore: 'push' } })]),
      live([team('cloud')], {
        teamRepositories: repos({
          cloud: [
            { name: 'netcore', roleName: 'write' },
            { name: 'legacy', roleName: 'admin' },
          ],
        }),
      }),
    );
    expect(changes).toEqual([
      {
        kind: 'remove-repo-access',
        slug: 'cloud',
        repository: 'legacy',
        from: 'admin',
      },
    ]);

    const client = new FakeClient();
    const skipped = await apply(client, 'acme', changes, live([]));
    expect(skipped.deleted).toBe(0);
    expect(skipped.skipped).toHaveLength(1);

    const applied = await apply(client, 'acme', changes, live([]), {
      allowDelete: true,
    });
    expect(applied.deleted).toBe(1);
    expect(client.calls).toContainEqual({
      method: 'removeRepoPermission',
      args: { slug: 'cloud', repo: 'legacy' },
    });
  });

  test('never proposes removing access a parent team already grants', () => {
    // GitHub reports a parent's repositories as the child's own, and the child
    // cannot give them up. Proposing it would be a change that runs forever.
    const changes = plan(
      desired([
        manifest('engineering', { repositories: { docs: 'push' } }),
        manifest('cloud', {
          parentSlug: 'engineering',
          repositories: { netcore: 'push' },
        }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamRepositories: repos({
          engineering: [{ name: 'docs', roleName: 'write' }],
          cloud: [
            { name: 'netcore', roleName: 'write' },
            { name: 'docs', roleName: 'write' },
          ],
        }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('still removes a child grant that outranks what the parent gives', () => {
    const changes = plan(
      desired([
        manifest('engineering', { repositories: { docs: 'pull' } }),
        manifest('cloud', { parentSlug: 'engineering', repositories: {} }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamRepositories: repos({
          engineering: [{ name: 'docs', roleName: 'read' }],
          cloud: [{ name: 'docs', roleName: 'admin' }],
        }),
      }),
    );
    expect(changes).toEqual([
      {
        kind: 'remove-repo-access',
        slug: 'cloud',
        repository: 'docs',
        from: 'admin',
      },
    ]);
  });
});

describe('custom repository roles', () => {
  const state = live([team('cloud')], {
    teamRepositories: repos({
      cloud: [{ name: 'netcore', roleName: 'Merge Queue Jumper' }],
    }),
    customRepositoryRoles: [
      { id: 71928, name: 'Merge Queue Jumper', baseRole: 'write' },
    ],
  });

  test('match by name without reporting drift', () => {
    const changes = plan(
      desired([
        manifest('cloud', { repositories: { netcore: 'Merge Queue Jumper' } }),
      ]),
      state,
    );
    expect(changes).toEqual([]);
  });

  test('rank by the built-in they extend', () => {
    // The child's custom role has base `write`, which the parent's `admin`
    // outranks, so the grant is the parent's to give and not a removal here.
    const changes = plan(
      desired([
        manifest('engineering', { repositories: { netcore: 'admin' } }),
        manifest('cloud', { parentSlug: 'engineering', repositories: {} }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamRepositories: repos({
          engineering: [{ name: 'netcore', roleName: 'admin' }],
          cloud: [{ name: 'netcore', roleName: 'Merge Queue Jumper' }],
        }),
        customRepositoryRoles: [
          { id: 71928, name: 'Merge Queue Jumper', baseRole: 'write' },
        ],
      }),
    );
    expect(changes).toEqual([]);
  });

  test('fail the plan when the organization defines no such role', () => {
    expect(() =>
      plan(
        desired([manifest('cloud', { repositories: { netcore: 'pul' } })]),
        state,
      ),
    ).toThrow(/neither a built-in permission/);
  });
});

describe('team roster', () => {
  test('is left alone by a team that declares neither list', () => {
    const changes = plan(
      desired([manifest('cloud')]),
      live([team('cloud')], {
        teamMembers: members({ cloud: [{ login: 'ada', role: 'member' }] }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('adds, promotes and removes against the declared roster', () => {
    const changes = plan(
      desired([
        manifest('cloud', { maintainers: ['ada'], members: ['grace'] }),
      ]),
      live([team('cloud')], {
        teamMembers: members({
          cloud: [
            { login: 'ada', role: 'member' },
            { login: 'alan', role: 'member' },
          ],
        }),
      }),
    );
    expect(changes).toEqual([
      {
        kind: 'set-membership',
        slug: 'cloud',
        username: 'grace',
        role: 'member',
        from: undefined,
      },
      {
        kind: 'set-membership',
        slug: 'cloud',
        username: 'ada',
        role: 'maintainer',
        from: 'member',
      },
      {
        kind: 'remove-membership',
        slug: 'cloud',
        username: 'alan',
        from: 'member',
      },
    ]);
  });

  test('never removes a parent member who belongs to a team below it', () => {
    // A child team's members are reported as the parent's, so taking the
    // listing at face value would propose evicting every one of them.
    const changes = plan(
      desired([
        manifest('engineering', { members: ['ada'] }),
        manifest('cloud', { parentSlug: 'engineering' }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamMembers: members({
          engineering: [
            { login: 'ada', role: 'member' },
            { login: 'grace', role: 'member' },
          ],
          cloud: [{ login: 'grace', role: 'member' }],
        }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('moves a member up from a child in one run without dropping them', () => {
    // GitHub reports ada on engineering only because she is in cloud, and the
    // API will not say which. Trusting the report would write nothing here,
    // cloud would drop her, and she would land in neither team.
    const changes = plan(
      desired([
        manifest('engineering', { members: ['ada'] }),
        manifest('cloud', { parentSlug: 'engineering', members: [] }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamMembers: members({
          engineering: [{ login: 'ada', role: 'member' }],
          cloud: [{ login: 'ada', role: 'member' }],
        }),
      }),
    );
    expect(changes).toEqual([
      // Added to the parent before the child lets go of her.
      {
        kind: 'set-membership',
        slug: 'engineering',
        username: 'ada',
        role: 'member',
        from: 'member',
      },
      {
        kind: 'remove-membership',
        slug: 'cloud',
        username: 'ada',
        from: 'member',
      },
    ]);
  });

  test('writes nothing for a member the child below is keeping', () => {
    // The mirror image of the case above, and the reason inheritance is judged
    // against the rosters after the run rather than direct membership alone.
    // Judging it against direct membership would rewrite this every run.
    const changes = plan(
      desired([
        manifest('engineering', { maintainers: ['ada'] }),
        manifest('cloud', {
          parentSlug: 'engineering',
          maintainers: ['ada'],
        }),
      ]),
      live([team('engineering'), team('cloud', 'engineering')], {
        teamMembers: members({
          engineering: [{ login: 'ada', role: 'maintainer' }],
          cloud: [{ login: 'ada', role: 'maintainer' }],
        }),
      }),
    );
    expect(changes).toEqual([]);
  });

  test('is owned by Entra rather than the definition when the team is synced', () => {
    const changes = plan(
      desired([
        manifest('cloud', {
          members: ['ada'],
          externalGroup: { id: 7 },
        }),
      ]),
      live([team('cloud')], {
        teamMembers: members({ cloud: [{ login: 'alan', role: 'member' }] }),
      }),
    );
    expect(changes).toEqual([
      { kind: 'link-group', slug: 'cloud', group: { id: 7 } },
    ]);
  });
});
