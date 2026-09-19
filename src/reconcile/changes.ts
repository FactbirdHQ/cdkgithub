import type {
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveRuleset,
  LiveTeam,
} from '../github/client.ts';
import type {
  ActionsPolicyManifest,
  BranchProtectionManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  ExternalGroupBinding,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedRuleset,
  TeamManifest,
} from '../synth/manifest.ts';

/** The two roles GitHub records for a team member. */
export type TeamRole = 'member' | 'maintainer';

/** Create a team that exists in the desired state but not on GitHub. */
export interface CreateTeam {
  readonly kind: 'create';
  readonly team: TeamManifest;
}

/** A single differing field on an existing resource. */
export interface FieldChange<T = unknown> {
  readonly field: string;
  readonly from: T;
  readonly to: T;
}

/** Update core properties of an existing team. */
export interface UpdateTeam {
  readonly kind: 'update';
  readonly slug: string;
  readonly team: TeamManifest;
  readonly fields: FieldChange[];
}

/** A team on GitHub that is not present in the desired state. Gated by --allow-delete. */
export interface DeleteTeam {
  readonly kind: 'delete';
  readonly live: LiveTeam;
}

/** Give a team access to a repository, or change the access it already has. */
export interface SetRepoAccess {
  readonly kind: 'set-repo-access';
  readonly slug: string;
  readonly repository: string;
  readonly permission: RepoPermission;
  /** The live permission, absent when the team cannot reach the repository yet. */
  readonly from?: string;
}

/**
 * A live repository grant the team's declared access map does not carry. Gated
 * by --allow-delete, because it takes a team's access away.
 */
export interface RemoveRepoAccess {
  readonly kind: 'remove-repo-access';
  readonly slug: string;
  readonly repository: string;
  readonly from: string;
}

/** Put a user in a team, or change the role they hold in it. */
export interface SetTeamMembership {
  readonly kind: 'set-membership';
  readonly slug: string;
  readonly username: string;
  readonly role: TeamRole;
  /** The live role, absent when the user is not in the team yet. */
  readonly from?: TeamRole;
}

/**
 * A live team member the declared roster does not carry. Gated by
 * --allow-delete, because it removes someone's access.
 */
export interface RemoveTeamMembership {
  readonly kind: 'remove-membership';
  readonly slug: string;
  readonly username: string;
  readonly from: TeamRole;
}

/** Ensure a team is linked to its Entra ID security group via SCIM. Gated by --enable-scim. */
export interface LinkExternalGroup {
  readonly kind: 'link-group';
  readonly slug: string;
  readonly group: ExternalGroupBinding;
}

/** Bring the org's member privileges and defaults in line with the definition. */
export interface UpdateOrgSettings {
  readonly kind: 'org-settings';
  readonly settings: OrgSettingsManifest;
  readonly fields: FieldChange[];
}

/**
 * Bring the Actions policy in line. `fields` names what differs; `policy` carries
 * the declaration so the applier knows which of the three endpoints to call.
 */
export interface UpdateActionsPolicy {
  readonly kind: 'actions-policy';
  readonly policy: ActionsPolicyManifest;
  readonly fields: FieldChange[];
}

export interface CreateRuleset {
  readonly kind: 'create-ruleset';
  readonly ruleset: ResolvedRuleset;
}

export interface UpdateRuleset {
  readonly kind: 'update-ruleset';
  readonly id: number;
  readonly ruleset: ResolvedRuleset;
  readonly fields: FieldChange[];
}

/** An org ruleset absent from the definition. Gated by --allow-delete. */
export interface DeleteRuleset {
  readonly kind: 'delete-ruleset';
  readonly live: LiveRuleset;
}

export interface CreateSecurityConfiguration {
  readonly kind: 'create-security-config';
  readonly config: CodeSecurityConfigurationManifest;
}

export interface UpdateSecurityConfiguration {
  readonly kind: 'update-security-config';
  readonly id: number;
  readonly config: CodeSecurityConfigurationManifest;
  readonly fields: FieldChange[];
}

/** A code security configuration absent from the definition. Gated by --allow-delete. */
export interface DeleteSecurityConfiguration {
  readonly kind: 'delete-security-config';
  readonly live: LiveCodeSecurityConfiguration;
}

