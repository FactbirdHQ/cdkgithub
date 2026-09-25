import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import type {
  ActorRestriction,
  AllowedActions,
  AllowedActionsConfig,
  BranchProtectionManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  CustomRepositoryRoleManifest,
  RepositoryManifest,
  DefaultWorkflowPermissions,
  EnabledRepositories,
  OrgConfigVisibility,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedBypassActor,
  ResolvedRuleset,
  RulesetConditions,
  RulesetManifest,
  RulesetRule,
  RulesetTarget,
  RunnerGroupManifest,
  RunnerGroupVisibility,
  SecurityAttachScope,
  SecurityDefaultScope,
  TeamNotificationSetting,
  TeamPrivacy,
} from '../synth/manifest.ts';
import { toCamelCaseKeys, toSnakeCaseKeys } from './casing.ts';
import { sealSecretValue } from './seal.ts';

/** GitHub reports the setting as a plain string; anything else is unknown. */
function notificationSettingOf(
  value: string | undefined,
): TeamNotificationSetting | undefined {
  return value === 'notifications_enabled' || value === 'notifications_disabled'
    ? value
    : undefined;
}

/** Live representation of a team as read back from GitHub. */
export interface LiveTeam {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly privacy: TeamPrivacy;
  /** Absent only when GitHub leaves it out of the response. */
  readonly notificationSetting?: TeamNotificationSetting;
  /** Slug of the parent team, or null if top-level. */
  readonly parentSlug: string | null;
}

/**
 * One repository a team can reach, as GitHub reports it.
 *
 * `roleName` is GitHub's friendly vocabulary, `read`/`write`/`admin` and the
 * display name of a custom role, which is not the vocabulary
 * `PUT /orgs/{org}/teams/{slug}/repos/{repo}` takes. {@link comparableRoleName}
 * is what reconciles the two.
 */
export interface LiveTeamRepository {
  readonly name: string;
  readonly roleName: string;
}

/** One member of a team, with the role GitHub records for them. */
export interface LiveTeamMember {
  readonly login: string;
  readonly role: 'member' | 'maintainer';
}

/** Shape of `GET /orgs/{org}/custom-repository-roles` (not a typed Octokit method). */
interface CustomRepositoryRolesResponse {
  custom_roles?: Array<{
    id: number;
    name: string;
    base_role?: string;
    description?: string;
    permissions?: string[];
  }>;
}

/** A repository role the organization defines on top of the five built-ins. */
export interface LiveCustomRepositoryRole {
  readonly id: number;
  readonly name: string;
  /** The built-in the role extends, which is what ranks it against the others. */
  readonly baseRole: string;
  readonly description?: string;
  /** What the role adds on top of its base. */
  readonly permissions: string[];
}

/**
 * GitHub answers with a friendly role name and takes a permission value, and the
 * two vocabularies disagree on exactly two words. Mapping the reply onto the
 * request is what lets a declared `push` match a live `write` instead of
 * reporting drift on every run. A custom role passes through: its display name
 * is both the reply and the request.
 */
const ROLE_NAME_TO_PERMISSION: Record<string, string> = {
  read: 'pull',
  write: 'push',
};

/** The inverse: the word GitHub takes, for a value written back to it. */
const PERMISSION_TO_ROLE_NAME: Record<string, string> = {
  pull: 'read',
  push: 'write',
};

export function githubRoleName(permission: string): string {
  return PERMISSION_TO_ROLE_NAME[permission] ?? permission;
}

export function comparableRoleName(roleName: string): string {
  return ROLE_NAME_TO_PERMISSION[roleName] ?? roleName;
}

/**
 * An organization role, which grants privileges across the whole organization
 * rather than on one repository.
 *
 * The five `all_repo_*` roles carry a `baseRole`, which is a repository
 * permission on every repository at once: the wildcard a team grant cannot
 * express. The rest carry `permissions` instead, naming what they allow.
 */
export interface LiveOrganizationRole {
  readonly id: number;
  readonly name: string;
  /** A repository permission granted on every repository, when the role has one. */
  readonly baseRole?: string;
  readonly permissions: string[];
  /** `Predefined` for GitHub's own roles, `Organization` for one defined here. */
  readonly source?: string;
}

/** Who holds one organization role. */
export interface LiveRoleAssignment {
  readonly role: string;
  readonly teams: string[];
  readonly users: string[];
}

/** An Entra ID (Azure AD) security group exposed to GitHub via SCIM. */
export interface ExternalIdpGroup {
  readonly id: number;
  readonly name: string;
}

/** Shape of `GET /orgs/{org}/organization-roles` (not a typed Octokit method). */
interface OrganizationRolesResponse {
  roles?: Array<{
    id: number;
    name: string;
    base_role?: string | null;
    permissions?: string[];
    source?: string;
  }>;
}

/** Shape of `GET /orgs/{org}/external-groups` (not covered by Octokit's typed methods). */
interface ExternalGroupsResponse {
  groups?: Array<{ group_id: number | string; group_name: string }>;
}

/** One entry of `GET /orgs/{org}/actions/runner-groups` (not a typed Octokit method). */
interface RawRunnerGroup {
  id: number;
  name: string;
  visibility?: string;
  default?: boolean;
  inherited?: boolean;
  allows_public_repositories?: boolean;
  restricted_to_workflows?: boolean;
  selected_workflows?: string[];
}

export interface CreateTeamParams {
  readonly name: string;
  readonly description?: string;
  readonly privacy: TeamPrivacy;
  readonly notificationSetting?: TeamNotificationSetting;
  /** Numeric id of the parent team, if nested. */
  readonly parentTeamId?: number;
}

export interface UpdateTeamParams {
  readonly name?: string;
  readonly description?: string;
  readonly privacy?: TeamPrivacy;
  readonly notificationSetting?: TeamNotificationSetting;
  /** Numeric id of the parent team, or null to detach. */
  readonly parentTeamId?: number | null;
}

/** A repository in the org, as needed to resolve names to the ids some APIs take. */
export interface LiveRepository {
  readonly id: number;
  readonly name: string;
}

/**
 * The org's member privileges and defaults, in the manifest's casing so the
 * planner can compare it field for field with what the definition declares.
 */
export type LiveOrgSettings = OrgSettingsManifest;

/** The org's effective Actions policy, assembled from three endpoints. */
export interface LiveActionsPolicy {
  readonly enabledRepositories: EnabledRepositories;
  /** Names of the repositories allowed to run Actions, when the policy is `selected`. */
  readonly selectedRepositories?: string[];
  readonly allowedActions?: AllowedActions;
  /** The allowlist, read only when `allowedActions` is `selected`. */
  readonly allowedActionsConfig?: AllowedActionsConfig;
  readonly defaultWorkflowPermissions: DefaultWorkflowPermissions;
  readonly canApprovePullRequestReviews: boolean;
}

/**
 * A ruleset as GitHub holds it. `conditions`, `rules`, and `bypassActors` are
 * converted to the manifest's casing on read so the planner compares like with
 * like; GitHub returns every parameter including the ones the definition never
 * declared, which is why the planner diffs them as a subset rather than for
 * deep equality.
 */
export interface LiveRuleset {
  readonly id: number;
  readonly name: string;
  readonly target: RulesetTarget;
  readonly enforcement: RulesetManifest['enforcement'];
  readonly conditions?: RulesetConditions;
  readonly rules: RulesetRule[];
  readonly bypassActors: ResolvedBypassActor[];
  /** Where the ruleset is defined. Only `Organization` ones are managed here. */
  readonly sourceType: string;
}

/**
 * A code security configuration. The feature fields come back under the same
 * names the manifest uses, so they are typed as a partial manifest.
 */
export type LiveCodeSecurityConfiguration =
  Partial<CodeSecurityConfigurationManifest> & {
    readonly id: number;
    readonly name: string;
    /** `global` configurations are GitHub's own presets and are never managed here. */
    readonly targetType?: 'global' | 'organization' | 'enterprise';
  };

/** Which configuration new repositories of a given scope inherit. */
export interface LiveDefaultSecurityConfiguration {
  readonly defaultForNewRepos: SecurityDefaultScope;
  readonly configurationId?: number;
  readonly configurationName?: string;
}

/** A GitHub App installed on the org, as needed to resolve a bypass actor by slug. */
export interface LiveAppInstallation {
  /** The app id, which is what a ruleset bypass actor stores. */
  readonly appId: number;
  readonly slug: string;
}

/** A custom property in the org's schema, in the manifest's casing. */
export type LiveCustomProperty = Omit<CustomPropertyManifest, 'values'>;

/**
 * A branch's live protection, flattened into the manifest's shape.
 *
 * The read endpoint returns `{ enabled }` wrappers where the write endpoint
 * takes plain booleans, and whole user, team, and app objects where the write
 * endpoint takes logins. Flattening here keeps that asymmetry out of the
 * planner, which then compares the definition against something shaped like
 * itself.
 */
export type LiveBranchProtection = Omit<BranchProtectionManifest, 'enabled'> & {
  /** False when the branch carries no protection at all. */
  readonly enabled: boolean;
};

