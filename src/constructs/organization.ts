import { Construct } from 'constructs';

import type { OrgSettingsManifest } from '../synth/governance.ts';
import { ActionsSecret, type ActionsSecretProps } from './actions-secret.ts';
import { ActionsVariable, type ActionsVariableProps } from './actions-variable.ts';
import { CodeSecurityConfiguration, type CodeSecurityConfigurationProps } from './code-security.ts';
import { CustomProperty, type CustomPropertyProps } from './custom-property.ts';
import { CustomRepositoryRole, type CustomRepositoryRoleProps } from './custom-repository-role.ts';
import { IssueField, type IssueFieldProps } from './issue-field.ts';
import { OrganizationRole, type OrganizationRoleProps } from './organization-role.ts';
import { Ruleset, type RulesetProps } from './ruleset.ts';
import { RunnerGroup, type RunnerGroupProps } from './runner-group.ts';
import { Team, type TeamProps } from './team.ts';

/** An organization variable, as `Organization.addVariable` takes it. */
export type OrganizationVariableOptions = Omit<ActionsVariableProps, 'name' | 'repository' | 'environment'>;

/** An organization secret, as `Organization.addSecret` takes it. */
export type OrganizationSecretOptions = Omit<ActionsSecretProps, 'name' | 'repository' | 'environment'>;

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

  /** Organization Actions variables, by name. Each must say who reads it. */
  readonly variable?: Readonly<Record<string, OrganizationVariableOptions>>;

  /** Organization Actions secrets, by name. Each must say who reads it. */
  readonly secret?: Readonly<Record<string, OrganizationSecretOptions>>;

  /** Organization rulesets, by name. */
  readonly ruleset?: Readonly<Record<string, Omit<RulesetProps, 'name'>>>;

  /** Self-hosted runner groups, by name. */
  readonly runnerGroup?: Readonly<Record<string, Omit<RunnerGroupProps, 'name'>>>;

  /** Repository custom properties, by name. */
  readonly customProperty?: Readonly<Record<string, Omit<CustomPropertyProps, 'name'>>>;

  /** Issue fields, by name. */
  readonly issueField?: Readonly<Record<string, Omit<IssueFieldProps, 'name'>>>;

  /** Code security configurations, by name. */
  readonly codeSecurityConfiguration?: Readonly<Record<string, Omit<CodeSecurityConfigurationProps, 'name'>>>;

  /** Who holds each organization role, by role name. */
  readonly organizationRole?: Readonly<Record<string, OrganizationRoleProps>>;

  /** Custom repository roles, by role name. */
  readonly customRepositoryRole?: Readonly<Record<string, CustomRepositoryRoleProps>>;
}

/**
 * A GitHub organization — the top-level scope that teams, rulesets, the Actions
 * policy, code security configurations, and custom properties are defined under.
 *
 * What it holds can be written as props, one record per kind keyed by name, or
 * added one at a time with the `add*` methods, the way an AWS CDK Lambda
 * function takes `environment` or `addEnvironment`. Both make the same
 * constructs a `new Ruleset(org, …)` would.
 */
export class Organization extends Construct {
  public readonly login: string;
  public readonly settings?: OrganizationSettings;

  constructor(scope: Construct, id: string, props: OrganizationProps) {
    super(scope, id);
    this.login = props.login;
    this.settings = props.settings;
    for (const [name, options] of Object.entries(props.variable ?? {})) {
      this.addVariable(name, options);
    }
    for (const [name, options] of Object.entries(props.secret ?? {})) {
      this.addSecret(name, options);
    }
    for (const [name, options] of Object.entries(props.ruleset ?? {})) {
      this.addRuleset(name, options);
    }
    for (const [name, options] of Object.entries(props.runnerGroup ?? {})) {
      this.addRunnerGroup(name, options);
    }
    for (const [name, options] of Object.entries(props.customProperty ?? {})) {
      this.addCustomProperty(name, options);
    }
    for (const [name, options] of Object.entries(props.issueField ?? {})) {
      this.addIssueField(name, options);
    }
    for (const [name, options] of Object.entries(props.codeSecurityConfiguration ?? {})) {
      this.addCodeSecurityConfiguration(name, options);
    }
    for (const [name, options] of Object.entries(props.organizationRole ?? {})) {
      this.addOrganizationRole(name, options);
    }
    for (const [name, options] of Object.entries(props.customRepositoryRole ?? {})) {
      this.addCustomRepositoryRole(name, options);
    }
  }

  /**
   * Declare a top-level team. Its roster is checked against the declared
   * vocabulary, as `new Team` checks it, and its `addSubTeam` children
   * inherit that check. Teams have no record prop, only this and
   * {@link Team.addSubTeam}.
   */
  addTeam(id: string, props: TeamProps = {}): Team {
    return new Team(this, id, props);
  }

  /** Declare an organization variable. */
  addVariable(name: string, options: OrganizationVariableOptions): ActionsVariable {
    return new ActionsVariable(this, name, options);
  }

  /** Declare an organization secret, its value read from `valueFrom` (default: its name). */
  addSecret(name: string, options: OrganizationSecretOptions): ActionsSecret {
    return new ActionsSecret(this, name, options);
  }

  /** Declare an organization ruleset. */
  addRuleset(name: string, options: Omit<RulesetProps, 'name'>): Ruleset {
    return new Ruleset(this, name, options);
  }

  /** Declare a self-hosted runner group. */
  addRunnerGroup(name: string, options: Omit<RunnerGroupProps, 'name'> = {}): RunnerGroup {
    return new RunnerGroup(this, name, options);
  }

  /** Declare a repository custom property. */
  addCustomProperty(name: string, options: Omit<CustomPropertyProps, 'name'>): CustomProperty {
    return new CustomProperty(this, name, options);
  }

  /** Declare an issue field. */
  addIssueField(name: string, options: Omit<IssueFieldProps, 'name'>): IssueField {
    return new IssueField(this, name, options);
  }

  /** Declare a code security configuration. */
  addCodeSecurityConfiguration(
    name: string,
    options: Omit<CodeSecurityConfigurationProps, 'name'>,
  ): CodeSecurityConfiguration {
    return new CodeSecurityConfiguration(this, name, options);
  }

  /** Declare who holds an organization role. */
  addOrganizationRole(name: string, options: OrganizationRoleProps = {}): OrganizationRole {
    return new OrganizationRole(this, name, options);
  }

  /** Declare a custom repository role. */
  addCustomRepositoryRole(name: string, options: CustomRepositoryRoleProps): CustomRepositoryRole {
    return new CustomRepositoryRole(this, name, options);
  }
}
