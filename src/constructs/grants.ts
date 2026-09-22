/**
 * Grants written one repository at a time.
 *
 * A `{ repo: permission }` map is compact and says the permission after the
 * repository, which is the wrong way round for reading: what a team may do is
 * the part worth seeing first, and it is the part that gets skimmed past in a
 * column of forty names. `maintain('nest')` reads as the sentence it is.
 *
 * Each helper takes as many repositories as you like, so a category declared
 * elsewhere is granted by spreading it: `triage(...systemII)`. A list of those
 * calls is flattened, which is why `[push('nest'), triage(...systemII)]` is one
 * list of grants rather than a list of lists.
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
  <R extends string>(...repositories: R[]): RepositoryGrant<R, P>[] =>
    repositories.map((repository) => ({ repository, permission }));

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
 * Curried so the role is named once and the binding is imported, rather than
 * its display name being retyped at every grant:
 *
 * ```ts
 * // roles.ts, beside the CustomRepositoryRole that declares it
 * export const MERGE_QUEUE_JUMPER = 'Merge Queue Jumper';
 * export const mergeQueueJumper = role(MERGE_QUEUE_JUMPER);
 *
 * // and wherever it is granted
 * repositories: [mergeQueueJumper('nest'), push('fbctl')],
 * ```
 *
 * A custom role is a string to GitHub, so a retyped one is a typo waiting to
 * reach `plan`. Binding it once makes the name a symbol the compiler checks.
 *
 * Not a sixth built-in helper, because which roles exist belongs to an
 * organization rather than to this tool.
 */
export const role =
  <N extends string>(name: N) =>
  <R extends string>(...repositories: R[]): RepositoryGrant<R, N>[] =>
    repositories.map((repository) => ({ repository, permission: name }));

/**
 * What a helper returns, or one grant on its own.
 *
 * `push('nest')` is a list of one and `triage(...systemII)` a list of many, so
 * a team's grants are a list of lists. Flattened on the way into the manifest,
 * which is what lets both sit in the same array.
 */
export type RepositoryGrantList = RepositoryGrant | readonly RepositoryGrant[];
