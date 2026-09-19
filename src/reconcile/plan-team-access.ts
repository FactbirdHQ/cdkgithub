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
import { declaresAccess, declaresRoster } from './live.ts';

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
  assertPermissionsResolve(teams, live.customRepositoryRoles);

  const changes: Change[] = [];
  for (const team of teams) {
    if (!liveBySlug.has(team.slug)) continue;
    if (declaresAccess(team)) {
      changes.push(...planRepoAccess(team, live, liveBySlug, roles));
    }
    if (declaresRoster(team)) {
      changes.push(...planRoster(team, live, liveBySlug));
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
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
  roles: Map<string, number>,
): Change[] {
  const declared = team.repositories ?? {};
  const current = new Map(
    (live.teamRepositories?.get(team.slug) ?? []).map(
      (r) => [r.name, comparableRoleName(r.roleName)] as const,
    ),
  );
  const inherited = inheritedAccess(team.slug, live, liveBySlug);

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
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
): Change[] {
  const declared = new Map<string, TeamRole>();
  for (const username of team.members ?? []) declared.set(username, 'member');
  // Maintainers are applied second: someone named in both lists is a maintainer.
  for (const username of team.maintainers ?? []) {
    declared.set(username, 'maintainer');
  }

  const current = new Map(
    (live.teamMembers?.get(team.slug) ?? []).map(
      (m) => [m.login, m.role] as const,
    ),
  );
  const throughChildren = membersOfDescendants(team.slug, live, liveBySlug);

  const changes: Change[] = [];
  for (const [username, role] of declared) {
    const from = current.get(username);
    if (from === role) continue;
    changes.push({
      kind: 'set-membership',
      slug: team.slug,
      username,
      role,
      from,
    });
  }

  for (const [username, from] of current) {
    if (declared.has(username)) continue;
    // Reported here only because they are in a team below this one. Their
    // membership belongs to that team's roster, not this one's.
    if (throughChildren.has(username)) continue;
    changes.push({
      kind: 'remove-membership',
      slug: team.slug,
      username,
      from,
    });
  }
  return changes;
}

/** Everyone who reaches `slug` by being in a team below it. */
function membersOfDescendants(
  slug: string,
  live: LiveState,
  liveBySlug: Map<string, LiveTeam>,
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
    for (const member of live.teamMembers?.get(next) ?? []) {
      inherited.add(member.login);
    }
    queue.push(...(children.get(next) ?? []));
  }
  return inherited;
}
