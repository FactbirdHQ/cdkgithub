import { describe, expect, test } from 'bun:test';
import type { LiveTeam } from '../src/github/client.ts';
import { renderTreeDiff } from '../src/reconcile/render-tree.ts';
import {
  desiredTree,
  readLiveTree,
  redundantGrants,
} from '../src/reconcile/tree.ts';
import { diffTrees } from '../src/reconcile/tree-diff.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

/** A live team, with the fields the tree never reads left at their defaults. */
function liveTeam(slug: string, parentSlug: string | null = null): LiveTeam {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: null,
    privacy: 'closed',
    parentSlug,
  };
}

function team(slug: string, partial: Partial<TeamManifest> = {}): TeamManifest {
  return {
    slug,
    name: slug,
    privacy: 'closed',
    maintainers: [],
    members: [],
    repositories: {},
    ...partial,
  };
}

function manifest(teams: TeamManifest[]): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams };
}

describe('reading the live tree', () => {
  test('subtracts a descendant team’s roster from its ancestors', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('cloud', 'engineering')],
      teamMembers: {
        // GitHub reports the child's people as members of the parent too.
        engineering: [
          { login: 'lead', role: 'maintainer' },
          { login: 'dev', role: 'member' },
          { login: 'ops', role: 'member' },
        ],
        cloud: [
          { login: 'ops', role: 'maintainer' },
          { login: 'dev', role: 'member' },
        ],
      },
    });

    const tree = await readLiveTree(client, 'acme');

    expect(tree.bySlug.get('engineering')?.members).toEqual([]);
    expect(tree.bySlug.get('engineering')?.maintainers).toEqual(['lead']);
    expect(tree.bySlug.get('cloud')?.members).toEqual(['dev']);
  });

  test('subtracts an ancestor’s grants but keeps a stronger one', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('cloud', 'engineering')],
      teamRepositories: {
        engineering: [
          { name: 'docs', roleName: 'write' },
          { name: 'api', roleName: 'read' },
        ],
        // Both arrive inherited; only the stronger `api` grant is the child's.
        cloud: [
          { name: 'docs', roleName: 'write' },
          { name: 'api', roleName: 'admin' },
        ],
      },
    });

    const tree = await readLiveTree(client, 'acme');
    const cloud = tree.bySlug.get('cloud');

    expect(cloud?.repositories).toEqual({ api: 'admin' });
    expect(cloud?.effectiveRepositories).toEqual({
      docs: 'push',
      api: 'admin',
    });
  });

  test('ranks a custom role by the built-in it extends', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('cloud', 'engineering')],
      customRepositoryRoles: [
        { id: 1, name: 'Merge Queue Jumper', baseRole: 'write' },
      ],
      teamRepositories: {
        engineering: [{ name: 'netcore', roleName: 'Merge Queue Jumper' }],
        // Inherited: the same role, so not the child's own grant.
        cloud: [{ name: 'netcore', roleName: 'Merge Queue Jumper' }],
      },
    });

    const tree = await readLiveTree(client, 'acme');

    expect(tree.bySlug.get('cloud')?.repositories).toEqual({});
    expect(tree.bySlug.get('cloud')?.effectiveRepositories).toEqual({
      netcore: 'Merge Queue Jumper',
    });
  });

  test('reads no teams for a personal account', async () => {
    const client = new FakeClient({ teams: [liveTeam('engineering')] });
    const tree = await readLiveTree(client, 'someone', 'user');
    expect(tree.roots).toEqual([]);
  });
});

