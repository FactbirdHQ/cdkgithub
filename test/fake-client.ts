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
  LiveOrgSecret,
  LiveOrgSettings,
  LiveOrgVariable,
  LiveRepository,
  LiveRepositoryProperties,
  LiveRunnerGroup,
  LiveRuleset,
  LiveOrganizationRole,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
  UpdateTeamParams,
  EnvironmentSettings,
  LiveCollaborator,
  LiveEnvironment,
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
  OrgConfigVisibility,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedRuleset,
  RunnerGroupManifest,
  SecurityAttachScope,
  SecurityDefaultScope,
} from '../src/synth/manifest.ts';

export interface FakeClientState {
  teams?: LiveTeam[];
  /** Live repository grants keyed by team slug, as GitHub reports them. */
  teamRepositories?: Record<string, LiveTeamRepository[]>;
  /** Live rosters keyed by team slug. */
  teamMembers?: Record<string, LiveTeamMember[]>;
  organizationOwners?: string[];
  /** Repositories GitHub answers as not found. */
  missingRepositories?: string[];
  customRepositoryRoles?: LiveCustomRepositoryRole[];
  organizationRoles?: LiveOrganizationRole[];
  internalRepositoriesAllowed?: boolean;
  /** Assignment per role id. */
  roleAssignments?: Record<number, { teams: string[]; users: string[] }>;
  externalGroups?: ExternalIdpGroup[];
  repositories?: LiveRepository[];
  appInstallations?: LiveAppInstallation[];
  /** Repositories per installation id. An id missing here answers 403, as for a non-user token. */
  installationRepositories?: Record<number, string[]>;
  settings?: LiveOrgSettings;
  actions?: LiveActionsPolicy;
  rulesets?: LiveRuleset[];
  securityConfigurations?: LiveCodeSecurityConfiguration[];
  /** Repositories and attachment status per configuration id. */
  securityConfigurationRepositories?: Record<
    number,
    Array<{ name: string; status: string }>
  >;
  defaultSecurityConfigurations?: LiveDefaultSecurityConfiguration[];
  customProperties?: LiveCustomProperty[];
  repositoryProperties?: LiveRepositoryProperties[];
  branchProtection?: LiveBranchProtection[];
  /** Repository rulesets keyed by repository name. */
  repositoryRulesets?: Record<string, LiveRuleset[]>;
  runnerGroups?: LiveRunnerGroup[];
  orgVariables?: LiveOrgVariable[];
  orgSecrets?: LiveOrgSecret[];
  /** Repository variables keyed by repository name. */
  repositoryVariables?: Record<string, Array<{ name: string; value: string }>>;
  /** Direct collaborators and pending invitations keyed by repository. */
  collaborators?: Record<string, Array<Omit<LiveCollaborator, 'repository'>>>;
  /** Environments keyed by repository, then name, as getEnvironment reports them. */
  environments?: Record<string, Record<string, LiveEnvironment>>;
  /** Environment secret names keyed by repository, then environment name. */
  environmentSecrets?: Record<string, Record<string, Array<{ name: string }>>>;
  /** Environment variables keyed by repository, then environment name. */
  environmentVariables?: Record<
    string,
    Record<string, Array<{ name: string; value: string }>>
  >;
  /** Repository secret names keyed by repository name. */
  repositorySecrets?: Record<string, Array<{ name: string }>>;
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
  organizationOwners: string[];
  missingRepositories: Set<string>;
  customRepositoryRoles: LiveCustomRepositoryRole[];
  organizationRoles: LiveOrganizationRole[];
  internalRepositoriesAllowed: boolean;
  roleAssignments: Record<number, { teams: string[]; users: string[] }>;
  externalGroups: ExternalIdpGroup[];
  repositories: LiveRepository[];
  appInstallations: LiveAppInstallation[];
  installationRepositories: Record<number, string[]>;
  settings: LiveOrgSettings;
  actions: LiveActionsPolicy;
  rulesets: LiveRuleset[];
  securityConfigurations: LiveCodeSecurityConfiguration[];
  securityConfigurationRepositories: Record<
    number,
    Array<{ name: string; status: string }>
  >;
  defaultSecurityConfigurations: LiveDefaultSecurityConfiguration[];
  customProperties: LiveCustomProperty[];
  repositoryProperties: LiveRepositoryProperties[];
  branchProtection: LiveBranchProtection[];
  repositoryRulesets: Record<string, LiveRuleset[]>;
  runnerGroups: LiveRunnerGroup[];
  orgVariables: LiveOrgVariable[];
  orgSecrets: LiveOrgSecret[];
  repositoryVariables: Record<string, Array<{ name: string; value: string }>>;
  environmentVariables: Record<
    string,
    Record<string, Array<{ name: string; value: string }>>
  >;
  environments: Record<string, Record<string, LiveEnvironment>>;
  collaborators: Record<string, Array<Omit<LiveCollaborator, 'repository'>>>;
  environmentSecrets: Record<string, Record<string, Array<{ name: string }>>>;
  repositorySecrets: Record<string, Array<{ name: string }>>;

