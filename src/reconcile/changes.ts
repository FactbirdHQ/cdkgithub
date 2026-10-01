import type {
  LiveCodeSecurityConfiguration,
  LiveCustomProperty,
  LiveCustomRepositoryRole,
  LiveIssueField,
  LiveRunnerGroup,
  LiveRuleset,
  LiveTeam,
  LiveCollaborator,
  LiveEnvironment,
} from '../github/client.ts';
import type {
  ActionsPolicyManifest,
  ActionsSecretManifest,
  ActionsVariableManifest,
  BranchProtectionManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  CollaboratorManifest,
  CustomRepositoryRoleManifest,
  EnvironmentManifest,
  IssueFieldManifest,
  RepositoryManifest,
  ExternalGroupBinding,
  OrgSettingsManifest,
  RepoPermission,
  ResolvedRuleset,
  RunnerGroupManifest,
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

export interface CreateRepositoryRuleset {
  readonly kind: 'create-repo-ruleset';
  readonly repository: string;
  readonly ruleset: ResolvedRuleset;
}

export interface UpdateRepositoryRuleset {
  readonly kind: 'update-repo-ruleset';
  readonly repository: string;
  readonly id: number;
  readonly ruleset: ResolvedRuleset;
  readonly fields: FieldChange[];
}

/**
 * A ruleset on a declared repository that the definition does not carry. Gated
 * by --allow-delete, and only ever proposed for repositories the definition
 * declares rulesets on.
 */
export interface DeleteRepositoryRuleset {
  readonly kind: 'delete-repo-ruleset';
  readonly repository: string;
  readonly live: LiveRuleset;
}

export interface CreateRunnerGroup {
  readonly kind: 'create-runner-group';
  readonly group: RunnerGroupManifest;
}

export interface UpdateRunnerGroup {
  readonly kind: 'update-runner-group';
  readonly id: number;
  readonly group: RunnerGroupManifest;
  readonly fields: FieldChange[];
}

/**
 * A runner group absent from the definition. Gated by --allow-delete: the
 * repositories using it lose their runners. GitHub's default group is never a
 * candidate, because GitHub refuses to delete it.
 */
export interface DeleteRunnerGroup {
  readonly kind: 'delete-runner-group';
  readonly live: LiveRunnerGroup;
}

export interface CreateVariable {
  readonly kind: 'create-variable';
  readonly variable: ActionsVariableManifest;
}

export interface UpdateVariable {
  readonly kind: 'update-variable';
  readonly variable: ActionsVariableManifest;
  readonly fields: FieldChange[];
}

/** A variable absent from a declared scope. Gated by --allow-delete. */
export interface DeleteVariable {
  readonly kind: 'delete-variable';
  readonly name: string;
  /** Absent for an organization variable. */
  readonly repository?: string;
  /** The environment on `repository`, absent for a repository-wide variable. */
  readonly environment?: string;
}

/**
 * Write a secret: create it, or bring an existing one's visibility in line.
 * Either way the value is read from the declared environment variable and
 * pushed, because GitHub takes the two together and cannot say whether the
 * value it holds is current.
 */
export interface PutSecret {
  readonly kind: 'put-secret';
  readonly secret: ActionsSecretManifest;
  /** Empty on a create; on an update, what differs. */
  readonly fields: FieldChange[];
  /** Whether the secret exists on GitHub already. */
  readonly exists: boolean;
}

/** A secret absent from a declared scope. Gated by --allow-delete. */
/**
 * Create a declared environment, or bring an existing one's declared settings
 * in line. `addPolicies` are the branch and tag patterns to add after the
 * write, which a `custom` policy needs before it admits anything.
 */
export interface PutEnvironment {
  readonly kind: 'put-environment';
  readonly environment: EnvironmentManifest;
  /** Absent when the environment does not exist yet. */
  readonly current?: LiveEnvironment;
  readonly fields: FieldChange[];
  readonly addPolicies: Array<{ name: string; type: 'branch' | 'tag' }>;
}

/** A branch or tag pattern an environment admits that the declaration does not. */
export interface DeleteEnvironmentBranchPolicy {
  readonly kind: 'delete-environment-branch-policy';
  readonly repository: string;
  readonly environment: string;
  readonly policy: { id: number; name: string; type: 'branch' | 'tag' };
}

/**
 * Grant a declared collaborator, or bring their permission in line. `current`
 * is what they hold or were invited to; a pending invitation is updated in
 * place rather than sent again.
 */
export interface SetCollaborator {
  readonly kind: 'set-collaborator';
  readonly collaborator: CollaboratorManifest;
  readonly current?: LiveCollaborator;
}

/** A direct collaborator or pending invitation the definition does not declare. Gated by --allow-delete. */
export interface RemoveCollaborator {
  readonly kind: 'remove-collaborator';
  readonly live: LiveCollaborator;
}

export interface DeleteSecret {
  readonly kind: 'delete-secret';
  readonly name: string;
  /** Absent for an organization secret. */
  readonly repository?: string;
  /** The environment on `repository`, absent for a repository-wide secret. */
  readonly environment?: string;
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

export interface CreateIssueField {
  readonly kind: 'create-issue-field';
  readonly field: IssueFieldManifest;
}

/** Addressed through `live`, whose id and option ids the write carries. */
export interface UpdateIssueField {
  readonly kind: 'update-issue-field';
  readonly live: LiveIssueField;
  readonly field: IssueFieldManifest;
  readonly fields: FieldChange[];
}

/**
 * An issue field absent from the definition. Deleting it clears its value from
 * every issue in the organization. Gated by --allow-delete.
 */
export interface DeleteIssueField {
  readonly kind: 'delete-issue-field';
  readonly live: LiveIssueField;
}

/** Write a branch's legacy protection. */
export interface SetBranchProtection {
  readonly kind: 'branch-protection';
  readonly protection: BranchProtectionManifest;
  readonly fields: FieldChange[];
}

/**
 * Remove a branch's legacy protection, from `enabled: false`. The declaration
 * is deliberate, but the change still removes every rule on the branch in one
 * call, so it is gated by `--allow-delete` like every other removal.
 */
export interface RemoveBranchProtection {
  readonly kind: 'remove-branch-protection';
  readonly repository: string;
  readonly branch: string;
}

/** Grant an organization role to a team or a person. */
export interface AssignOrganizationRole {
  readonly kind: 'assign-org-role';
  readonly role: string;
  readonly roleId: number;
  readonly subject: 'team' | 'user';
  readonly name: string;
}

/**
 * Take an organization role away. Gated by `--allow-delete`: a role can carry a
 * repository permission on every repository, so removing one is as wide a change
 * as this tool makes.
 */
export interface RevokeOrganizationRole {
  readonly kind: 'revoke-org-role';
  readonly role: string;
  readonly roleId: number;
  readonly subject: 'team' | 'user';
  readonly name: string;
}

export interface CreateRepositoryRole {
  readonly kind: 'create-repo-role';
  readonly role: CustomRepositoryRoleManifest;
}

export interface UpdateRepositoryRole {
  readonly kind: 'update-repo-role';
  readonly id: number;
  readonly role: CustomRepositoryRoleManifest;
  readonly fields: FieldChange[];
}

/**
 * A custom repository role the definition does not declare. Gated by
 * `--allow-delete`: teams grant through it, and deleting it takes their access
 * rather than dropping them to the base role.
 */
export interface DeleteRepositoryRole {
  readonly kind: 'delete-repo-role';
  readonly live: LiveCustomRepositoryRole;
}

/**
 * Create a repository the organization does not have.
 *
 * There is no update and no delete beside it. An existing repository is adopted
 * as it stands, and a declaration removed from the definition removes nothing
 * from GitHub.
 */
export interface CreateRepository {
  readonly kind: 'create-repository';
  readonly repository: RepositoryManifest;
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
  | CreateRepositoryRuleset
  | UpdateRepositoryRuleset
  | DeleteRepositoryRuleset
  | CreateRunnerGroup
  | UpdateRunnerGroup
  | DeleteRunnerGroup
  | CreateVariable
  | UpdateVariable
  | DeleteVariable
  | PutSecret
  | DeleteSecret
  | PutEnvironment
  | SetCollaborator
  | RemoveCollaborator
  | DeleteEnvironmentBranchPolicy
  | CreateSecurityConfiguration
  | UpdateSecurityConfiguration
  | DeleteSecurityConfiguration
  | SetDefaultSecurityConfiguration
  | AttachSecurityConfiguration
  | CreateCustomProperty
  | UpdateCustomProperty
  | DeleteCustomProperty
  | SetPropertyValues
  | CreateIssueField
  | UpdateIssueField
  | DeleteIssueField
  | SetBranchProtection
  | RemoveBranchProtection
  | CreateRepository
  | CreateRepositoryRole
  | UpdateRepositoryRole
  | DeleteRepositoryRole
  | AssignOrganizationRole
  | RevokeOrganizationRole;

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
  'revoke-org-role',
  'delete-repo-role',
  'remove-repo-access',
  'remove-membership',
  'delete-ruleset',
  'delete-repo-ruleset',
  'delete-runner-group',
  'delete-variable',
  'delete-secret',
  'delete-environment-branch-policy',
  'remove-collaborator',
  'delete-security-config',
  'delete-property',
  'delete-issue-field',
  'remove-branch-protection',
] as const satisfies ReadonlyArray<Change['kind']>;

export type DestructiveKind = (typeof DESTRUCTIVE_KINDS)[number];

/**
 * The names `--allow-delete=<scope,...>` accepts, each covering one destructive
 * kind. A bare `--allow-delete` covers them all; naming scopes lets a run that
 * prunes one obsolete team not also authorize revoking an organization role.
 */
export const DELETE_SCOPES = {
  teams: 'delete',
  members: 'remove-membership',
  grants: 'remove-repo-access',
  'org-roles': 'revoke-org-role',
  'repo-roles': 'delete-repo-role',
  rulesets: 'delete-ruleset',
  'repo-rulesets': 'delete-repo-ruleset',
  'runner-groups': 'delete-runner-group',
  variables: 'delete-variable',
  secrets: 'delete-secret',
  'branch-policies': 'delete-environment-branch-policy',
  collaborators: 'remove-collaborator',
  'security-configs': 'delete-security-config',
  properties: 'delete-property',
  'issue-fields': 'delete-issue-field',
  'branch-protection': 'remove-branch-protection',
} as const satisfies Record<string, DestructiveKind>;

export type DeleteScope = keyof typeof DELETE_SCOPES;

export function isDestructive(change: Change): boolean {
  return (DESTRUCTIVE_KINDS as ReadonlyArray<string>).includes(change.kind);
}
