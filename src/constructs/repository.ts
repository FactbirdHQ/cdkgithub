import { Construct } from 'constructs';
import type { RepoPermission, RepositoryVisibility } from '../synth/manifest.ts';
import { ActionsSecret } from './actions-secret.ts';
import { ActionsVariable } from './actions-variable.ts';
import { Collaborator } from './collaborator.ts';
import {
  BranchProtection,
  type BranchProtectionProps,
} from './branch-protection.ts';
import {
  Environment,
  type EnvironmentOptions,
  type SecretOptions,
} from './environment.ts';
import {
  RepositoryRuleset,
  type RepositoryRulesetProps,
} from './repository-ruleset.ts';

/** A repository ruleset, as `Repository.addRuleset` takes it. */
export type RepositoryRulesetOptions = Omit<
  RepositoryRulesetProps,
  'name' | 'repository'
>;

/** A branch's legacy protection, as `Repository.addBranchProtection` takes it. */
export type BranchProtectionOptions = Omit<
  BranchProtectionProps,
  'branch' | 'repository'
>;

export interface RepositoryProps {
  /** Repository name without the owner. Defaults to the construct id. */
  readonly name?: string;

  /**
   * What the repository is for. Written only when the repository is created.
   */
  readonly description?: string;

  /**
   * Who can see a repository created from this declaration.
   *
   * Left unset it resolves at apply time to `internal` where the organization
   * is owned by an enterprise account, and `private` where it is not. Internal
   * is the better default of the two: every member of the enterprise can read
   * it, which is what makes cross-team work possible without asking, while
   * nobody outside the enterprise can, including outside collaborators.
   *
   * `public` is never a default and never inferred. GitHub's own API defaults a
   * new repository to public, and a repository opened to the internet by a
   * default nobody read is a decision nobody made.
   *
   * All of this applies to creating one. An existing repository keeps the
   * visibility it has: this is ignored for it, so declaring `public` never
   * opens a private repository and declaring nothing never closes an open one.
   */
  readonly visibility?: RepositoryVisibility;

  /** Merge buttons offered on a repository created from this declaration. */
  readonly allowMergeCommit?: boolean;
  readonly allowSquashMerge?: boolean;
  readonly allowRebaseMerge?: boolean;

  /** Delete the head branch once a pull request merges. */
  readonly deleteBranchOnMerge?: boolean;

  /** Feature tabs on a repository created from this declaration. */
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasWiki?: boolean;

  /**
   * Deployment environments, by name, like an AWS CDK Lambda function's
   * `environment`. The same as calling {@link Repository.addEnvironment} for
   * each.
   */
  readonly environment?: Readonly<Record<string, EnvironmentOptions>>;

  /** Repository-wide Actions variables, by name and value. */
  readonly variable?: Readonly<Record<string, string>>;

  /** Repository-wide Actions secrets, by name. */
  readonly secret?: Readonly<Record<string, SecretOptions>>;

  /** Repository rulesets, by name. */
  readonly ruleset?: Readonly<Record<string, RepositoryRulesetOptions>>;

  /** Direct collaborators, by login: who holds what on this repository outside any team. */
  readonly collaborator?: Readonly<Record<string, RepoPermission>>;

  /** Legacy branch protection, by branch. */
  readonly branchProtection?: Readonly<Record<string, BranchProtectionOptions>>;
}

/**
 * A repository: created if GitHub does not have one by this name, adopted
 * unchanged if it does.
 *
 * Adoption is the whole of the second case. An existing repository's settings
 * are never read, diffed or written, so declaring one that already exists is
 * always a no-op and a definition can name the whole estate without proposing a
 * single change to it. The props describe what to create, not what to enforce.
 *
 * Nothing here deletes. Removing a declaration removes the declaration: the
 * repository stays, with its code, issues and history. The edit that drops a
 * repository from a definition is textually identical to the edit that drops it
 * from the company, and only one of those is recoverable, so this tool offers
 * the recoverable one.
 *
 * It is also the scope {@link BranchProtection}, {@link Environment} and the
 * repository's own variables and secrets nest under, declared as props or
 * added with the methods below.
 *
 * ```ts
 * const deck = new Repository(org, 'flight-deck', { private: true });
 * new BranchProtection(deck, 'main', { enforceAdmins: true });
 * ```
 */
export class Repository extends Construct {
  public readonly repositoryName: string;
  public readonly props: RepositoryProps;

  constructor(scope: Construct, id: string, props: RepositoryProps = {}) {
    super(scope, id);
    this.repositoryName = props.name ?? id;
    this.props = props;
    for (const [name, options] of Object.entries(props.environment ?? {})) {
      this.addEnvironment(name, options);
    }
    for (const [name, value] of Object.entries(props.variable ?? {})) {
      this.addVariable(name, value);
    }
    for (const [name, options] of Object.entries(props.secret ?? {})) {
      this.addSecret(name, options);
    }
    for (const [name, options] of Object.entries(props.ruleset ?? {})) {
      this.addRuleset(name, options);
    }
    for (const [login, permission] of Object.entries(props.collaborator ?? {})) {
      this.addCollaborator(login, permission);
    }
    for (const [branch, options] of Object.entries(props.branchProtection ?? {})) {
      this.addBranchProtection(branch, options);
    }
  }

  /** Declare a deployment environment on this repository. */
  addEnvironment(name: string, options: EnvironmentOptions = {}): Environment {
    return new Environment(this, name, options);
  }

  /** Declare a repository-wide variable. */
  addVariable(name: string, value: string): ActionsVariable {
    return new ActionsVariable(this, name, { value });
  }

  /** Declare a repository-wide secret, its value read from `valueFrom` (default: its name). */
  addSecret(name: string, options: SecretOptions = {}): ActionsSecret {
    return new ActionsSecret(this, name, options);
  }

  /** Declare a ruleset on this repository. */
  addRuleset(name: string, options: RepositoryRulesetOptions): RepositoryRuleset {
    return new RepositoryRuleset(this, name, options);
  }

  /** Grant a person access to this repository directly, outside any team. */
  addCollaborator(login: string, permission: RepoPermission): Collaborator {
    return new Collaborator(this, login, { permission });
  }

  /** Declare a branch's legacy protection, or `{ enabled: false }` to retire it. */
  addBranchProtection(
    branch: string,
    options: BranchProtectionOptions = {},
  ): BranchProtection {
    return new BranchProtection(this, branch, options);
  }
}
