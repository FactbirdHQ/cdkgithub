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
  CustomProperty,
  type CustomPropertyProps,
} from './constructs/custom-property.ts';
export {
  CustomRepositoryRole,
  type CustomRepositoryRoleProps,
} from './constructs/custom-repository-role.ts';
export {
  admin,
  maintain,
  pull,
  push,
  role,
  triage,
  type RepositoryGrant,
} from './constructs/grants.ts';
export type { ExternalGroupProps } from './constructs/external-group.ts';
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
export { Ruleset, type RulesetProps } from './constructs/ruleset.ts';
export { Team, teamOf, type TeamProps } from './constructs/team.ts';
export {
  UserAccount,
  type UserAccountProps,
} from './constructs/user-account.ts';
export type {
  ActionsPolicyManifest,
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
  CustomPropertyManifest,
  CustomPropertyValueType,
  CustomRepositoryRoleManifest,
  DefaultRepositoryPermission,
  DefaultWorkflowPermissions,
  DesiredState,
  EnabledRepositories,
  ExternalGroupBinding,
  OrganizationRoleManifest,
  OrgSettingsManifest,
  OwnerType,
  PatternRuleParameters,
  DeployKeyBypass,
  OrganizationAdminBypass,
  RepoPermission,
  RepositoryAccess,
  RepositoryVisibility,
  RepositoryRoleBypass,
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
