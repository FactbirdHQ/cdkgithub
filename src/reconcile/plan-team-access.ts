/**
 * Diff a team's repository grants and its roster against the live organization.
 *
 * Both surfaces are complicated by the same thing: GitHub reports inherited
 * access as though it were the team's own. A child team's repository listing
 * carries everything its ancestors can reach, and a parent team's member
 * listing carries everyone in its descendants. Neither is removable where it is
 * reported, so a diff that took the listings at face value would propose
 * deleting access it cannot delete, every run, forever.
 *
 * So a live grant or member is only ever proposed for removal when the team
 * tree does not already explain it. Additions and permission changes need no
 * such care: they compare the declaration against the effective access, which
 * is what the team actually has.
 */

import type { LiveCustomRepositoryRole, LiveTeam } from '../github/client.ts';
import { comparableRoleName } from '../github/client.ts';
import type { TeamManifest } from '../synth/manifest.ts';
import { isBuiltInRepoPermission } from '../synth/manifest.ts';
import type { Change, TeamRole } from './changes.ts';
import type { LiveState } from './live.ts';
import { declaresAccess, declaresRoster, resolveLive } from './live.ts';

/** Built-in permissions from weakest to strongest. */
const PERMISSION_RANK: Record<string, number> = {
  pull: 1,
  triage: 2,
  push: 3,
  maintain: 4,
  admin: 5,
};

/**
 * Plan the repository grants and rosters of teams that already exist.
 *
 * A team the definition creates this run is skipped: `apply` writes its grants
 * and roster as part of the create, when the team finally has an id.
 */
export function planTeamAccess(
  teams: TeamManifest[],
  live: LiveState,
): Change[] {
  const liveBySlug = new Map(live.teams.map((t) => [t.slug, t] as const));
  const roles = rankCustomRoles(live.customRepositoryRoles ?? []);
  // Keyed by live slug, because that is how the tree and the live rosters are
  // keyed while a rename is still pending.
  const declaredByLiveSlug = new Map(
    teams.flatMap((t) => {
      const current = resolveLive(t, liveBySlug);
      return current ? [[current.slug, t] as const] : [];
    }),
  );
  assertPermissionsResolve(teams, live.customRepositoryRoles);

  const changes: Change[] = [];
  for (const team of teams) {
    // Live state is keyed by the slug GitHub answers to now, which for a team
    // being renamed is still the old one. The changes below are addressed to the
    // new slug instead: they run after the rename, and the old slug is gone by
    // then, since GitHub redirects neither the team nor its sub-resources.
    const current = resolveLive(team, liveBySlug);
    if (!current) continue;
    if (declaresAccess(team)) {
      changes.push(
        ...planRepoAccess(team, current.slug, live, liveBySlug, roles),
      );
    }
    if (declaresRoster(team)) {
      changes.push(
        ...planRoster(team, current.slug, live, liveBySlug, declaredByLiveSlug),
      );
    }
  }
  return changes;
}

/**
 * Fail the plan on a permission that is neither a built-in nor a role the org
 * defines. This runs before any write, which is the point: a misspelled
 * permission is a typo to fix, not a grant to make.
 */
function assertPermissionsResolve(
  teams: TeamManifest[],
  customRoles: LiveCustomRepositoryRole[] | undefined,
): void {
  const known = new Set((customRoles ?? []).map((r) => r.name));
  for (const team of teams) {
    for (const [repo, permission] of Object.entries(team.repositories ?? {})) {
      if (isBuiltInRepoPermission(permission)) continue;
      if (known.has(permission)) continue;
      const available = [...known].map((n) => `"${n}"`).join(', ');
      throw new Error(
        `Team "${team.slug}" grants "${permission}" on ${repo}, which is ` +
          'neither a built-in permission (pull, triage, push, maintain, admin) ' +
          `nor a custom repository role this organization defines${
            available ? ` (${available})` : ''
          }.`,
      );
    }
  }
}

/** Rank each custom role by the built-in it extends, so it sorts with them. */
function rankCustomRoles(
  roles: LiveCustomRepositoryRole[],
): Map<string, number> {
  return new Map(
    roles.map((r) => [
      r.name,
      PERMISSION_RANK[comparableRoleName(r.baseRole)] ?? 0,
    ]),
  );
}

function rankOf(permission: string, roles: Map<string, number>): number {
  return PERMISSION_RANK[permission] ?? roles.get(permission) ?? 0;
}

function planRepoAccess(
  team: TeamManifest,
  liveSlug: string,
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
  roles: Map<string, number>,
): Change[] {
  const declared = team.repositories ?? {};
  const current = new Map(
    (live.teamRepositories?.get(liveSlug) ?? []).map(
      (r) => [r.name, comparableRoleName(r.roleName)] as const,
    ),
  );
  const inherited = inheritedAccess(liveSlug, live, liveBySlug);

  const changes: Change[] = [];
  for (const [repository, permission] of Object.entries(declared)) {
    const from = current.get(repository);
    if (from === permission) continue;
    changes.push({
      kind: 'set-repo-access',
      slug: team.slug,
      repository,
      permission,
      from,
    });
  }

  for (const [repository, from] of current) {
    if (repository in declared) continue;
    // An ancestor grants at least this much, so the grant is not the team's to
    // give up: removing it here would either fail or strip the ancestor's.
    const above = inherited.get(repository);
    if (above !== undefined && rankOf(above, roles) >= rankOf(from, roles)) {
      continue;
    }
    changes.push({
      kind: 'remove-repo-access',
      slug: team.slug,
      repository,
      from,
    });
  }
  return changes;
}

