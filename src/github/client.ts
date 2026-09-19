import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import type {
  ActorRestriction,
  AllowedActions,
  AllowedActionsConfig,
  BranchProtectionManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  DefaultWorkflowPermissions,
  EnabledRepositories,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedBypassActor,
  ResolvedRuleset,
  RulesetConditions,
  RulesetManifest,
  RulesetRule,
  RulesetTarget,
  SecurityAttachScope,
  SecurityDefaultScope,
  TeamPrivacy,
} from '../synth/manifest.ts';
import { toCamelCaseKeys, toSnakeCaseKeys } from './casing.ts';

/** Live representation of a team as read back from GitHub. */
export interface LiveTeam {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly privacy: TeamPrivacy;
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
  custom_roles?: Array<{ id: number; name: string; base_role?: string }>;
}

/** A repository role the organization defines on top of the five built-ins. */
export interface LiveCustomRepositoryRole {
  readonly id: number;
  readonly name: string;
  /** The built-in the role extends, which is what ranks it against the others. */
  readonly baseRole: string;
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

export function comparableRoleName(roleName: string): string {
  return ROLE_NAME_TO_PERMISSION[roleName] ?? roleName;
}

/** An Entra ID (Azure AD) security group exposed to GitHub via SCIM. */
export interface ExternalIdpGroup {
  readonly id: number;
  readonly name: string;
}

/** Shape of `GET /orgs/{org}/external-groups` (not covered by Octokit's typed methods). */
interface ExternalGroupsResponse {
  groups?: Array<{ group_id: number | string; group_name: string }>;
}

export interface CreateTeamParams {
  readonly name: string;
  readonly description?: string;
  readonly privacy: TeamPrivacy;
  /** Numeric id of the parent team, if nested. */
  readonly parentTeamId?: number;
}

export interface UpdateTeamParams {
  readonly name?: string;
  readonly description?: string;
  readonly privacy?: TeamPrivacy;
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

/**
 * Thin, typed surface over the GitHub API used by the reconciler. Kept as an
 * interface so tests can supply an in-memory fake without touching the network.
 */
export interface GitHubClient {
  listTeams(org: string): Promise<LiveTeam[]>;
  createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam>;
  updateTeam(
    org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<void>;
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

  listExternalGroups(org: string): Promise<ExternalIdpGroup[]>;
  linkExternalGroup(org: string, slug: string, groupId: number): Promise<void>;

  /** Repositories in the org, used to resolve names to ids. */
  listRepositories(org: string): Promise<LiveRepository[]>;

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
  createRuleset(org: string, ruleset: ResolvedRuleset): Promise<void>;
  updateRuleset(
    org: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void>;
  deleteRuleset(org: string, id: number): Promise<void>;

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

/** Default {@link GitHubClient} backed by Octokit against api.github.com. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({ auth: token, baseUrl });
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
      parentSlug: t.parent?.slug ?? null,
    }));
  }

  async createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam> {
    const { data } = await this.octokit.rest.teams.create({
      org,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      parent_team_id: params.parentTeamId,
    });
    return {
      id: data.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      privacy: (data.privacy as TeamPrivacy) ?? 'closed',
      parentSlug: data.parent?.slug ?? null,
    };
  }

  async updateTeam(
    org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<void> {
    await this.octokit.rest.teams.updateInOrg({
      org,
      team_slug: slug,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      parent_team_id: params.parentTeamId,
    });
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
    const roles = (data as CustomRepositoryRolesResponse).custom_roles ?? [];
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      baseRole: r.base_role ?? 'read',
    }));
  }

  // The external-groups endpoints are not in Octokit's generated typed methods,
  // so we call them via the raw request route and type the response ourselves.
  // See: https://docs.github.com/en/enterprise-cloud@latest/rest/teams/external-groups

  async listExternalGroups(org: string): Promise<ExternalIdpGroup[]> {
    const { data } = await this.octokit.request(
      'GET /orgs/{org}/external-groups',
      { org },
    );
    const groups = (data as ExternalGroupsResponse).groups ?? [];
    return groups.map((g) => ({ id: Number(g.group_id), name: g.group_name }));
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
      // An unprotected branch is a 404 here, which is an answer rather than a
      // failure: the branch simply has no protection to compare against.
      if (isNotFound(error))
        return { repository: repo, branch, enabled: false };
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 404
  );
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
