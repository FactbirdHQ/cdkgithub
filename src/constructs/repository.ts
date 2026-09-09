import { Construct } from 'constructs';

export interface RepositoryProps {
  /** Repository name without the owner. Defaults to the construct id. */
  readonly name?: string;
}

/**
 * A repository, used as a scope rather than as something cdkgithub creates.
 *
 * Repository creation is out of scope: the repository has to exist before
 * anything here can be attached to it. What the construct provides is a place to
 * nest {@link BranchProtection} under, the same way {@link Team} nests under
 * {@link Organization}.
 *
 * ```ts
 * const deck = new Repository(org, 'flight-deck');
 * new BranchProtection(deck, 'main', { enforceAdmins: true });
 * ```
 */
export class Repository extends Construct {
  public readonly repositoryName: string;

  constructor(scope: Construct, id: string, props: RepositoryProps = {}) {
    super(scope, id);
    this.repositoryName = props.name ?? id;
  }
}
