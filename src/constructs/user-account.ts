import { Construct } from 'constructs';

export interface UserAccountProps {
  /** The GitHub username (e.g. `martinjlowm`). */
  readonly login: string;
}

/**
 * A personal GitHub account, as an alternative root to {@link Organization}.
 *
 * A personal account has no teams, no organization rulesets, no Actions policy,
 * no code security configurations, and no custom properties. Everything
 * org-wide is simply not available to it, so the synthesizer rejects those
 * constructs rather than letting them synthesize into a manifest that could
 * never apply.
 *
 * What is left is repositories and their branch protection, which is the one
 * case where the legacy branch protection API is the right tool rather than a
 * leftover.
 *
 * ```ts
 * const me = new UserAccount(app, 'martinjlowm', { login: 'martinjlowm' });
 * const dotfiles = new Repository(me, 'dotfiles');
 * new BranchProtection(dotfiles, 'main', { requiredSignatures: true });
 * ```
 */
export class UserAccount extends Construct {
  public readonly login: string;

  constructor(scope: Construct, id: string, props: UserAccountProps) {
    super(scope, id);
    this.login = props.login;
  }
}