/** Make a configuration the one new repositories of a scope inherit. */
export interface SetDefaultSecurityConfiguration {
  readonly kind: 'default-security-config';
  readonly configName: string;
  readonly scope: NonNullable<
    CodeSecurityConfigurationManifest['defaultForNewRepos']
  >;
  readonly from?: string;
}

/**
 * Attach a configuration to repositories. Attachment lives on the repositories
 * rather than on the configuration, so this is re-applied every run instead of
 * being diffed, the way team external-group links are.
 */
export interface AttachSecurityConfiguration {
  readonly kind: 'attach-security-config';
  readonly configName: string;
  readonly scope: string;
  /** Repository names, when attaching to a named list rather than a scope. */
  readonly repositories?: string[];
}

export interface CreateCustomProperty {
  readonly kind: 'create-property';
  readonly property: CustomPropertyManifest;
}

export interface UpdateCustomProperty {
  readonly kind: 'update-property';
  readonly property: CustomPropertyManifest;
  readonly fields: FieldChange[];
}

/** A custom property absent from the definition. Gated by --allow-delete. */
export interface DeleteCustomProperty {
  readonly kind: 'delete-property';
  readonly live: LiveCustomProperty;
}

/** Set one property's value on the repositories whose value differs. */
export interface SetPropertyValues {
  readonly kind: 'property-values';
  readonly propertyName: string;
  /** Repository name to desired value, for the repositories that differ. */
  readonly values: Record<string, string | string[] | null>;
}

/** Write a branch's legacy protection. */
export interface SetBranchProtection {
  readonly kind: 'branch-protection';
  readonly protection: BranchProtectionManifest;
  readonly fields: FieldChange[];
}

/**
 * Remove a branch's legacy protection, from `enabled: false`. This is a
 * deliberate declaration rather than a prune, so it is not gated by
 * `--allow-delete`: the definition asked for the branch to be unprotected.
 */
export interface RemoveBranchProtection {
  readonly kind: 'remove-branch-protection';
  readonly repository: string;
  readonly branch: string;
}

export type Change =
  | CreateTeam
  | UpdateTeam
  | DeleteTeam
  | SetRepoAccess
  | RemoveRepoAccess
  | SetTeamMembership
  | RemoveTeamMembership
  | LinkExternalGroup
  | UpdateOrgSettings
  | UpdateActionsPolicy
  | CreateRuleset
  | UpdateRuleset
  | DeleteRuleset
  | CreateSecurityConfiguration
  | UpdateSecurityConfiguration
  | DeleteSecurityConfiguration
  | SetDefaultSecurityConfiguration
  | AttachSecurityConfiguration
  | CreateCustomProperty
  | UpdateCustomProperty
  | DeleteCustomProperty
  | SetPropertyValues
  | SetBranchProtection
  | RemoveBranchProtection;

/** The team-shaped changes, which the team applier owns. */
export type TeamChange =
  | CreateTeam
  | UpdateTeam
  | DeleteTeam
  | SetRepoAccess
  | RemoveRepoAccess
  | SetTeamMembership
  | RemoveTeamMembership
  | LinkExternalGroup;

/** Everything else: the org-wide governance surfaces. */
export type GovernanceChange = Exclude<Change, TeamChange>;

const TEAM_KINDS: ReadonlyArray<Change['kind']> = [
  'create',
  'update',
  'delete',
  'set-repo-access',
  'remove-repo-access',
  'set-membership',
  'remove-membership',
  'link-group',
];

export function isGovernanceChange(change: Change): change is GovernanceChange {
  return !TEAM_KINDS.includes(change.kind);
}

/** The change kinds that remove something and therefore need `--allow-delete`. */
export const DESTRUCTIVE_KINDS = [
  'delete',
  'remove-repo-access',
  'remove-membership',
  'delete-ruleset',
  'delete-security-config',
  'delete-property',
] as const satisfies ReadonlyArray<Change['kind']>;

export function isDestructive(change: Change): boolean {
  return (DESTRUCTIVE_KINDS as ReadonlyArray<string>).includes(change.kind);
}