describe('diffing the two trees', () => {
  test('a team declared but not live is an addition', async () => {
    const live = await readLiveTree(new FakeClient({ teams: [] }), 'acme');
    const diff = diffTrees(live, desiredTree(manifest([team('platform')])));

    expect(diff.counts).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(diff.roots[0]?.mark).toBe('added');
  });

  test('a live team the definition drops keeps its live parent', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('app-1', 'engineering')],
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(live, desiredTree(manifest([team('engineering')])));

    const engineering = diff.roots[0];
    expect(engineering?.slug).toBe('engineering');
    expect(engineering?.children.map((c) => [c.slug, c.mark])).toEqual([
      ['app-1', 'removed'],
    ]);
  });

  test('previousSlug pairs a rename into one changed team', async () => {
    const client = new FakeClient({
      teams: [liveTeam('app-1')],
      teamMembers: { 'app-1': [{ login: 'dev', role: 'member' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('analytics-platform', {
            previousSlug: 'app-1',
            members: ['dev'],
          }),
        ]),
      ),
    );

    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 1 });
    const renamed = diff.roots[0];
    expect(renamed?.live?.slug).toBe('app-1');
    expect(renamed?.properties).toEqual([
      { property: 'slug', from: 'app-1', to: 'analytics-platform' },
      { property: 'name', from: 'app-1', to: 'analytics-platform' },
    ]);
    // The roster moved with the team rather than being dropped and re-added.
    expect(renamed?.rosters).toEqual([]);
    expect(renderTreeDiff(diff)).toContain(
      'team analytics-platform   (was app-1)',
    );
  });

  test('a team that moves is reported once, under where it is headed', async () => {
    const client = new FakeClient({
      teams: [
        liveTeam('engineering'),
        liveTeam('software'),
        liveTeam('review', 'engineering'),
      ],
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('engineering'),
          team('software'),
          team('review', { parentSlug: 'software' }),
        ]),
      ),
    );

    const software = diff.roots.find((r) => r.slug === 'software');
    expect(software?.children.map((c) => c.slug)).toEqual(['review']);
    expect(diff.roots.find((r) => r.slug === 'engineering')?.children).toEqual(
      [],
    );
    expect(software?.children[0]?.properties).toEqual([
      { property: 'parent', from: 'engineering', to: 'software' },
    ]);
  });

  test('a re-declared child grant is no change at all, only redundant', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('cloud', 'engineering')],
      teamRepositories: {
        engineering: [{ name: 'docs', roleName: 'write' }],
        cloud: [{ name: 'docs', roleName: 'write' }],
      },
    });
    const live = await readLiveTree(client, 'acme');
    // The definition re-declares the parent's grant on the child, the way the
    // import writes it. Both sides resolve to the same effective access.
    const wanted = desiredTree(
      manifest([
        team('engineering', { repositories: { docs: 'push' } }),
        team('cloud', {
          parentSlug: 'engineering',
          repositories: { docs: 'push' },
        }),
      ]),
    );

    expect(diffTrees(live, wanted).counts).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
    });
    expect(redundantGrants(wanted)).toEqual([
      { slug: 'cloud', repositories: ['docs'] },
    ]);
  });

  test('a custom role matches when the live roles rank it', async () => {
    const client = new FakeClient({
      teams: [liveTeam('cloud')],
      customRepositoryRoles: [
        { id: 1, name: 'Merge Queue Jumper', baseRole: 'write' },
      ],
      teamRepositories: {
        cloud: [{ name: 'netcore', roleName: 'Merge Queue Jumper' }],
      },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([
        team('cloud', { repositories: { netcore: 'Merge Queue Jumper' } }),
      ]),
      live.customRoles,
    );

    expect(diffTrees(live, wanted).counts.changed).toBe(0);
  });

  test('an IdP-synced team has its roster left to Entra', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering')],
      teamMembers: { engineering: [{ login: 'leaver', role: 'member' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('engineering', {
            members: ['joiner'],
            externalGroup: { name: 'GH-Engineering' },
          }),
        ]),
      ),
    );

    expect(diff.counts.changed).toBe(0);
    expect(diff.roots[0]?.rosterOwnedByIdp).toBe(true);
  });

  test('roster and grant differences are both reported', async () => {
    const client = new FakeClient({
      teams: [liveTeam('cloud')],
      teamMembers: { cloud: [{ login: 'leaver', role: 'member' }] },
      teamRepositories: { cloud: [{ name: 'api', roleName: 'read' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('cloud', {
            members: ['joiner'],
            repositories: { api: 'push', docs: 'pull' },
          }),
        ]),
      ),
    );

    const cloud = diff.roots[0];
    expect(cloud?.mark).toBe('changed');
    expect(cloud?.grants).toEqual([
      { repository: 'api', from: 'pull', to: 'push' },
      { repository: 'docs', from: undefined, to: 'pull' },
    ]);
    expect(cloud?.rosters).toEqual([
      { role: 'member', added: ['joiner'], removed: ['leaver'] },
    ]);
  });
});

describe('rendering', () => {
  test('marks the gutter and nests by depth', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('gone', 'engineering')],
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('engineering'),
          team('cloud', {
            parentSlug: 'engineering',
            repositories: { api: 'push' },
          }),
        ]),
      ),
    );

    const output = renderTreeDiff(diff);
    expect(output).toContain('  organization acme');
    expect(output).toContain('    team engineering');
    expect(output).toContain('+     team cloud');
    expect(output).toContain('-     team gone');
    expect(output).toContain('0 teams to change, 1 to add, 1 to remove.');
  });

  test('samples a long grant list unless --full is passed', async () => {
    const repositories = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`repo-${i}`, 'push' as const]),
    );
    const client = new FakeClient({ teams: [liveTeam('devops')] });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(manifest([team('devops', { repositories })])),
    );

    expect(renderTreeDiff(diff)).toContain('… and 12 more grants');
    expect(renderTreeDiff(diff, { full: true })).not.toContain('more grants');
  });

  test('--changed-only keeps an unchanged parent that holds a change', async () => {
    const client = new FakeClient({
      teams: [liveTeam('engineering'), liveTeam('quiet')],
    });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(
      live,
      desiredTree(
        manifest([
          team('engineering'),
          team('quiet'),
          team('cloud', { parentSlug: 'engineering' }),
        ]),
      ),
    );

    const output = renderTreeDiff(diff, { changedOnly: true });
    expect(output).toContain('team engineering');
    expect(output).toContain('team cloud');
    expect(output).not.toContain('team quiet');
  });

  test('says nothing changed when the trees match', async () => {
    const client = new FakeClient({ teams: [liveTeam('cloud')] });
    const live = await readLiveTree(client, 'acme');
    const diff = diffTrees(live, desiredTree(manifest([team('cloud')])));

    expect(renderTreeDiff(diff)).toContain(
      'No differences. The organization tree matches the definition.',
    );
  });
});
