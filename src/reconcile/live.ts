import type {
  GitHubClient,
  LiveActionsPolicy,
  LiveAppInstallation,
  LiveBranchProtection,
  LiveCollaborator,
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveDefaultSecurityConfiguration,
  LiveIssueField,
  LiveOrganizationRole,
  LiveOrgSecret,
  LiveOrgSettings,
  LiveOrgVariable,
  LiveCustomRepositoryRole,
  LiveRepoSecret,
  LiveEnvironment,
  LiveRepoEnvironment,
  LiveRepoVariable,
  LiveRepository,
  LiveRepositoryProperties,
  LiveRepositoryRuleset,
  LiveRunnerGroup,
  LiveRuleset,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
} from '../github/client.ts';
import type { DesiredState, TeamManifest } from '../synth/manifest.ts';
import { isBuiltInRepoPermission } from '../synth/manifest.ts';
import { scopesOf } from './owned-scopes.ts';

/**
 * Everything read back from the live organization, ready to diff.
 *
 * A field is `undefined` when the surface was never read, which happens exactly
 * when the definition does not declare it. That keeps a teams-only definition
 * working with a teams-only token: cdkgithub asks GitHub for the Actions policy
 * or the code security configurations only once someone has written some.
 */
export interface LiveState {
  readonly teams: LiveTeam[];
  /** Every repository in the organization, read when the definition names one. */
  readonly repositories?: LiveRepository[];
  /**
   * Repository grants keyed by slug: the teams that declare an access map,
   * plus their live ancestors. The ancestors are read because GitHub reports
   * an inherited grant as though it were the team's own; without the
   * ancestor's listing to explain it, an inherited grant would read as one to
   * remove. A declaring team's own presence here is what marks the surface
   * managed; an ancestor's presence is context only.
   */
  readonly teamRepositories?: Map<string, LiveTeamRepository[]>;
  /**
   * Rosters keyed by slug: the teams that declare one, plus their live
   * descendants. Each member says whether they are on the team only through a
   * team below it, and the descendants' rosters say who a team below will go
   * on holding once the run has been applied.
   */
  readonly teamMembers?: Map<string, LiveTeamMember[]>;
  /** Logins of the organization's owners, read when a team declares a roster. */
  readonly organizationOwners?: string[];
  /**
   * Every organization role and who holds it, read when the definition names
   * one. Roles are org-wide, so this is read whole rather than per declaration:
   * the point of showing it is what is assigned that nobody wrote down.
   */
  readonly organizationRoles?: Array<
    LiveOrganizationRole & { teams: string[]; users: string[] }
  >;
  /** Only read when a declared permission is not one of the five built-ins. */
  readonly customRepositoryRoles?: LiveCustomRepositoryRole[];
  readonly settings?: LiveOrgSettings;
  readonly actions?: LiveActionsPolicy;
  readonly rulesets?: LiveRuleset[];
  /** Rulesets of the repositories the definition declares rulesets on, and no others. */
  readonly repositoryRulesets?: LiveRepositoryRuleset[];
  readonly runnerGroups?: LiveRunnerGroup[];
  /** The organization's variables, read whenever the owner is an organization. */
  readonly actionsVariables?: LiveOrgVariable[];
  /** The organization's secret names, read whenever the owner is an organization. */
  readonly actionsSecrets?: LiveOrgSecret[];
  /** Variables of every repository the definition declares or an entry names. */
  readonly repositoryVariables?: LiveRepoVariable[];
  /**
   * The deployment environments of every repository whose variables are read.
   * Each one owns its variables the way its repository owns the repository's.
   */
  readonly repositoryEnvironments?: LiveRepoEnvironment[];
  /** The environments the definition declares, as they stand; absent ones are missing. */
  readonly environments?: LiveEnvironment[];
  /**
   * Direct collaborators and pending invitations of every declared repository,
   * read only once the definition declares a collaborator.
   */
  readonly repositoryCollaborators?: LiveCollaborator[];
  /** Secret names of every repository the definition declares or an entry names. */
  readonly repositorySecrets?: LiveRepoSecret[];
  readonly securityConfigurations?: LiveCodeSecurityConfiguration[];
  readonly defaultSecurityConfigurations?: LiveDefaultSecurityConfiguration[];
  readonly customProperties?: LiveCustomProperty[];
  readonly repositoryProperties?: LiveRepositoryProperties[];
  readonly issueFields?: LiveIssueField[];
  /** One entry per declared repository and branch, protected or not. */
  readonly branchProtection?: LiveBranchProtection[];
  /** Only read when a ruleset names a GitHub App as a bypass actor. */
  readonly appInstallations?: LiveAppInstallation[];
}

