import { describe, expect, test } from 'bun:test';
import type { LiveTeam } from '../src/github/client.ts';
import {
  accessByPerson,
  diffAccessByPerson,
} from '../src/reconcile/access-by-person.ts';
import {
  renderAccessByPerson,
  renderAccessCsv,
} from '../src/reconcile/render-person.ts';
import { desiredTree, readLiveTree } from '../src/reconcile/tree.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

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

describe('pivoting a tree onto its people', () => {
  test('a member reaches what their team reaches, inheritance included', () => {
    const tree = desiredTree(
      manifest([
        team('engineering', { repositories: { docs: 'push' } }),
        team('cloud', {
          parentSlug: 'engineering',
          members: ['dev'],
          repositories: { api: 'admin' },
        }),
      ]),
    );

    const dev = accessByPerson(tree).get('dev');
    expect(dev?.teams).toEqual(['cloud']);
    expect([...(dev?.repositories.keys() ?? [])]).toEqual(['api', 'docs']);
    expect(dev?.repositories.get('docs')?.permission).toBe('push');
  });

  test('belonging to a parent does not confer a child’s grants', () => {
    const tree = desiredTree(
      manifest([
        team('engineering', {
          members: ['lead'],
          repositories: { docs: 'push' },
        }),
        team('cloud', {
          parentSlug: 'engineering',
          repositories: { secret: 'admin' },
        }),
      ]),
    );

    const lead = accessByPerson(tree).get('lead');
    expect([...(lead?.repositories.keys() ?? [])]).toEqual(['docs']);
  });

  test('two teams granting the same repo keep the stronger permission', () => {
    const tree = desiredTree(
      manifest([
        team('support', { members: ['sam'], repositories: { api: 'pull' } }),
        team('platform', { members: ['sam'], repositories: { api: 'admin' } }),
      ]),
    );

    const sam = accessByPerson(tree).get('sam');
    expect(sam?.repositories.get('api')?.permission).toBe('admin');
    expect(sam?.repositories.get('api')?.through).toContain('platform');
    expect(sam?.repositories.get('api')?.through).toContain('support');
  });

  test('a maintainer counts as reaching the team’s repositories', () => {
    const tree = desiredTree(
      manifest([
        team('cloud', { maintainers: ['boss'], repositories: { api: 'push' } }),
      ]),
    );
    expect(accessByPerson(tree).get('boss')?.repositories.size).toBe(1);
  });
});

