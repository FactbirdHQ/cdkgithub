/**
 * Grants written one repository at a time.
 *
 * A `{ repo: permission }` map is compact and says the permission after the
 * repository, which is the wrong way round for reading: what a team may do is
 * the part worth seeing first, and it is the part that gets skimmed past in a
 * column of forty names. `maintain('netcore')` reads as the sentence it is.
 *
 * The helpers are generic over the repository name so a definition can narrow
 * them to its own list of repositories and have a misspelling fail where it is
 * written. They deliberately do not check for a repository granted twice in one
 * team: a tuple type can be made to detect it, at the cost of an error message
 * nobody can read, so {@link synthesize} asserts it instead and names both.
 */

import type {
  BuiltInRepoPermission,
  RepoPermission,
} from '../synth/manifest.ts';

/** One repository, at one permission. */
export interface RepositoryGrant<
  R extends string = string,
  P extends RepoPermission = RepoPermission,
> {
  readonly repository: R;
  readonly permission: P;
}

const at =
  <P extends BuiltInRepoPermission>(permission: P) =>
  <R extends string>(repository: R): RepositoryGrant<R, P> => ({
    repository,
    permission,
  });

/** Read the code, and nothing else. */
export const pull = at('pull');
/** Manage issues and pull requests without writing code. */
export const triage = at('triage');
/** Push to the repository. */
export const push = at('push');
/** Push, plus the repository's own presentation. Nothing destructive. */
export const maintain = at('maintain');
/** Everything, including deleting and transferring it. */
export const admin = at('admin');

/**
 * A grant through a repository role the organization defines.
 *
 * `role('Merge Queue Jumper')('netcore')` rather than a sixth helper, because the
 * set of custom roles belongs to an organization and not to this tool.
 */
export const role =
  <N extends string>(name: N) =>
  <R extends string>(repository: R): RepositoryGrant<R, N> => ({
    repository,
    permission: name,
  });