  links: Array<{ slug: string; groupId: number }> = [];
  memberships: Array<{ slug: string; username: string; role: string }> = [];
  calls: Array<{ method: string; args: unknown }> = [];

  private nextId = 1000;

  constructor(state: FakeClientState = {}) {
    this.teams = state.teams ?? [];
    this.teamRepositories = state.teamRepositories ?? {};
    this.teamMembers = state.teamMembers ?? {};
    this.organizationOwners = state.organizationOwners ?? [];
    this.missingRepositories = new Set(state.missingRepositories ?? []);
    this.customRepositoryRoles = state.customRepositoryRoles ?? [];
    this.organizationRoles = state.organizationRoles ?? [];
    this.internalRepositoriesAllowed =
      state.internalRepositoriesAllowed ?? false;
    this.roleAssignments = state.roleAssignments ?? {};
    this.externalGroups = state.externalGroups ?? [];
    this.repositories = state.repositories ?? [];
    this.appInstallations = state.appInstallations ?? [];
    this.installationRepositories = state.installationRepositories ?? {};
    this.settings = state.settings ?? {};
    this.actions = state.actions ?? {
      enabledRepositories: 'all',
      allowedActions: 'all',
      defaultWorkflowPermissions: 'write',
      canApprovePullRequestReviews: true,
    };
    this.rulesets = state.rulesets ?? [];
    this.securityConfigurations = state.securityConfigurations ?? [];
    this.securityConfigurationRepositories =
      state.securityConfigurationRepositories ?? {};
    this.defaultSecurityConfigurations =
      state.defaultSecurityConfigurations ?? [];
    this.customProperties = state.customProperties ?? [];
    this.repositoryProperties = state.repositoryProperties ?? [];
    this.branchProtection = state.branchProtection ?? [];
    this.repositoryRulesets = state.repositoryRulesets ?? {};
    this.runnerGroups = state.runnerGroups ?? [];
    this.orgVariables = state.orgVariables ?? [];
    this.orgSecrets = state.orgSecrets ?? [];
    this.repositoryVariables = state.repositoryVariables ?? {};
    this.environmentVariables = state.environmentVariables ?? {};
    this.environments = state.environments ?? {};
    this.collaborators = state.collaborators ?? {};
    this.environmentSecrets = state.environmentSecrets ?? {};
    this.repositorySecrets = state.repositorySecrets ?? {};
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
      notificationSetting: params.notificationSetting,
      parentSlug,
    };
    this.teams.push(created);
    return created;
  }

  async updateTeam(
    _org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<LiveTeam> {
    this.record('updateTeam', { slug, params });
    const current = this.teams.find((t) => t.slug === slug);
    const name = params.name ?? current?.name ?? slug;
    const updated: LiveTeam = {
      id: current?.id ?? this.nextId++,
      // The same naive derivation as createTeam. A test that wants GitHub to
      // disagree with the planner's guess overrides this method.
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      description: params.description ?? current?.description ?? null,
      privacy: params.privacy ?? current?.privacy ?? 'closed',
      parentSlug:
        this.teams.find((t) => t.id === params.parentTeamId)?.slug ?? null,
    };
    if (current) {
      this.teams = this.teams.map((t) => (t.slug === slug ? updated : t));
    }
    return updated;
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

  async listOrganizationOwners(): Promise<string[]> {
    return this.organizationOwners;
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
  ): Promise<LiveRepository> {
    this.record('createRepository', repository);
    const created = { id: this.nextId++, name: repository.name };
    this.repositories.push(created);
    return created;
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

  async listInstallationRepositories(installationId: number): Promise<string[]> {
    const repositories = this.installationRepositories[installationId];
    if (!repositories) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    return repositories;
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

  async findRulesetIdByName(
    _org: string,
    name: string,
  ): Promise<number | undefined> {
    return this.rulesets.find((r) => r.name === name)?.id;
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

  // ---- repository rulesets -------------------------------------------------

  async listRepositoryRulesets(
    _owner: string,
    repo: string,
  ): Promise<LiveRuleset[]> {
    return this.repositoryRulesets[repo] ?? [];
  }

  async findRepositoryRulesetIdByName(
    _owner: string,
    repo: string,
    name: string,
  ): Promise<number | undefined> {
    return (this.repositoryRulesets[repo] ?? []).find((r) => r.name === name)
      ?.id;
  }

  async createRepositoryRuleset(
    _owner: string,
    repo: string,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    this.record('createRepositoryRuleset', { repo, ruleset });
  }

  async updateRepositoryRuleset(
    _owner: string,
    repo: string,
    id: number,
    ruleset: ResolvedRuleset,
  ): Promise<void> {
    this.record('updateRepositoryRuleset', { repo, id, ruleset });
  }

  async deleteRepositoryRuleset(
    _owner: string,
    repo: string,
    id: number,
  ): Promise<void> {
    this.record('deleteRepositoryRuleset', { repo, id });
  }

  // ---- runner groups -------------------------------------------------------

  async listRunnerGroups(): Promise<LiveRunnerGroup[]> {
    return this.runnerGroups;
  }

  async createRunnerGroup(
    _org: string,
    group: RunnerGroupManifest,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    this.record('createRunnerGroup', { group, selectedRepositoryIds });
  }

  async updateRunnerGroup(
    _org: string,
    id: number,
    group: RunnerGroupManifest,
  ): Promise<void> {
    this.record('updateRunnerGroup', { id, group });
  }

  async setRunnerGroupRepositories(
    _org: string,
    id: number,
    repositoryIds: number[],
  ): Promise<void> {
    this.record('setRunnerGroupRepositories', { id, repositoryIds });
  }

  async deleteRunnerGroup(_org: string, id: number): Promise<void> {
    this.record('deleteRunnerGroup', { id });
  }

  // ---- actions variables ---------------------------------------------------

  async listOrgVariables(): Promise<LiveOrgVariable[]> {
    return this.orgVariables;
  }

  async createOrgVariable(
    _org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    this.record('createOrgVariable', {
      name,
      value,
      visibility,
      selectedRepositoryIds,
    });
  }

  async updateOrgVariable(
    _org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    this.record('updateOrgVariable', {
      name,
      value,
      visibility,
      selectedRepositoryIds,
    });
  }

  async deleteOrgVariable(_org: string, name: string): Promise<void> {
    this.record('deleteOrgVariable', name);
  }

  async listRepositoryVariables(
    _owner: string,
    repo: string,
  ): Promise<Array<{ name: string; value: string }>> {
    return this.repositoryVariables[repo] ?? [];
  }

  async createRepositoryVariable(
    _owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('createRepositoryVariable', { repo, name, value });
  }

  async updateRepositoryVariable(
    _owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('updateRepositoryVariable', { repo, name, value });
  }

  async deleteRepositoryVariable(
    _owner: string,
    repo: string,
    name: string,
  ): Promise<void> {
    this.record('deleteRepositoryVariable', { repo, name });
  }

  async listEnvironmentsOfRepositories(
    owner: string,
    repositories: readonly string[],
  ): Promise<Map<string, string[]>> {
    this.record('listEnvironmentsOfRepositories', repositories);
    const found = new Map<string, string[]>();
    for (const repository of repositories) {
      if (this.missingRepositories.has(repository)) continue;
      found.set(repository, await this.listRepositoryEnvironments(owner, repository));
    }
    return found;
  }

  async listRepositoryEnvironments(
    _owner: string,
    repo: string,
  ): Promise<string[]> {
    return [
      ...new Set([
        ...Object.keys(this.environments[repo] ?? {}),
        ...Object.keys(this.environmentVariables[repo] ?? {}),
        ...Object.keys(this.environmentSecrets[repo] ?? {}),
      ]),
    ];
  }

  async listRepositoryCollaborators(
    _owner: string,
    repo: string,
  ): Promise<Array<Omit<LiveCollaborator, 'repository'>>> {
    return this.collaborators[repo] ?? [];
  }

  async putRepositoryCollaborator(
    _owner: string,
    repo: string,
    login: string,
    permission: string,
  ): Promise<void> {
    this.record('putRepositoryCollaborator', { repo, login, permission });
  }

  async updateRepositoryInvitation(
    _owner: string,
    repo: string,
    invitationId: number,
    permission: string,
  ): Promise<void> {
    this.record('updateRepositoryInvitation', { repo, invitationId, permission });
  }

  async deleteRepositoryCollaborator(
    _owner: string,
    repo: string,
    login: string,
  ): Promise<void> {
    this.record('deleteRepositoryCollaborator', { repo, login });
  }

  async deleteRepositoryInvitation(
    _owner: string,
    repo: string,
    invitationId: number,
  ): Promise<void> {
    this.record('deleteRepositoryInvitation', { repo, invitationId });
  }

  async getEnvironment(
    _owner: string,
    repo: string,
    name: string,
  ): Promise<LiveEnvironment | undefined> {
    return this.environments[repo]?.[name];
  }

  async putEnvironment(
    _owner: string,
    repo: string,
    name: string,
    settings: EnvironmentSettings,
  ): Promise<void> {
    this.record('putEnvironment', { repo, name, settings });
  }

  async createEnvironmentBranchPolicy(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
    type: 'branch' | 'tag',
  ): Promise<void> {
    this.record('createEnvironmentBranchPolicy', { repo, environment, name, type });
  }

  async deleteEnvironmentBranchPolicy(
    _owner: string,
    repo: string,
    environment: string,
    id: number,
  ): Promise<void> {
    this.record('deleteEnvironmentBranchPolicy', { repo, environment, id });
  }

  async getTeamId(_org: string, slug: string): Promise<number> {
    const team = this.teams.find((t) => t.slug === slug);
    if (!team) throw Object.assign(new Error(`no team ${slug}`), { status: 404 });
    return team.id;
  }

  async getUserId(login: string): Promise<number> {
    let h = 0;
    for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  async listEnvironmentSecrets(
    _owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string }>> {
    return this.environmentSecrets[repo]?.[environment] ?? [];
  }

  async putEnvironmentSecret(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('putEnvironmentSecret', { repo, environment, name, value });
  }

  async deleteEnvironmentSecret(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void> {
    this.record('deleteEnvironmentSecret', { repo, environment, name });
  }

  async listEnvironmentVariables(
    _owner: string,
    repo: string,
    environment: string,
  ): Promise<Array<{ name: string; value: string }>> {
    return this.environmentVariables[repo]?.[environment] ?? [];
  }

  async createEnvironmentVariable(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('createEnvironmentVariable', { repo, environment, name, value });
  }

  async updateEnvironmentVariable(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('updateEnvironmentVariable', { repo, environment, name, value });
  }

  async deleteEnvironmentVariable(
    _owner: string,
    repo: string,
    environment: string,
    name: string,
  ): Promise<void> {
    this.record('deleteEnvironmentVariable', { repo, environment, name });
  }

  // ---- actions secrets -----------------------------------------------------

  async listOrgSecrets(): Promise<LiveOrgSecret[]> {
    return this.orgSecrets;
  }

  async putOrgSecret(
    _org: string,
    name: string,
    value: string,
    visibility: OrgConfigVisibility,
    selectedRepositoryIds?: number[],
  ): Promise<void> {
    this.record('putOrgSecret', {
      name,
      value,
      visibility,
      selectedRepositoryIds,
    });
  }

  async deleteOrgSecret(_org: string, name: string): Promise<void> {
    this.record('deleteOrgSecret', name);
  }

  async listRepositorySecrets(
    _owner: string,
    repo: string,
  ): Promise<Array<{ name: string }>> {
    return this.repositorySecrets[repo] ?? [];
  }

  async putRepositorySecret(
    _owner: string,
    repo: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.record('putRepositorySecret', { repo, name, value });
  }

  async deleteRepositorySecret(
    _owner: string,
    repo: string,
    name: string,
  ): Promise<void> {
    this.record('deleteRepositorySecret', { repo, name });
  }

  // ---- code security -------------------------------------------------------

  async listSecurityConfigurations(): Promise<LiveCodeSecurityConfiguration[]> {
    return this.securityConfigurations;
  }

  async listSecurityConfigurationRepositories(
    _org: string,
    id: number,
  ): Promise<Array<{ name: string; status: string }>> {
    return this.securityConfigurationRepositories[id] ?? [];
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
