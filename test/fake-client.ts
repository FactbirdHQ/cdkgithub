import type {
  CreateTeamParams,
  ExternalIdpGroup,
  GitHubClient,
  LiveActionsPolicy,
  LiveAppInstallation,
  LiveBranchProtection,
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveCustomRepositoryRole,
  LiveDefaultSecurityConfiguration,
  LiveOrgSettings,
  LiveRepository,
  LiveRepositoryProperties,
  LiveRuleset,
  LiveOrganizationRole,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
  UpdateTeamParams,
} from '../src/github/client.ts';
import type {
  AllowedActions,
  BranchProtectionManifest,
  AllowedActionsConfig,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  CustomRepositoryRoleManifest,
  RepositoryManifest,
  DefaultWorkflowPermissions,
  EnabledRepositories,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedRuleset,
  SecurityAttachScope,
  SecurityDefaultScope,
} from '../src/synth/manifest.ts';

export interface FakeClientState {
  teams?: LiveTeam[];
  /** Live repository grants keyed by team slug, as GitHub reports them. */
  teamRepositories?: Record<string, LiveTeamRepository[]>;
  /** Live rosters keyed by team slug. */
  teamMembers?: Record<string, LiveTeamMember[]>;
  customRepositoryRoles?: LiveCustomRepositoryRole[];
  organizationRoles?: LiveOrganizationRole[];
  internalRepositoriesAllowed?: boolean;
  /** Assignment per role id. */
  roleAssignments?: Record<number, { teams: string[]; users: string[] }>;
  externalGroups?: ExternalIdpGroup[];
  repositories?: LiveRepository[];
  appInstallations?: LiveAppInstallation[];
  settings?: LiveOrgSettings;
  actions?: LiveActionsPolicy;
  rulesets?: LiveRuleset[];
  securityConfigurations?: LiveCodeSecurityConfiguration[];
  defaultSecurityConfigurations?: LiveDefaultSecurityConfiguration[];
  customProperties?: LiveCustomProperty[];
  repositoryProperties?: LiveRepositoryProperties[];
  branchProtection?: LiveBranchProtection[];
}

/**
 * In-memory {@link GitHubClient} for the tests: no network, no token.
 *
 * Writes are recorded rather than simulated. The reconciler is what these tests
 * are about, so what matters is which calls it makes and with what, not
 * re-implementing GitHub's own state transitions.
 */
export class FakeClient implements GitHubClient {
  teams: LiveTeam[];
  teamRepositories: Record<string, LiveTeamRepository[]>;
  teamMembers: Record<string, LiveTeamMember[]>;
  customRepositoryRoles: LiveCustomRepositoryRole[];
  organizationRoles: LiveOrganizationRole[];
  internalRepositoriesAllowed: boolean;
  roleAssignments: Record<number, { teams: string[]; users: string[] }>;
  externalGroups: ExternalIdpGroup[];
  repositories: LiveRepository[];
  appInstallations: LiveAppInstallation[];
  settings: LiveOrgSettings;
  actions: LiveActionsPolicy;
  rulesets: LiveRuleset[];
  securityConfigurations: LiveCodeSecurityConfiguration[];
  defaultSecurityConfigurations: LiveDefaultSecurityConfiguration[];
  customProperties: LiveCustomProperty[];
  repositoryProperties: LiveRepositoryProperties[];
  branchProtection: LiveBranchProtection[];

  links: Array<{ slug: string; groupId: number }> = [];
  memberships: Array<{ slug: string; username: string; role: string }> = [];
  calls: Array<{ method: string; args: unknown }> = [];

  private nextId = 1000;

  constructor(state: FakeClientState = {}) {
    this.teams = state.teams ?? [];
    this.teamRepositories = state.teamRepositories ?? {};
    this.teamMembers = state.teamMembers ?? {};
    this.customRepositoryRoles = state.customRepositoryRoles ?? [];
    this.organizationRoles = state.organizationRoles ?? [];
    this.internalRepositoriesAllowed =
      state.internalRepositoriesAllowed ?? false;
    this.roleAssignments = state.roleAssignments ?? {};
    this.externalGroups = state.externalGroups ?? [];
    this.repositories = state.repositories ?? [];
    this.appInstallations = state.appInstallations ?? [];
    this.settings = state.settings ?? {};
    this.actions = state.actions ?? {
      enabledRepositories: 'all',
      allowedActions: 'all',
      defaultWorkflowPermissions: 'write',
      canApprovePullRequestReviews: true,
    };
    this.rulesets = state.rulesets ?? [];
    this.securityConfigurations = state.securityConfigurations ?? [];
    this.defaultSecurityConfigurations =
      state.defaultSecurityConfigurations ?? [];
    this.customProperties = state.customProperties ?? [];
    this.repositoryProperties = state.repositoryProperties ?? [];
    this.branchProtection = state.branchProtection ?? [];
  }

