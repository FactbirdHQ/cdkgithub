import { Construct } from 'constructs';
import type {
  ActorRestriction,
  RequiredPullRequestReviews,
  RequiredStatusChecks,
} from '../synth/branch-protection.ts';

export interface BranchProtectionProps {
  /** Branch name. Defaults to the construct id. One literal branch, no patterns. */
  readonly branch?: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Nesting is the clearer way to say it.
   */
  readonly repository?: string;

  /**
   * `false` removes the branch's protection. That is how you retire legacy
   * protection once a ruleset covers the branch, rather than deleting the
   * construct and leaving the live setting behind.
   * @default true
   */
  readonly enabled?: boolean;

  readonly requiredStatusChecks?: RequiredStatusChecks | null;
  readonly requiredPullRequestReviews?: RequiredPullRequestReviews | null;
  /** Apply the rules to administrators too. */
  readonly enforceAdmins?: boolean;
  /** Who may push at all. Organization repositories only. */
  readonly restrictions?: ActorRestriction | null;
  readonly requiredLinearHistory?: boolean;
  readonly allowForcePushes?: boolean;
  readonly allowDeletions?: boolean;
  readonly blockCreations?: boolean;
  readonly requiredConversationResolution?: boolean;
  /** Make the branch read-only. */
  readonly lockBranch?: boolean;
  /** Allow a locked branch to pull from upstream. */
  readonly allowForkSyncing?: boolean;
  readonly requiredSignatures?: boolean;
}

/**
 * Legacy branch protection for one branch of one repository.
 *
 * Prefer a {@link Ruleset}. Rulesets replaced this API, apply across
 * repositories, and compose, whereas this protects exactly one branch of one
 * repository and has to be repeated for every branch you care about. Synthesis
 * warns when an organization definition uses it.
 *
 * It is still the right tool for a personal account, which has no organization
 * rulesets to inherit, and for writing down protection a repository already
 * carries so it can be reviewed and then migrated.
 *
 * ```ts
 * const deck = new Repository(org, 'flight-deck');
 *
 * new BranchProtection(deck, 'main', {
 *   enforceAdmins: true,
 *   requiredSignatures: true,
 *   requiredStatusChecks: { strict: true, checks: [{ context: 'build' }] },
 *   requiredPullRequestReviews: {
 *     requiredApprovingReviewCount: 1,
 *     dismissStaleReviews: true,
 *   },
 * });
 * ```
 */
export class BranchProtection extends Construct {
  public readonly branch: string;
  public readonly props: BranchProtectionProps;

  constructor(scope: Construct, id: string, props: BranchProtectionProps = {}) {
    super(scope, id);
    this.props = props;
    this.branch = props.branch ?? id;
  }
}