/** Read the live state for the surfaces `desired` declares, and nothing more. */
export async function readLiveState(
  client: GitHubClient,
  desired: DesiredState,
): Promise<LiveState> {
  const owner = desired.owner;
  const declaresPropertyValues = (desired.customProperties ?? []).some(
    (p) => p.values !== undefined,
  );
  // The org's installations resolve an app slug to its id, and tell whether an
  // app can see the repository a repository ruleset lives on. Nothing else
  // needs them, so the call is skipped unless a ruleset asks either question.
  const namesAnApp =
    (desired.rulesets ?? []).some((r) =>
      (r.bypassActors ?? []).some(
        (a) => a.actorType === 'Integration' && typeof a.app === 'string',
      ),
    ) ||
    (desired.repositoryRulesets ?? []).some((r) =>
      (r.bypassActors ?? []).some((a) => a.actorType === 'Integration'),
    );

  // A declaration on a repository this same run creates has nothing to read
  // yet, so a 404 on one of these is an empty surface rather than a failure.
  const beingCreated = new Set(
    (desired.repositories ?? []).map((r) => r.name),
  );
  const variableScopes = scopesOf(desired.actionsVariables, desired);
  const secretScopes = scopesOf(desired.actionsSecrets, desired);

  // Every repository whose variables or secrets are owned owns its
  // environments' too, so the environments are listed once for both, in
  // batched GraphQL queries rather than one REST request per repository.
  const repositoryEnvironments = await readEnvironments(
    client,
    owner,
    [...new Set([...variableScopes.repositories, ...secretScopes.repositories])],
    beingCreated,
  );
  const environmentsOf = (repository: string) =>
    (repositoryEnvironments ?? [])
      .filter((e) => e.repository === repository)
      .map((e) => e.name);

  // A team is read back only for the surface it declares, so a definition that
  // names teams without rosters or access maps still costs one call in total.
  const namesCustomRole = desired.teams.some((t) =>
    Object.values(t.repositories ?? {}).some(
      (p) => !isBuiltInRepoPermission(p),
    ),
  );

  const [
    teams,
    settings,
    actions,
    rulesets,
    configurations,
    defaultSecurityConfigurations,
    customProperties,
    repositoryProperties,
    issueFields,
    branchProtection,
    installations,
    repositories,
    customRepositoryRoles,
    organizationRoles,
    repositoryRulesets,
    runnerGroups,
    actionsVariables,
    actionsSecrets,
    repositoryVariables,
    repositorySecrets,
    environments,
    repositoryCollaborators,
  ] = await Promise.all([
    // A personal account has no teams, and asking for them 404s.
    desired.ownerType === 'organization' ? client.listTeams(owner) : [],
    desired.settings ? client.getOrgSettings(owner) : undefined,
    desired.actions ? client.getActionsPolicy(owner) : undefined,
    desired.rulesets ? client.listRulesets(owner) : undefined,
    desired.codeSecurityConfigurations
      ? client.listSecurityConfigurations(owner)
      : undefined,
    desired.codeSecurityConfigurations
      ? client.listDefaultSecurityConfigurations(owner)
      : undefined,
    desired.customProperties ? client.listCustomProperties(owner) : undefined,
    declaresPropertyValues ? client.listRepositoryProperties(owner) : undefined,
    desired.issueFields ? client.listIssueFields(owner) : undefined,
    readBranchProtection(client, owner, desired),
    namesAnApp ? client.listAppInstallations(owner) : undefined,
    desired.repositories ? client.listRepositories(owner) : undefined,
    namesCustomRole || desired.customRepositoryRoles
      ? client.listCustomRepositoryRoles(owner)
      : undefined,
    desired.organizationRoles
      ? readOrganizationRoles(client, owner)
      : undefined,
    readPerRepository(
      namedRepositories(desired.repositoryRulesets),
      beingCreated,
      async (repository) =>
        (await client.listRepositoryRulesets(owner, repository)).map((r) => ({
          ...r,
          repository,
        })),
    ),
    desired.runnerGroups ? client.listRunnerGroups(owner) : undefined,
    variableScopes.organization ? client.listOrgVariables(owner) : undefined,
    secretScopes.organization ? client.listOrgSecrets(owner) : undefined,
    readPerRepository(
      variableScopes.repositories,
      beingCreated,
      (repository) =>
        readRepositoryVariables(
          client,
          owner,
          repository,
          environmentsOf(repository),
        ),
    ),
    readPerRepository(
      secretScopes.repositories,
      beingCreated,
      (repository) =>
        readRepositorySecrets(
          client,
          owner,
          repository,
          environmentsOf(repository),
        ),
    ),
    desired.environments
      ? Promise.all(
          desired.environments.map((e) =>
            client.getEnvironment(owner, e.repository, e.name),
          ),
        ).then((found) => found.filter((e) => e !== undefined))
      : undefined,
    desired.collaborators
      ? readCollaborators(
          client,
          owner,
          [
            ...new Set([
              ...(desired.repositories ?? []).map((r) => r.name),
              ...desired.collaborators.map((c) => c.repository),
            ]),
          ],
          beingCreated,
        )
      : undefined,
  ]);

  // Per-team reads come second: a team the definition creates this run has no
  // live grants or roster to read, and asking for them would 404. A team being
  // renamed still answers to its old slug here, because nothing has been written
  // yet, so the maps are keyed by the live slug throughout.
  const liveBySlug = new Map(teams.map((t) => [t.slug, t] as const));
  const existing = desired.teams.flatMap((team) => {
    const current = resolveLive(team, liveBySlug);
    return current ? [{ team, slug: current.slug }] : [];
  });

  // A declaring team's listing alone cannot be diffed safely. GitHub reports an
  // ancestor's grants as the team's own, and a member held through a team
  // below stays on this team only while that team keeps them. The ancestors'
  // grants and the descendants' rosters answer both, so they are read
  // alongside, declared or not.
  const accessSlugs = new Set<string>();
  const rosterSlugs = new Set<string>();
  for (const { team, slug } of existing) {
    if (declaresAccess(team)) {
      accessSlugs.add(slug);
      for (const ancestor of ancestorSlugs(slug, liveBySlug)) {
        accessSlugs.add(ancestor);
      }
    }
    if (declaresRoster(team)) {
      rosterSlugs.add(slug);
      for (const descendant of descendantSlugs(slug, teams)) {
        rosterSlugs.add(descendant);
      }
    }
  }

  const [
    teamRepositories,
    teamMembers,
    organizationOwners,
    appInstallations,
    securityConfigurations,
  ] = await Promise.all([
    readSlugs(accessSlugs, (slug) => client.listTeamRepositories(owner, slug)),
    readSlugs(rosterSlugs, (slug) => client.listTeamMembers(owner, slug)),
    rosterSlugs.size > 0 ? client.listOrganizationOwners(owner) : undefined,
    readInstallationRepositories(client, installations, desired),
    readAttachedRepositories(client, owner, configurations, desired),
  ]);

  return {
    teams,
    teamRepositories,
    teamMembers,
    organizationOwners,
    repositories,
    customRepositoryRoles,
    organizationRoles,
    settings,
    actions,
    rulesets,
    securityConfigurations,
    defaultSecurityConfigurations,
    customProperties,
    repositoryProperties,
    issueFields,
    branchProtection,
    appInstallations,
    repositoryRulesets,
    runnerGroups,
    actionsVariables,
    actionsSecrets,
    repositoryVariables,
    repositoryEnvironments,
    repositorySecrets,
    environments,
    repositoryCollaborators,
  };
}

