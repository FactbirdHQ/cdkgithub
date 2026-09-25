import { Construct } from 'constructs';
import type { OrgSettingsManifest } from '../synth/governance.ts';

/**
 * Member privileges and org-wide defaults, as authored. Every field is optional
 * and an omitted field is one cdkgithub does not manage, so adopting a single
 * setting never resets the others.
 */
export type OrganizationSettings = OrgSettingsManifest;

export interface OrganizationProps {
  /** The GitHub organization login (e.g. `factbird`). */
  readonly login: string;

  /**
   * Member privileges and org-wide defaults, applied with `PATCH /orgs/{org}`.
   *
   * ```ts
   * new Organization(app, 'factbird', {
   *   login: 'factbird',
   *   settings: {
   *     defaultRepositoryPermission: 'read',
   *     membersCanCreatePublicRepositories: false,
   *     membersCanForkPrivateRepositories: false,
   *     webCommitSignoffRequired: true,
   *   },
   * });
   * ```
   */
  readonly settings?: OrganizationSettings;
}

/**
 * A GitHub organization — the top-level scope that teams, rulesets, the Actions
 * policy, code security configurations, and custom properties are defined under.
 */
export class Organization extends Construct {
  public readonly login: string;
  public readonly settings?: OrganizationSettings;

  constructor(scope: Construct, id: string, props: OrganizationProps) {
    super(scope, id);
    this.login = props.login;
    this.settings = props.settings;
  }
}
