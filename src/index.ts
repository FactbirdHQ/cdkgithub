/**
 * cdkgithub — define GitHub organization team structure as Infrastructure
 * as Code, built on the `constructs` programming model (inspired by AWS CDK).
 *
 * Public authoring API. Import these in your org definition (see `orgs/`).
 */
export { App, type AppProps } from "./constructs/app.ts";
export {
  Organization,
  type OrganizationProps,
} from "./constructs/organization.ts";
export { Team, type TeamProps } from "./constructs/team.ts";
export type { ExternalGroupProps } from "./constructs/external-group.ts";
export type {
  DesiredState,
  ExternalGroupBinding,
  RepoPermission,
  RepositoryAccess,
  TeamManifest,
  TeamPrivacy,
} from "./synth/manifest.ts";
