import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveTeam, UpdateTeamParams } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import { writeBackup } from '../src/reconcile/backup.ts';
import type { Change } from '../src/reconcile/changes.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { rollbackManifest } from '../src/reconcile/rollback.ts';
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

describe('ruleset adoption', () => {
  test('a create finding its name already live becomes an update', async () => {
    const client = new FakeClient({
      rulesets: [
        {
          id: 55,
          name: 'protect-main',
          target: 'branch',
          enforcement: 'evaluate',
          rules: [],
          bypassActors: [],
          sourceType: 'Organization',
        },
      ],
    });
    const change: Change = {
      kind: 'create-ruleset',
      ruleset: {
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        rules: [],
      },
    };

    await apply(client, 'acme', [change], { teams: [] });

    // One ruleset named protect-main, not two both enforcing.
    expect(client.callsTo('createRuleset')).toEqual([]);
    expect(client.callsTo('updateRuleset')).toHaveLength(1);
    expect(client.callsTo('updateRuleset')[0]).toMatchObject({ id: 55 });
  });
});

describe('rename slug read-back', () => {
  test("GitHub's derived slug, not the local guess, addresses the rest of the run", async () => {
    const client = new FakeClient({
      teams: [team({ slug: 'platform', id: 7 })],
    });
    // GitHub disagrees with the locally derived slug, as it does when the
    // wanted slug is already taken and a suffix is appended.
    client.updateTeam = async (_org: string, slug: string, params: UpdateTeamParams): Promise<LiveTeam> => {
      client.calls.push({ method: 'updateTeam', args: { slug, params } });
      return team({ slug: 'infra-1', id: 7, name: params.name ?? slug });
    };

    const changes: Change[] = [
      {
        kind: 'update',
        slug: 'platform',
        team: { slug: 'infra', name: 'Infra', privacy: 'closed' },
        fields: [{ field: 'slug', from: 'platform', to: 'infra' }],
      },
      {
        kind: 'set-repo-access',
        slug: 'infra',
        repository: 'app',
        permission: 'push',
      },
      { kind: 'set-membership', slug: 'infra', username: 'octocat', role: 'member' },
    ];

    await apply(client, 'acme', changes, {
      teams: [team({ slug: 'platform', id: 7 })],
    });

    expect(client.callsTo('setRepoPermission')).toEqual([{ slug: 'infra-1', repo: 'app', permission: 'push' }]);
    expect(client.memberships).toEqual([{ slug: 'infra-1', username: 'octocat', role: 'member' }]);
  });
});

describe('repository created this run', () => {
  test('is resolvable by the governance changes after it', async () => {
    const client = new FakeClient({ repositories: [] });
    const changes: Change[] = [
      { kind: 'create-repository', repository: { name: 'fresh' } },
      {
        kind: 'attach-security-config',
        configName: 'baseline',
        scope: 'selected',
        repositories: ['fresh'],
      },
    ];
    client.securityConfigurations = [{ id: 9, name: 'baseline' }];

    await apply(client, 'acme', changes, { teams: [] });

    const attached = client.callsTo('attachSecurityConfiguration');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ id: 9 });
    expect((attached[0] as { repositoryIds: number[] }).repositoryIds).toHaveLength(1);
  });
});

describe('backup', () => {
  const desired: DesiredState = {
    owner: 'acme',
    ownerType: 'organization',
    teams: [],
  };
  const live: LiveState = {
    teams: [team({ slug: 'platform' }), team({ slug: 'web', parentSlug: 'platform' })],
    teamMembers: new Map([['platform', [{ login: 'octocat', role: 'maintainer' as const, inherited: false }]]]),
    teamRepositories: new Map([['platform', [{ name: 'app', roleName: 'write' }]]]),
  };

  test('writes the snapshot, the rollback manifest, the plan, and a journal', () => {
    const outdir = mkdtempSync(join(tmpdir(), 'cdkgithub-backup-'));
    const backup = writeBackup(outdir, desired, live, []);
    backup.journal({ kind: 'delete', description: 'delete team web', status: 'applied' });
    backup.journal({ kind: 'update', description: 'update team platform', status: 'failed', error: 'boom' });

    const files = readdirSync(backup.dir).sort();
    expect(files).toEqual(['journal.jsonl', 'live-state.json', 'plan.json', 'rollback-manifest.json']);

    const snapshot = JSON.parse(readFileSync(join(backup.dir, 'live-state.json'), 'utf8')) as {
      teamMembers: Record<string, unknown[]>;
    };
    expect(snapshot.teamMembers.platform).toHaveLength(1);

    const journal = readFileSync(join(backup.dir, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; error?: string });
    expect(journal.map((j) => j.status)).toEqual(['applied', 'failed']);
    expect(journal[1]!.error).toBe('boom');
  });

  test('the rollback manifest restores teams, rosters, and grants', () => {
    const manifest = rollbackManifest(desired, live);
    expect(manifest.owner).toBe('acme');
    // Parents before children, so it applies top-to-bottom.
    expect(manifest.teams.map((t) => t.slug)).toEqual(['platform', 'web']);

    const platform = manifest.teams[0]!;
    expect(platform.maintainers).toEqual(['octocat']);
    expect(platform.repositories).toEqual({ app: 'push' });
    // The child's surfaces were never read, so the rollback does not claim them.
    expect(manifest.teams[1]!.members).toBeUndefined();
    expect(manifest.teams[1]!.repositories).toBeUndefined();
  });

  test('an IdP-synced team keeps its shape but not a roster', () => {
    const withIdp: DesiredState = {
      ...desired,
      teams: [
        {
          slug: 'platform',
          name: 'platform',
          privacy: 'closed',
          externalGroup: { name: 'Platform Group' },
        },
      ],
    };
    const manifest = rollbackManifest(withIdp, live);
    expect(manifest.teams[0]!.maintainers).toBeUndefined();
    expect(manifest.teams[0]!.members).toBeUndefined();
  });
});
