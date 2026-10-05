/**
 * Desired-state types for the organization's governance surfaces: org settings,
 * the Actions policy, rulesets, code security configurations, and custom
 * properties.
 *
 * Two conventions run through this file:
 *
 * - **Partial declaration.** Every field is optional and `undefined` means
 *   "cdkgithub does not manage this"; the planner only diffs what the definition
 *   actually declares, so adopting one setting never resets its neighbours.
 * - **camelCase in, snake_case out.** These types mirror GitHub's payloads
 *   field-for-field but in the casing the rest of the authoring API uses. The
 *   client deep-converts keys before writing, and the planner converts the
 *   desired state the same way before comparing it to what GitHub returns.
 */

import type { RepoPermission } from './manifest.ts';

// ---------------------------------------------------------------------------
// Organization settings — PATCH /orgs/{org}
// ---------------------------------------------------------------------------

/** Base permission every org member gets on every repository. */
export type DefaultRepositoryPermission = 'read' | 'write' | 'admin' | 'none';

/**
 * Member privileges and org-wide defaults.
 *
 * The `*_enabled_for_new_repositories` security toggles that `PATCH /orgs` also
 * accepts are deliberately absent: GitHub has superseded them with code security
 * configurations, which this tool models as
 * {@link CodeSecurityConfigurationManifest}.
 */
export interface OrgSettingsManifest {
  readonly defaultRepositoryPermission?: DefaultRepositoryPermission;
  readonly membersCanCreateRepositories?: boolean;
  readonly membersCanCreatePublicRepositories?: boolean;
  readonly membersCanCreatePrivateRepositories?: boolean;
  readonly membersCanCreateInternalRepositories?: boolean;
  readonly membersCanCreatePages?: boolean;
  readonly membersCanCreatePublicPages?: boolean;
  readonly membersCanCreatePrivatePages?: boolean;
  readonly membersCanForkPrivateRepositories?: boolean;
  readonly webCommitSignoffRequired?: boolean;
  readonly hasOrganizationProjects?: boolean;
  readonly hasRepositoryProjects?: boolean;
}

// ---------------------------------------------------------------------------
// Actions policy — /orgs/{org}/actions/permissions[/*]
// ---------------------------------------------------------------------------

/** Which repositories in the org may run GitHub Actions at all. */
export type EnabledRepositories = 'all' | 'none' | 'selected';

/** Which actions and reusable workflows those repositories may run. */
export type AllowedActions = 'all' | 'local_only' | 'selected';

/** The allowlist that applies when `allowedActions` is `selected`. */
export interface AllowedActionsConfig {
  /** Allow actions published by GitHub itself (the `actions` org). */
  readonly githubOwnedAllowed?: boolean;
  /** Allow actions from GitHub Marketplace verified creators. */
  readonly verifiedAllowed?: boolean;
  /** Explicit allowlist, e.g. `["octo-org/*", "actions/checkout@v4"]`. */
  readonly patternsAllowed?: string[];
}

/** Default `GITHUB_TOKEN` permissions granted to workflow runs. */
export type DefaultWorkflowPermissions = 'read' | 'write';

export interface ActionsPolicyManifest {
  readonly enabledRepositories?: EnabledRepositories;
  /**
   * Repository names that may run Actions. Only meaningful with
   * `enabledRepositories: "selected"`; names are resolved to ids at apply time.
   */
  readonly selectedRepositories?: string[];
  readonly allowedActions?: AllowedActions;
  /** Only meaningful with `allowedActions: "selected"`. */
  readonly allowedActionsConfig?: AllowedActionsConfig;
  readonly defaultWorkflowPermissions?: DefaultWorkflowPermissions;
  /** Whether workflow runs may approve pull requests. Enabling this is a known risk. */
  readonly canApprovePullRequestReviews?: boolean;
}

// ---------------------------------------------------------------------------
// Rulesets — /orgs/{org}/rulesets
// ---------------------------------------------------------------------------

/** What a ruleset protects: refs, tags, pushes, or repository lifecycle. */
export type RulesetTarget = 'branch' | 'tag' | 'push' | 'repository';

