/**
 * The access an organization role confers, as repository grants.
 *
 * Five of GitHub's predefined roles carry a `base_role`, which is a repository
 * permission on every repository at once, and `security_manager` carries read
 * the same way. So a role assignment can reach further than any team grant
 * while living entirely outside the team tree.
 *
 * Which is why it belongs in the access review. A report built from team grants
 * alone describes a smaller organization than the real one: it leaves the
 * widest access in the definition invisible, and reads a repository moved from
 * a team to a role as access withdrawn when nothing was withdrawn.
 *
 * The permission is GitHub's own `base_role` rather than a table kept here. A
 * role whose base is absent grants no repository access and contributes
 * nothing.
 */

import type { LiveOrganizationRole } from '../github/client.ts';
import type { RepoPermission } from '../synth/manifest.ts';

/** An organization role and who holds it. */
export interface OrgRoleAssignment {
  readonly name: string;
  /** Team slugs holding it. Everyone in the team, and in its children, holds it. */
  readonly teams: readonly string[];
  /** People holding it in their own right. */
  readonly users: readonly string[];
  /**
   * The repository permission it carries on every repository, if any.
   *
   * Read from GitHub rather than assumed, so a role whose base changes is
   * described as it is.
   */
  readonly baseRole?: RepoPermission;
}

/**
 * `security_manager` carries read on every repository.
 *
 * GitHub reports it among the role's `permissions` rather than as a
 * `base_role`, so it is the one role whose reach has to be named here.
 */
const READS_EVERY_REPOSITORY = 'security_manager';

/** Describe a live role as an assignment, keeping the reach GitHub reports. */
export function assignmentFromLive(
  role: LiveOrganizationRole & { teams: string[]; users: string[] },
): OrgRoleAssignment {
  const baseRole = role.baseRole ?? (role.name === READS_EVERY_REPOSITORY ? 'read' : undefined);
  return {
    name: role.name,
    teams: role.teams,
    users: role.users,
    baseRole: baseRole as RepoPermission | undefined,
  };
}

/**
 * Everyone who holds a role, by login.
 *
 * A team assignment reaches the team's members and everyone below it, because
 * a child team's members are members of the organization's copy of the parent
 * for this purpose.
 */
export function holdersOf(
  assignment: OrgRoleAssignment,
  membersOfTeam: (slug: string) => readonly string[],
): Set<string> {
  const out = new Set<string>(assignment.users);
  for (const slug of assignment.teams) {
    for (const login of membersOfTeam(slug)) {
      out.add(login);
    }
  }
  return out;
}
