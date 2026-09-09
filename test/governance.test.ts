import { describe, expect, test } from 'bun:test';
import { toCamelCaseKeys, toSnakeCaseKeys } from '../src/github/casing.ts';
import type { LiveRuleset } from '../src/github/client.ts';
import { apply } from '../src/reconcile/applier.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import { matchesSubset } from '../src/reconcile/subset.ts';
import type { DesiredState, RulesetManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams: [], ...overrides };
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return { teams: [], ...overrides };
}

const protectMain: RulesetManifest = {
  name: 'protect-main',
  target: 'branch',
  enforcement: 'active',
  conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        requiredApprovingReviewCount: 1,
        dismissStaleReviewsOnPush: true,
        requireCodeOwnerReview: false,
        requireLastPushApproval: false,
        requiredReviewThreadResolution: true,
      },
    },
  ],
};

/** The same ruleset as GitHub hands it back: extra parameters and all. */
function liveProtectMain(overrides: Partial<LiveRuleset> = {}): LiveRuleset {
  return {
    id: 7,
    name: 'protect-main',
    target: 'branch',
    enforcement: 'active',
    sourceType: 'Organization',
    conditions: { refName: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          requiredApprovingReviewCount: 1,
          dismissStaleReviewsOnPush: true,
          requireCodeOwnerReview: false,
          requireLastPushApproval: false,
          requiredReviewThreadResolution: true,
          // GitHub fills these in; the definition never mentioned them.
          allowedMergeMethods: ['merge', 'squash', 'rebase'],
          automaticCopilotCodeReviewEnabled: false,
        },
      } as unknown as RulesetManifest['rules'][number],
    ],
    bypassActors: [],
    ...overrides,
  };
}

describe('surfaces are unmanaged until declared', () => {
  test('a teams-only definition proposes nothing for rulesets or properties', () => {
    const changes = plan(
      desired(),
      live({
        rulesets: [liveProtectMain()],
        customProperties: [{ name: 'tier', valueType: 'string' }],
      }),
    );
    expect(changes).toEqual([]);
  });

  test('a declared surface prunes what the definition omits', () => {
    const changes = plan(
      desired({ rulesets: [] }),
      live({ rulesets: [liveProtectMain()] }),
    );
    expect(changes.map((c) => c.kind)).toEqual(['delete-ruleset']);
  });
});

describe('rulesets', () => {
  test('reports no change when the live ruleset only adds defaults', () => {
    const changes = plan(
      desired({ rulesets: [protectMain] }),
      live({ rulesets: [liveProtectMain()] }),
    );
    expect(changes).toEqual([]);
  });

  test('names the parts that differ', () => {
    const changes = plan(
      desired({ rulesets: [{ ...protectMain, enforcement: 'evaluate' }] }),
      live({ rulesets: [liveProtectMain()] }),
    );
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.kind).toBe('update-ruleset');
    if (change.kind === 'update-ruleset') {
      expect(change.fields.map((f) => f.field)).toEqual(['enforcement']);
      expect(change.id).toBe(7);
    }
  });

  test('an extra live rule counts as a difference', () => {
    const withExtraRule = liveProtectMain({
      rules: [...liveProtectMain().rules, { type: 'required_signatures' }],
    });
    const changes = plan(
      desired({ rulesets: [protectMain] }),
      live({ rulesets: [withExtraRule] }),
    );
    expect(changes).toHaveLength(1);
    if (changes[0]!.kind === 'update-ruleset') {
      expect(changes[0]!.fields.map((f) => f.field)).toEqual(['rules']);
    }
  });

  test('creates a ruleset that does not exist, and leaves enterprise ones alone', () => {
    const changes = plan(
      desired({ rulesets: [protectMain] }),
      live({
        rulesets: [
          liveProtectMain({
            id: 99,
            name: 'enterprise-wide',
            sourceType: 'Enterprise',
          }),
        ],
      }),
    );
    expect(changes.map((c) => c.kind)).toEqual(['create-ruleset']);
  });
});

