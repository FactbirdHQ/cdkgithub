import { Construct } from 'constructs';

/** Who holds an organization role. Both lists are optional and additive. */
export interface OrganizationRoleProps {
  /** Team slugs that hold the role. Everyone in the team holds it. */
  readonly teams?: string[];
  /** Usernames that hold the role in their own right. */
  readonly users?: string[];
}

/**
 * An organization role, held by teams or by people.
 *
 * The role itself is GitHub's: `security_manager`, `ci_cd_admin`, the five
 * `all_repo_*` roles and the rest are predefined, and this declares who holds
 * one rather than what one grants. A name GitHub does not define is a synthesis
 * error, because inventing a role here would be a grant that silently does
 * nothing.
 *
 * This matters more than its size suggests. `all_repo_maintain` is a repository
 * permission on every repository at once, with no list to keep current, and
 * `security_manager` carries `read` on all of them the same way. So a role
 * assignment can widen access further than any team grant, while living
 * entirely outside the team tree.
 *
 * Assigning to a team and to its members separately is allowed and is what
 * GitHub reports, but the second is redundant: the team assignment already
 * reaches everyone in it. `plan` says so rather than removing it.
 */
export class OrganizationRole extends Construct {
  public readonly roleName: string;
  public readonly props: OrganizationRoleProps;

  constructor(scope: Construct, id: string, props: OrganizationRoleProps = {}) {
    super(scope, id);
    this.roleName = id;
    this.props = props;
  }
}