/** `active` enforces the rules; `evaluate` reports violations without blocking. */
export type RulesetEnforcement = 'disabled' | 'active' | 'evaluate';

/** `always`, or `pull_request` to bypass only through a pull request. */
export type BypassMode = 'always' | 'pull_request';

export type BypassActorType = 'Integration' | 'OrganizationAdmin' | 'RepositoryRole' | 'Team' | 'DeployKey';

interface BypassCommon {
  readonly bypassMode?: BypassMode;
}

/** Every organization administrator. */
export interface OrganizationAdminBypass extends BypassCommon {
  readonly actorType: 'OrganizationAdmin';
}

/** Any deploy key on a matching repository. */
export interface DeployKeyBypass extends BypassCommon {
  readonly actorType: 'DeployKey';
}

/** One team, named by slug and resolved to its id while planning. */
export interface TeamBypass extends BypassCommon {
  readonly actorType: 'Team';
  /** Team slug, or a numeric team id to skip the lookup. */
  readonly team: string | number;
}

/** One GitHub App, named by the slug of its installation on this org. */
export interface AppBypass extends BypassCommon {
  readonly actorType: 'Integration';
  /** App slug as it appears in the org's installations, or a numeric app id. */
  readonly app: string | number;
}

/**
 * One repository role.
 *
 * This one takes an id rather than a name. GitHub's REST description carries no
 * route for listing repository roles at the API version pinned here, and the
 * ids of the built-in roles are not in the published schema either, so a name
 * lookup would mean hardcoding a mapping nobody can check. Granting bypass to
 * the wrong role is the kind of mistake worth refusing to guess at.
 */
export interface RepositoryRoleBypass extends BypassCommon {
  readonly actorType: 'RepositoryRole';
  readonly roleId: number;
}

/**
 * An actor allowed to bypass a ruleset's rules.
 *
 * GitHub stores a numeric `actor_id` whose meaning depends on `actor_type`, and
 * those ids are not knowable when the definition is written. So the definition
 * names the actor and cdkgithub resolves it while planning, before the diff:
 * resolving only at apply time would leave the planner comparing a name against
 * the id GitHub returns, and every run would report drift.
 */
export type RulesetBypassActor =
  | OrganizationAdminBypass
  | DeployKeyBypass
  | TeamBypass
  | AppBypass
  | RepositoryRoleBypass;

/** A bypass actor after resolution: what GitHub stores, and what the diff compares. */
export interface ResolvedBypassActor {
  readonly actorType: BypassActorType;
  readonly actorId: number | null;
  readonly bypassMode?: BypassMode;
}

/** An include/exclude pattern pair, as used for refs and repository names. */
export interface RulesetNamePatterns {
  /** Patterns that must match. `~ALL` and `~DEFAULT_BRANCH` are accepted for refs. */
  readonly include?: string[];
  readonly exclude?: string[];
}

/** A repository custom property that a ruleset targets. */
export interface RulesetPropertySpec {
  readonly name: string;
  readonly propertyValues: string[];
  /** `custom` (the default) or `system` for GitHub-defined properties. */
  readonly source?: 'custom' | 'system';
}

/**
 * Which repositories and refs a ruleset applies to.
 *
 * Target repositories either by name (`repositoryName`) or by custom property
 * (`repositoryProperty`) — GitHub accepts one or the other, not both. Property
 * targeting is what makes {@link CustomPropertyManifest} worth declaring: classify
 * repos once, then aim rulesets at the class.
 */
export interface RulesetConditions {
  readonly refName?: RulesetNamePatterns;
  readonly repositoryName?: RulesetNamePatterns & {
    /** Prevent matching repositories from being renamed out of the ruleset. */
    readonly protected?: boolean;
  };
  readonly repositoryProperty?: {
    readonly include?: RulesetPropertySpec[];
    readonly exclude?: RulesetPropertySpec[];
  };
}