  /** Every recorded call to one method, in order. */
  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  // ---- organization roles --------------------------------------------------

  async listOrganizationRoles(): Promise<LiveOrganizationRole[]> {
    return this.organizationRoles;
  }

  async readRoleAssignment(
    _org: string,
    roleId: number,
  ): Promise<{ teams: string[]; users: string[] }> {
    return this.roleAssignments[roleId] ?? { teams: [], users: [] };
  }

  async assignRoleToTeam(
    _org: string,
    roleId: number,
    team: string,
  ): Promise<void> {
    this.record('assignRoleToTeam', { roleId, team });
  }

  async removeRoleFromTeam(
    _org: string,
    roleId: number,
    team: string,
  ): Promise<void> {
    this.record('removeRoleFromTeam', { roleId, team });
  }

  async assignRoleToUser(
    _org: string,
    roleId: number,
    username: string,
  ): Promise<void> {
    this.record('assignRoleToUser', { roleId, username });
  }

  async removeRoleFromUser(
    _org: string,
    roleId: number,
    username: string,
  ): Promise<void> {
    this.record('removeRoleFromUser', { roleId, username });
  }

  // ---- teams ---------------------------------------------------------------

  async listTeams(): Promise<LiveTeam[]> {
    return this.teams;
  }

  async createTeam(_org: string, params: CreateTeamParams): Promise<LiveTeam> {
    const parentSlug =
      this.teams.find((t) => t.id === params.parentTeamId)?.slug ?? null;
    const created: LiveTeam = {
      id: this.nextId++,
      slug: params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: params.name,
      description: params.description ?? null,
      privacy: params.privacy,
      parentSlug,
    };
    this.teams.push(created);
    return created;
  }

