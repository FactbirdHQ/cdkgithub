import { comparableRoleName } from '../github/client.ts';
import type { LiveTeam } from '../github/client.ts';
import type { DesiredState, TeamManifest } from '../synth/manifest.ts';
import type { LiveState } from './live.ts';

/**
 * A manifest that puts the team structure back the way this run found it.
 *
 * Written next to the pre-apply snapshot, so a bad apply is reverted with
 * `cdkgithub apply --manifest <backup>/rollback-manifest.json`. It covers the
 * teams, and the rosters and grants that were read this run; a surface that
 * was never read cannot be restored from here, and the governance surfaces are
 * deliberately absent, because their declarations live in git and revert by
 * reverting the definition and applying it.
 */
export function rollbackManifest(
  desired: DesiredState,
  live: LiveState,
): DesiredState {
  // An IdP-synced team's roster belongs to Entra; restoring it from here would
  // fight the next SCIM push, so those teams keep their shape but not a roster.
  const idpSynced = new Set(
    desired.teams.filter((t) => t.externalGroup).map((t) => t.slug),
  );
  const teams = [...live.teams]
    .sort((a, b) => depthOf(a, live.teams) - depthOf(b, live.teams))
    .map((team) => toTeamManifest(team, live, idpSynced.has(team.slug)));

  return {
    owner: desired.owner,
    ownerType: desired.ownerType,
    teams,
  };
}

function toTeamManifest(
  team: LiveTeam,
  live: LiveState,
  idpSynced: boolean,
): TeamManifest {
  const roster = idpSynced ? undefined : live.teamMembers?.get(team.slug);
  const grants = live.teamRepositories?.get(team.slug);

  const repositories = grants
    ? Object.fromEntries(
        grants.map((g) => [g.name, comparableRoleName(g.roleName)]),
      )
    : undefined;

  return {
    slug: team.slug,
    name: team.name,
    description: team.description ?? undefined,
    privacy: team.privacy,
    parentSlug: team.parentSlug ?? undefined,
    maintainers: roster
      ?.filter((m) => m.role === 'maintainer')
      .map((m) => m.login),
    members: roster?.filter((m) => m.role === 'member').map((m) => m.login),
    repositories,
  };
}

/** Depth in the parent chain, so the manifest lists parents before children. */
function depthOf(team: LiveTeam, all: LiveTeam[]): number {
  const bySlug = new Map(all.map((t) => [t.slug, t] as const));
  let depth = 0;
  let current: LiveTeam | undefined = team;
  while (current?.parentSlug) {
    depth++;
    current = bySlug.get(current.parentSlug);
    if (depth > all.length) break;
  }
  return depth;
}
