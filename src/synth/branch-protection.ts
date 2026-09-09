/**
 * Desired-state types for legacy branch protection,
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection`.
 *
 * Rulesets replaced this API and cover the same ground across many repositories
 * at once, so an organization should reach for {@link RulesetManifest} first.
 * Legacy protection earns its place in two situations. A personal account has no
 * organization rulesets to inherit, and a repository already carrying protection
 * needs describing before it can be migrated. `collectWarnings` says so at synth
 * time when the owner is an organization.
 *
 * The same camelCase convention as the rest of the manifest applies. The write
 * side of this API takes flat booleans and login strings; the read side returns
 * `{ enabled }` wrappers and whole user objects, and the client flattens those
 * back into this shape so the planner compares like with like.
 */

/** Users, teams, and apps named in a restriction or an allowance. */
export interface ActorRestriction {
  /** Usernames. */
  readonly users?: string[];
  /** Team slugs. */
  readonly teams?: string[];
  /** App slugs. */
  readonly apps?: string[];
}

/** A status check that must pass, optionally pinned to the app reporting it. */
export interface BranchStatusCheck {
  readonly context: string;
  /** The app that must report the check. Absent means any app may. */
  readonly appId?: number | null;
}

export interface RequiredStatusChecks {
  /** Require the branch to be up to date with the base before merging. */
  readonly strict: boolean;
  readonly checks: BranchStatusCheck[];
}

export interface RequiredPullRequestReviews {
  readonly requiredApprovingReviewCount?: number;
  readonly dismissStaleReviews?: boolean;
  readonly requireCodeOwnerReviews?: boolean;
  readonly requireLastPushApproval?: boolean;
  /** Who may dismiss reviews. Organization repositories only. */
  readonly dismissalRestrictions?: ActorRestriction;
  /** Who may merge without meeting the review requirement. Organization repositories only. */
  readonly bypassPullRequestAllowances?: ActorRestriction;
}

/**
 * Protection for one branch of one repository.
 *
 * Every field is optional and undeclared fields are left as they are, matching
 * the rest of the manifest. The exception is `enabled: false`, which removes the
 * branch's protection outright; that is the declarative way to retire legacy
 * protection once a ruleset covers the branch.
 */
export interface BranchProtectionManifest {
  /** Repository name, without the owner. */
  readonly repository: string;
  /** Branch name. Patterns are not supported; this API takes one literal branch. */
  readonly branch: string;
  /**
   * `false` deletes the branch's protection.
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
  /** Block creating new refs that match the branch. */
  readonly blockCreations?: boolean;
  readonly requiredConversationResolution?: boolean;
  /** Make the branch read-only. */
  readonly lockBranch?: boolean;
  /** Allow a locked branch to pull from upstream. */
  readonly allowForkSyncing?: boolean;
  /**
   * Require signed commits. This has its own endpoint rather than living in the
   * protection payload, so the applier writes it separately.
   */
  readonly requiredSignatures?: boolean;
}
