import { Construct } from 'constructs';
import { ActionsSecret, type ActionsSecretProps } from './actions-secret.ts';
import { ActionsVariable } from './actions-variable.ts';
import type {
  DeploymentBranchPolicy,
  EnvironmentReviewers,
} from '../synth/actions-admin.ts';

/** Where a secret declared by name takes its value from. */
export type SecretOptions = Pick<ActionsSecretProps, 'valueFrom'>;

/** An environment's settings and contents, as `Repository.addEnvironment` takes them. */
export interface EnvironmentOptions {
  /**
   * Which refs may deploy here. `"protected"` admits protected branches only;
   * a `{ branches, tags }` object admits refs matching those name patterns and
   * nothing else. `"all"` is GitHub's default, any branch.
   *
   * This is what makes an OIDC trust on `environment:<name>` mean anything: a
   * cloud role that trusts the environment trusts every ref allowed to deploy
   * to it.
   */
  readonly deploymentBranchPolicy?: DeploymentBranchPolicy;

  /** Teams and people who must approve a deployment. At most six in total. */
  readonly reviewers?: EnvironmentReviewers;

  /** Stop whoever triggered a deployment approving it themselves. */
  readonly preventSelfReview?: boolean;

  /** Minutes a deployment waits before it proceeds, up to 43200 (30 days). */
  readonly waitTimer?: number;

  /** Variables only jobs in this environment read, by name and value. */
  readonly variable?: Readonly<Record<string, string>>;

  /** Secrets only jobs in this environment read, by name. */
  readonly secret?: Readonly<Record<string, SecretOptions>>;
}

export interface EnvironmentProps extends EnvironmentOptions {
  /** Environment name. Defaults to the construct id. */
  readonly name?: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Nesting, or {@link Repository.addEnvironment}, is the clearer way to say it.
   */
  readonly repository?: string;
}

/**
 * A deployment environment on a repository.
 *
 * Declaring one creates it when the repository lacks it and holds every field
 * written here to what it says; a field left out is not managed. An environment
 * the definition does not declare is left alone, because deleting one also
 * deletes its secrets, variables and deployment history.
 *
 * Whether administrators may bypass the rules is not declarable: GitHub
 * reports `can_admins_bypass` but its REST API does not accept it.
 *
 * Variables and secrets nested under it live in it, so each form below
 * declares the same thing:
 *
 * ```ts
 * const deck = new Repository(org, 'flight-deck', {
 *   environment: {
 *     production: {
 *       deploymentBranchPolicy: { branches: ['main'] },
 *       variable: { DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/deploy' },
 *       secret: { SENTRY_DSN: {} },
 *     },
 *   },
 * });
 *
 * const production = deck.addEnvironment('production', {
 *   deploymentBranchPolicy: { branches: ['main'] },
 * });
 * production.addVariable('DEPLOY_ROLE_ARN', 'arn:aws:iam::123456789012:role/deploy');
 * production.addSecret('SENTRY_DSN');
 * ```
 */
export class Environment extends Construct {
  public readonly environmentName: string;
  public readonly props: EnvironmentProps;

  constructor(scope: Construct, id: string, props: EnvironmentProps = {}) {
    super(scope, id);
    this.props = props;
    this.environmentName = props.name ?? id;
    for (const [name, value] of Object.entries(props.variable ?? {})) {
      this.addVariable(name, value);
    }
    for (const [name, options] of Object.entries(props.secret ?? {})) {
      this.addSecret(name, options);
    }
  }

  /** Declare a variable in this environment. */
  addVariable(name: string, value: string): ActionsVariable {
    return new ActionsVariable(this, name, { value });
  }

  /** Declare a secret in this environment, its value read from `valueFrom` (default: its name). */
  addSecret(name: string, options: SecretOptions = {}): ActionsSecret {
    return new ActionsSecret(this, name, options);
  }
}
