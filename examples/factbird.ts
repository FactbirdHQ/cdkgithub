/**
 * Example organization definition — the human-authored source of truth for the
 * `factbird` org's team structure and governance. Edit this, run
 * `cdkgithub synth examples/factbird.ts`, then `cdkgithub plan` to preview and
 * `cdkgithub apply --yes` to reconcile.
 */
import {
  ActionsPolicy,
  App,
  BranchProtection,
  CodeSecurityConfiguration,
  CustomProperty,
  Organization,
  Repository,
  Ruleset,
  Team,
} from '../src/index.ts';

const app = new App();

const org = new Organization(app, 'factbird', {
  login: 'factbird',
  settings: {
    defaultRepositoryPermission: 'read',
    membersCanCreatePublicRepositories: false,
    membersCanForkPrivateRepositories: false,
    webCommitSignoffRequired: true,
  },
});

// ---- Teams ----------------------------------------------------------------

// Top-level team, membership driven by an Entra ID security group (SCIM).
const engineering = new Team(org, 'engineering', {
  description: 'All engineers',
  privacy: 'closed',
  externalGroup: { name: 'GH-Engineering' }, // Entra security group; linked via SCIM
});

// Nested team: scoped under `engineering`, so it becomes a child team on GitHub.
new Team(engineering, 'platform', {
  description: 'Platform & infrastructure',
  externalGroup: { name: 'GH-Platform' },
  repositories: {
    'flight-deck': 'maintain',
    'module-cdk-aws': 'push',
  },
});

// A non-synced team whose membership is managed here directly.
new Team(org, 'security', {
  description: 'Security guild',
  privacy: 'secret',
  maintainers: ['mj'],
});

// ---- Classification -------------------------------------------------------

// Properties classify repositories so rulesets can target the class rather than
// a list of names, and keep covering repositories nobody has created yet.
new CustomProperty(org, 'service-tier', {
  valueType: 'single_select',
  description: 'How much protection a repository needs',
  allowedValues: ['tier-1', 'tier-2', 'internal'],
  required: true,
  defaultValue: 'internal',
  values: {
    'flight-deck': 'tier-1',
    'module-cdk-aws': 'tier-2',
  },
});

// ---- Rulesets -------------------------------------------------------------

// Everything gets the default branch protected against deletion and rewrites.
new Ruleset(org, 'protect-default-branch', {
  conditions: {
    refName: { include: ['~DEFAULT_BRANCH'] },
    repositoryName: { include: ['~ALL'] },
  },
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
});

// Tier-1 services additionally need a reviewed, signed, up-to-date merge.
new Ruleset(org, 'tier-1-review', {
  conditions: {
    refName: { include: ['~DEFAULT_BRANCH'] },
    repositoryProperty: {
      include: [{ name: 'service-tier', propertyValues: ['tier-1'] }],
    },
  },
  rules: [
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: {
        requiredApprovingReviewCount: 1,
        dismissStaleReviewsOnPush: true,
        requireCodeOwnerReview: true,
        requireLastPushApproval: false,
        requiredReviewThreadResolution: true,
        allowedMergeMethods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        requiredStatusChecks: [{ context: 'build' }],
        strictRequiredStatusChecksPolicy: true,
      },
    },
  ],
  bypassActors: [{ actorType: 'OrganizationAdmin', actorId: 1 }],
});

// ---- Actions --------------------------------------------------------------

new ActionsPolicy(org, 'actions', {
  allowedActions: 'selected',
  allowedActionsConfig: {
    githubOwnedAllowed: true,
    verifiedAllowed: false,
    patternsAllowed: ['factbird/*'],
  },
  // Workflows that need to write ask for it in the workflow file.
  defaultWorkflowPermissions: 'read',
  canApprovePullRequestReviews: false,
});

// ---- Code security --------------------------------------------------------

new CodeSecurityConfiguration(org, 'baseline', {
  description: 'Dependabot, secret scanning, and push protection everywhere',
  dependencyGraph: 'enabled',
  dependabotAlerts: 'enabled',
  dependabotSecurityUpdates: 'enabled',
  secretScanning: 'enabled',
  secretScanningPushProtection: 'enabled',
  privateVulnerabilityReporting: 'enabled',
  enforcement: 'enforced',
  defaultForNewRepos: 'all',
  attach: 'all_without_configurations',
});

// ---- Legacy branch protection ---------------------------------------------

// One repository still carries branch protection from before the rulesets
// above. It is written down here so it is reviewable, and `enabled: false`
// retires it once the ruleset has been running in `evaluate` long enough to
// trust. Synth warns about this block, which is the point: on an organization
// it is a migration step, not a destination.
const legacy = new Repository(org, 'module-cdk-aws');

new BranchProtection(legacy, 'main', {
  enforceAdmins: true,
  requiredSignatures: true,
  requiredStatusChecks: { strict: true, checks: [{ context: 'build' }] },
  requiredPullRequestReviews: {
    requiredApprovingReviewCount: 1,
    dismissStaleReviews: true,
  },
});

app.synth();
