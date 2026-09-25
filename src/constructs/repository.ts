import { Construct } from 'constructs';
import type { RepositoryVisibility } from '../synth/manifest.ts';

export interface RepositoryProps {
  /** Repository name without the owner. Defaults to the construct id. */
  readonly name?: string;

  /**
   * What the repository is for. Written only when the repository is created.
   */
  readonly description?: string;

  /**
   * Who can see a repository created from this declaration.
   *
   * Left unset it resolves at apply time to `internal` where the organization
   * is owned by an enterprise account, and `private` where it is not. Internal
   * is the better default of the two: every member of the enterprise can read
   * it, which is what makes cross-team work possible without asking, while
   * nobody outside the enterprise can, including outside collaborators.
   *
   * `public` is never a default and never inferred. GitHub's own API defaults a
   * new repository to public, and a repository opened to the internet by a
   * default nobody read is a decision nobody made.
   *
   * All of this applies to creating one. An existing repository keeps the
   * visibility it has: this is ignored for it, so declaring `public` never
   * opens a private repository and declaring nothing never closes an open one.
   */
  readonly visibility?: RepositoryVisibility;

  /** Merge buttons offered on a repository created from this declaration. */
  readonly allowMergeCommit?: boolean;
  readonly allowSquashMerge?: boolean;
  readonly allowRebaseMerge?: boolean;

  /** Delete the head branch once a pull request merges. */
  readonly deleteBranchOnMerge?: boolean;

  /** Feature tabs on a repository created from this declaration. */
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasWiki?: boolean;

  /**
   * Own this repository's Actions secrets even when the definition declares none
   * on it. An {@link ActionsSecret} in the scope owns it already; this keeps it
   * owned once the last one is removed, so that removal plans a delete (gated
   * by `--allow-delete=secrets`) instead of dropping the scope from what is
   * read and leaving the secret on GitHub.
   */
  readonly ownsSecrets?: boolean;

  /** The same for Actions variables, gated by `--allow-delete=variables`. */
  readonly ownsVariables?: boolean;
}

/**
 * A repository: created if GitHub does not have one by this name, adopted
 * unchanged if it does.
 *
 * Adoption is the whole of the second case. An existing repository's settings
 * are never read, diffed or written, so declaring one that already exists is
 * always a no-op and a definition can name the whole estate without proposing a
 * single change to it. The props describe what to create, not what to enforce.
 *
 * Nothing here deletes. Removing a declaration removes the declaration: the
 * repository stays, with its code, issues and history. The edit that drops a
 * repository from a definition is textually identical to the edit that drops it
 * from the company, and only one of those is recoverable, so this tool offers
 * the recoverable one.
 *
 * It is also the scope {@link BranchProtection} nests under.
 *
 * ```ts
 * const deck = new Repository(org, 'flow-portal', { private: true });
 * new BranchProtection(deck, 'main', { enforceAdmins: true });
 * ```
 */
export class Repository extends Construct {
  public readonly repositoryName: string;
  public readonly props: RepositoryProps;

  constructor(scope: Construct, id: string, props: RepositoryProps = {}) {
    super(scope, id);
    this.repositoryName = props.name ?? id;
    this.props = props;
  }
}
