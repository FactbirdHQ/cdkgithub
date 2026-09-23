import { describe, expect, test } from 'bun:test';
import {
  App,
  BranchProtection,
  Organization,
  Repository,
  Ruleset,
  Team,
  UserAccount,
} from '../src/index.ts';
import type { LiveBranchProtection } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { collectWarnings } from '../src/synth/warnings.ts';
import { FakeClient } from './fake-client.ts';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams: [], ...overrides };
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return { teams: [], ...overrides };
}

/** A branch as GitHub reports it, already flattened by the client. */
function liveProtection(
  overrides: Partial<LiveBranchProtection> = {},
): LiveBranchProtection {
  return {
    repository: 'app',
    branch: 'main',
    enabled: true,
    enforceAdmins: true,
    requiredLinearHistory: false,
    allowForcePushes: false,
    allowDeletions: false,
    requiredSignatures: false,
    requiredStatusChecks: { strict: true, checks: [{ context: 'build' }] },
    requiredPullRequestReviews: {
      requiredApprovingReviewCount: 1,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: false,
      requireLastPushApproval: false,
    },
    ...overrides,
  };
}

describe('owner model', () => {
  test('a personal account synthesizes repositories and branch protection', () => {
    const app = new App();
    const me = new UserAccount(app, 'martinjlowm', { login: 'martinjlowm' });
    const dotfiles = new Repository(me, 'dotfiles');
    new BranchProtection(dotfiles, 'main', { requiredSignatures: true });

    const state = synthesize(app);

    expect(state.ownerType).toBe('user');
    expect(state.owner).toBe('martinjlowm');
    expect(state.branchProtection).toEqual([
      { repository: 'dotfiles', branch: 'main', requiredSignatures: true },
    ]);
  });

  test('a personal account rejects the org-only surfaces', () => {
    const app = new App();
    const me = new UserAccount(app, 'martinjlowm', { login: 'martinjlowm' });
    new Team(me, 'engineering');

    expect(() => synthesize(app)).toThrow(
      /declares Team, which GitHub only offers to organizations/,
    );
  });

  test('rejects two owners in one app', () => {
    const app = new App();
    new Organization(app, 'acme', { login: 'acme' });
    new UserAccount(app, 'me', { login: 'me' });

    expect(() => synthesize(app)).toThrow(/Expected exactly one Organization/);
  });

  test('reads the repository from nesting, or from the prop', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const deck = new Repository(org, 'flow-portal');
    new BranchProtection(deck, 'main', {});
    new BranchProtection(org, 'release', { repository: 'module-infra' });

    const state = synthesize(app);

    expect(
      state.branchProtection?.map((p) => `${p.repository}#${p.branch}`).sort(),
    ).toEqual(['flow-portal#main', 'module-infra#release']);
  });

  test('a branch protection with no repository at all is an error', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new BranchProtection(org, 'main', {});

    expect(() => synthesize(app)).toThrow(/names no repository/);
  });
});