/**
 * Read one repository-scoped surface for every repository the definition owns
 * it on. An empty list leaves the surface unread, and a repository outside the
 * list is never touched, which is what scopes the pruning below to the
 * repositories the definition speaks for.
 *
 * A 404 on a repository this run is about to create is an empty surface; on
 * any other it is a typo or a permissions gap, and reading it as empty would
 * turn every declaration into a create against a repository that is not there.
 */
/**
 * The environments of each repository, missing ones treated the way
 * {@link readPerRepository} treats them: empty when this run creates the
 * repository, and a failure otherwise.
 */
async function readEnvironments(
  client: GitHubClient,
  owner: string,
  repositories: readonly string[],
  beingCreated: ReadonlySet<string>,
): Promise<Array<{ repository: string; name: string }> | undefined> {
  if (repositories.length === 0) return undefined;
  const found = await client.listEnvironmentsOfRepositories(owner, repositories);
  return repositories.flatMap((repository) =>
    foundOrCreated(found, repository, beingCreated).map((name) => ({ repository, name })),
  );
}

/**
 * The direct collaborators and invitations of each repository, missing ones
 * treated the way {@link readPerRepository} treats them.
 */
async function readCollaborators(
  client: GitHubClient,
  owner: string,
  repositories: readonly string[],
  beingCreated: ReadonlySet<string>,
): Promise<LiveCollaborator[] | undefined> {
  if (repositories.length === 0) return undefined;
  const found = await client.listCollaboratorsOfRepositories(owner, repositories);
  return repositories.flatMap((repository) =>
    foundOrCreated(found, repository, beingCreated).map((c) => ({ ...c, repository })),
  );
}