describe('organization settings and the actions policy', () => {
  test('diffs only the fields the definition declares', () => {
    const changes = plan(
      desired({
        settings: {
          defaultRepositoryPermission: 'read',
          webCommitSignoffRequired: true,
        },
      }),
      live({
        settings: {
          defaultRepositoryPermission: 'write',
          webCommitSignoffRequired: true,
          membersCanCreatePublicRepositories: true,
        },
      }),
    );
    expect(changes).toHaveLength(1);
    if (changes[0]!.kind === 'org-settings') {
      expect(changes[0]!.fields).toEqual([
        { field: 'defaultRepositoryPermission', from: 'write', to: 'read' },
      ]);
    }
  });

  test('reports nested allowlist fields with a dotted path', () => {
    const changes = plan(
      desired({
        actions: {
          allowedActions: 'selected',
          allowedActionsConfig: {
            githubOwnedAllowed: true,
            patternsAllowed: ['acme/*'],
          },
        },
      }),
      live({
        actions: {
          enabledRepositories: 'all',
          allowedActions: 'selected',
          allowedActionsConfig: {
            githubOwnedAllowed: true,
            patternsAllowed: [],
          },
          defaultWorkflowPermissions: 'write',
          canApprovePullRequestReviews: true,
        },
      }),
    );
    expect(changes).toHaveLength(1);
    if (changes[0]!.kind === 'actions-policy') {
      expect(changes[0]!.fields.map((f) => f.field)).toEqual([
        'allowedActionsConfig.patternsAllowed',
      ]);
    }
  });

  test('writes the allowlist and the token defaults through their own endpoints', async () => {
    const client = new FakeClient({
      actions: {
        enabledRepositories: 'all',
        allowedActions: 'all',
        defaultWorkflowPermissions: 'write',
        canApprovePullRequestReviews: true,
      },
    });
    const state = live({ actions: client.actions });
    const changes = plan(
      desired({
        actions: {
          allowedActions: 'selected',
          allowedActionsConfig: { patternsAllowed: ['acme/*'] },
          defaultWorkflowPermissions: 'read',
          canApprovePullRequestReviews: false,
        },
      }),
      state,
    );

    const result = await apply(client, 'acme', changes, state, {});

    expect(result.governance).toBe(1);
    expect(client.callsTo('setActionsPermissions')).toEqual([
      { enabledRepositories: undefined, allowedActions: 'selected' },
    ]);
    expect(client.callsTo('setAllowedActions')).toEqual([
      { patternsAllowed: ['acme/*'] },
    ]);
    expect(client.callsTo('setDefaultWorkflowPermissions')).toEqual([
      {
        defaultWorkflowPermissions: 'read',
        canApprovePullRequestReviews: false,
      },
    ]);
  });

  test('touches only the endpoint whose fields differ', async () => {
    const client = new FakeClient({
      actions: {
        enabledRepositories: 'all',
        allowedActions: 'all',
        defaultWorkflowPermissions: 'write',
        canApprovePullRequestReviews: true,
      },
    });
    const state = live({ actions: client.actions });
    const changes = plan(
      desired({
        actions: {
          allowedActions: 'all',
          defaultWorkflowPermissions: 'read',
        },
      }),
      state,
    );

    await apply(client, 'acme', changes, state, {});

    expect(client.callsTo('setActionsPermissions')).toEqual([]);
    expect(client.callsTo('setDefaultWorkflowPermissions')).toEqual([
      {
        defaultWorkflowPermissions: 'read',
        canApprovePullRequestReviews: undefined,
      },
    ]);
  });
});

describe('custom properties', () => {
  test('sets values only on the repositories that differ, one call per value', async () => {
    const client = new FakeClient();
    const state = live({
      customProperties: [
        { name: 'tier', valueType: 'single_select', allowedValues: ['a', 'b'] },
      ],
      repositoryProperties: [
        { repository: 'already', properties: { tier: 'a' } },
        { repository: 'stale', properties: { tier: 'b' } },
      ],
    });
    const changes = plan(
      desired({
        customProperties: [
          {
            name: 'tier',
            valueType: 'single_select',
            allowedValues: ['a', 'b'],
            values: { already: 'a', stale: 'a', missing: 'b' },
          },
        ],
      }),
      state,
    );

    expect(changes.map((c) => c.kind)).toEqual(['property-values']);
    if (changes[0]!.kind === 'property-values') {
      expect(changes[0]!.values).toEqual({ stale: 'a', missing: 'b' });
    }

    await apply(client, 'acme', changes, state, {});
    expect(client.callsTo('setRepositoryPropertyValues')).toEqual([
      { repositories: ['stale'], values: { tier: 'a' } },
      { repositories: ['missing'], values: { tier: 'b' } },
    ]);
  });
});

