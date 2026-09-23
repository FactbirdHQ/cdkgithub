import { Construct } from 'constructs';
import type {
  RepositoryRulesetTarget,
  RulesetBypassActor,
  RulesetConditions,
  RulesetEnforcement,
  RulesetRule,
} from '../synth/governance.ts';

export interface RepositoryRulesetProps {
  /** Ruleset name as it appears in the repository's rules settings. Defaults to the construct id. */
  readonly name?: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Nesting is the clearer way to say it.
   */
  readonly repository?: string;

  /**
   * What the ruleset protects. `repository` lifecycle rules exist only at the
   * organization level.
   * @default "branch"
   */
  readonly target?: RepositoryRulesetTarget;

  /** @default "active" */
  readonly enforcement?: RulesetEnforcement;

  /**
   * Which refs the ruleset applies to. The ruleset already lives on its
   * repository, so `refName` is the only condition there is.
   */
  readonly conditions?: Pick<RulesetConditions, 'refName'>;

  /** The rules themselves. */
  readonly rules: RulesetRule[];

  /** Actors permitted to bypass the rules. */
  readonly bypassActors?: RulesetBypassActor[];
}

/**
 * A ruleset on one repository.
 *
 * An organization {@link Ruleset} is the stronger tool: it covers repositories
 * that do not exist yet, and repository rules can only add restrictions on top
 * of it. A repository ruleset is for the rule that genuinely belongs to one
 * repository, such as a merge queue or a release-tag pattern, and for
 * personal accounts, which have no organization to inherit from.
 *
 * ```ts
 * const deck = new Repository(org, "flow-portal");
 *
 * new RepositoryRuleset(deck, "merge-queue", {
 *   conditions: { refName: { include: ["~DEFAULT_BRANCH"] } },
 *   rules: [
 *     {
 *       type: "merge_queue",
 *       parameters: {
 *         mergeMethod: "SQUASH",
 *         groupingStrategy: "ALLGREEN",
 *         minEntriesToMerge: 1,
 *         maxEntriesToMerge: 5,
 *         maxEntriesToBuild: 5,
 *         minEntriesToMergeWaitMinutes: 5,
 *         checkResponseTimeoutMinutes: 60,
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export class RepositoryRuleset extends Construct {
  public readonly rulesetName: string;
  public readonly props: RepositoryRulesetProps;

  constructor(scope: Construct, id: string, props: RepositoryRulesetProps) {
    super(scope, id);
    this.props = props;
    this.rulesetName = props.name ?? id;
  }
}
