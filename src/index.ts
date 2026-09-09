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
export type { ExternalGroupProps } from './constructs/external-group.ts';
export {
  Organization,
  type OrganizationProps,
  type OrganizationSettings,
} from './constructs/organization.ts';
export {
  Repository,
  type RepositoryProps,
} from './constructs/repository.ts';
export { Ruleset, type RulesetProps } from './constructs/ruleset.ts';
export { Team, type TeamProps } from './constructs/team.ts';
export {
  UserAccount,
  type UserAccountProps,
} from './constructs/user-account.ts';
export type {
  ActionsPolicyManifest,
  ActorRestriction,
  AllowedActions,
  AllowedActionsConfig,
  BranchProtectionManifest,
  BranchStatusCheck,
  CodeScanningTool,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  CustomPropertyValueType,
  DefaultRepositoryPermission,
  DefaultWorkflowPermissions,
  DesiredState,
  EnabledRepositories,
  ExternalGroupBinding,
  OrgSettingsManifest,
  OwnerType,
  PatternRuleParameters,
  RepoPermission,
  RepositoryAccess,
  RequiredPullRequestReviews,
  RequiredStatusChecks,
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
  TeamManifest,
  TeamPrivacy,
  WorkflowFileReference,
} from './synth/manifest.ts';
export { collectWarnings } from './synth/warnings.ts';
