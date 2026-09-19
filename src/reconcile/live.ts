import type {
  GitHubClient,
  LiveActionsPolicy,
  LiveAppInstallation,
  LiveBranchProtection,
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveDefaultSecurityConfiguration,
  LiveOrgSettings,
  LiveCustomRepositoryRole,
  LiveRepositoryProperties,
  LiveRuleset,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
} from '../github/client.ts';
import type { DesiredState, TeamManifest } from '../synth/manifest.ts';
import { isBuiltInRepoPermission } from '../synth/manifest.ts';

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
  /**
   * Repository grants of the teams that declare an access map, keyed by slug. A
   * team absent from this map declared none, so its access is left alone.
   */
  readonly teamRepositories?: Map<string, LiveTeamRepository[]>;
  /** Rosters of the teams that declare one, keyed by slug. */
  readonly teamMembers?: Map<string, LiveTeamMember[]>;
  /** Only read when a declared permission is not one of the five built-ins. */
  readonly customRepositoryRoles?: LiveCustomRepositoryRole[];
  readonly settings?: LiveOrgSettings;
  readonly actions?: LiveActionsPolicy;
  readonly rulesets?: LiveRuleset[];
  readonly securityConfigurations?: LiveCodeSecurityConfiguration[];
  readonly defaultSecurityConfigurations?: LiveDefaultSecurityConfiguration[];
  readonly customProperties?: LiveCustomProperty[];
  readonly repositoryProperties?: LiveRepositoryProperties[];
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
  // Resolving a bypass actor by app slug is the only thing that needs the org's
  // installations, so the call is skipped unless one is named.
  const namesAnApp = (desired.rulesets ?? []).some((r) =>
    (r.bypassActors ?? []).some(
      (a) => a.actorType === 'Integration' && typeof a.app === 'string',
    ),
  );

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
    securityConfigurations,
    defaultSecurityConfigurations,
    customProperties,
    repositoryProperties,
    branchProtection,
    appInstallations,
    customRepositoryRoles,
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
    readBranchProtection(client, owner, desired),
    namesAnApp ? client.listAppInstallations(owner) : undefined,
    namesCustomRole ? client.listCustomRepositoryRoles(owner) : undefined,
  ]);

  // Per-team reads come second: a team the definition creates this run has no
  // live grants or roster to read, and asking for them would 404.
  const live = new Set(teams.map((t) => t.slug));
  const existing = desired.teams.filter((t) => live.has(t.slug));
  const [teamRepositories, teamMembers] = await Promise.all([
    readPerTeam(existing, declaresAccess, (slug) =>
      client.listTeamRepositories(owner, slug),
    ),
    readPerTeam(existing, declaresRoster, (slug) =>
      client.listTeamMembers(owner, slug),
    ),
  ]);

  return {
    teams,
    teamRepositories,
    teamMembers,
    customRepositoryRoles,
    settings,
    actions,
    rulesets,
    securityConfigurations,
    defaultSecurityConfigurations,
    customProperties,
    repositoryProperties,
    branchProtection,
    appInstallations,
  };
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
 * Read one surface for the teams that declare it, keyed by slug. Returns
 * `undefined` when no team does, which is what keeps the surface unmanaged
 * rather than managed-and-empty.
 */
async function readPerTeam<T>(
  teams: TeamManifest[],
  declares: (team: TeamManifest) => boolean,
  read: (slug: string) => Promise<T[]>,
): Promise<Map<string, T[]> | undefined> {
  const wanted = teams.filter(declares);
  if (wanted.length === 0) return undefined;

  const entries = await Promise.all(
    wanted.map(async (t) => [t.slug, await read(t.slug)] as const),
  );
  return new Map(entries);
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
