import { Construct } from 'constructs';
import type {
  AllowedActions,
  AllowedActionsConfig,
  DefaultWorkflowPermissions,
  EnabledRepositories,
} from '../synth/governance.ts';

export interface ActionsPolicyProps {
  /** Which repositories may run Actions at all. */
  readonly enabledRepositories?: EnabledRepositories;

  /**
   * Repository names allowed to run Actions. Only read when
   * `enabledRepositories` is `selected`; the names are resolved to repository
   * ids at apply time.
   */
  readonly selectedRepositories?: string[];

  /** Which actions and reusable workflows those repositories may run. */
  readonly allowedActions?: AllowedActions;

  /** The allowlist itself. Only read when `allowedActions` is `selected`. */
  readonly allowedActionsConfig?: AllowedActionsConfig;

  /**
   * Default `GITHUB_TOKEN` permissions for workflow runs. `read` is the setting
   * most orgs want: workflows that need to write ask for it in the workflow file.
   */
  readonly defaultWorkflowPermissions?: DefaultWorkflowPermissions;

  /** Whether workflow runs may approve pull requests. */
  readonly canApprovePullRequestReviews?: boolean;
}

/**
 * The organization's GitHub Actions policy.
 *
 * One per organization; a second instance is a synthesis error. Fields left
 * undefined stay under whatever the org has configured today.
 *
 * ```ts
 * new ActionsPolicy(org, 'actions', {
 *   allowedActions: 'selected',
 *   allowedActionsConfig: {
 *     githubOwnedAllowed: true,
 *     verifiedAllowed: false,
 *     patternsAllowed: ['factbird/*'],
 *   },
 *   defaultWorkflowPermissions: 'read',
 *   canApprovePullRequestReviews: false,
 * });
 * ```
 */
export class ActionsPolicy extends Construct {
  public readonly props: ActionsPolicyProps;

  constructor(scope: Construct, id: string, props: ActionsPolicyProps) {
    super(scope, id);
    this.props = props;
  }
}
