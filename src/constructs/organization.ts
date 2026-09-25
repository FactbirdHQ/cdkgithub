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

  /**
   * Own this organization's Actions secrets even when the definition declares none
   * on it. An {@link ActionsSecret} in the scope owns it already; this keeps it
   * owned once the last one is removed, so that removal plans a delete (gated
   * by `--allow-delete=secrets`) instead of dropping the scope from what is
   * read and leaving the secret on GitHub.
   */
  readonly ownsSecrets?: boolean;

  /** The same for Actions variables, gated by `--allow-delete=variables`. */
  readonly ownsVariables?: boolean;
}

/**
 * A GitHub organization — the top-level scope that teams, rulesets, the Actions
 * policy, code security configurations, and custom properties are defined under.
 */
export class Organization extends Construct {
  public readonly login: string;
  public readonly settings?: OrganizationSettings;
  public readonly ownsSecrets?: boolean;
  public readonly ownsVariables?: boolean;

  constructor(scope: Construct, id: string, props: OrganizationProps) {
    super(scope, id);
    this.login = props.login;
    this.settings = props.settings;
    this.ownsSecrets = props.ownsSecrets;
    this.ownsVariables = props.ownsVariables;
  }
}