/**
 * What a batched read found for `repository`. A repository the batch did not
 * find is empty when this run creates it, and a failure otherwise.
 */
function foundOrCreated<T>(
  found: ReadonlyMap<string, T[]>,
  repository: string,
  beingCreated: ReadonlySet<string>,
): T[] {
  const entries = found.get(repository);
  if (entries) return entries;
  if (beingCreated.has(repository)) return [];
  throw new Error(
    `Repository "${repository}" was not found: it does not exist, or the token cannot see it.`,
  );
}

async function readPerRepository<T>(
  repositories: readonly string[],
  beingCreated: ReadonlySet<string>,
  read: (repository: string) => Promise<T[]>,
): Promise<T[] | undefined> {
  if (repositories.length === 0) return undefined;

  const results = await Promise.all(
    repositories.map(async (repository) => {
      try {
        return await read(repository);
      } catch (error) {
        if (isNotFound(error) && beingCreated.has(repository)) return [];
        if (isNotFound(error)) {
          throw new Error(
            `Repository "${repository}" was not found: it does not exist, or the token cannot see it.`,
          );
        }
        throw error;
      }
    }),
  );
  return results.flat();
}

/**
 * One repository's variables: the repository-wide ones, and those of each of
 * its deployment environments, tagged with the environment.
 */
async function readRepositoryVariables(
  client: GitHubClient,
  owner: string,
  repository: string,
  environments: string[],
): Promise<LiveRepoVariable[]> {
  const [variables, scoped] = await Promise.all([
    client.listRepositoryVariables(owner, repository),
    Promise.all(
      environments.map(async (environment) =>
        (
          await client.listEnvironmentVariables(owner, repository, environment)
        ).map((v) => ({ ...v, repository, environment })),
      ),
    ),
  ]);
  return [...variables.map((v) => ({ ...v, repository })), ...scoped.flat()];
}

/** The same for secret names. */
async function readRepositorySecrets(
  client: GitHubClient,
  owner: string,
  repository: string,
  environments: string[],
): Promise<LiveRepoSecret[]> {
  const [secrets, scoped] = await Promise.all([
    client.listRepositorySecrets(owner, repository),
    Promise.all(
      environments.map(async (environment) =>
        (
          await client.listEnvironmentSecrets(owner, repository, environment)
        ).map((s) => ({ ...s, repository, environment })),
      ),
    ),
  ]);
  return [...secrets.map((s) => ({ ...s, repository })), ...scoped.flat()];
}

/** The distinct repositories a list of repository-scoped declarations names. */
function namedRepositories(
  declared: ReadonlyArray<{ repository?: string }> | undefined,
): string[] {
  return [
    ...new Set(
      (declared ?? []).flatMap((d) => (d.repository ? [d.repository] : [])),
    ),
  ];
}

/**
 * Add the covered repositories to each `selected` installation whose app a
 * repository ruleset names as a bypass actor. An installation GitHub refuses
 * to list for this token keeps no list, and planning then cannot check it.
 */
async function readInstallationRepositories(
  client: GitHubClient,
  installations: LiveAppInstallation[] | undefined,
  desired: DesiredState,
): Promise<LiveAppInstallation[] | undefined> {
  if (!installations) return undefined;
  const named = new Set<string | number>(
    (desired.repositoryRulesets ?? []).flatMap((r) =>
      (r.bypassActors ?? []).flatMap((a) =>
        a.actorType === 'Integration' ? [a.app] : [],
      ),
    ),
  );
  return Promise.all(
    installations.map(async (installation) => {
      if (
        installation.repositorySelection !== 'selected' ||
        !(named.has(installation.slug) || named.has(installation.appId))
      ) {
        return installation;
      }
      try {
        const repositories = await client.listInstallationRepositories(
          installation.id,
        );
        return { ...installation, repositories };
      } catch (error) {
        if (isAccessDenied(error)) return installation;
        throw error;
      }
    }),
  );
}

/**
 * GitHub's attachment statuses for a repository that is on the configuration
 * or on its way there. `detached`, `removed`, `failed` and
 * `removed_by_enterprise` mean it is not, and another attach is due.
 */
const ATTACHED_STATUSES = new Set(['attached', 'attaching', 'enforced', 'updating']);

/**
 * Add the attached repositories to each live configuration the definition
 * attaches to named repositories, so the plan attaches only the ones missing.
 */