/** The custom property values carried by one repository. */
export interface LiveRepositoryProperties {
  readonly repository: string;
  readonly properties: Record<string, string | string[] | null>;
}

/** A ruleset that lives on one repository, as read back for diffing. */
export interface LiveRepositoryRuleset extends LiveRuleset {
  readonly repository: string;
}

/** A self-hosted runner group, as GitHub reports it. */
export interface LiveRunnerGroup {
  readonly id: number;
  readonly name: string;
  readonly visibility: RunnerGroupVisibility;
  /** GitHub's built-in group. It can be reconfigured but never deleted. */
  readonly isDefault: boolean;
  readonly allowsPublicRepositories: boolean;
  readonly restrictedToWorkflows: boolean;
  readonly selectedWorkflows: string[];
  /** Repository names, read only when the visibility is `selected`. */
  readonly selectedRepositories?: string[];
}

/** An organization Actions variable. Values are plain and come back whole. */
export interface LiveOrgVariable {
  readonly name: string;
  readonly value: string;
  readonly visibility: OrgConfigVisibility;
  /** Repository names, read only when the visibility is `selected`. */
  readonly selectedRepositories?: string[];
}

/** One repository's Actions variable. */
export interface LiveRepoVariable {
  readonly repository: string;
  /** The deployment environment it is scoped to. Absent for a repository-wide one. */
  readonly environment?: string;
  readonly name: string;
  readonly value: string;
}

/** A deployment environment on one repository. */
export interface LiveRepoEnvironment {
  readonly repository: string;
  readonly name: string;
}

/** An organization Actions secret. GitHub never returns the value. */
export interface LiveOrgSecret {
  readonly name: string;
  readonly visibility: OrgConfigVisibility;
  /** Repository names, read only when the visibility is `selected`. */
  readonly selectedRepositories?: string[];
}

/** One repository's Actions secret: a name and nothing more. */
export interface LiveRepoSecret {
  readonly repository: string;
  /** The deployment environment it is scoped to. Absent for a repository-wide one. */
  readonly environment?: string;
  readonly name: string;
}

/** A deployment environment's settings, as far as cdkgithub declares them. */
export interface LiveEnvironment {
  readonly repository: string;
  readonly name: string;
  readonly deploymentBranchPolicy: 'all' | 'protected' | 'custom';
  /** The branch and tag patterns, when the policy is `custom`. */
  readonly branchPolicies: Array<{ id: number; name: string; type: 'branch' | 'tag' }>;
  readonly reviewers: { teams: string[]; users: string[] };
  readonly preventSelfReview: boolean;
  readonly waitTimer: number;
}

/** What a create-or-update writes. Reviewers are resolved ids by then. */
export interface EnvironmentSettings {
  readonly deploymentBranchPolicy: 'all' | 'protected' | 'custom';
  readonly reviewers: Array<{ type: 'User' | 'Team'; id: number }>;
  readonly preventSelfReview: boolean;
  readonly waitTimer: number;
}

/**
 * Thin, typed surface over the GitHub API used by the reconciler. Kept as an
 * interface so tests can supply an in-memory fake without touching the network.
 */
