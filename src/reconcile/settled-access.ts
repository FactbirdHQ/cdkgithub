/**
 * The rules `plan` and `diff` share for reading live access that already
 * satisfies a declaration, so `diff` never shows a change `plan` would not make.
 */

import { comparableRoleName } from '../github/client.ts';
import type { TeamRole } from './changes.ts';
import { rankOf } from './permission-rank.ts';

/**
 * GitHub reports an organization owner as maintainer whatever role was
 * written, so for an owner any membership satisfies the declaration.
 */
export function teamRoleHolds(reported: TeamRole | undefined, declared: TeamRole, isOwner: boolean): boolean {
  return reported === declared || (isOwner && reported === 'maintainer');
}

/** `slug` and every team above it, which an organization role reaches through. */
export function selfAndAncestors(slug: string, parentOf: (slug: string) => string | null | undefined): Set<string> {
  const teams = new Set<string>();
  for (let team: string | null | undefined = slug; team && !teams.has(team); team = parentOf(team)) {
    teams.add(team);
  }
  return teams;
}

/**
 * The strongest repository permission an organization role grants any of
 * `teams`, or `undefined` when none carries one.
 */
export function organizationRoleFloor(
  teams: ReadonlySet<string>,
  organizationRoles: readonly { readonly teams: readonly string[]; readonly baseRole?: string }[],
  ranks: Map<string, number>,
): string | undefined {
  let floor: string | undefined;
  for (const role of organizationRoles) {
    if (!role.baseRole || !role.teams.some((t) => teams.has(t))) {
      continue;
    }
    const permission = comparableRoleName(role.baseRole);
    if (floor === undefined || rankOf(permission, ranks) > rankOf(floor, ranks)) {
      floor = permission;
    }
  }
  return floor;
}
