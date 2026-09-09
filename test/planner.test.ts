import { describe, expect, test } from 'bun:test';
import type { LiveTeam } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

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
  return { owner: 'acme', ownerType: 'organization', teams };
}

/** Live state carrying only teams — the governance surfaces stay unread. */
function live(teams: LiveTeam[] = []): LiveState {
  return { teams };
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
      live(),
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
      live([
        team({ slug: 'engineering', name: 'engineering', privacy: 'closed' }),
      ]),
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
      live([team({ slug: 'engineering', name: 'engineering' })]),
    );
    expect(changes).toHaveLength(0);
  });

  test('proposes deletes children-first for unmanaged teams', () => {
    const changes = plan(
      desired([]),
      live([
        team({ slug: 'parent' }),
        team({ slug: 'child', parentSlug: 'parent' }),
      ]),
    );
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
      live([team({ slug: 'engineering', name: 'engineering' })]),
    );
    expect(changes.some((c) => c.kind === 'link-group')).toBe(true);
  });
});

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
    const changes = plan(desired([parent, child]), live());

    const result = await apply(client, 'acme', changes, live(), {});

    expect(result.created).toBe(2);
    const createdChild = client.teams.find((t) => t.slug === 'child');
    expect(createdChild!.parentSlug).toBe('parent');
  });

  test('skips deletes and links unless explicitly enabled', async () => {
    const client = new FakeClient({
      teams: [team({ slug: 'old', name: 'old' })],
      externalGroups: [{ id: 42, name: 'GH-Engineering' }],
    });
    const state = live(client.teams.slice());
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          externalGroup: { name: 'GH-Engineering' },
        },
      ]),
      state,
    );

    const result = await apply(client, 'acme', changes, state, {});
    expect(result.deleted).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.skipped).toHaveLength(2); // one delete + one link skipped
  });

  test('links to the resolved Entra group id when SCIM is enabled', async () => {
    const client = new FakeClient({
      teams: [team({ slug: 'engineering', name: 'engineering' })],
      externalGroups: [{ id: 42, name: 'GH-Engineering' }],
    });
    const state = live(client.teams.slice());
    const changes = plan(
      desired([
        {
          ...baseTeam,
          slug: 'engineering',
          name: 'engineering',
          externalGroup: { name: 'GH-Engineering' },
        },
      ]),
      state,
    );

    const result = await apply(client, 'acme', changes, state, {
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
