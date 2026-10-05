/**
 * cdkgithub — define GitHub organization structure and governance as
 * Infrastructure as Code, built on the `constructs` programming model
 * (inspired by AWS CDK).
 *
 * Public authoring API. Import these in your org definition (see `examples/`).
 */
export {
  ActionsPolicy,
  type ActionsPolicyProps,
} from './constructs/actions-policy.ts';
export {
  ActionsSecret,
  type ActionsSecretProps,
} from './constructs/actions-secret.ts';
export {
  ActionsVariable,
  type ActionsVariableProps,
} from './constructs/actions-variable.ts';
export { App, type AppProps } from './constructs/app.ts';
export {
  BranchProtection,
  type BranchProtectionProps,
} from './constructs/branch-protection.ts';
export {
  CodeSecurityConfiguration,
  type CodeSecurityConfigurationProps,
} from './constructs/code-security.ts';
export {
  Collaborator,
  type CollaboratorProps,
} from './constructs/collaborator.ts';
export {
  CustomProperty,
  type CustomPropertyProps,
} from './constructs/custom-property.ts';
export {
  CustomRepositoryRole,
  type CustomRepositoryRoleProps,
} from './constructs/custom-repository-role.ts';
export {
  Environment,
  type EnvironmentProps,
} from './constructs/environment.ts';
export type { ExternalGroupProps } from './constructs/external-group.ts';
export {
  admin,
  maintain,
  pull,
  push,
  type RepositoryGrant,
  role,
  triage,
} from './constructs/grants.ts';
export {
  IssueField,
  type IssueFieldProps,
} from './constructs/issue-field.ts';
export {
  Organization,
  type OrganizationProps,
  type OrganizationSettings,
} from './constructs/organization.ts';
export {
  OrganizationRole,
  type OrganizationRoleProps,
} from './constructs/organization-role.ts';
export {
  Repository,
  type RepositoryProps,
} from './constructs/repository.ts';
export {
  RepositoryRuleset,
  type RepositoryRulesetProps,
} from './constructs/repository-ruleset.ts';
export { Ruleset, type RulesetProps } from './constructs/ruleset.ts';
export {
  RunnerGroup,
  type RunnerGroupProps,
} from './constructs/runner-group.ts';
export {
  ScimProvisioning,
  type ScimProvisioningProps,
} from './constructs/scim-provisioning.ts';
export { Team, type TeamProps, teamOf } from './constructs/team.ts';
export {
  UserAccount,
  type UserAccountProps,
} from './constructs/user-account.ts';
export type {
  ActionsPolicyManifest,
  ActionsSecretManifest,
  ActionsVariableManifest,
  ActorRestriction,
  AllowedActions,
  AllowedActionsConfig,
  AppBypass,
  BranchProtectionManifest,
  BranchStatusCheck,
  BuiltInRepoPermission,
  BypassActorType,
  BypassMode,
  CodeScanningTool,
  CodeSecurityConfigurationManifest,
  CollaboratorManifest,
  CustomPropertyManifest,
  CustomPropertyValueType,
  CustomRepositoryRoleManifest,
  DefaultRepositoryPermission,
  DefaultWorkflowPermissions,
  DeployKeyBypass,
  DeploymentBranchPolicy,
  DesiredState,
  EnabledRepositories,
  EnvironmentManifest,
  EnvironmentReviewers,
  ExternalGroupBinding,
  IssueFieldDataType,
  IssueFieldManifest,
  IssueFieldOptionColor,
  IssueFieldOptionManifest,
  OrganizationAdminBypass,
  OrganizationRoleManifest,
  OrgConfigVisibility,
  OrgSettingsManifest,
  OwnerType,
  PatternRuleParameters,
  RepoPermission,
  RepositoryAccess,
  RepositoryRoleBypass,
  RepositoryRulesetManifest,
  RepositoryRulesetTarget,
  RepositoryVisibility,
  RequiredPullRequestReviews,
  RequiredStatusChecks,
  ResolvedBypassActor,
  ResolvedRuleset,
  RulesetBypassActor,
  RulesetConditions,
  RulesetEnforcement,
  RulesetManifest,
  RulesetNamePatterns,
  RulesetPropertySpec,
  RulesetRule,
  RulesetTarget,
  RunnerGroupManifest,
  RunnerGroupVisibility,
  ScimProvisioningManifest,
  SecurityAttachScope,
  SecurityDefaultScope,
  SecurityFeature,
  StatusCheckConfiguration,
  TeamBypass,
  TeamManifest,
  TeamPrivacy,
  WorkflowFileReference,
} from './synth/manifest.ts';
export {
  BUILT_IN_REPO_PERMISSIONS,
  isBuiltInRepoPermission,
} from './synth/manifest.ts';
export { collectWarnings } from './synth/warnings.ts';
export type {
  Vocabulary,
  VocabularyMember,
  VocabularyRepository,
} from './vocabulary.ts';