describe('branch protection planning', () => {
  test('reports no change when the branch already matches', () => {
    const changes = plan(
      desired({
        branchProtection: [
          { repository: 'app', branch: 'main', enforceAdmins: true },
        ],
      }),
      live({ branchProtection: [liveProtection()] }),
    );
    expect(changes).toEqual([]);
  });

  test('names the settings that differ', () => {
    const changes = plan(
      desired({
        branchProtection: [
          {
            repository: 'app',
            branch: 'main',
            enforceAdmins: true,
            requiredPullRequestReviews: {
              requiredApprovingReviewCount: 2,
              dismissStaleReviews: true,
            },
          },
        ],
      }),
      live({ branchProtection: [liveProtection()] }),
    );

    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.kind).toBe('branch-protection');
    if (change.kind === 'branch-protection') {
      expect(change.fields.map((f) => f.field)).toEqual([
        'requiredPullRequestReviews.requiredApprovingReviewCount',
      ]);
    }
  });

  test('an unprotected branch reads as one whole change, not a field list', () => {
    const changes = plan(
      desired({
        branchProtection: [
          { repository: 'app', branch: 'main', enforceAdmins: true },
        ],
      }),
      live({
        branchProtection: [
          { repository: 'app', branch: 'main', enabled: false },
        ],
      }),
    );
    expect(changes).toHaveLength(1);
    if (changes[0]!.kind === 'branch-protection') {
      expect(changes[0]!.fields).toEqual([
        { field: 'protection', from: 'none', to: 'declared' },
      ]);
    }
  });

  test('enabled: false removes protection, and is a no-op once it is gone', () => {
    const retire = desired({
      branchProtection: [{ repository: 'app', branch: 'main', enabled: false }],
    });

    expect(
      plan(retire, live({ branchProtection: [liveProtection()] })).map(
        (c) => c.kind,
      ),
    ).toEqual(['remove-branch-protection']);

    expect(
      plan(
        retire,
        live({
          branchProtection: [
            { repository: 'app', branch: 'main', enabled: false },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('branch protection applying', () => {
  test('writes signatures through their own endpoint', async () => {
    const client = new FakeClient();
    const state = live({
      branchProtection: [{ repository: 'app', branch: 'main', enabled: false }],
    });
    const changes = plan(
      desired({
        branchProtection: [
          {
            repository: 'app',
            branch: 'main',
            enforceAdmins: true,
            requiredSignatures: true,
          },
        ],
      }),
      state,
    );

    await apply(client, 'acme', changes, state, {});

    expect(client.callsTo('putBranchProtection')).toHaveLength(1);
    expect(client.callsTo('setSignatureProtection')).toEqual([
      { repo: 'app', branch: 'main', required: true },
    ]);
  });

  test('removing protection is gated behind --allow-delete', async () => {
    const client = new FakeClient();
    const state = live({ branchProtection: [liveProtection()] });
    const changes = plan(
      desired({
        branchProtection: [
          { repository: 'app', branch: 'main', enabled: false },
        ],
      }),
      state,
    );

    // The declaration is deliberate, but tearing down an enforcement surface
    // still needs the gate: without it, nothing is deleted and the skip says so.
    const withoutGate = await apply(client, 'acme', changes, state, {});
    expect(withoutGate.skipped).toEqual([
      'remove branch protection from app#main (use --allow-delete)',
    ]);
    expect(client.callsTo('deleteBranchProtection')).toEqual([]);

    const withGate = await apply(client, 'acme', changes, state, {
      allowDelete: true,
    });
    expect(withGate.skipped).toEqual([]);
    expect(client.callsTo('deleteBranchProtection')).toEqual([
      { repo: 'app', branch: 'main' },
    ]);
  });
});

describe('warnings', () => {
  test('warns when an organization reaches for legacy protection', () => {
    const warnings = collectWarnings(
      desired({
        branchProtection: [{ repository: 'app', branch: 'main' }],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Organization rulesets cover the same rules');
    expect(warnings[0]).toContain('app#main');
  });

  test('stays quiet for a personal account, which has no rulesets', () => {
    expect(
      collectWarnings({
        owner: 'martinjlowm',
        ownerType: 'user',
        teams: [],
        branchProtection: [{ repository: 'dotfiles', branch: 'main' }],
      }),
    ).toEqual([]);
  });

  test('stays quiet when the protection is being retired', () => {
    expect(
      collectWarnings(
        desired({
          branchProtection: [
            { repository: 'app', branch: 'main', enabled: false },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test('flags a branch covered by both systems at once', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Ruleset(org, 'protect-all', {
      conditions: { repositoryName: { include: ['~ALL'] } },
      rules: [{ type: 'deletion' }],
    });
    const repo = new Repository(org, 'app');
    new BranchProtection(repo, 'main', { enforceAdmins: true });

    const warnings = collectWarnings(synthesize(app));

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('the stricter rule wins');
    expect(warnings[1]).toContain('"protect-all"');
  });

  test('does not flag an overlap the ruleset patterns rule out', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Ruleset(org, 'services-only', {
      conditions: { repositoryName: { include: ['service-*'] } },
      rules: [{ type: 'deletion' }],
    });
    const repo = new Repository(org, 'docs');
    new BranchProtection(repo, 'main', { enforceAdmins: true });

    // Only the "prefer rulesets" warning, no overlap claim.
    expect(collectWarnings(synthesize(app))).toHaveLength(1);
  });
});