describe('code security configurations', () => {
  test('creates, defaults, and attaches in an order that resolves the id', async () => {
    const client = new FakeClient({ repositories: [{ id: 5, name: 'app' }] });
    const state = live({
      securityConfigurations: [],
      defaultSecurityConfigurations: [],
    });
    const changes = plan(
      desired({
        codeSecurityConfigurations: [
          {
            name: 'baseline',
            description: 'Secret scanning everywhere',
            secretScanning: 'enabled',
            defaultForNewRepos: 'all',
            attachRepositories: ['app'],
          },
        ],
      }),
      state,
    );

    expect(changes.map((c) => c.kind)).toEqual([
      'create-security-config',
      'default-security-config',
      'attach-security-config',
    ]);

    await apply(client, 'acme', changes, state, {});

    const [attached] = client.callsTo('attachSecurityConfiguration');
    expect(attached).toEqual({
      id: 1000,
      scope: 'selected',
      repositoryIds: [5],
    });
    expect(client.callsTo('setSecurityConfigurationAsDefault')).toEqual([
      { id: 1000, scope: 'all' },
    ]);
  });

  test('resolves the id of each configuration this run creates', async () => {
    const client = new FakeClient();
    const state = live({
      securityConfigurations: [],
      defaultSecurityConfigurations: [],
    });
    const changes = plan(
      desired({
        codeSecurityConfigurations: [
          {
            name: 'public-baseline',
            description: 'Public repositories',
            defaultForNewRepos: 'public',
          },
          {
            name: 'private-baseline',
            description: 'Private repositories',
            defaultForNewRepos: 'private_and_internal',
          },
        ],
      }),
      state,
    );

    await apply(client, 'acme', changes, state, {});

    // The second configuration does not exist yet when the first one is
    // defaulted, so its id has to come from its own create.
    expect(client.callsTo('setSecurityConfigurationAsDefault')).toEqual([
      { id: 1000, scope: 'public' },
      { id: 1001, scope: 'private_and_internal' },
    ]);
  });

  test("leaves GitHub's own global presets out of the pruning", () => {
    const changes = plan(
      desired({ codeSecurityConfigurations: [] }),
      live({
        securityConfigurations: [
          { id: 1, name: 'GitHub recommended', targetType: 'global' },
          { id: 2, name: 'ours', targetType: 'organization' },
        ],
      }),
    );
    expect(changes).toHaveLength(1);
    if (changes[0]!.kind === 'delete-security-config') {
      expect(changes[0]!.live.name).toBe('ours');
    }
  });
});

describe('deletes stay gated behind --allow-delete', () => {
  test('governance deletes are skipped and reported', async () => {
    const client = new FakeClient({ rulesets: [liveProtectMain()] });
    const state = live({
      rulesets: client.rulesets,
      customProperties: [{ name: 'tier', valueType: 'string' }],
    });
    const changes = plan(
      desired({ rulesets: [], customProperties: [] }),
      state,
    );

    const skipped = await apply(client, 'acme', changes, state, {});
    expect(skipped.skipped).toEqual([
      'delete custom property "tier" (use --allow-delete)',
      'delete ruleset "protect-main" (use --allow-delete)',
    ]);
    expect(client.callsTo('deleteRuleset')).toEqual([]);

    const allowed = await apply(client, 'acme', changes, state, {
      allowDelete: true,
    });
    expect(allowed.governance).toBe(2);
    expect(client.callsTo('deleteRuleset')).toEqual([7]);
  });
});