/** The strongest grant each ancestor of `slug` holds, keyed by repository. */
function inheritedAccess(
  slug: string,
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
): Map<string, string> {
  const merged = new Map<string, string>();
  let parent = liveBySlug.get(slug)?.parentSlug ?? null;
  const seen = new Set<string>([slug]);

  while (parent && !seen.has(parent)) {
    seen.add(parent);
    for (const repo of live.teamRepositories?.get(parent) ?? []) {
      // An ancestor's own listing already merges everything above it, so the
      // first value wins and the walk could stop here for repositories it names.
      if (!merged.has(repo.name)) {
        merged.set(repo.name, comparableRoleName(repo.roleName));
      }
    }
    parent = liveBySlug.get(parent)?.parentSlug ?? null;
  }
  return merged;
}

function planRoster(
  team: TeamManifest,
  liveSlug: string,
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
  declaredByLiveSlug: Map<string, TeamManifest>,
): Change[] {
  const declared = new Map<string, TeamRole>();
  for (const username of team.members ?? []) declared.set(username, 'member');
  // Maintainers are applied second: someone named in both lists is a maintainer.
  for (const username of team.maintainers ?? []) {
    declared.set(username, 'maintainer');
  }

  const reported = new Map(
    (live.teamMembers?.get(liveSlug) ?? []).map(
      (m) => [m.login, m.role] as const,
    ),
  );
  // The roster GitHub reports is this team's own plus everyone in a team below
  // it, and the API draws no line between the two: asking for one member's
  // membership answers the same either way. Whoever a team below explains is
  // therefore not provably a member of this one.
  const explainedNow = membersOfDescendants(liveSlug, live, liveBySlug);
  // The same question asked of the rosters those teams will hold once this run
  // has been applied. The two differ exactly for someone a child is dropping,
  // which is the case that needs a membership written here.
  const explainedAfter = membersOfDescendants(
    liveSlug,
    live,
    liveBySlug,
    declaredByLiveSlug,
  );
  const direct = new Map(
    [...reported].filter(([login]) => !explainedNow.has(login)),
  );

  const changes: Change[] = [];
  for (const [username, role] of declared) {
    const effective = reported.get(username);
    // Satisfied when the role on this team is already right and it comes from
    // either a membership here or a team below that is keeping them. Moving
    // someone up from a child fails both, which is the point: the child drops
    // them this run, so this team has to hold them itself.
    const held = direct.has(username) || explainedAfter.has(username);
    if (effective === role && held) continue;
    changes.push({
      kind: 'set-membership',
      slug: team.slug,
      username,
      role,
      from: effective,
    });
  }

  for (const [username, from] of direct) {
    if (declared.has(username)) continue;
    changes.push({
      kind: 'remove-membership',
      slug: team.slug,
      username,
      from,
    });
  }
  return changes;
}

/**
 * Everyone who reaches `slug` by being in a team below it.
 *
 * Without `declaredByLiveSlug` the answer is about the organization as it
 * stands. With it, the answer is about the organization this run will leave
 * behind: a descendant that declares a roster is about to become that roster, so
 * it explains the people it keeps and not the ones it drops.
 */
function membersOfDescendants(
  slug: string,
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
  declaredByLiveSlug?: Map<string, TeamManifest>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const team of liveBySlug.values()) {
    if (!team.parentSlug) continue;
    const siblings = children.get(team.parentSlug) ?? [];
    siblings.push(team.slug);
    children.set(team.parentSlug, siblings);
  }

  const inherited = new Set<string>();
  const queue = [...(children.get(slug) ?? [])];
  const seen = new Set<string>([slug]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    for (const login of rosterOf(next, live, declaredByLiveSlug)) {
      inherited.add(login);
    }
    queue.push(...(children.get(next) ?? []));
  }
  return inherited;
}

/**
 * The logins a team holds, or will hold once this run has been applied when a
 * declaration is supplied. A team that declares no roster, or whose roster Entra
 * owns, keeps whoever it has either way.
 */
function rosterOf(
  liveSlug: string,
  live: LiveState,
  declaredByLiveSlug?: Map<string, TeamManifest>,
): string[] {
  const declaration = declaredByLiveSlug?.get(liveSlug);
  if (declaration && declaresRoster(declaration)) {
    return [...(declaration.members ?? []), ...(declaration.maintainers ?? [])];
  }
  return (live.teamMembers?.get(liveSlug) ?? []).map((m) => m.login);
}
