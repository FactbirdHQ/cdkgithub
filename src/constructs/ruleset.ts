import { Construct } from 'constructs';
import type {
  RulesetBypassActor,
  RulesetConditions,
  RulesetEnforcement,
  RulesetRule,
  RulesetTarget,
} from '../synth/governance.ts';

export interface RulesetProps {
  /**
   * Ruleset name as it appears in the org's rules settings. Defaults to the
   * construct id. GitHub keeps names unique per org, so this is the identity
   * cdkgithub diffs on.
   */
  readonly name?: string;

  /**
   * What the ruleset protects.
   * @default "branch"
   */
  readonly target?: RulesetTarget;

  /**
   * `active` blocks violations, `evaluate` records them without blocking (a good
   * way to land a new ruleset before it starts failing people's pushes), and
   * `disabled` keeps the definition without effect.
   * @default "active"
   */
  readonly enforcement?: RulesetEnforcement;

  /**
   * Which repositories and refs the ruleset applies to. Omitting it targets
   * every repository in the org.
   */
  readonly conditions?: RulesetConditions;

  /** The rules themselves. An empty ruleset is accepted but protects nothing. */
  readonly rules: RulesetRule[];

  /** Actors permitted to bypass the rules, e.g. the org admins or a release app. */
  readonly bypassActors?: RulesetBypassActor[];
}

/**
 * An organization ruleset — GitHub's replacement for branch protection.
 *
 * Rulesets apply across repositories, selected by name pattern or by custom
 * property, and repository-level rules can only add restrictions on top of them.
 * That is why cdkgithub models the org level and leaves per-repository rulesets
 * to the repositories themselves.
 *
 * ```ts
 * new Ruleset(org, 'protect-default-branch', {
 *   conditions: { refName: { include: ['~DEFAULT_BRANCH'] } },
 *   rules: [
 *     { type: 'deletion' },
 *     { type: 'non_fast_forward' },
 *     {
 *       type: 'pull_request',
 *       parameters: {
 *         requiredApprovingReviewCount: 1,
 *         dismissStaleReviewsOnPush: true,
 *         requireCodeOwnerReview: false,
 *         requireLastPushApproval: false,
 *         requiredReviewThreadResolution: true,
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export class Ruleset extends Construct {
  public readonly rulesetName: string;
  public readonly props: RulesetProps;

  constructor(scope: Construct, id: string, props: RulesetProps) {
    super(scope, id);
    this.props = props;
    this.rulesetName = props.name ?? id;
  }
}
