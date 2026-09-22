/**
 * Desired-state manifest types — the output of synthesizing the construct tree.
 *
 * This is the serializable contract between `synth` (build desired state from
 * constructs) and `plan`/`apply` (diff & reconcile against the live GitHub org).
 * Keep it JSON-friendly: no class instances, no functions.
 *
 * The governance surfaces (settings, Actions policy, rulesets, code security,
 * custom properties) live in `./governance.ts` and are re-exported here.
 */

import type { BranchProtectionManifest } from './branch-protection.ts';
import type {
  ActionsPolicyManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  CustomRepositoryRoleManifest,
  OrganizationRoleManifest,
  OrgSettingsManifest,
  RulesetManifest,
} from './governance.ts';

export * from './branch-protection.ts';
export * from './governance.ts';

/** GitHub team visibility. `closed` = visible to all org members; `secret` = hidden. */
export type TeamPrivacy = 'closed' | 'secret';

/** The five permissions GitHub ships with every repository. */
export type BuiltInRepoPermission =
  | 'pull'
  | 'triage'
  | 'push'
  | 'maintain'
  | 'admin';

/**
 * Repository access level granted to a team: one of the five built-ins, or the
 * name of a custom repository role the organization defines.
 *
 * A custom role is written as its display name, `"Merge Queue Jumper"`, which is
 * the string GitHub's own API both takes and returns. `plan` resolves every name
 * that is not a built-in against `GET /orgs/{org}/custom-repository-roles` and
 * fails on one that matches nothing, so a misspelled `"pul"` is caught before
 * anything is written rather than granted as a role nobody defined.
 *
 * The `string & {}` arm widens the type without collapsing it, so an editor
 * still completes the five built-ins.
 */
export type RepoPermission = BuiltInRepoPermission | (string & {});

/** The built-ins, for telling a declared permission from a custom role name. */
export const BUILT_IN_REPO_PERMISSIONS: readonly BuiltInRepoPermission[] = [
  'pull',
  'triage',
  'push',
  'maintain',
  'admin',
];

export function isBuiltInRepoPermission(
  permission: string,
): permission is BuiltInRepoPermission {
  return (BUILT_IN_REPO_PERMISSIONS as readonly string[]).includes(permission);
}

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
  /**
   * The slug the team carries on GitHub today, when {@link slug} is a new one
   * the rename has not landed yet. The planner matches on {@link slug} first,
   * so the marker stops mattering the moment the rename applies.
   */
  readonly previousSlug?: string;
  readonly description?: string;
  readonly privacy: TeamPrivacy;
  /** Slug of the parent team, if this team is nested. */
  readonly parentSlug?: string;
  /**
   * Usernames that should be team maintainers, absent when the definition does
   * not manage this team's roster. See {@link members}.
   */
  readonly maintainers?: string[];
  /**
   * Usernames that should be plain members, absent when the definition does not
   * manage this team's roster.
   *
   * Absence is meaningful here the way it is for the governance surfaces. A team
   * that declares neither list keeps the members it has and is never read back,
   * so a definition covering only the team tree still runs on a token that only
   * reaches teams. Declaring either list makes the definition own the roster,
   * and a live member missing from it is proposed for removal.
   */
  readonly members?: string[];
  /**
   * Repository access grants, absent when the definition does not manage this
   * team's access. Declaring the map, `{}` included, makes the definition own
   * it, and a live grant missing from the map is proposed for removal.
   */
  readonly repositories?: RepositoryAccess;
  /** Entra ID group linkage (SCIM). Absent when the team is not IdP-synced. */
  readonly externalGroup?: ExternalGroupBinding;
}

/**
 * Who the definition manages. An organization has teams, rulesets, an Actions
 * policy, code security configurations, custom properties, and member
 * privileges. A personal account has none of those, so declaring one against a
 * `UserAccount` is a synthesis error rather than a silent no-op.
 */
export type OwnerType = 'organization' | 'user';

/**
 * The complete synthesized desired state for one account.
 *
 * Every governance collection is optional, and absence is meaningful: a surface
 * the definition never declares is one cdkgithub leaves alone, so it never
 * proposes deleting rulesets or properties from an org that has only adopted the
 * team structure. Once a surface is declared, the definition owns it and live
 * resources missing from it are proposed for deletion (gated by `--allow-delete`).
 */
export interface DesiredState {
  /** The organization login or username everything below belongs to. */
  readonly owner: string;
  /** Whether `owner` is an organization or a personal account. */
  readonly ownerType: OwnerType;
  /** Teams keyed implicitly by slug; ordered parents-before-children. */
  readonly teams: TeamManifest[];
  /** Member privileges and org-wide defaults. Only declared fields are diffed. */
  readonly settings?: OrgSettingsManifest;
  /** GitHub Actions permissions, allowlist, and default token scope. */
  readonly actions?: ActionsPolicyManifest;
  /** Repository roles this organization defines, keyed by name. */
  readonly customRepositoryRoles?: CustomRepositoryRoleManifest[];
  /** Who holds which organization role. Keyed by role name. */
  readonly organizationRoles?: OrganizationRoleManifest[];
  /** Organization rulesets, keyed by name. */
  readonly rulesets?: RulesetManifest[];
  /** Code security configurations, keyed by name. */
  readonly codeSecurityConfigurations?: CodeSecurityConfigurationManifest[];
  /** Repository custom properties, keyed by name. */
  readonly customProperties?: CustomPropertyManifest[];
  /**
   * Legacy per-branch protection, keyed by repository and branch. Rulesets cover
   * the same ground org-wide; this is for personal accounts and for describing
   * protection that already exists.
   */
  readonly branchProtection?: BranchProtectionManifest[];
}
