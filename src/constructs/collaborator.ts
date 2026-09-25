import { Construct } from 'constructs';
import type { RepoPermission } from '../synth/manifest.ts';

export interface CollaboratorProps {
  /** GitHub login. Defaults to the construct id. */
  readonly login?: string;

  /** What the person holds on the repository: a built-in or a custom role name. */
  readonly permission: RepoPermission;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Nesting, or {@link Repository.addCollaborator}, is the clearer way to say it.
   */
  readonly repository?: string;
}

/**
 * A person granted access to one repository directly, outside any team: an
 * organization member added by hand, or an outside collaborator.
 *
 * Declaring one makes direct collaborators a managed surface. From then on
 * every declared repository's collaborators and pending invitations are read,
 * and one the definition does not declare is a gated removal
 * (`--allow-delete=collaborators`). A person who is not an organization member
 * is invited, and holds nothing until they accept.
 *
 * ```ts
 * const atat = new Repository(org, 'atat');
 * atat.addCollaborator('dbrgn', 'triage');
 * ```
 */
export class Collaborator extends Construct {
  public readonly login: string;
  public readonly props: CollaboratorProps;

  constructor(scope: Construct, id: string, props: CollaboratorProps) {
    super(scope, id);
    this.props = props;
    this.login = props.login ?? id;
  }
}
