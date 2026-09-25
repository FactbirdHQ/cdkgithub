import { Construct } from 'constructs';
import type {
  DeploymentBranchPolicy,
  EnvironmentReviewers,
} from '../synth/actions-admin.ts';

export interface EnvironmentProps {
  /** Environment name. Defaults to the construct id. */
  readonly name?: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Nesting is the clearer way to say it.
   */
  readonly repository?: string;

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
 * ```ts
 * const deck = new Repository(org, 'flight-deck');
 * new Environment(deck, 'production', {
 *   deploymentBranchPolicy: { branches: ['main'] },
 *   reviewers: { teams: ['platform'] },
 *   preventSelfReview: true,
 * });
 * ```
 */
export class Environment extends Construct {
  public readonly environmentName: string;
  public readonly props: EnvironmentProps;

  constructor(scope: Construct, id: string, props: EnvironmentProps = {}) {
    super(scope, id);
    this.props = props;
    this.environmentName = props.name ?? id;
  }
}