describe('matchesSubset', () => {
  test('ignores live fields the definition never mentioned', () => {
    expect(matchesSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matchesSubset({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  test('compares arrays without regard to order but not to length', () => {
    expect(matchesSubset(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(matchesSubset(['a'], ['a', 'b'])).toBe(false);
  });

  test('treats an omitted value and an explicit null as the same', () => {
    expect(matchesSubset({ description: null }, {})).toBe(true);
  });
});

describe('ruleset rule coverage', () => {
  test('every rule type GitHub accepts round-trips through the payload', () => {
    // One of each, so a rule type that stops converting cleanly fails here
    // rather than at apply time against the live org.
    const everyRule: RulesetManifest['rules'] = [
      { type: 'creation' },
      { type: 'update', parameters: { updateAllowsFetchAndMerge: true } },
      { type: 'deletion' },
      { type: 'required_linear_history' },
      { type: 'required_signatures' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          requiredApprovingReviewCount: 2,
          dismissStaleReviewsOnPush: true,
          requireCodeOwnerReview: true,
          requireLastPushApproval: true,
          requiredReviewThreadResolution: true,
          allowedMergeMethods: ['squash'],
          automaticCopilotCodeReviewEnabled: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          requiredStatusChecks: [{ context: 'build', integrationId: 15368 }],
          strictRequiredStatusChecksPolicy: true,
          doNotEnforceOnCreate: true,
        },
      },
      {
        type: 'required_deployments',
        parameters: { requiredDeploymentEnvironments: ['production'] },
      },
      {
        type: 'commit_message_pattern',
        parameters: { operator: 'regex', pattern: '^(feat|fix)' },
      },
      {
        type: 'branch_name_pattern',
        parameters: { operator: 'starts_with', pattern: 'release/' },
      },
      {
        type: 'workflows',
        parameters: {
          workflows: [{ path: '.github/workflows/ci.yaml', repositoryId: 1 }],
        },
      },
      {
        type: 'file_path_restriction',
        parameters: { restrictedFilePaths: ['secrets/**'] },
      },
      { type: 'max_file_size', parameters: { maxFileSize: 100 } },
      { type: 'max_file_path_length', parameters: { maxFilePathLength: 255 } },
      {
        type: 'file_extension_restriction',
        parameters: { restrictedFileExtensions: ['.pem'] },
      },
      {
        type: 'code_scanning',
        parameters: {
          codeScanningTools: [
            {
              tool: 'CodeQL',
              alertsThreshold: 'errors',
              securityAlertsThreshold: 'high_or_higher',
            },
          ],
        },
      },
      {
        type: 'merge_queue',
        parameters: {
          mergeMethod: 'SQUASH',
          groupingStrategy: 'ALLGREEN',
          minEntriesToMerge: 1,
          maxEntriesToMerge: 5,
          maxEntriesToBuild: 5,
          minEntriesToMergeWaitMinutes: 5,
          checkResponseTimeoutMinutes: 60,
        },
      },
    ];

    const payload = toSnakeCaseKeys(everyRule) as Array<
      Record<string, unknown>
    >;

    const paramsOf = (type: string) =>
      payload.find((r) => r.type === type)?.parameters;

    // 21 rule types, but the 5 pattern rules share one shape and two of them
    // stand in for the set.
    expect(payload).toHaveLength(18);
    expect(paramsOf('pull_request')).toMatchObject({
      required_approving_review_count: 2,
      allowed_merge_methods: ['squash'],
      automatic_copilot_code_review_enabled: false,
    });
    expect(paramsOf('merge_queue')).toMatchObject({
      merge_method: 'SQUASH',
      grouping_strategy: 'ALLGREEN',
      min_entries_to_merge_wait_minutes: 5,
      check_response_timeout_minutes: 60,
    });
    expect(paramsOf('code_scanning')).toMatchObject({
      code_scanning_tools: [
        {
          tool: 'CodeQL',
          alerts_threshold: 'errors',
          security_alerts_threshold: 'high_or_higher',
        },
      ],
    });
    expect(toCamelCaseKeys<RulesetManifest['rules']>(payload)).toEqual(
      everyRule,
    );
  });
});