export interface GitHubClient {
  listTeams(org: string): Promise<LiveTeam[]>;
  createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam>;
  /**
   * Update a team, addressed by the slug GitHub answers to now. Returns the
   * team as GitHub stores it afterwards: on a rename, the returned slug is the
   * one GitHub actually derived, which is the only trustworthy version of it.
   */
  updateTeam(
    org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<LiveTeam>;
  deleteTeam(org: string, slug: string): Promise<void>;
  setMembership(
    org: string,
    slug: string,
    username: string,
    role: 'member' | 'maintainer',
  ): Promise<void>;
  removeMembership(org: string, slug: string, username: string): Promise<void>;
  setRepoPermission(
    org: string,
    slug: string,
    repo: string,
    permission: RepoPermission,
  ): Promise<void>;
  removeRepoPermission(org: string, slug: string, repo: string): Promise<void>;

  /** A team's direct roster, read back only when the definition declares one. */
  listTeamMembers(org: string, slug: string): Promise<LiveTeamMember[]>;

  /** A team's repository grants, read back only when the definition declares them. */
  listTeamRepositories(
    org: string,
    slug: string,
  ): Promise<LiveTeamRepository[]>;

  /** The org's custom repository roles, for resolving a non-built-in permission. */
  listCustomRepositoryRoles(org: string): Promise<LiveCustomRepositoryRole[]>;
  createCustomRepositoryRole(
    org: string,
    role: CustomRepositoryRoleManifest,
  ): Promise<void>;
  updateCustomRepositoryRole(
    org: string,
    roleId: number,
    role: CustomRepositoryRoleManifest,
  ): Promise<void>;
  deleteCustomRepositoryRole(org: string, roleId: number): Promise<void>;

  listExternalGroups(org: string): Promise<ExternalIdpGroup[]>;
  linkExternalGroup(org: string, slug: string, groupId: number): Promise<void>;

  // Organization roles — /orgs/{org}/organization-roles
  listOrganizationRoles(org: string): Promise<LiveOrganizationRole[]>;
  readRoleAssignment(
    org: string,
    roleId: number,
  ): Promise<{ teams: string[]; users: string[] }>;
  assignRoleToTeam(org: string, roleId: number, team: string): Promise<void>;
  removeRoleFromTeam(org: string, roleId: number, team: string): Promise<void>;
  assignRoleToUser(
    org: string,
    roleId: number,
    username: string,
  ): Promise<void>;
  removeRoleFromUser(
    org: string,
    roleId: number,
    username: string,
  ): Promise<void>;

  /** Repositories in the org, used to resolve names to ids. */
  listRepositories(org: string): Promise<LiveRepository[]>;

  /**
   * Create a repository. There is deliberately no update and no delete beside
   * it: an existing repository is adopted as it stands, and nothing here
   * removes one.
   */
  createRepository(
    org: string,
    repository: RepositoryManifest,
  ): Promise<LiveRepository>;

  /**
   * Whether this organization can have internal repositories, which is true
   * exactly when an enterprise account owns it.
   */
  supportsInternalRepositories(org: string): Promise<boolean>;

  /** Apps installed on the org, used to resolve a ruleset bypass actor by slug. */
  listAppInstallations(org: string): Promise<LiveAppInstallation[]>;

  // Organization settings — PATCH /orgs/{org}
  getOrgSettings(org: string): Promise<LiveOrgSettings>;
  updateOrgSettings(org: string, settings: OrgSettingsManifest): Promise<void>;

  // Actions policy — /orgs/{org}/actions/permissions[/*]
  getActionsPolicy(org: string): Promise<LiveActionsPolicy>;
  setActionsPermissions(
    org: string,
    params: {
      enabledRepositories?: EnabledRepositories;
      allowedActions?: AllowedActions;
    },
  ): Promise<void>;
  setActionsSelectedRepositories(
    org: string,
    repositoryIds: number[],
  ): Promise<void>;
  setAllowedActions(org: string, config: AllowedActionsConfig): Promise<void>;
  setDefaultWorkflowPermissions(
    org: string,
    params: {
      defaultWorkflowPermissions?: DefaultWorkflowPermissions;
      canApprovePullRequestReviews?: boolean;
    },
  ): Promise<void>;

  // Rulesets — /orgs/{org}/rulesets
  listRulesets(org: string): Promise<LiveRuleset[]>;
  /**
   * The id of the org ruleset with this exact name, or undefined. GitHub does
   * not make ruleset names unique, so a create that ran once already must be
   * found and turned into an update rather than enforced twice.
   */
  findRulesetIdByName(org: string, name: string): Promise<number | undefined>;
  createRuleset(org: string, ruleset: ResolvedRuleset): Promise<void>;
  updateRuleset(
    org: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void>;
  deleteRuleset(org: string, id: number): Promise<void>;

  // Repository rulesets — /repos/{owner}/{repo}/rulesets
  /** Only the rulesets the repository itself defines, never inherited ones. */
  listRepositoryRulesets(owner: string, repo: string): Promise<LiveRuleset[]>;
  /** Same reason as {@link findRulesetIdByName}: names are not unique, creates must adopt. */
  findRepositoryRulesetIdByName(
    owner: string,
    repo: string,
    name: string,
  ): Promise<number | undefined>;
  createRepositoryRuleset(
    owner: string,
    repo: string,
    ruleset: ResolvedRuleset,
  ): Promise<void>;
  updateRepositoryRuleset(
    owner: string,
    repo: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void>;
  deleteRepositoryRuleset(
    owner: string,
    repo: string,
    id: number,
  ): Promise<void>;

  // Runner groups — /orgs/{org}/actions/runner-groups
  listRunnerGroups(org: string): Promise<LiveRunnerGroup[]>;
  createRunnerGroup(
    org: string,
    group: RunnerGroupManifest,
    selectedRepositoryIds?: number[],
  ): Promise<void>;
  /** Updates everything but the repository list, which has its own endpoint. */
  updateRunnerGroup(
    org: string,
    id: number,
    group: RunnerGroupManifest,
  ): Promise<void>;
  setRunnerGroupRepositories(
    org: string,
    id: number,
    repositoryIds: number[],
  ): Promise<void>;
  deleteRunnerGroup(org: string, id: number): Promise<void>;

  // Actions variables — /orgs/{org}/actions/variables and per repository
  listOrgVariables(org: string): Promise<LiveOrgVariable[]>;
  createOrgVariable(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void>;
  updateOrgVariable(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void>;
  deleteOrgVariable(org: string, name: string): Promise<void>;
  listRepositoryVariables(
    owner: string,
    repo: string,
  ): Promise<Array<{ name: string; value: string }>>;
  createRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void>;
  updateRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void>;
  deleteRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
  ): Promise<void>;
  /** Names of a repository's deployment environments. */
  listRepositoryEnvironments(owner: string, repo: string): Promise<string[]>;
  /** One environment, or undefined when the repository has no such environment. */
  getEnvironment(
    owner: string,
    repo: string,
    name: string,
  ): Promise<LiveEnvironment | undefined>;
  putEnvironment(
    owner: string,
    repo: string,
    name: string,
    settings: EnvironmentSettings,
  ): Promise<void>;
  createEnvironmentBranchPolicy(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    type: 'branch' | 'tag',
  ): Promise<void>;
  deleteEnvironmentBranchPolicy(
    owner: string,
    repo: string,
    environment: string,
    id: number,
  ): Promise<void>;
  /** Numeric ids, for naming reviewers. */
  getTeamId(org: string, slug: string): Promise<number>;
  getUserId(login: string): Promise<number>;
  listEnvironmentSecrets(
    owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string }>>;
  putEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void>;
  deleteEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void>;
  listEnvironmentVariables(
    owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string; value: string }>>;
  createEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void>;
  updateEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void>;
  deleteEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void>;

  // Actions secrets — /orgs/{org}/actions/secrets and per repository.
  // The put methods take the plaintext and seal it to the right public key
  // before anything leaves the process; there is no method that sends a value
  // unencrypted, and none that reads one back, because GitHub has neither.
  listOrgSecrets(org: string): Promise<LiveOrgSecret[]>;
  putOrgSecret(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void>;
  deleteOrgSecret(org: string, name: string): Promise<void>;
  listRepositorySecrets(
    owner: string,
    repo: string,
  ): Promise<Array<{ name: string }>>;
  putRepositorySecret(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void>;
  deleteRepositorySecret(
    owner: string,
    repo: string,
    name: string,
  ): Promise<void>;

  // Code security — /orgs/{org}/code-security/configurations
  listSecurityConfigurations(
    org: string,
  ): Promise<LiveCodeSecurityConfiguration[]>;
  listDefaultSecurityConfigurations(
    org: string,
  ): Promise<LiveDefaultSecurityConfiguration[]>;
  createSecurityConfiguration(
    org: string,
    config: CodeSecurityConfigurationManifest,
  ): Promise<number>;
  updateSecurityConfiguration(
    org: string,
    id: number,
    config: CodeSecurityConfigurationManifest,
  ): Promise<void>;
  deleteSecurityConfiguration(org: string, id: number): Promise<void>;
  setSecurityConfigurationAsDefault(
    org: string,
    id: number,
    scope: SecurityDefaultScope,
  ): Promise<void>;
  attachSecurityConfiguration(
    org: string,
    id: number,
    scope: SecurityAttachScope | 'selected',
    repositoryIds?: number[],
  ): Promise<void>;

  // Custom properties — /orgs/{org}/properties/{schema,values}
  listCustomProperties(org: string): Promise<LiveCustomProperty[]>;
  listRepositoryProperties(org: string): Promise<LiveRepositoryProperties[]>;
  putCustomProperty(
    org: string,
    property: CustomPropertyManifest,
  ): Promise<void>;
  deleteCustomProperty(org: string, name: string): Promise<void>;
  setRepositoryPropertyValues(
    org: string,
    repositories: string[],
    values: Record<string, string | string[] | null>,
  ): Promise<void>;

  // Legacy branch protection — /repos/{owner}/{repo}/branches/{branch}/protection
  getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<LiveBranchProtection>;
  putBranchProtection(
    owner: string,
    repo: string,
    protection: BranchProtectionManifest,
  ): Promise<void>;
  deleteBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<void>;
  setSignatureProtection(
    owner: string,
    repo: string,
    branch: string,
    required: boolean,
  ): Promise<void>;
}

type CreateRulesetParams =
  RestEndpointMethodTypes['repos']['createOrgRuleset']['parameters'];
type UpdateRulesetParams =
  RestEndpointMethodTypes['repos']['updateOrgRuleset']['parameters'];
type CreateSecurityConfigParams =
  RestEndpointMethodTypes['codeSecurity']['createConfiguration']['parameters'];

/**
 * Octokit with GitHub's own throttling and retry best practices: requests are
 * queued rather than fired unbounded, a primary or secondary rate limit is
 * waited out and retried a few times, and transient 5xx/network failures are
 * retried. Without this, one 403 mid-apply leaves the organization half
 * reconciled.
 */
const ThrottledOctokit = Octokit.plugin(retry, throttling);

/** How many times a rate-limited request is retried before giving up. */
const RATE_LIMIT_RETRIES = 3;

function createOctokit(token: string, baseUrl?: string): Octokit {
  return new ThrottledOctokit({
    auth: token,
    baseUrl,
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.error(
          `warning: rate limited on ${options.method} ${options.url}, ` +
            `retrying in ${retryAfter}s`,
        );
        return retryCount < RATE_LIMIT_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.error(
          `warning: secondary rate limit on ${options.method} ${options.url}, ` +
            `retrying in ${retryAfter}s`,
        );
        return retryCount < RATE_LIMIT_RETRIES;
      },
    },
  });
}

/** Default {@link GitHubClient} backed by Octokit against api.github.com. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, baseUrl?: string, octokit?: Octokit) {
    this.octokit = octokit ?? createOctokit(token, baseUrl);
  }

  async listTeams(org: string): Promise<LiveTeam[]> {
    const teams = await this.octokit.paginate(this.octokit.rest.teams.list, {
      org,
      per_page: 100,
    });
    return teams.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description ?? null,
      privacy: (t.privacy as TeamPrivacy) ?? 'closed',
      notificationSetting: notificationSettingOf(t.notification_setting),
      parentSlug: t.parent?.slug ?? null,
    }));
  }

  async createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam> {
    const { data } = await this.octokit.rest.teams.create({
      org,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      notification_setting: params.notificationSetting,
      parent_team_id: params.parentTeamId,
    });
    return {
      id: data.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      privacy: (data.privacy as TeamPrivacy) ?? 'closed',
      notificationSetting: notificationSettingOf(data.notification_setting),
      parentSlug: data.parent?.slug ?? null,
    };
  }

  async updateTeam(
    org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<LiveTeam> {
    const { data } = await this.octokit.rest.teams.updateInOrg({
      org,
      team_slug: slug,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      notification_setting: params.notificationSetting,
      parent_team_id: params.parentTeamId,
    });
    return {
      id: data.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      privacy: (data.privacy as TeamPrivacy) ?? 'closed',
      notificationSetting: notificationSettingOf(data.notification_setting),
      parentSlug: data.parent?.slug ?? null,
    };
  }

  async deleteTeam(org: string, slug: string): Promise<void> {
    await this.octokit.rest.teams.deleteInOrg({ org, team_slug: slug });
  }

  async setMembership(
    org: string,
    slug: string,
    username: string,
    role: 'member' | 'maintainer',
  ): Promise<void> {
    await this.octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
      org,
      team_slug: slug,
      username,
      role,
    });
  }

  async removeMembership(
    org: string,
    slug: string,
    username: string,
  ): Promise<void> {
    await this.octokit.rest.teams.removeMembershipForUserInOrg({
      org,
      team_slug: slug,
      username,
    });
  }

  async setRepoPermission(
    org: string,
    slug: string,
    repo: string,
    permission: RepoPermission,
  ): Promise<void> {
    await this.octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
      org,
      team_slug: slug,
      owner: org,
      repo,
      permission,
    });
  }

  async removeRepoPermission(
    org: string,
    slug: string,
    repo: string,
  ): Promise<void> {
    await this.octokit.rest.teams.removeRepoInOrg({
      org,
      team_slug: slug,
      owner: org,
      repo,
    });
  }

  async listTeamMembers(org: string, slug: string): Promise<LiveTeamMember[]> {
    // Two calls rather than one: the unfiltered listing reports every member
    // with the same role, so the maintainers have to be asked for by name.
    const byRole = async (role: 'maintainer' | 'member') => {
      const users = await this.octokit.paginate(
        this.octokit.rest.teams.listMembersInOrg,
        { org, team_slug: slug, role, per_page: 100 },
      );
      return users.map((u) => ({ login: u.login, role }));
    };
    const [maintainers, members] = await Promise.all([
      byRole('maintainer'),
      byRole('member'),
    ]);
    return [...maintainers, ...members];
  }

  async listTeamRepositories(
    org: string,
    slug: string,
  ): Promise<LiveTeamRepository[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.teams.listReposInOrg,
      { org, team_slug: slug, per_page: 100 },
    );
    return repos.map((r) => ({
      name: r.name,
      roleName: r.role_name ?? 'read',
    }));
  }

  async listCustomRepositoryRoles(
    org: string,
  ): Promise<LiveCustomRepositoryRole[]> {
    // Not among Octokit's generated typed methods at the pinned API version, so
    // it goes through the raw route with the response typed here.
    const { data } = await this.octokit.request<string>(
      'GET /orgs/{org}/custom-repository-roles',
      { org },
    );
    const roles = expectArray(
      (data as CustomRepositoryRolesResponse).custom_roles,
      'GET /orgs/{org}/custom-repository-roles',
      'custom_roles',
    );
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      baseRole: r.base_role ?? 'read',
      description: r.description,
      permissions: r.permissions ?? [],
    }));
  }

  // The external-groups endpoints are not in Octokit's generated typed methods,
  // so we call them via the raw request route and type the response ourselves.
  // See: https://docs.github.com/en/enterprise-cloud@latest/rest/teams/external-groups

  // The organization-roles endpoints are not in Octokit's generated typed
  // methods, so they go through the raw request route with the response typed
  // here. See https://docs.github.com/en/rest/orgs/organization-roles

  async listOrganizationRoles(org: string): Promise<LiveOrganizationRole[]> {
    const { data } = await this.octokit.request(
      'GET /orgs/{org}/organization-roles',
      { org },
    );
    const roles = expectArray(
      (data as OrganizationRolesResponse).roles,
      'GET /orgs/{org}/organization-roles',
      'roles',
    );
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      baseRole: r.base_role ?? undefined,
      permissions: r.permissions ?? [],
      source: r.source,
    }));
  }

  async readRoleAssignment(
    org: string,
    roleId: number,
  ): Promise<{ teams: string[]; users: string[] }> {
    const [teams, users] = await Promise.all([
      this.octokit.paginate(
        'GET /orgs/{org}/organization-roles/{role_id}/teams',
        { org, role_id: roleId, per_page: 100 },
      ),
      this.octokit.paginate(
        'GET /orgs/{org}/organization-roles/{role_id}/users',
        { org, role_id: roleId, per_page: 100 },
      ),
    ]);
    return {
      teams: (teams as Array<{ slug: string }>).map((t) => t.slug).sort(),
      users: (users as Array<{ login: string }>).map((u) => u.login).sort(),
    };
  }

  async assignRoleToTeam(
    org: string,
    roleId: number,
    team: string,
  ): Promise<void> {
    await this.octokit.request(
      'PUT /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}',
      { org, team_slug: team, role_id: roleId },
    );
  }

  async removeRoleFromTeam(
    org: string,
    roleId: number,
    team: string,
  ): Promise<void> {
    await this.octokit.request(
      'DELETE /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}',
      { org, team_slug: team, role_id: roleId },
    );
  }

  async assignRoleToUser(
    org: string,
    roleId: number,
    username: string,
  ): Promise<void> {
    await this.octokit.request(
      'PUT /orgs/{org}/organization-roles/users/{username}/{role_id}',
      { org, username, role_id: roleId },
    );
  }

  async removeRoleFromUser(
    org: string,
    roleId: number,
    username: string,
  ): Promise<void> {
    await this.octokit.request(
      'DELETE /orgs/{org}/organization-roles/users/{username}/{role_id}',
      { org, username, role_id: roleId },
    );
  }

  // Custom repository roles — /orgs/{org}/custom-repository-roles

  async createCustomRepositoryRole(
    org: string,
    role: CustomRepositoryRoleManifest,
  ): Promise<void> {
    await this.octokit.request('POST /orgs/{org}/custom-repository-roles', {
      org,
      name: role.name,
      description: role.description,
      base_role: githubRoleName(role.baseRole),
      permissions: [...role.permissions],
    });
  }

  async updateCustomRepositoryRole(
    org: string,
    roleId: number,
    role: CustomRepositoryRoleManifest,
  ): Promise<void> {
    await this.octokit.request(
      'PATCH /orgs/{org}/custom-repository-roles/{role_id}',
      {
        org,
        role_id: roleId,
        name: role.name,
        description: role.description,
        base_role: githubRoleName(role.baseRole),
        permissions: [...role.permissions],
      },
    );
  }

  async deleteCustomRepositoryRole(org: string, roleId: number): Promise<void> {
    await this.octokit.request(
      'DELETE /orgs/{org}/custom-repository-roles/{role_id}',
      { org, role_id: roleId },
    );
  }

  async supportsInternalRepositories(org: string): Promise<boolean> {
    const { data } = await this.octokit.rest.orgs.get({ org });
    return (
      (data as { members_can_create_internal_repositories?: boolean })
        .members_can_create_internal_repositories === true
    );
  }

  async createRepository(
    org: string,
    repository: RepositoryManifest,
  ): Promise<LiveRepository> {
    const { data } = await this.octokit.request('POST /orgs/{org}/repos', {
      org,
      name: repository.name,
      description: repository.description,
      // Resolved by the caller: `internal` where the enterprise allows it,
      // `private` where it does not, and `public` only when it was asked for.
      //
      // Cast because Octokit's generated types still say public-or-private.
      // The endpoint has accepted `internal` since enterprise accounts gained
      // it, and sends back the repository with that visibility.
      visibility: (repository.visibility ?? 'private') as 'public' | 'private',
      allow_merge_commit: repository.allowMergeCommit,
      allow_squash_merge: repository.allowSquashMerge,
      allow_rebase_merge: repository.allowRebaseMerge,
      delete_branch_on_merge: repository.deleteBranchOnMerge,
      has_issues: repository.hasIssues,
      has_projects: repository.hasProjects,
      has_wiki: repository.hasWiki,
    });
    const created = data as { id: number; name: string };
    return { id: created.id, name: created.name };
  }

  async listExternalGroups(org: string): Promise<ExternalIdpGroup[]> {
    // Paginated by hand: the endpoint pages at 30 by default, and its body
    // wraps the array in `{groups}`, which defeats `octokit.paginate`. Reading
    // only the first page would make every group past it "not provisioned".
    const all: ExternalIdpGroup[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.request(
        'GET /orgs/{org}/external-groups',
        { org, per_page: perPage, page },
      );
      const groups = expectArray(
        (data as ExternalGroupsResponse).groups,
        'GET /orgs/{org}/external-groups',
        'groups',
      );
      all.push(
        ...groups.map((g) => ({ id: Number(g.group_id), name: g.group_name })),
      );
      if (groups.length < perPage) return all;
    }
  }

  async linkExternalGroup(
    org: string,
    slug: string,
    groupId: number,
  ): Promise<void> {
    await this.octokit.request(
      'PATCH /orgs/{org}/teams/{team_slug}/external-groups',
      { org, team_slug: slug, group_id: groupId },
    );
  }

  async listRepositories(org: string): Promise<LiveRepository[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.repos.listForOrg,
      {
        org,
        per_page: 100,
      },
    );
    return repos.map((r) => ({ id: r.id, name: r.name }));
  }

  async listAppInstallations(org: string): Promise<LiveAppInstallation[]> {
    const installations = await this.octokit.paginate(
      this.octokit.rest.orgs.listAppInstallations,
      { org, per_page: 100 },
    );
    return installations.map((i) => ({ appId: i.app_id, slug: i.app_slug }));
  }

  // ---- Organization settings ---------------------------------------------

  async getOrgSettings(org: string): Promise<LiveOrgSettings> {
    const { data } = await this.octokit.rest.orgs.get({ org });
    return {
      // GitHub returns null for a few of these on orgs that never set them;
      // undefined is what "not set" means everywhere else in this codebase.
      defaultRepositoryPermission:
        data.default_repository_permission as OrgSettingsManifest['defaultRepositoryPermission'],
      membersCanCreateRepositories:
        data.members_can_create_repositories ?? undefined,
      membersCanCreatePublicRepositories:
        data.members_can_create_public_repositories,
      membersCanCreatePrivateRepositories:
        data.members_can_create_private_repositories,
      membersCanCreateInternalRepositories:
        data.members_can_create_internal_repositories,
      membersCanCreatePages: data.members_can_create_pages ?? undefined,
      membersCanCreatePublicPages:
        data.members_can_create_public_pages ?? undefined,
      membersCanCreatePrivatePages:
        data.members_can_create_private_pages ?? undefined,
      membersCanForkPrivateRepositories:
        data.members_can_fork_private_repositories ?? undefined,
      webCommitSignoffRequired: data.web_commit_signoff_required,
      hasOrganizationProjects: data.has_organization_projects,
      hasRepositoryProjects: data.has_repository_projects,
    };
  }

  async updateOrgSettings(
    org: string,
    settings: OrgSettingsManifest,
  ): Promise<void> {
    await this.octokit.rest.orgs.update({
      org,
      default_repository_permission: settings.defaultRepositoryPermission,
      members_can_create_repositories: settings.membersCanCreateRepositories,
      members_can_create_public_repositories:
        settings.membersCanCreatePublicRepositories,
      members_can_create_private_repositories:
        settings.membersCanCreatePrivateRepositories,
      members_can_create_internal_repositories:
        settings.membersCanCreateInternalRepositories,
      members_can_create_pages: settings.membersCanCreatePages,
      members_can_create_public_pages: settings.membersCanCreatePublicPages,
      members_can_create_private_pages: settings.membersCanCreatePrivatePages,
      members_can_fork_private_repositories:
        settings.membersCanForkPrivateRepositories,
      web_commit_signoff_required: settings.webCommitSignoffRequired,
      has_organization_projects: settings.hasOrganizationProjects,
      has_repository_projects: settings.hasRepositoryProjects,
    });
  }

  // ---- Actions policy ------------------------------------------------------

  async getActionsPolicy(org: string): Promise<LiveActionsPolicy> {
    const { data: permissions } =
      await this.octokit.rest.actions.getGithubActionsPermissionsOrganization({
        org,
      });
    const { data: workflow } =
      await this.octokit.rest.actions.getGithubActionsDefaultWorkflowPermissionsOrganization(
        { org },
      );

    let allowedActionsConfig: AllowedActionsConfig | undefined;
    if (permissions.allowed_actions === 'selected') {
      const { data } =
        await this.octokit.rest.actions.getAllowedActionsOrganization({ org });
      allowedActionsConfig = {
        githubOwnedAllowed: data.github_owned_allowed,
        verifiedAllowed: data.verified_allowed,
        patternsAllowed: data.patterns_allowed,
      };
    }

    let selectedRepositories: string[] | undefined;
    if (permissions.enabled_repositories === 'selected') {
      const repos = await this.octokit.paginate(
        this.octokit.rest.actions
          .listSelectedRepositoriesEnabledGithubActionsOrganization,
        { org, per_page: 100 },
      );
      selectedRepositories = repos.map((r) => r.name);
    }

    return {
      enabledRepositories: permissions.enabled_repositories,
      selectedRepositories,
      allowedActions: permissions.allowed_actions,
      allowedActionsConfig,
      defaultWorkflowPermissions: workflow.default_workflow_permissions,
      canApprovePullRequestReviews: workflow.can_approve_pull_request_reviews,
    };
  }

  async setActionsPermissions(
    org: string,
    params: {
      enabledRepositories?: EnabledRepositories;
      allowedActions?: AllowedActions;
    },
  ): Promise<void> {
    // The endpoint replaces both fields, so a partial declaration has to be
    // merged onto what the org has today.
    const { data: current } =
      await this.octokit.rest.actions.getGithubActionsPermissionsOrganization({
        org,
      });
    await this.octokit.rest.actions.setGithubActionsPermissionsOrganization({
      org,
      enabled_repositories:
        params.enabledRepositories ?? current.enabled_repositories,
      allowed_actions: params.allowedActions ?? current.allowed_actions,
    });
  }

  async setActionsSelectedRepositories(
    org: string,
    repositoryIds: number[],
  ): Promise<void> {
    await this.octokit.rest.actions.setSelectedRepositoriesEnabledGithubActionsOrganization(
      { org, selected_repository_ids: repositoryIds },
    );
  }

  async setAllowedActions(
    org: string,
    config: AllowedActionsConfig,
  ): Promise<void> {
    await this.octokit.rest.actions.setAllowedActionsOrganization({
      org,
      github_owned_allowed: config.githubOwnedAllowed,
      verified_allowed: config.verifiedAllowed,
      patterns_allowed: config.patternsAllowed,
    });
  }

  async setDefaultWorkflowPermissions(
    org: string,
    params: {
      defaultWorkflowPermissions?: DefaultWorkflowPermissions;
      canApprovePullRequestReviews?: boolean;
    },
  ): Promise<void> {
    await this.octokit.rest.actions.setGithubActionsDefaultWorkflowPermissionsOrganization(
      {
        org,
        default_workflow_permissions: params.defaultWorkflowPermissions,
        can_approve_pull_request_reviews: params.canApprovePullRequestReviews,
      },
    );
  }

  // ---- Rulesets ------------------------------------------------------------

  async findRulesetIdByName(
    org: string,
    name: string,
  ): Promise<number | undefined> {
    const summaries = await this.octokit.paginate(
      this.octokit.rest.repos.getOrgRulesets,
      { org, per_page: 100 },
    );
    return summaries.find((s) => s.name === name)?.id;
  }

  async listRulesets(org: string): Promise<LiveRuleset[]> {
    const summaries = await this.octokit.paginate(
      this.octokit.rest.repos.getOrgRulesets,
      { org, per_page: 100 },
    );
    // The list endpoint omits rules and conditions, so each ruleset is read back
    // in full before it can be diffed.
    const rulesets: LiveRuleset[] = [];
    for (const summary of summaries) {
      const { data } = await this.octokit.rest.repos.getOrgRuleset({
        org,
        ruleset_id: summary.id,
      });
      rulesets.push({
        id: data.id,
        name: data.name,
        target: (data.target ?? 'branch') as RulesetTarget,
        enforcement: data.enforcement,
        conditions: data.conditions
          ? toCamelCaseKeys<RulesetConditions>(data.conditions)
          : undefined,
        rules: toCamelCaseKeys<RulesetRule[]>(data.rules ?? []),
        bypassActors: toCamelCaseKeys<ResolvedBypassActor[]>(
          data.bypass_actors ?? [],
        ),
        sourceType: data.source_type ?? 'Organization',
      });
    }
    return rulesets;
  }

  async createRuleset(org: string, ruleset: ResolvedRuleset): Promise<void> {
    await this.octokit.rest.repos.createOrgRuleset({
      org,
      ...rulesetPayload(ruleset),
    } as CreateRulesetParams);
  }

  async updateRuleset(
    org: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    await this.octokit.rest.repos.updateOrgRuleset({
      org,
      ruleset_id: id,
      ...rulesetPayload(ruleset),
    } as UpdateRulesetParams);
  }

  async deleteRuleset(org: string, id: number): Promise<void> {
    await this.octokit.rest.repos.deleteOrgRuleset({ org, ruleset_id: id });
  }

  // ---- Repository rulesets -------------------------------------------------

  async listRepositoryRulesets(
    owner: string,
    repo: string,
  ): Promise<LiveRuleset[]> {
    // `includes_parents: false` keeps org and enterprise rulesets out: they
    // are visible from the repository but owned elsewhere, and a pruning pass
    // that saw them would propose deleting policy it does not manage.
    const summaries = await this.octokit.paginate(
      this.octokit.rest.repos.getRepoRulesets,
      { owner, repo, per_page: 100, includes_parents: false },
    );
    const rulesets: LiveRuleset[] = [];
    for (const summary of summaries) {
      const { data } = await this.octokit.rest.repos.getRepoRuleset({
        owner,
        repo,
        ruleset_id: summary.id,
        includes_parents: false,
      });
      rulesets.push({
        id: data.id,
        name: data.name,
        target: (data.target ?? 'branch') as RulesetTarget,
        enforcement: data.enforcement,
        conditions: data.conditions
          ? toCamelCaseKeys<RulesetConditions>(data.conditions)
          : undefined,
        rules: toCamelCaseKeys<RulesetRule[]>(data.rules ?? []),
        bypassActors: toCamelCaseKeys<ResolvedBypassActor[]>(
          data.bypass_actors ?? [],
        ),
        sourceType: data.source_type ?? 'Repository',
      });
    }
    return rulesets;
  }

  async findRepositoryRulesetIdByName(
    owner: string,
    repo: string,
    name: string,
  ): Promise<number | undefined> {
    const summaries = await this.octokit.paginate(
      this.octokit.rest.repos.getRepoRulesets,
      { owner, repo, per_page: 100, includes_parents: false },
    );
    return summaries.find((s) => s.name === name)?.id;
  }

  async createRepositoryRuleset(
    owner: string,
    repo: string,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    await this.octokit.rest.repos.createRepoRuleset({
      owner,
      repo,
      ...rulesetPayload(ruleset),
    } as RestEndpointMethodTypes['repos']['createRepoRuleset']['parameters']);
  }

  async updateRepositoryRuleset(
    owner: string,
    repo: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    await this.octokit.rest.repos.updateRepoRuleset({
      owner,
      repo,
      ruleset_id: id,
      ...rulesetPayload(ruleset),
    } as RestEndpointMethodTypes['repos']['updateRepoRuleset']['parameters']);
  }

  async deleteRepositoryRuleset(
    owner: string,
    repo: string,
    id: number,
  ): Promise<void> {
    await this.octokit.rest.repos.deleteRepoRuleset({
      owner,
      repo,
      ruleset_id: id,
    });
  }

  // ---- Runner groups ---------------------------------------------------------

  // The runner-group endpoints are not in Octokit's generated typed methods at
  // the pinned version, so they go through the raw request route with the
  // responses typed here, like the organization-roles endpoints above. Both
  // list bodies wrap their array, which defeats `octokit.paginate`, so they
  // page by hand the way listExternalGroups does.
  // See https://docs.github.com/en/rest/actions/self-hosted-runner-groups

  async listRunnerGroups(org: string): Promise<LiveRunnerGroup[]> {
    const raw: RawRunnerGroup[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.request(
        'GET /orgs/{org}/actions/runner-groups',
        { org, per_page: perPage, page },
      );
      const groups = expectArray(
        (data as { runner_groups?: RawRunnerGroup[] }).runner_groups,
        'GET /orgs/{org}/actions/runner-groups',
        'runner_groups',
      );
      raw.push(...groups);
      if (groups.length < perPage) break;
    }
    // An enterprise shares its runner groups into every organization, and the
    // listing returns them marked `inherited`, possibly under the same name as
    // a group the organization owns. The org endpoints cannot change or
    // delete them, so they are not part of the org's own surface: reading
    // them would make the importer emit two groups with one name and the
    // planner diff a group no apply could touch.
    return Promise.all(
      raw
        .filter((g) => g.inherited !== true)
        .map(async (g) => ({
        id: g.id,
        name: g.name,
        visibility: (g.visibility ?? 'all') as RunnerGroupVisibility,
        isDefault: g.default === true,
        allowsPublicRepositories: g.allows_public_repositories === true,
        restrictedToWorkflows: g.restricted_to_workflows === true,
        selectedWorkflows: g.selected_workflows ?? [],
        selectedRepositories:
          g.visibility === 'selected'
            ? await this.listRunnerGroupRepositories(org, g.id)
            : undefined,
      })),
    );
  }

  private async listRunnerGroupRepositories(
    org: string,
    id: number,
  ): Promise<string[]> {
    const names: string[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.request(
        'GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories',
        { org, runner_group_id: id, per_page: perPage, page },
      );
      const repos = expectArray(
        (data as { repositories?: Array<{ name: string }> }).repositories,
        'GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories',
        'repositories',
      );
      names.push(...repos.map((r) => r.name));
      if (repos.length < perPage) return names;
    }
  }

  async createRunnerGroup(
    org: string,
    group: RunnerGroupManifest,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    await this.octokit.request('POST /orgs/{org}/actions/runner-groups', {
      org,
      ...runnerGroupPayload(group),
      selected_repository_ids: selectedRepositoryIds,
    });
  }

  async updateRunnerGroup(
    org: string,
    id: number,
    group: RunnerGroupManifest,
  ): Promise<void> {
    await this.octokit.request(
      'PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}',
      { org, runner_group_id: id, ...runnerGroupPayload(group) },
    );
  }

  async setRunnerGroupRepositories(
    org: string,
    id: number,
    repositoryIds: number[],
  ): Promise<void> {
    await this.octokit.request(
      'PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories',
      { org, runner_group_id: id, selected_repository_ids: repositoryIds },
    );
  }

  async deleteRunnerGroup(org: string, id: number): Promise<void> {
    await this.octokit.request(
      'DELETE /orgs/{org}/actions/runner-groups/{runner_group_id}',
      { org, runner_group_id: id },
    );
  }

  // ---- Actions variables -----------------------------------------------------

  async listOrgVariables(org: string): Promise<LiveOrgVariable[]> {
    const variables = await this.octokit.paginate(
      this.octokit.rest.actions.listOrgVariables,
      { org, per_page: 100 },
    );
    return Promise.all(
      variables.map(async (v) => ({
        name: v.name,
        value: v.value,
        visibility: v.visibility as OrgConfigVisibility,
        selectedRepositories:
          v.visibility === 'selected'
            ? await this.listOrgVariableRepositories(org, v.name)
            : undefined,
      })),
    );
  }

  private async listOrgVariableRepositories(
    org: string,
    name: string,
  ): Promise<string[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.actions.listSelectedReposForOrgVariable,
      { org, name, per_page: 100 },
    );
    return repos.map((r) => r.name);
  }

  async createOrgVariable(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    await this.octokit.rest.actions.createOrgVariable({
      org,
      name,
      value,
      visibility,
      selected_repository_ids: selectedRepositoryIds,
    });
  }

  async updateOrgVariable(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    await this.octokit.rest.actions.updateOrgVariable({
      org,
      name,
      value,
      visibility,
      selected_repository_ids: selectedRepositoryIds,
    });
  }

  async deleteOrgVariable(org: string, name: string): Promise<void> {
    await this.octokit.rest.actions.deleteOrgVariable({ org, name });
  }

  async listRepositoryVariables(
    owner: string,
    repo: string,
  ): Promise<Array<{ name: string; value: string }>> {
    const variables = await this.octokit.paginate(
      this.octokit.rest.actions.listRepoVariables,
      { owner, repo, per_page: 100 },
    );
    return variables.map((v) => ({ name: v.name, value: v.value }));
  }

  async createRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.octokit.rest.actions.createRepoVariable({
      owner,
      repo,
      name,
      value,
    });
  }

  async updateRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.octokit.rest.actions.updateRepoVariable({
      owner,
      repo,
      name,
      value,
    });
  }

  async deleteRepositoryVariable(
    owner: string,
    repo: string,
    name: string,
  ): Promise<void> {
    await this.octokit.rest.actions.deleteRepoVariable({ owner, repo, name });
  }

  async listRepositoryEnvironments(
    owner: string,
    repo: string,
  ): Promise<string[]> {
    // Octokit's paginate does not type this endpoint as a list, so page by hand.
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.repos.getAllEnvironments({
        owner,
        repo,
        per_page: 100,
        page,
      });
      const environments = data.environments ?? [];
      names.push(...environments.map((e) => e.name));
      if (environments.length < 100) return names;
    }
  }

  async getEnvironment(
    owner: string,
    repo: string,
    name: string,
  ): Promise<LiveEnvironment | undefined> {
    let data;
    try {
      ({ data } = await this.octokit.rest.repos.getEnvironment({
        owner,
        repo,
        environment_name: name,
      }));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
    const policy = data.deployment_branch_policy;
    const deploymentBranchPolicy = !policy
      ? ('all' as const)
      : policy.protected_branches
        ? ('protected' as const)
        : ('custom' as const);
    const branchPolicies =
      deploymentBranchPolicy === 'custom'
        ? await this.listEnvironmentBranchPolicies(owner, repo, name)
        : [];
    const teams: string[] = [];
    const users: string[] = [];
    let preventSelfReview = false;
    let waitTimer = 0;
    for (const rule of data.protection_rules ?? []) {
      if (rule.type === 'wait_timer' && 'wait_timer' in rule) {
        waitTimer = rule.wait_timer ?? 0;
      }
      if (rule.type === 'required_reviewers' && 'reviewers' in rule) {
        preventSelfReview =
          'prevent_self_review' in rule ? Boolean(rule.prevent_self_review) : false;
        for (const entry of rule.reviewers ?? []) {
          const reviewer = entry.reviewer as { slug?: string; login?: string } | undefined;
          if (entry.type === 'Team' && reviewer?.slug) teams.push(reviewer.slug);
          if (entry.type === 'User' && reviewer?.login) users.push(reviewer.login);
        }
      }
    }
    return {
      repository: repo,
      name,
      deploymentBranchPolicy,
      branchPolicies,
      reviewers: { teams, users },
      preventSelfReview,
      waitTimer,
    };
  }

  private async listEnvironmentBranchPolicies(
    owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ id: number; name: string; type: 'branch' | 'tag' }>> {
    const policies: Array<{ id: number; name: string; type: 'branch' | 'tag' }> = [];
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.repos.listDeploymentBranchPolicies({
        owner,
        repo,
        environment_name: environment,
        per_page: 100,
        page,
      });
      for (const policy of data.branch_policies) {
        if (policy.id === undefined || policy.name === undefined) continue;
        policies.push({
          id: policy.id,
          name: policy.name,
          type: policy.type === 'tag' ? 'tag' : 'branch',
        });
      }
      if (data.branch_policies.length < 100) return policies;
    }
  }

  async putEnvironment(
    owner: string,
    repo: string,
    name: string,
    settings: EnvironmentSettings,
  ): Promise<void> {
    await this.octokit.rest.repos.createOrUpdateEnvironment({
      owner,
      repo,
      environment_name: name,
      wait_timer: settings.waitTimer,
      prevent_self_review: settings.preventSelfReview,
      reviewers: settings.reviewers,
      deployment_branch_policy:
        settings.deploymentBranchPolicy === 'all'
          ? null
          : {
              protected_branches: settings.deploymentBranchPolicy === 'protected',
              custom_branch_policies: settings.deploymentBranchPolicy === 'custom',
            },
    });
  }

  async createEnvironmentBranchPolicy(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    type: 'branch' | 'tag',
  ): Promise<void> {
    await this.octokit.rest.repos.createDeploymentBranchPolicy({
      owner,
      repo,
      environment_name: environment,
      name,
      type,
    });
  }

  async deleteEnvironmentBranchPolicy(
    owner: string,
    repo: string,
    environment: string,
    id: number,
  ): Promise<void> {
    await this.octokit.rest.repos.deleteDeploymentBranchPolicy({
      owner,
      repo,
      environment_name: environment,
      branch_policy_id: id,
    });
  }

  async getTeamId(org: string, slug: string): Promise<number> {
    const { data } = await this.octokit.rest.teams.getByName({ org, team_slug: slug });
    return data.id;
  }

  async getUserId(login: string): Promise<number> {
    const { data } = await this.octokit.rest.users.getByUsername({ username: login });
    return data.id;
  }

  async listEnvironmentSecrets(
    owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string }>> {
    const secrets = await this.octokit.paginate(
      this.octokit.rest.actions.listEnvironmentSecrets,
      { owner, repo, environment_name: environment, per_page: 100 },
    );
    return secrets.map((s) => ({ name: s.name }));
  }

  async putEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    const { data: key } = await this.octokit.rest.actions.getEnvironmentPublicKey({
      owner,
      repo,
      environment_name: environment,
    });
    await this.octokit.rest.actions.createOrUpdateEnvironmentSecret({
      owner,
      repo,
      environment_name: environment,
      secret_name: name,
      encrypted_value: await sealSecretValue(key.key, value),
      key_id: key.key_id,
    });
  }

  async deleteEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void> {
    await this.octokit.rest.actions.deleteEnvironmentSecret({
      owner,
      repo,
      environment_name: environment,
      secret_name: name,
    });
  }

  async listEnvironmentVariables(
    owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string; value: string }>> {
    const variables = await this.octokit.paginate(
      this.octokit.rest.actions.listEnvironmentVariables,
      { owner, repo, environment_name: environment, per_page: 30 },
    );
    return variables.map((v) => ({ name: v.name, value: v.value }));
  }

  async createEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.octokit.rest.actions.createEnvironmentVariable({
      owner,
      repo,
      environment_name: environment,
      name,
      value,
    });
  }

  async updateEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.octokit.rest.actions.updateEnvironmentVariable({
      owner,
      repo,
      environment_name: environment,
      name,
      value,
    });
  }

  async deleteEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void> {
    await this.octokit.rest.actions.deleteEnvironmentVariable({
      owner,
      repo,
      environment_name: environment,
      name,
    });
  }

  // ---- Actions secrets ---------------------------------------------------------

  async listOrgSecrets(org: string): Promise<LiveOrgSecret[]> {
    const secrets = await this.octokit.paginate(
      this.octokit.rest.actions.listOrgSecrets,
      { org, per_page: 100 },
    );
    return Promise.all(
      secrets.map(async (s) => ({
        name: s.name,
        visibility: s.visibility as OrgConfigVisibility,
        selectedRepositories:
          s.visibility === 'selected'
            ? await this.listOrgSecretRepositories(org, s.name)
            : undefined,
      })),
    );
  }

  private async listOrgSecretRepositories(
    org: string,
    name: string,
  ): Promise<string[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.actions.listSelectedReposForOrgSecret,
      { org, secret_name: name, per_page: 100 },
    );
    return repos.map((r) => r.name);
  }

  async putOrgSecret(
    org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    const { data: key } = await this.octokit.rest.actions.getOrgPublicKey({
      org,
    });
    await this.octokit.rest.actions.createOrUpdateOrgSecret({
      org,
      secret_name: name,
      encrypted_value: await sealSecretValue(key.key, value),
      key_id: key.key_id,
      visibility,
      selected_repository_ids: selectedRepositoryIds,
    });
  }

  async deleteOrgSecret(org: string, name: string): Promise<void> {
    await this.octokit.rest.actions.deleteOrgSecret({
      org,
      secret_name: name,
    });
  }

  async listRepositorySecrets(
    owner: string,
    repo: string,
  ): Promise<Array<{ name: string }>> {
    const secrets = await this.octokit.paginate(
      this.octokit.rest.actions.listRepoSecrets,
      { owner, repo, per_page: 100 },
    );
    return secrets.map((s) => ({ name: s.name }));
  }

  async putRepositorySecret(
    owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    const { data: key } = await this.octokit.rest.actions.getRepoPublicKey({
      owner,
      repo,
    });
    await this.octokit.rest.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: name,
      encrypted_value: await sealSecretValue(key.key, value),
      key_id: key.key_id,
    });
  }

  async deleteRepositorySecret(
    owner: string,
    repo: string,
    name: string,
  ): Promise<void> {
    await this.octokit.rest.actions.deleteRepoSecret({
      owner,
      repo,
      secret_name: name,
    });
  }

  // ---- Code security configurations ---------------------------------------

  async listSecurityConfigurations(
    org: string,
  ): Promise<LiveCodeSecurityConfiguration[]> {
    const configs = await this.octokit.paginate(
      this.octokit.rest.codeSecurity.getConfigurationsForOrg,
      { org, per_page: 100 },
    );
    return configs.map((c) => ({
      ...toCamelCaseKeys<Partial<CodeSecurityConfigurationManifest>>(c),
      id: c.id ?? 0,
      name: c.name ?? '',
      targetType: c.target_type,
    }));
  }

  async listDefaultSecurityConfigurations(
    org: string,
  ): Promise<LiveDefaultSecurityConfiguration[]> {
    const { data } =
      await this.octokit.rest.codeSecurity.getDefaultConfigurations({ org });
    return data
      .filter((d) => d.default_for_new_repos !== undefined)
      .map((d) => ({
        defaultForNewRepos: d.default_for_new_repos as SecurityDefaultScope,
        configurationId: d.configuration?.id,
        configurationName: d.configuration?.name,
      }));
  }

  async createSecurityConfiguration(
    org: string,
    config: CodeSecurityConfigurationManifest,
  ): Promise<number> {
    const { data } = await this.octokit.rest.codeSecurity.createConfiguration({
      org,
      ...securityConfigPayload(config),
    } as CreateSecurityConfigParams);
    return data.id ?? 0;
  }

  async updateSecurityConfiguration(
    org: string,
    id: number,
    config: CodeSecurityConfigurationManifest,
  ): Promise<void> {
    await this.octokit.rest.codeSecurity.updateConfiguration({
      org,
      configuration_id: id,
      ...securityConfigPayload(config),
    });
  }

  async deleteSecurityConfiguration(org: string, id: number): Promise<void> {
    await this.octokit.rest.codeSecurity.deleteConfiguration({
      org,
      configuration_id: id,
    });
  }

  async setSecurityConfigurationAsDefault(
    org: string,
    id: number,
    scope: SecurityDefaultScope,
  ): Promise<void> {
    await this.octokit.rest.codeSecurity.setConfigurationAsDefault({
      org,
      configuration_id: id,
      default_for_new_repos: scope,
    });
  }

  async attachSecurityConfiguration(
    org: string,
    id: number,
    scope: SecurityAttachScope | 'selected',
    repositoryIds?: number[],
  ): Promise<void> {
    await this.octokit.rest.codeSecurity.attachConfiguration({
      org,
      configuration_id: id,
      scope,
      selected_repository_ids: repositoryIds,
    });
  }

  // ---- Custom properties ---------------------------------------------------

  async listCustomProperties(org: string): Promise<LiveCustomProperty[]> {
    const { data } = await this.octokit.rest.orgs.getAllCustomProperties({
      org,
    });
    return data.map((p) => ({
      name: p.property_name,
      valueType: p.value_type,
      required: p.required,
      defaultValue: p.default_value,
      description: p.description,
      allowedValues: p.allowed_values,
      valuesEditableBy: p.values_editable_by,
    }));
  }

  async listRepositoryProperties(
    org: string,
  ): Promise<LiveRepositoryProperties[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.orgs.listCustomPropertiesValuesForRepos,
      { org, per_page: 100 },
    );
    return repos.map((r) => ({
      repository: r.repository_name,
      properties: Object.fromEntries(
        r.properties.map((p) => [p.property_name, p.value]),
      ),
    }));
  }

  async putCustomProperty(
    org: string,
    property: CustomPropertyManifest,
  ): Promise<void> {
    await this.octokit.rest.orgs.createOrUpdateCustomProperty({
      org,
      custom_property_name: property.name,
      value_type: property.valueType,
      required: property.required,
      default_value: property.defaultValue,
      description: property.description,
      allowed_values: property.allowedValues,
      values_editable_by: property.valuesEditableBy,
    });
  }

  async deleteCustomProperty(org: string, name: string): Promise<void> {
    await this.octokit.rest.orgs.removeCustomProperty({
      org,
      custom_property_name: name,
    });
  }

  async setRepositoryPropertyValues(
    org: string,
    repositories: string[],
    values: Record<string, string | string[] | null>,
  ): Promise<void> {
    await this.octokit.rest.orgs.createOrUpdateCustomPropertiesValuesForRepos({
      org,
      repository_names: repositories,
      properties: Object.entries(values).map(([property_name, value]) => ({
        property_name,
        value,
      })),
    });
  }

  // ---- Legacy branch protection -------------------------------------------

  async getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<LiveBranchProtection> {
    let data: Awaited<
      ReturnType<Octokit['rest']['repos']['getBranchProtection']>
    >['data'];
    try {
      ({ data } = await this.octokit.rest.repos.getBranchProtection({
        owner,
        repo,
        branch,
      }));
    } catch (error) {
      // An unprotected branch is a 404 here, but so is a repository that does
      // not exist, a branch that does not exist, and a repository the token
      // cannot see (GitHub masks those as 404 too). Only the first is an
      // answer; the rest must fail, or a typo or a permissions gap reads as
      // "unprotected" and the plan writes protection from scratch over
      // settings it never saw.
      if (isNotFound(error)) {
        try {
          await this.octokit.rest.repos.getBranch({ owner, repo, branch });
        } catch (branchError) {
          if (isNotFound(branchError)) {
            throw new Error(
              `Cannot read branch protection for ${repo}#${branch}: the ` +
                'repository or branch does not exist, or the token cannot see it.',
            );
          }
          throw branchError;
        }
        return { repository: repo, branch, enabled: false };
      }
      throw error;
    }

    const reviews = data.required_pull_request_reviews;
    return {
      repository: repo,
      branch,
      enabled: true,
      requiredStatusChecks: data.required_status_checks
        ? {
            strict: data.required_status_checks.strict ?? false,
            checks: (data.required_status_checks.checks ?? []).map((c) => ({
              context: c.context,
              appId: c.app_id,
            })),
          }
        : null,
      requiredPullRequestReviews: reviews
        ? {
            requiredApprovingReviewCount:
              reviews.required_approving_review_count,
            dismissStaleReviews: reviews.dismiss_stale_reviews,
            requireCodeOwnerReviews: reviews.require_code_owner_reviews,
            requireLastPushApproval: reviews.require_last_push_approval,
            dismissalRestrictions: toActors(reviews.dismissal_restrictions),
            bypassPullRequestAllowances: toActors(
              reviews.bypass_pull_request_allowances,
            ),
          }
        : null,
      enforceAdmins: data.enforce_admins?.enabled,
      restrictions: toActors(data.restrictions) ?? null,
      requiredLinearHistory: data.required_linear_history?.enabled,
      allowForcePushes: data.allow_force_pushes?.enabled,
      allowDeletions: data.allow_deletions?.enabled,
      blockCreations: data.block_creations?.enabled,
      requiredConversationResolution:
        data.required_conversation_resolution?.enabled,
      lockBranch: data.lock_branch?.enabled,
      allowForkSyncing: data.allow_fork_syncing?.enabled,
      requiredSignatures: data.required_signatures?.enabled,
    };
  }

  async putBranchProtection(
    owner: string,
    repo: string,
    protection: BranchProtectionManifest,
  ): Promise<void> {
    const reviews = protection.requiredPullRequestReviews;
    const checks = protection.requiredStatusChecks;

    await this.octokit.rest.repos.updateBranchProtection({
      owner,
      repo,
      branch: protection.branch,
      // GitHub requires these four keys to be present, so an undeclared one is
      // sent as null rather than omitted.
      required_status_checks: checks
        ? {
            strict: checks.strict,
            // `contexts` is deprecated in favour of `checks` but still required.
            contexts: checks.checks.map((c) => c.context),
            checks: checks.checks.map((c) => ({
              context: c.context,
              app_id: c.appId ?? undefined,
            })),
          }
        : null,
      enforce_admins: protection.enforceAdmins ?? null,
      required_pull_request_reviews: reviews
        ? {
            required_approving_review_count:
              reviews.requiredApprovingReviewCount,
            dismiss_stale_reviews: reviews.dismissStaleReviews,
            require_code_owner_reviews: reviews.requireCodeOwnerReviews,
            require_last_push_approval: reviews.requireLastPushApproval,
            dismissal_restrictions: reviews.dismissalRestrictions,
            bypass_pull_request_allowances: reviews.bypassPullRequestAllowances,
          }
        : null,
      restrictions: protection.restrictions
        ? {
            users: protection.restrictions.users ?? [],
            teams: protection.restrictions.teams ?? [],
            apps: protection.restrictions.apps,
          }
        : null,
      required_linear_history: protection.requiredLinearHistory,
      allow_force_pushes: protection.allowForcePushes,
      allow_deletions: protection.allowDeletions,
      block_creations: protection.blockCreations,
      required_conversation_resolution:
        protection.requiredConversationResolution,
      lock_branch: protection.lockBranch,
      allow_fork_syncing: protection.allowForkSyncing,
    });
  }

  async deleteBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<void> {
    await this.octokit.rest.repos.deleteBranchProtection({
      owner,
      repo,
      branch,
    });
  }

  async setSignatureProtection(
    owner: string,
    repo: string,
    branch: string,
    required: boolean,
  ): Promise<void> {
    // Signed commits sit outside the protection payload, on their own endpoint.
    if (required) {
      await this.octokit.rest.repos.createCommitSignatureProtection({
        owner,
        repo,
        branch,
      });
    } else {
      await this.octokit.rest.repos.deleteCommitSignatureProtection({
        owner,
        repo,
        branch,
      });
    }
  }
}

/**
 * Reduce GitHub's user, team, and app objects to the logins the write side
 * takes. Apps can come back as null entries, so they are dropped rather than
 * turned into empty strings.
 */
interface NamedActor {
  readonly login?: string;
  readonly slug?: string | null;
}

function toActors(
  restriction:
    | {
        users?: ReadonlyArray<NamedActor | null> | null;
        teams?: ReadonlyArray<NamedActor | null> | null;
        apps?: ReadonlyArray<NamedActor | null> | null;
      }
    | undefined,
): ActorRestriction | undefined {
  if (!restriction) return undefined;

  const names = (
    actors: ReadonlyArray<NamedActor | null> | null | undefined,
    key: 'login' | 'slug',
  ): string[] =>
    (actors ?? [])
      .map((a) => a?.[key])
      .filter((name): name is string => typeof name === 'string');

  return {
    users: names(restriction.users, 'login'),
    teams: names(restriction.teams, 'slug'),
    apps: names(restriction.apps, 'slug'),
  };
}

/**
 * The array a wrapped list response must carry. A body without it is a failure
 * to surface, not an empty organization: defaulting to `[]` here would read as
 * "nothing exists" and cascade into creates and deletes computed against a
 * world emptier than the real one.
 */
function expectArray<T>(
  value: T[] | undefined,
  endpoint: string,
  key: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Unexpected response from ${endpoint}: expected an array under "${key}".`,
    );
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 404
  );
}

/**
 * The write payload for a runner group, minus the repository list: create
 * takes it inline, update does not, so the caller supplies it where it can.
 */
function runnerGroupPayload(group: RunnerGroupManifest): {
  name: string;
  visibility?: RunnerGroupVisibility;
  allows_public_repositories?: boolean;
  restricted_to_workflows?: boolean;
  selected_workflows?: string[];
} {
  return {
    name: group.name,
    visibility: group.visibility,
    allows_public_repositories: group.allowsPublicRepositories,
    restricted_to_workflows: group.restrictedToWorkflows,
    selected_workflows: group.selectedWorkflows
      ? [...group.selectedWorkflows]
      : undefined,
  };
}

/** The write payload for a ruleset: the manifest, minus its name-as-identity, in GitHub's casing. */
function rulesetPayload(ruleset: ResolvedRuleset): Record<string, unknown> {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: toSnakeCaseKeys(ruleset.conditions ?? {}),
    rules: toSnakeCaseKeys(ruleset.rules),
    bypass_actors: toSnakeCaseKeys(ruleset.bypassActors ?? []),
  };
}

/**
 * The write payload for a code security configuration. Fields the definition
 * leaves undefined are omitted, so GitHub keeps whatever the configuration
 * already had.
 */
function securityConfigPayload(
  config: CodeSecurityConfigurationManifest,
): Record<string, unknown> {
  return {
    name: config.name,
    description: config.description,
    advanced_security: config.advancedSecurity,
    dependency_graph: config.dependencyGraph,
    dependency_graph_autosubmit_action: config.dependencyGraphAutosubmitAction,
    dependabot_alerts: config.dependabotAlerts,
    dependabot_security_updates: config.dependabotSecurityUpdates,
    code_scanning_default_setup: config.codeScanningDefaultSetup,
    secret_scanning: config.secretScanning,
    secret_scanning_push_protection: config.secretScanningPushProtection,
    secret_scanning_validity_checks: config.secretScanningValidityChecks,
    secret_scanning_non_provider_patterns:
      config.secretScanningNonProviderPatterns,
    private_vulnerability_reporting: config.privateVulnerabilityReporting,
    enforcement: config.enforcement,
  };
}