describe('diffing access person by person', () => {
  async function scenario() {
    const client = new FakeClient({
      teams: [liveTeam('cloud'), liveTeam('support')],
      teamMembers: {
        cloud: [{ login: 'mover', role: 'member' }],
        support: [{ login: 'stayer', role: 'member' }],
      },
      teamRepositories: {
        cloud: [
          { name: 'api', roleName: 'read' },
          { name: 'legacy', roleName: 'write' },
        ],
        support: [{ name: 'docs', roleName: 'read' }],
      },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([
        team('cloud', { repositories: { api: 'admin', fresh: 'push' } }),
        team('support', {
          members: ['stayer', 'mover'],
          repositories: { docs: 'pull' },
        }),
      ]),
    );
    return diffAccessByPerson(live, wanted);
  }

  test('reports what someone gains, loses, and holds differently', async () => {
    const mover = (await scenario()).find((p) => p.login === 'mover');

    expect(mover?.teamsJoined).toEqual(['support']);
    expect(mover?.teamsLeft).toEqual(['cloud']);
    expect(mover?.gained.map((g) => g.repository)).toEqual(['docs']);
    expect(mover?.lost.map((l) => l.repository)).toEqual(['api', 'legacy']);
    expect(mover?.unchanged).toBe(false);
  });

  test('someone whose access is identical is marked unchanged', async () => {
    const stayer = (await scenario()).find((p) => p.login === 'stayer');
    expect(stayer?.unchanged).toBe(true);
    expect(stayer?.gained).toEqual([]);
    expect(stayer?.lost).toEqual([]);
  });

  test('a permission change is neither a gain nor a loss', async () => {
    const client = new FakeClient({
      teams: [liveTeam('cloud')],
      teamMembers: { cloud: [{ login: 'dev', role: 'member' }] },
      teamRepositories: { cloud: [{ name: 'api', roleName: 'read' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([
        team('cloud', { members: ['dev'], repositories: { api: 'admin' } }),
      ]),
    );

    const dev = diffAccessByPerson(live, wanted)[0];
    expect(dev?.gained).toEqual([]);
    expect(dev?.lost).toEqual([]);
    expect(dev?.changed[0]?.from?.permission).toBe('pull');
    expect(dev?.changed[0]?.to?.permission).toBe('admin');
  });
});

describe('rendering the person view', () => {
  async function people() {
    const client = new FakeClient({
      teams: [liveTeam('cloud')],
      teamMembers: { cloud: [{ login: 'dev', role: 'member' }] },
      teamRepositories: { cloud: [{ name: 'legacy', roleName: 'write' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([
        team('cloud', { members: ['dev'], repositories: { fresh: 'push' } }),
      ]),
    );
    return diffAccessByPerson(live, wanted);
  }

  test('shows the count moving and names the team behind each grant', async () => {
    const output = renderAccessByPerson(await people());
    expect(output).toContain('dev   (1 repo)');
    expect(output).toContain('+ fresh = "push"   via cloud');
    expect(output).toContain('- legacy   (had "push" via cloud)');
    expect(output).toContain(
      '1 of 1 person sees their repository access change.',
    );
  });

  test('--full keeps the marks rather than flattening to a listing', async () => {
    const client = new FakeClient({
      teams: [liveTeam('cloud')],
      teamMembers: { cloud: [{ login: 'dev', role: 'member' }] },
      teamRepositories: {
        cloud: [
          { name: 'legacy', roleName: 'write' },
          { name: 'steady', roleName: 'read' },
          { name: 'raised', roleName: 'read' },
        ],
      },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([
        team('cloud', {
          members: ['dev'],
          repositories: { fresh: 'push', steady: 'pull', raised: 'admin' },
        }),
      ]),
    );

    const output = renderAccessByPerson(diffAccessByPerson(live, wanted), {
      full: true,
    });

    expect(output).toContain('+ fresh = "push"   via cloud');
    expect(output).toContain('- legacy   (had "push" via cloud)');
    expect(output).toContain('~ raised: "pull" -> "admin"   via cloud');
    // The one that does not move is the only one left plain.
    expect(output).toContain('  steady = "pull"   via cloud');
    expect(output).not.toContain('+ steady');
  });

  test('CSV carries one row per person per repository, both sides', async () => {
    const rows = renderAccessCsv(await people()).split('\n');
    expect(rows[0]).toBe('login,repository,before,after,via');
    expect(rows).toContain('dev,fresh,,push,cloud');
    expect(rows).toContain('dev,legacy,push,,cloud');
  });

  test('--changed-only drops the people who are unaffected', async () => {
    const client = new FakeClient({
      teams: [liveTeam('quiet')],
      teamMembers: { quiet: [{ login: 'nobody', role: 'member' }] },
    });
    const live = await readLiveTree(client, 'acme');
    const wanted = desiredTree(
      manifest([team('quiet', { members: ['nobody'] })]),
    );
    const output = renderAccessByPerson(diffAccessByPerson(live, wanted), {
      changedOnly: true,
    });

    expect(output).toContain('No one’s repository access changes.');
  });
});

describe('where a grant comes from', () => {
  test('an inherited grant names the ancestor, not the team joined', () => {
    const tree = desiredTree(
      manifest([
        team('engineering', { repositories: { nest: 'push' } }),
        team('cloud', { parentSlug: 'engineering' }),
        team('connected-operations', {
          parentSlug: 'cloud',
          members: ['dev'],
        }),
      ]),
    );

    // `dev` joined the leaf, but nothing there mentions nest.
    expect(
      accessByPerson(tree).get('dev')?.repositories.get('nest')?.through,
    ).toEqual(['engineering']);
  });

  test('a grant the team makes itself names the team', () => {
    const tree = desiredTree(
      manifest([
        team('engineering', { repositories: { nest: 'push' } }),
        team('cloud', {
          parentSlug: 'engineering',
          members: ['dev'],
          repositories: { api: 'maintain' },
        }),
      ]),
    );

    const reach = accessByPerson(tree).get('dev')?.repositories;
    expect(reach?.get('api')?.through).toEqual(['cloud']);
    expect(reach?.get('nest')?.through).toEqual(['engineering']);
  });

  test('a child re-declaring its parent still names the parent', () => {
    // The child's line changes nothing, so it is not where the grant lives.
    const tree = desiredTree(
      manifest([
        team('engineering', { repositories: { nest: 'push' } }),
        team('cloud', {
          parentSlug: 'engineering',
          members: ['dev'],
          repositories: { nest: 'push' },
        }),
      ]),
    );

    expect(
      accessByPerson(tree).get('dev')?.repositories.get('nest')?.through,
    ).toEqual(['engineering']);
  });

  test('a child granting more than its parent names the child', () => {
    const tree = desiredTree(
      manifest([
        team('engineering', { repositories: { nest: 'pull' } }),
        team('cloud', {
          parentSlug: 'engineering',
          members: ['dev'],
          repositories: { nest: 'maintain' },
        }),
      ]),
    );

    const reach = accessByPerson(tree).get('dev')?.repositories.get('nest');
    expect(reach?.permission).toBe('maintain');
    expect(reach?.through).toEqual(['cloud']);
  });
});