async function readAttachedRepositories(
  client: GitHubClient,
  owner: string,
  configurations: LiveCodeSecurityConfiguration[] | undefined,
  desired: DesiredState,
): Promise<LiveCodeSecurityConfiguration[] | undefined> {
  if (!configurations) return undefined;
  const byRepository = new Set(
    (desired.codeSecurityConfigurations ?? [])
      .filter((c) => c.attachRepositories?.length)
      .map((c) => c.name),
  );
  return Promise.all(
    configurations.map(async (configuration) => {
      if (!byRepository.has(configuration.name)) return configuration;
      const repositories = await client.listSecurityConfigurationRepositories(
        owner,
        configuration.id,
      );
      return {
        ...configuration,
        attachedRepositories: repositories
          .filter((r) => ATTACHED_STATUSES.has(r.status))
          .map((r) => r.name),
      };
    }),
  );
}

/** A 403 or 404: the token may not read this, which is not a failure. */
function isAccessDenied(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 403 || status === 404;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 404
  );
}

/** Every organization role, with who holds it. */
async function readOrganizationRoles(
  client: GitHubClient,
  owner: string,
): Promise<
  Array<LiveOrganizationRole & { teams: string[]; users: string[] }> | undefined
> {
  const roles = await client.listOrganizationRoles(owner);
  return Promise.all(
    roles.map(async (role) => ({
      ...role,
      ...(await client.readRoleAssignment(owner, role.id)),
    })),
  );
}

/**
 * The live team a declaration refers to: the one under its own slug, or the one
 * it is renaming.
 *
 * The derived slug is tried first, so a `previousSlug` left in place after the
 * rename landed still resolves to the team it always did rather than to whatever
 * someone has since created under the freed-up name.
 */
export function resolveLive(
  team: TeamManifest,
  liveBySlug: Map<string, LiveTeam>,
): LiveTeam | undefined {
  return (
    liveBySlug.get(team.slug) ??
    (team.previousSlug ? liveBySlug.get(team.previousSlug) : undefined)
  );
}

/** A team declares its repository access when it carries a map, `{}` included. */
export function declaresAccess(team: TeamManifest): boolean {
  return team.repositories !== undefined;
}

/**
 * A team declares its roster when it carries either list. An IdP-synced team is
 * excluded whatever it declares: Entra owns that membership, and reconciling it
 * here would fight the next SCIM push.
 */
export function declaresRoster(team: TeamManifest): boolean {
  if (team.externalGroup) return false;
  return team.members !== undefined || team.maintainers !== undefined;
}

/**
 * Read one surface for a set of live slugs. Returns `undefined` when the set
 * is empty, which is what keeps the surface unmanaged rather than
 * managed-and-empty.
 */
async function readSlugs<T>(
  slugs: ReadonlySet<string>,
  read: (slug: string) => Promise<T[]>,
): Promise<Map<string, T[]> | undefined> {
  if (slugs.size === 0) return undefined;

  const entries = await Promise.all(
    [...slugs].map(async (slug) => [slug, await read(slug)] as const),
  );
  return new Map(entries);
}

/** The live parent chain of `slug`, nearest first, with a cycle guard. */
function ancestorSlugs(
  slug: string,
  liveBySlug: Map<string, LiveTeam>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([slug]);
  let parent = liveBySlug.get(slug)?.parentSlug ?? null;
  while (parent && !seen.has(parent)) {
    chain.push(parent);
    seen.add(parent);
    parent = liveBySlug.get(parent)?.parentSlug ?? null;
  }
  return chain;
}

/** Every live team below `slug`, in no particular order. */
function descendantSlugs(slug: string, teams: LiveTeam[]): string[] {
  const children = new Map<string, string[]>();
  for (const team of teams) {
    if (!team.parentSlug) continue;
    const siblings = children.get(team.parentSlug) ?? [];
    siblings.push(team.slug);
    children.set(team.parentSlug, siblings);
  }

  const found: string[] = [];
  const seen = new Set<string>([slug]);
  const queue = [...(children.get(slug) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

/**
 * Read the protection of each declared branch. There is no endpoint that lists
 * every protected branch in an org, so this only ever looks at branches the
 * definition names; a branch cdkgithub was never told about stays invisible to
 * it, which is also why branch protection is never pruned.
 */
async function readBranchProtection(
  client: GitHubClient,
  owner: string,
  desired: DesiredState,
): Promise<LiveBranchProtection[] | undefined> {
  const declared = desired.branchProtection;
  if (!declared) return undefined;

  return Promise.all(
    declared.map((p) =>
      client.getBranchProtection(owner, p.repository, p.branch),
    ),
  );
}
