import { describe, expect, test } from 'bun:test';
import type { LiveTeam } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

function team(slug: string, overrides: Partial<LiveTeam> = {}): LiveTeam {
  return {
    id: 100,
    slug,
    name: slug,
    description: null,
    privacy: 'closed',
    parentSlug: null,
    ...overrides,
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

describe('renaming a team', () => {
  const renamed = manifest('tech-council', {
    name: 'Tech Council',
    previousSlug: 'tech-leads',
  });

  test('updates the live team instead of replacing it', () => {
    const changes = plan(desired([renamed]), {
      teams: [team('tech-leads', { name: 'tech-leads' })],
    });

    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.kind).toBe('update');
    if (change.kind !== 'update') return;
    // Addressed by the slug GitHub still answers to.
    expect(change.slug).toBe('tech-leads');
    expect(change.fields).toEqual([
      { field: 'slug', from: 'tech-leads', to: 'tech-council' },
      { field: 'name', from: 'tech-leads', to: 'Tech Council' },
    ]);
  });

  test('does not propose deleting the team it claims', () => {
    const changes = plan(desired([renamed]), { teams: [team('tech-leads')] });
    expect(changes.some((c) => c.kind === 'delete')).toBe(false);
  });

  test('leaves the marker inert once the rename has landed', () => {
    const changes = plan(desired([renamed]), {
      teams: [team('tech-council', { name: 'Tech Council' })],
    });
    expect(changes).toEqual([]);
  });

  test('claims the team under its own slug, not one since created under the old name', () => {
    const changes = plan(desired([renamed]), {
      teams: [
        team('tech-council', { id: 1, name: 'Tech Council' }),
        team('tech-leads', { id: 2, name: 'tech-leads' }),
      ],
    });
    // The revived old slug is unclaimed, so it reads as a delete rather than
    // being renamed a second time.
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('delete');
  });

  test('addresses grants to the new slug while reading them from the old', () => {
    const live: LiveState = {
      teams: [team('tech-leads')],
      teamRepositories: new Map([
        ['tech-leads', [{ name: 'netcore', roleName: 'read' }]],
      ]),
    };
    const changes = plan(
      desired([
        manifest('tech-council', {
          name: 'Tech Council',
          previousSlug: 'tech-leads',
          repositories: { netcore: 'push' },
        }),
      ]),
      live,
    );

    // The grant change runs after the rename, when the old slug is gone.
    expect(changes).toContainEqual({
      kind: 'set-repo-access',
      slug: 'tech-council',
      repository: 'netcore',
      permission: 'push',
      from: 'pull',
    });
  });

  test('keeps a child attached to the parent being renamed', async () => {
    const live: LiveState = {
      teams: [
        team('cloud', { id: 7, name: 'cloud' }),
        team('app-1', { id: 8, name: 'app-1', parentSlug: 'cloud' }),
      ],
    };
    const changes = plan(
      desired([
        manifest('platform', { name: 'Platform', previousSlug: 'cloud' }),
        manifest('app-1', { parentSlug: 'platform' }),
      ]),
      live,
    );

    const client = new FakeClient({ teams: [...live.teams] });
    await apply(client, 'acme', changes, live);

    // The child's parent is named by the new slug, which only resolves because
    // a rename carries the id across.
    expect(client.callsTo('updateTeam')).toContainEqual({
      slug: 'app-1',
      params: {
        name: 'app-1',
        description: '',
        privacy: 'closed',
        parentTeamId: 7,
      },
    });
  });
});