/** Parameters shared by the five name/message pattern rules. */
export interface PatternRuleParameters {
  /** How the rule is labelled in the GitHub UI and in violation messages. */
  readonly name?: string;
  /** Fail when the pattern *does* match, rather than when it does not. */
  readonly negate?: boolean;
  readonly operator: 'starts_with' | 'ends_with' | 'contains' | 'regex';
  readonly pattern: string;
}

/** A status check that must pass, optionally pinned to the app that reports it. */
export interface StatusCheckConfiguration {
  readonly context: string;
  readonly integrationId?: number;
}

/** A code scanning tool whose results must be in before a ref updates. */
export interface CodeScanningTool {
  /** The name of the tool, as it reports itself, e.g. `CodeQL`. */
  readonly tool: string;
  /** Severity at which an ordinary alert blocks the update. */
  readonly alertsThreshold: 'none' | 'errors' | 'errors_and_warnings' | 'all';
  /** Severity at which a security alert blocks the update. */
  readonly securityAlertsThreshold: 'none' | 'critical' | 'high_or_higher' | 'medium_or_higher' | 'all';
}

/** A reusable workflow that must run, pinned to a ref or sha. */
export interface WorkflowFileReference {
  readonly path: string;
  readonly repositoryId: number;
  readonly ref?: string;
  readonly sha?: string;
}

/**
 * One rule in a ruleset. This is GitHub's rule union, restricted to the types
 * that make sense to declare centrally; the shape of each `parameters` object
 * mirrors the REST payload.
 */
export type RulesetRule =
  | { readonly type: 'creation' }
  | {
      readonly type: 'update';
      readonly parameters?: { readonly updateAllowsFetchAndMerge: boolean };
    }
  | { readonly type: 'deletion' }
  | { readonly type: 'required_linear_history' }
  | { readonly type: 'required_signatures' }
  | { readonly type: 'non_fast_forward' }
  | {
      readonly type: 'pull_request';
      readonly parameters: {
        readonly requiredApprovingReviewCount: number;
        readonly dismissStaleReviewsOnPush: boolean;
        readonly requireCodeOwnerReview: boolean;
        readonly requireLastPushApproval: boolean;
        readonly requiredReviewThreadResolution: boolean;
        readonly allowedMergeMethods?: Array<'merge' | 'squash' | 'rebase'>;
        /** Request a Copilot review on every new pull request. */
        readonly automaticCopilotCodeReviewEnabled?: boolean;
        /**
         * GitHub's `require_extra_approval_for_unattributed_changes`. GitHub
         * reports it on every pull request rule, but a rule written without it
         * takes whatever GitHub defaults it to, so a rule that relies on it
         * should declare it.
         */
        readonly requireExtraApprovalForUnattributedChanges?: boolean;
      };
    }
  | {
      readonly type: 'required_status_checks';
      readonly parameters: {
        readonly requiredStatusChecks: StatusCheckConfiguration[];
        readonly strictRequiredStatusChecksPolicy: boolean;
        /** Let branch/repo creation through even when a check would block it. */
        readonly doNotEnforceOnCreate?: boolean;
      };
    }
  | {
      readonly type: 'required_deployments';
      readonly parameters: {
        readonly requiredDeploymentEnvironments: string[];
      };
    }
  | {
      readonly type:
        | 'commit_message_pattern'
        | 'commit_author_email_pattern'
        | 'committer_email_pattern'
        | 'branch_name_pattern'
        | 'tag_name_pattern';
      readonly parameters: PatternRuleParameters;
    }
  | {
      readonly type: 'workflows';
      readonly parameters: { readonly workflows: WorkflowFileReference[] };
    }
  | {
      readonly type: 'file_path_restriction';
      readonly parameters: { readonly restrictedFilePaths: string[] };
    }
  | {
      readonly type: 'max_file_size';
      readonly parameters: { readonly maxFileSize: number };
    }
  | {
      readonly type: 'max_file_path_length';
      readonly parameters: { readonly maxFilePathLength: number };
    }
  | {
      readonly type: 'file_extension_restriction';
      readonly parameters: { readonly restrictedFileExtensions: string[] };
    }
  | {
      readonly type: 'code_scanning';
      readonly parameters: { readonly codeScanningTools: CodeScanningTool[] };
    }
  | {
      readonly type: 'merge_queue';
      readonly parameters: {
        readonly mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
        /** How many PRs are built together, and how the group is formed. */
        readonly groupingStrategy: 'ALLGREEN' | 'HEADGREEN';
        readonly minEntriesToMerge: number;
        readonly maxEntriesToMerge: number;
        readonly maxEntriesToBuild: number;
        /** How long to wait for `minEntriesToMerge` before merging a smaller group. */
        readonly minEntriesToMergeWaitMinutes: number;
        /** A required check that has not reported by now counts as failed. */
        readonly checkResponseTimeoutMinutes: number;
      };
    };

