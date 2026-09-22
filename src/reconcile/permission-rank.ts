/**
 * Order the repository permissions, built-in and custom alike.
 *
 * Inheritance is what needs the order: a child team holds whatever an ancestor
 * grants, and where both grant the same repository GitHub keeps the stronger of
 * the two. A custom role has no rank of its own, so it borrows the rank of the
 * built-in it extends, which is the only ordering GitHub itself states.
 */

import type { LiveCustomRepositoryRole } from '../github/client.ts';
import { comparableRoleName } from '../github/client.ts';
import type { RepoPermission } from '../synth/manifest.ts';

/** Built-in permissions from weakest to strongest. */
export const PERMISSION_RANK: Record<string, number> = {
  pull: 1,
  triage: 2,
  push: 3,
  maintain: 4,
  admin: 5,
};

/** Ranks each custom role by the built-in it extends, so it sorts with them. */
export function rankCustomRoles(
  roles: readonly LiveCustomRepositoryRole[],
): Map<string, number> {
  return new Map(
    roles.map((r) => [
      r.name,
      PERMISSION_RANK[comparableRoleName(r.baseRole)] ?? 0,
    ]),
  );
}

/** Where a permission sits in the order. An unknown one ranks below them all. */
export function rankOf(permission: string, roles: Map<string, number>): number {
  return PERMISSION_RANK[permission] ?? roles.get(permission) ?? 0;
}

/** The stronger of two permissions, which is what GitHub grants on an overlap. */
export function strongerPermission(
  a: RepoPermission,
  b: RepoPermission,
  roles: Map<string, number>,
): RepoPermission {
  return rankOf(a, roles) >= rankOf(b, roles) ? a : b;
}
