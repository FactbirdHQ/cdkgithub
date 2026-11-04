import { describe, expect, test } from 'bun:test';

import type { Octokit } from '@octokit/rest';

import { OctokitGitHubClient } from '../src/github/client.ts';
import { App, Organization, Team } from '../src/index.ts';
import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import { rollbackManifest } from '../src/reconcile/rollback.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

const DEVOPS = { id: 'ea8d6d62-727c-44eb-bf27-eb9a753ba1e5', name: 'SG_DevOps', description: '' };
const CLOUD = { id: '7f78084e-fb54-4a0a-837a-34b4bcbbb988', name: 'SG_Cloud', description: '' };

function liveTeam(slug: string) {
  return { id: slug.length, slug, name: slug, description: null, privacy: 'closed' as const, parentSlug: null };
}

function desired(teams: TeamManifest[]): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams };
}

function synthTeam(props: ConstructorParameters<typeof Team>[2]): TeamManifest {
  const app = new App();
  const org = new Organization(app, 'acme', { login: 'acme' });
  new Team(org, 'devops', props);
  return synthesize(app).teams[0]!;
}

describe('synthesizing teamSync', () => {
  test('lowercases ids and defaults the description', () => {
    const team = synthTeam({ teamSync: [{ id: DEVOPS.id.toUpperCase(), name: 'SG_DevOps' }] });
    expect(team.teamSync).toEqual([DEVOPS]);
  });

  test('carries an empty list, which owns the mappings', () => {
    expect(synthTeam({ teamSync: [], members: ['octocat'] }).teamSync).toEqual([]);
  });

  test('refuses an id that is not an Entra object id', () => {
    expect(() => synthTeam({ teamSync: [{ id: 'SG_DevOps', name: 'SG_DevOps' }] })).toThrow('not an Entra object id');
  });

  test('refuses the same group twice', () => {
    expect(() => synthTeam({ teamSync: [DEVOPS, { ...DEVOPS, id: DEVOPS.id.toUpperCase() }] })).toThrow('twice');
  });

  test('refuses a roster beside a group, which Entra would overwrite', () => {
    expect(() => synthTeam({ teamSync: [DEVOPS], maintainers: ['octocat'] })).toThrow('declares a roster');
  });

  test('refuses an externalGroup beside teamSync', () => {
    expect(() => synthTeam({ teamSync: [DEVOPS], externalGroup: { name: 'GH-DevOps' } })).toThrow('both');
  });
});

describe('planning teamSync', () => {
  const team: TeamManifest = { slug: 'devops', name: 'devops', privacy: 'closed', teamSync: [DEVOPS] };

  test('maps a team that has no groups', () => {
    const changes = plan(desired([team]), { teams: [liveTeam('devops')], teamSyncGroups: new Map([['devops', []]]) });
    expect(changes).toEqual([{ kind: 'set-team-sync', slug: 'devops', groups: [DEVOPS], from: [] }]);
  });

  test('compares ids only, so a group renamed in Entra is no change', () => {
    const renamed = { ...DEVOPS, name: 'SG_Platform_DevOps' };
    const changes = plan(desired([team]), {
      teams: [liveTeam('devops')],
      teamSyncGroups: new Map([['devops', [renamed]]]),
    });
    expect(changes).toEqual([]);
  });

  test('an empty list removes a mapping made in the web interface', () => {
    const changes = plan(desired([{ ...team, teamSync: [] }]), {
      teams: [liveTeam('devops')],
      teamSyncGroups: new Map([['devops', [CLOUD]]]),
    });
    expect(changes).toEqual([{ kind: 'set-team-sync', slug: 'devops', groups: [], from: [CLOUD] }]);
  });

  test('maps a team this run creates, after creating it', () => {
    const changes = plan(desired([team]), { teams: [] });
    expect(changes.map((c) => c.kind)).toEqual(['create', 'set-team-sync']);
  });

  test("leaves a synced team's roster to Entra", () => {
    const changes = plan(desired([team]), {
      teams: [liveTeam('devops')],
      teamSyncGroups: new Map([['devops', [DEVOPS]]]),
      teamMembers: new Map([['devops', [{ login: 'stranger', role: 'member', inherited: false }]]]),
    });
    expect(changes).toEqual([]);
  });
});

describe('reading and applying teamSync', () => {
  test('reads mappings only for teams that declare them', async () => {
    const client = new FakeClient({
      teams: [liveTeam('devops'), liveTeam('cloud')],
      teamSyncGroups: { devops: [DEVOPS], cloud: [CLOUD] },
    });
    const live = await readLiveState(
      client,
      desired([
        { slug: 'devops', name: 'devops', privacy: 'closed', teamSync: [DEVOPS] },
        { slug: 'cloud', name: 'cloud', privacy: 'closed' },
      ]),
    );
    expect([...(live.teamSyncGroups?.keys() ?? [])]).toEqual(['devops']);
  });

  test('applies only behind --allow-delete', async () => {
    const client = new FakeClient({ teams: [liveTeam('devops')] });
    const state = desired([{ slug: 'devops', name: 'devops', privacy: 'closed', teamSync: [DEVOPS] }]);
    const live = await readLiveState(client, state);
    const changes = plan(state, live);

    const gated = await apply(client, 'acme', changes, live, {});
    expect(gated.skipped).toHaveLength(1);
    expect(client.callsTo('setTeamSyncGroups')).toEqual([]);

    await apply(client, 'acme', changes, live, { allowDelete: new Set(['set-team-sync'] as const) });
    expect(client.callsTo('setTeamSyncGroups')).toEqual([{ slug: 'devops', groups: [DEVOPS] }]);
  });

  test('the rollback restores the mappings it read, without a roster', () => {
    const rollback = rollbackManifest(desired([]), {
      teams: [liveTeam('devops')],
      teamSyncGroups: new Map([['devops', [DEVOPS]]]),
      teamMembers: new Map([['devops', [{ login: 'octocat', role: 'member', inherited: false }]]]),
    });
    expect(rollback.teams[0]).toMatchObject({ slug: 'devops', teamSync: [DEVOPS], members: undefined });
  });
});

describe('the team-sync endpoints', () => {
  function clientWith(request: (route: string, params: unknown) => Promise<unknown>) {
    return new OctokitGitHubClient('token', undefined, { request } as unknown as Octokit);
  }

  test('a team with no mapping answers 403 "not externally managed", which reads as no groups', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('This team is not externally managed.'), { status: 403 });
    });
    await expect(client.listTeamSyncGroups('acme', 'devops')).resolves.toEqual([]);
  });

  test('any other 403 is a failure, not an empty mapping', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    });
    await expect(client.listTeamSyncGroups('acme', 'devops')).rejects.toThrow('not accessible');
  });

  test('writes the groups in the shape GitHub takes', async () => {
    const requests: Array<{ route: string; params: unknown }> = [];
    const client = clientWith(async (route, params) => {
      requests.push({ route, params });
      return { data: {} };
    });
    await client.setTeamSyncGroups('acme', 'devops', [DEVOPS]);
    expect(requests).toEqual([
      {
        route: 'PATCH /orgs/{org}/teams/{team_slug}/team-sync/group-mappings',
        params: {
          org: 'acme',
          team_slug: 'devops',
          groups: [{ group_id: DEVOPS.id, group_name: 'SG_DevOps', group_description: '' }],
        },
      },
    ]);
  });
});