/** A single organization ruleset. Identified by its name, which GitHub keeps unique. */
export interface RulesetManifest {
  readonly name: string;
  readonly target: RulesetTarget;
  readonly enforcement: RulesetEnforcement;
  readonly conditions?: RulesetConditions;
  readonly rules: RulesetRule[];
  readonly bypassActors?: RulesetBypassActor[];
}

/**
 * A ruleset whose bypass actors carry ids instead of names. The planner produces
 * these, and they are what the client writes and what the live org returns.
 */
export interface ResolvedRuleset extends Omit<RulesetManifest, 'bypassActors'> {
  readonly bypassActors?: ResolvedBypassActor[];
}

/** What a repository-level ruleset protects. Repository lifecycle rules are org-only. */
export type RepositoryRulesetTarget = Exclude<RulesetTarget, 'repository'>;

/**
 * A ruleset defined on one repository rather than on the organization.
 *
 * Same rule union and bypass actors as {@link RulesetManifest}, minus the
 * repository-targeting conditions: the ruleset already lives on its repository,
 * so only `refName` selects anything.
 */
export interface RepositoryRulesetManifest extends Omit<RulesetManifest, 'target' | 'conditions'> {
  /** The repository the ruleset lives on. */
  readonly repository: string;
  readonly target: RepositoryRulesetTarget;
  readonly conditions?: Pick<RulesetConditions, 'refName'>;
}

// ---------------------------------------------------------------------------
// Code security configurations — /orgs/{org}/code-security/configurations
// ---------------------------------------------------------------------------

/** Tri-state used by most code security features. `not_set` leaves the repo's own choice. */
export type SecurityFeature = 'enabled' | 'disabled' | 'not_set';

/** Which repositories a configuration is attached to when it is applied. */
export type SecurityAttachScope = 'all' | 'all_without_configurations' | 'public' | 'private_or_internal';

/** Which new repositories inherit a configuration automatically. */
export type SecurityDefaultScope = 'all' | 'public' | 'private_and_internal';

export interface CodeSecurityConfigurationManifest {
  /** Unique within the org; this is the configuration's identity for diffing. */
  readonly name: string;
  readonly description: string;
  readonly advancedSecurity?: 'enabled' | 'disabled' | 'code_security' | 'secret_protection';
  readonly dependencyGraph?: SecurityFeature;
  readonly dependencyGraphAutosubmitAction?: SecurityFeature;
  readonly dependabotAlerts?: SecurityFeature;
  readonly dependabotSecurityUpdates?: SecurityFeature;
  readonly codeScanningDefaultSetup?: SecurityFeature;
  readonly secretScanning?: SecurityFeature;
  readonly secretScanningPushProtection?: SecurityFeature;
  readonly secretScanningValidityChecks?: SecurityFeature;
  readonly secretScanningNonProviderPatterns?: SecurityFeature;
  readonly privateVulnerabilityReporting?: SecurityFeature;
  /** `enforced` stops repository admins from turning the features back off. */
  readonly enforcement?: 'enforced' | 'unenforced';
  /** Make this the configuration new repositories of the given scope start with. */
  readonly defaultForNewRepos?: SecurityDefaultScope;
  /**
   * Attach the configuration to existing repositories. Applied on every run
   * rather than diffed, because a scope names no repositories to compare.
   */
  readonly attach?: SecurityAttachScope;
  /**
   * Attach to these repositories by name, diffed against the repositories
   * already attached. Mutually exclusive with `attach`.
   */
  readonly attachRepositories?: string[];
}

