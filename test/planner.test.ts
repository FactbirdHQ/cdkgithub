import { describe, expect, test } from 'bun:test';
import type {
  CreateTeamParams,
  ExternalIdpGroup,
  GitHubClient,
  LiveTeam,
  UpdateTeamParams,
} from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState, RepoPermission } from '../src/synth/manifest.ts';

function team(overrides: Partial<LiveTeam> & Pick<LiveTeam, 'slug'>): LiveTeam {
  return {
    id: Math.abs(hash(overrides.slug)),
    name: overrides.slug,
    description: null,
    privacy: 'closed',
    parentSlug: null,
    ...overrides,
  };
}

function desired(teams: DesiredState['teams']): DesiredState {
  return { org: 'acme', teams };
}

const baseTeam = {
  name: 'Engineering',
  description: undefined,
  privacy: 'closed' as const,
  maintainers: [],
  members: [],
  repositories: {},
};

describe('plan', () => {
  test('creates a team that does not exist', () => {
    const changes = plan(
      desired([{ ...baseTeam, slug: 'engineering', name: 'engineering' }]),
      [],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('create');
  });

  test('updates only changed fields', () => {
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          privacy: 'secret',
        },
      ]),
      [team({ slug: 'engineering', name: 'engineering', privacy: 'closed' })],
    );
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.kind).toBe('update');
    if (change.kind === 'update') {
      expect(change.fields).toEqual([
        { field: 'privacy', from: 'closed', to: 'secret' },
      ]);
    }
  });

  test('no change when live matches desired', () => {
    const changes = plan(
      desired([{ ...baseTeam, slug: 'engineering', name: 'engineering' }]),
      [team({ slug: 'engineering', name: 'engineering' })],
    );
    expect(changes).toHaveLength(0);
  });

  test('proposes deletes children-first for unmanaged teams', () => {
    const changes = plan(desired([]), [
      team({ slug: 'parent' }),
      team({ slug: 'child', parentSlug: 'parent' }),
    ]);
    const deletes = changes.filter((c) => c.kind === 'delete');
    expect(
      deletes.map((d) => (d.kind === 'delete' ? d.live.slug : '')),
    ).toEqual(['child', 'parent']);
  });

  test('emits a link-group change for IdP-bound teams', () => {
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          externalGroup: { name: 'GH-Engineering' },
        },
      ]),
      [team({ slug: 'engineering', name: 'engineering' })],
    );
    expect(changes.some((c) => c.kind === 'link-group')).toBe(true);
  });
});

/** Minimal in-memory GitHubClient for exercising the applier. */
class FakeClient implements GitHubClient {
  teams: LiveTeam[];
  externalGroups: ExternalIdpGroup[];
  links: Array<{ slug: string; groupId: number }> = [];
  memberships: Array<{ slug: string; username: string; role: string }> = [];
  private nextId = 1000;

  constructor(teams: LiveTeam[] = [], groups: ExternalIdpGroup[] = []) {
    this.teams = teams;
    this.externalGroups = groups;
  }

  async listTeams(): Promise<LiveTeam[]> {
    return this.teams;
  }
  async createTeam(_org: string, params: CreateTeamParams): Promise<LiveTeam> {
    const parentSlug =
      this.teams.find((t) => t.id === params.parentTeamId)?.slug ?? null;
    const created: LiveTeam = {
      id: this.nextId++,
      slug: params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: params.name,
      description: params.description ?? null,
      privacy: params.privacy,
      parentSlug,
    };
    this.teams.push(created);
    return created;
  }
  async updateTeam(
    _o: string,
    _s: string,
    _p: UpdateTeamParams,
  ): Promise<void> {}
  async deleteTeam(_org: string, slug: string): Promise<void> {
    this.teams = this.teams.filter((t) => t.slug !== slug);
  }
  async setMembership(
    _org: string,
    slug: string,
    username: string,
    role: 'member' | 'maintainer',
  ): Promise<void> {
    this.memberships.push({ slug, username, role });
  }
  async setRepoPermission(
    _org: string,
    _slug: string,
    _repo: string,
    _permission: RepoPermission,
  ): Promise<void> {}
  async listExternalGroups(): Promise<ExternalIdpGroup[]> {
    return this.externalGroups;
  }
  async linkExternalGroup(
    _o: string,
    slug: string,
    groupId: number,
  ): Promise<void> {
    this.links.push({ slug, groupId });
  }
}

describe('apply', () => {
  test('creates parent then child, resolving the parent id', async () => {
    const parent = { ...baseTeam, slug: 'parent', name: 'parent' };
    const child = {
      ...baseTeam,
      slug: 'child',
      name: 'child',
      parentSlug: 'parent',
    };
    const client = new FakeClient();
    const changes = plan(desired([parent, child]), []);

    const result = await apply(client, 'acme', changes, [], {});

    expect(result.created).toBe(2);
    const createdChild = client.teams.find((t) => t.slug === 'child');
    expect(createdChild!.parentSlug).toBe('parent');
  });

  test('skips deletes and links unless explicitly enabled', async () => {
    const client = new FakeClient(
      [team({ slug: 'old', name: 'old' })],
      [{ id: 42, name: 'GH-Engineering' }],
    );
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          externalGroup: { name: 'GH-Engineering' },
        },
      ]),
      client.teams.slice(),
    );

    const result = await apply(
      client,
      'acme',
      changes,
      client.teams.slice(),
      {},
    );
    expect(result.deleted).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.skipped).toHaveLength(2); // one delete + one link skipped
  });

  test('links to the resolved Entra group id when SCIM is enabled', async () => {
    const client = new FakeClient(
      [team({ slug: 'engineering', name: 'engineering' })],
      [{ id: 42, name: 'GH-Engineering' }],
    );
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          externalGroup: { name: 'GH-Engineering' },
        },
      ]),
      client.teams.slice(),
    );

    const result = await apply(client, 'acme', changes, client.teams.slice(), {
      enableScim: true,
    });
    expect(result.linked).toBe(1);
    expect(client.links).toEqual([{ slug: 'engineering', groupId: 42 }]);
  });
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
