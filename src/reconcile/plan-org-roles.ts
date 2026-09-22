/**
 * Diff who holds each organization role.
 *
 * A role is GitHub's, not the definition's: `security_manager`, `ci_cd_admin`,
 * the five `all_repo_*` roles. What is declared here is who holds one, so a name
 * GitHub does not define fails the plan rather than being created.
 *
 * Teams and users are separate surfaces on the same role. Declaring `teams` and
 * leaving `users` off owns the first and leaves the second alone, which is what
 * every other optional field in this tool means.
 */

import type { LiveOrganizationRole } from '../github/client.ts';
import type { OrganizationRoleManifest } from '../synth/manifest.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';

type LiveRole = LiveOrganizationRole & { teams: string[]; users: string[] };

export function planOrganizationRoles(
  desired: OrganizationRoleManifest[] | undefined,
  live: LiveState,
): Change[] {
  if (!desired) return [];
  const known = new Map((live.organizationRoles ?? []).map((r) => [r.name, r]));
  assertRolesExist(desired, known);

  const changes: Change[] = [];
  for (const declaration of desired) {
    const current = known.get(declaration.name) as LiveRole;

    for (const subject of ['team', 'user'] as const) {
      const wanted = subject === 'team' ? declaration.teams : declaration.users;
      if (wanted === undefined) continue; // Surface not owned here.

      const held = subject === 'team' ? current.teams : current.users;
      const heldSet = new Set(held);
      const wantedSet = new Set(wanted);

      for (const name of wanted) {
        if (heldSet.has(name)) continue;
        changes.push({
          kind: 'assign-org-role',
          role: declaration.name,
          roleId: current.id,
          subject,
          name,
        });
      }
      for (const name of held) {
        if (wantedSet.has(name)) continue;
        changes.push({
          kind: 'revoke-org-role',
          role: declaration.name,
          roleId: current.id,
          subject,
          name,
        });
      }
    }
  }
  return changes;
}

/**
 * Fail on a role GitHub does not define, before anything is written.
 *
 * Organization roles cannot be created through this surface, so a name that
 * matches nothing is a typo. Left alone it would read as a grant and do nothing
 * at all, which is the failure worth catching early.
 */
function assertRolesExist(
  desired: OrganizationRoleManifest[],
  known: Map<string, LiveRole>,
): void {
  for (const declaration of desired) {
    if (known.has(declaration.name)) continue;
    const available = [...known.keys()].sort().join(', ');
    throw new Error(
      `Organization role "${declaration.name}" does not exist in this ` +
        `organization. Roles are defined by GitHub and cannot be created here` +
        `${available ? ` (available: ${available})` : ''}.`,
    );
  }
}

/**
 * Assignments the definition does not mention, for the plan to report.
 *
 * Roles are read whole rather than per declaration, so this is the answer to
 * "what is assigned that nobody wrote down" — an access path as wide as
 * `all_repo_admin` is worth seeing even when nothing proposes to change it.
 */
export function unmanagedRoleAssignments(
  desired: OrganizationRoleManifest[] | undefined,
  live: LiveState,
): Array<{
  role: string;
  baseRole?: string;
  teams: string[];
  users: string[];
}> {
  const declared = new Map((desired ?? []).map((d) => [d.name, d]));

  return (live.organizationRoles ?? [])
    .map((role) => {
      const d = declared.get(role.name);
      return {
        role: role.name,
        baseRole: role.baseRole,
        // A surface the definition owns is not unmanaged, even when it is empty.
        teams: d?.teams !== undefined ? [] : role.teams,
        users: d?.users !== undefined ? [] : role.users,
      };
    })
    .filter((r) => r.teams.length > 0 || r.users.length > 0);
}