// ---------------------------------------------------------------------------
// Custom properties — /orgs/{org}/properties/schema and /properties/values
// ---------------------------------------------------------------------------

export type CustomPropertyValueType = 'string' | 'single_select' | 'multi_select' | 'true_false';

export interface CustomPropertyManifest {
  readonly name: string;
  readonly valueType: CustomPropertyValueType;
  readonly required?: boolean;
  readonly defaultValue?: string | string[] | null;
  readonly description?: string | null;
  /** Permitted values for `single_select` and `multi_select`. */
  readonly allowedValues?: string[] | null;
  readonly valuesEditableBy?: 'org_actors' | 'org_and_repo_actors' | null;
  /**
   * Per-repository values: `{ "flow-portal": "tier-1" }`. Declaring them here
   * keeps a property and the repositories it classifies in one place, which is
   * what property-targeted rulesets need.
   */
  readonly values?: Record<string, string | string[] | null>;
}

// ---------------------------------------------------------------------------
// Issue fields — /orgs/{org}/issue-fields
// ---------------------------------------------------------------------------

export type IssueFieldDataType = 'text' | 'date' | 'number' | 'single_select' | 'multi_select';

export type IssueFieldOptionColor = 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple';

/** One choice of a `single_select` or `multi_select` issue field. */
export interface IssueFieldOptionManifest {
  readonly name: string;
  readonly description?: string | null;
  /** Defaults to `gray`, which GitHub requires some color for. */
  readonly color?: IssueFieldOptionColor;
}

export interface IssueFieldManifest {
  readonly name: string;
  /** Fixed at creation. GitHub has no endpoint that changes it. */
  readonly dataType: IssueFieldDataType;
  readonly description?: string | null;
  readonly visibility?: 'organization_members_only' | 'all';
  /**
   * The choices of a select field, in the order GitHub lists them. The list is
   * the whole set. An option left out is removed, and so is its value on every
   * issue that holds it.
   */
  readonly options?: IssueFieldOptionManifest[];
}

// ---------------------------------------------------------------------------
// Organization roles — /orgs/{org}/organization-roles
// ---------------------------------------------------------------------------

/**
 * Who holds one organization role.
 *
 * Absent lists mean the same thing they mean everywhere else here: a surface
 * the definition does not own. Declaring `teams` and leaving `users` off leaves
 * the individual assignments alone.
 */
export interface OrganizationRoleManifest {
  /** GitHub's name for the role, e.g. `security_manager`. */
  readonly name: string;
  readonly teams?: string[];
  readonly users?: string[];
}

/**
 * A repository role the organization defines on top of a built-in.
 *
 * `name` is its identity for diffing, and the string a team writes as a
 * permission to grant through it.
 */
export interface CustomRepositoryRoleManifest {
  readonly name: string;
  readonly description: string;
  readonly baseRole: string;
  readonly permissions: readonly string[];
}

/**
 * Who can see a repository.
 *
 * `internal` exists only in an organization owned by an enterprise account, and
 * means every member of that enterprise can read it while nobody outside can.
 * `private` means only the teams and people given access.
 */
export type RepositoryVisibility = 'public' | 'private' | 'internal';

/**
 * A repository to create if the organization does not have one by this name.
 *
 * Everything but `name` describes what to create. An existing repository is
 * adopted unchanged, so none of it is compared against a live one.
 */
/** A person granted access to one repository directly, outside any team. */
export interface CollaboratorManifest {
  readonly repository: string;
  readonly login: string;
  readonly permission: RepoPermission;
}

export interface RepositoryManifest {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: RepositoryVisibility;
  readonly allowMergeCommit?: boolean;
  readonly allowSquashMerge?: boolean;
  readonly allowRebaseMerge?: boolean;
  readonly deleteBranchOnMerge?: boolean;
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasWiki?: boolean;
}
