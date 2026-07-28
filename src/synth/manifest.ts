/**
 * Desired-state manifest types — the output of synthesizing the construct tree.
 *
 * This is the serializable contract between `synth` (build desired state from
 * constructs) and `plan`/`apply` (diff & reconcile against the live GitHub org).
 * Keep it JSON-friendly: no class instances, no functions.
 */

/** GitHub team visibility. `closed` = visible to all org members; `secret` = hidden. */
export type TeamPrivacy = "closed" | "secret";

/** Repository access level granted to a team. Mirrors GitHub's permission values. */
export type RepoPermission = "pull" | "triage" | "push" | "maintain" | "admin";

/**
 * A reference to an external identity-provider group (Entra ID security group)
 * that should be linked to the team via GitHub's SCIM external-groups API.
 *
 * At author time you typically only know the group's display `name`; the numeric
 * `id` is assigned by GitHub once the group has been provisioned via SCIM and is
 * resolved at apply time. Providing `id` directly skips the name lookup.
 */
export interface ExternalGroupBinding {
  /** Display name of the Entra security group as seen in GitHub's external groups. */
  readonly name?: string;
  /** GitHub external-group id, if already known. */
  readonly id?: number;
}

/** A team's mapping of `repo name -> permission`. */
export type RepositoryAccess = Record<string, RepoPermission>;

/** Fully-resolved desired state for a single team. */
export interface TeamManifest {
  /** URL-safe slug GitHub uses to address the team (derived from the name). */
  readonly slug: string;
  /** Human-readable team name. */
  readonly name: string;
  readonly description?: string;
  readonly privacy: TeamPrivacy;
  /** Slug of the parent team, if this team is nested. */
  readonly parentSlug?: string;
  /** Usernames that should be team maintainers. */
  readonly maintainers: string[];
  /** Usernames that should be plain members. */
  readonly members: string[];
  /** Repository access grants. */
  readonly repositories: RepositoryAccess;
  /** Entra ID group linkage (SCIM). Absent when the team is not IdP-synced. */
  readonly externalGroup?: ExternalGroupBinding;
}

/** The complete synthesized desired state for one organization. */
export interface DesiredState {
  /** GitHub organization login the teams belong to. */
  readonly org: string;
  /** Teams keyed implicitly by slug; ordered parents-before-children. */
  readonly teams: TeamManifest[];
}