  async updateTeam(
    _org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<void> {
    this.record('updateTeam', { slug, params });
  }

  async deleteTeam(_org: string, slug: string): Promise<void> {
    this.teams = this.teams.filter((t) => t.slug !== slug);
  }

  async setMembership(
    _org: string,
    slug: string,
    username: string,
    role: 'member' | 'maintainer',
  ): Promise<void> {
    this.memberships.push({ slug, username, role });
  }

  async removeMembership(
    _org: string,
    slug: string,
    username: string,
  ): Promise<void> {
    this.record('removeMembership', { slug, username });
  }

  async setRepoPermission(
    _org: string,
    slug: string,
    repo: string,
    permission: RepoPermission,
  ): Promise<void> {
    this.record('setRepoPermission', { slug, repo, permission });
  }

  async removeRepoPermission(
    _org: string,
    slug: string,
    repo: string,
  ): Promise<void> {
    this.record('removeRepoPermission', { slug, repo });
  }

  async listTeamMembers(_org: string, slug: string): Promise<LiveTeamMember[]> {
    return this.teamMembers[slug] ?? [];
  }

  async listTeamRepositories(
    _org: string,
    slug: string,
  ): Promise<LiveTeamRepository[]> {
    return this.teamRepositories[slug] ?? [];
  }

  async listCustomRepositoryRoles(): Promise<LiveCustomRepositoryRole[]> {
    return this.customRepositoryRoles;
  }

  async createCustomRepositoryRole(
    _org: string,
    role: CustomRepositoryRoleManifest,
  ): Promise<void> {
    this.record('createCustomRepositoryRole', role);
  }

  async updateCustomRepositoryRole(
    _org: string,
    roleId: number,
    role: CustomRepositoryRoleManifest,
  ): Promise<void> {
    this.record('updateCustomRepositoryRole', { roleId, role });
  }

  async deleteCustomRepositoryRole(
    _org: string,
    roleId: number,
  ): Promise<void> {
    this.record('deleteCustomRepositoryRole', { roleId });
  }

  async supportsInternalRepositories(): Promise<boolean> {
    return this.internalRepositoriesAllowed;
  }

  async createRepository(
    _org: string,
    repository: RepositoryManifest,
  ): Promise<void> {
    this.record('createRepository', repository);
    this.repositories.push({ id: this.nextId++, name: repository.name });
  }

  async listExternalGroups(): Promise<ExternalIdpGroup[]> {
    return this.externalGroups;
  }

  async linkExternalGroup(
    _org: string,
    slug: string,
    groupId: number,
  ): Promise<void> {
    this.links.push({ slug, groupId });
  }

  // ---- repositories --------------------------------------------------------

  async listRepositories(): Promise<LiveRepository[]> {
    return this.repositories;
  }

  async listAppInstallations(): Promise<LiveAppInstallation[]> {
    return this.appInstallations;
  }

  // ---- organization settings ----------------------------------------------

  async getOrgSettings(): Promise<LiveOrgSettings> {
    return this.settings;
  }

  async updateOrgSettings(
    _org: string,
    settings: OrgSettingsManifest,
  ): Promise<void> {
    this.record('updateOrgSettings', settings);
    this.settings = { ...this.settings, ...settings };
  }

  // ---- actions policy ------------------------------------------------------

  async getActionsPolicy(): Promise<LiveActionsPolicy> {
    return this.actions;
  }

  async setActionsPermissions(
    _org: string,
    params: {
      enabledRepositories?: EnabledRepositories;
      allowedActions?: AllowedActions;
    },
  ): Promise<void> {
    this.record('setActionsPermissions', params);
  }

  async setActionsSelectedRepositories(
    _org: string,
    repositoryIds: number[],
  ): Promise<void> {
    this.record('setActionsSelectedRepositories', repositoryIds);
  }

  async setAllowedActions(
    _org: string,
    config: AllowedActionsConfig,
  ): Promise<void> {
    this.record('setAllowedActions', config);
  }

  async setDefaultWorkflowPermissions(
    _org: string,
    params: {
      defaultWorkflowPermissions?: DefaultWorkflowPermissions;
      canApprovePullRequestReviews?: boolean;
    },
  ): Promise<void> {
    this.record('setDefaultWorkflowPermissions', params);
  }

  // ---- rulesets ------------------------------------------------------------

  async listRulesets(): Promise<LiveRuleset[]> {
    return this.rulesets;
  }

  async createRuleset(_org: string, ruleset: ResolvedRuleset): Promise<void> {
    this.record('createRuleset', ruleset);
  }

  async updateRuleset(
    _org: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    this.record('updateRuleset', { id, ruleset });
  }

  async deleteRuleset(_org: string, id: number): Promise<void> {
    this.record('deleteRuleset', id);
    this.rulesets = this.rulesets.filter((r) => r.id !== id);
  }

  // ---- code security -------------------------------------------------------

  async listSecurityConfigurations(): Promise<LiveCodeSecurityConfiguration[]> {
    return this.securityConfigurations;
  }

  async listDefaultSecurityConfigurations(): Promise<
    LiveDefaultSecurityConfiguration[]
  > {
    return this.defaultSecurityConfigurations;
  }

  async createSecurityConfiguration(
    _org: string,
    config: CodeSecurityConfigurationManifest,
  ): Promise<number> {
    this.record('createSecurityConfiguration', config);
    const id = this.nextId++;
    this.securityConfigurations.push({
      ...config,
      id,
      targetType: 'organization',
    });
    return id;
  }

  async updateSecurityConfiguration(
    _org: string,
    id: number,
    config: CodeSecurityConfigurationManifest,
  ): Promise<void> {
    this.record('updateSecurityConfiguration', { id, config });
  }

  async deleteSecurityConfiguration(_org: string, id: number): Promise<void> {
    this.record('deleteSecurityConfiguration', id);
  }

  async setSecurityConfigurationAsDefault(
    _org: string,
    id: number,
    scope: SecurityDefaultScope,
  ): Promise<void> {
    this.record('setSecurityConfigurationAsDefault', { id, scope });
  }

  async attachSecurityConfiguration(
    _org: string,
    id: number,
    scope: SecurityAttachScope | 'selected',
    repositoryIds?: number[],
  ): Promise<void> {
    this.record('attachSecurityConfiguration', { id, scope, repositoryIds });
  }

  // ---- custom properties ---------------------------------------------------

  async listCustomProperties(): Promise<LiveCustomProperty[]> {
    return this.customProperties;
  }

  async listRepositoryProperties(): Promise<LiveRepositoryProperties[]> {
    return this.repositoryProperties;
  }

  async putCustomProperty(
    _org: string,
    property: CustomPropertyManifest,
  ): Promise<void> {
    this.record('putCustomProperty', property);
  }

  async deleteCustomProperty(_org: string, name: string): Promise<void> {
    this.record('deleteCustomProperty', name);
  }

  async setRepositoryPropertyValues(
    _org: string,
    repositories: string[],
    values: Record<string, string | string[] | null>,
  ): Promise<void> {
    this.record('setRepositoryPropertyValues', { repositories, values });
  }

  // ---- branch protection ---------------------------------------------------

  async getBranchProtection(
    _owner: string,
    repo: string,
    branch: string,
  ): Promise<LiveBranchProtection> {
    return (
      this.branchProtection.find(
        (p) => p.repository === repo && p.branch === branch,
      ) ?? { repository: repo, branch, enabled: false }
    );
  }

  async putBranchProtection(
    _owner: string,
    repo: string,
    protection: BranchProtectionManifest,
  ): Promise<void> {
    this.record('putBranchProtection', { repo, protection });
  }

  async deleteBranchProtection(
    _owner: string,
    repo: string,
    branch: string,
  ): Promise<void> {
    this.record('deleteBranchProtection', { repo, branch });
  }

  async setSignatureProtection(
    _owner: string,
    repo: string,
    branch: string,
    required: boolean,
  ): Promise<void> {
    this.record('setSignatureProtection', { repo, branch, required });
  }
}
