import type {
  GitHubClient,
  LiveActionsPolicy,
  LiveBranchProtection,
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveDefaultSecurityConfiguration,
  LiveOrgSettings,
  LiveRepositoryProperties,
  LiveRuleset,
  LiveTeam,
} from '../github/client.ts';
import type { DesiredState } from '../synth/manifest.ts';

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
  readonly settings?: LiveOrgSettings;
  readonly actions?: LiveActionsPolicy;
  readonly rulesets?: LiveRuleset[];
  readonly securityConfigurations?: LiveCodeSecurityConfiguration[];
  readonly defaultSecurityConfigurations?: LiveDefaultSecurityConfiguration[];
  readonly customProperties?: LiveCustomProperty[];
  readonly repositoryProperties?: LiveRepositoryProperties[];
  /** One entry per declared repository and branch, protected or not. */
  readonly branchProtection?: LiveBranchProtection[];
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
  ]);

  return {
    teams,
    settings,
    actions,
    rulesets,
    securityConfigurations,
    defaultSecurityConfigurations,
    customProperties,
    repositoryProperties,
    branchProtection,
  };
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
