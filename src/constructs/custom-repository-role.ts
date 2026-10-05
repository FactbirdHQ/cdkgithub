import { Construct } from 'constructs';

import type { BuiltInRepoPermission } from '../synth/manifest.ts';

export interface CustomRepositoryRoleProps {
  readonly description: string;
  /** The built-in this role extends. Everything below is added on top. */
  readonly baseRole: Exclude<BuiltInRepoPermission, 'admin'>;
  /**
   * The permissions the role adds, by GitHub's own names, e.g.
   * `jump_merge_queue` or `manage_webhooks`.
   *
   * A permission the base role already includes is rejected by GitHub rather
   * than ignored, which is a useful way to find out where the built-in line
   * actually falls.
   */
  readonly permissions: string[];
}

/**
 * A repository role the organization defines on top of a built-in.
 *
 * This is what fills the gap between `push` and `maintain`, and between
 * `maintain` and `admin`. `maintain` adds only a repository's presentation over
 * write, and everything consequential — branch protection, webhooks, Actions
 * secrets, access — is `admin`. A custom role is the way to grant one of those
 * without granting all of them.
 *
 * Declaring it here also closes a type. `RepoPermission` is open, because it has
 * to admit a role name GitHub knows and this tool does not, so a misspelled role
 * survives until `plan` checks it against the live organization. A definition
 * that declares its own roles knows their names at compile time and can narrow
 * the permission type to them, which moves that error from a plan to a red
 * squiggle.
 *
 * Deleting one is gated behind `--allow-delete`: teams hold grants through it,
 * and removing the role removes their access.
 */
export class CustomRepositoryRole extends Construct {
  public readonly roleName: string;
  public readonly props: CustomRepositoryRoleProps;

  constructor(scope: Construct, id: string, props: CustomRepositoryRoleProps) {
    super(scope, id);
    this.roleName = id;
    this.props = props;
  }
}
