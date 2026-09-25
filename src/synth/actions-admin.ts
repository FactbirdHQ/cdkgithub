/**
 * Desired-state types for the Actions administration surfaces: runner groups,
 * and the secrets and variables workflows read.
 *
 * The same two conventions as `./governance.ts` apply: optional fields are
 * unmanaged, and the types mirror GitHub's payloads in camelCase.
 *
 * Secrets and variables come in an organization scope and a repository scope,
 * and one manifest type covers both: an entry carrying `repository` lives on
 * that repository, an entry without one lives on the organization. Ownership
 * follows the scopes that appear in the collection, not the collection itself:
 * declaring only repository-scoped entries never reads or prunes the
 * organization's own, and vice versa. A scope declared owned in
 * {@link OwnedScopes} is owned with no entry in it at all.
 */

// ---------------------------------------------------------------------------
// Runner groups — /orgs/{org}/actions/runner-groups
// ---------------------------------------------------------------------------

/** Which repositories may send jobs to a runner group. */
export type RunnerGroupVisibility = 'all' | 'selected' | 'private';

export interface RunnerGroupManifest {
  /** Group name, unique in the org; the identity the planner diffs on. */
  readonly name: string;
  /** @default "all" */
  readonly visibility?: RunnerGroupVisibility;
  /** Repository names allowed to use the group. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];
  /** Whether public repositories may use the group. Off is GitHub's default and the safe one. */
  readonly allowsPublicRepositories?: boolean;
  /** Restrict the group to the workflows named in `selectedWorkflows`. */
  readonly restrictedToWorkflows?: boolean;
  /** Workflow refs, e.g. `octo-org/octo-repo/.github/workflows/deploy.yaml@main`. */
  readonly selectedWorkflows?: string[];
}

// ---------------------------------------------------------------------------
// Secrets and variables — /orgs/{org}/actions/{secrets,variables},
//                         /repos/{owner}/{repo}/actions/{secrets,variables}
// ---------------------------------------------------------------------------

/** Which repositories can read an organization secret or variable. */
export type OrgConfigVisibility = 'all' | 'private' | 'selected';

export interface ActionsVariableManifest {
  /** Variable name. GitHub treats names case-insensitively and reports them uppercased. */
  readonly name: string;
  /** The value, in the clear: a variable is configuration, not a credential. */
  readonly value: string;
  /** The repository the variable lives on. Absent for an organization variable. */
  readonly repository?: string;
  /** Required on an organization variable; a repository variable has no visibility. */
  readonly visibility?: OrgConfigVisibility;
  /** Repository names that can read it. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];
}

/**
 * A secret, declared without its value.
 *
 * The manifest is written to disk and the plan to backups, so the value never
 * enters either: `valueFrom` names the environment variable `apply` reads it
 * from at the moment of writing. GitHub cannot return a secret's value, so the
 * planner diffs existence and visibility only; the value is pushed when the
 * secret is created and again on any update.
 */
export interface ActionsSecretManifest {
  /** Secret name. GitHub treats names case-insensitively and reports them uppercased. */
  readonly name: string;
  /** Environment variable the value is read from when `apply` writes. */
  readonly valueFrom: string;
  /** The repository the secret lives on. Absent for an organization secret. */
  readonly repository?: string;
  /** Required on an organization secret; a repository secret has no visibility. */
  readonly visibility?: OrgConfigVisibility;
  /** Repository names that can read it. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];
}

/**
 * The scopes a secret or variable collection owns whether or not it declares an
 * entry in them.
 *
 * An entry owns its own scope already. This covers the scope with no entry
 * left in it: without it, removing the last secret on a repository removes the
 * repository from what is read, and the secret the removal meant to delete
 * stays on GitHub with nothing in the plan to say so.
 */
export interface OwnedScopes {
  /** The organization's own secrets or variables. */
  readonly organization?: boolean;
  /** Repositories whose secrets or variables are owned. */
  readonly repositories?: string[];
}
