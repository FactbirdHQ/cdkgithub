import { Construct } from 'constructs';
import type { OrgConfigVisibility } from '../synth/actions-admin.ts';

export interface ActionsSecretProps {
  /** Secret name. Defaults to the construct id. */
  readonly name?: string;

  /**
   * Environment variable `apply` reads the value from at the moment it writes.
   * Defaults to the secret's own name. The value itself never appears in the
   * definition, the manifest, the plan, or the backups.
   */
  readonly valueFrom?: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Either makes this a repository secret; without both it is an organization
   * secret.
   */
  readonly repository?: string;

  /**
   * Which repositories can read an organization secret. Required there, so
   * nobody finds out at apply time what a default decided; not accepted on a
   * repository secret.
   */
  readonly visibility?: OrgConfigVisibility;

  /** Repository names that can read it. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];
}

/**
 * A GitHub Actions secret, declared without its value.
 *
 * The declaration owns the secret's existence and visibility; the value comes
 * out of the environment named by `valueFrom` when `apply` writes, sealed with
 * the repository or organization public key before it leaves the process.
 * GitHub cannot return a secret's value, so `plan` diffs existence and
 * visibility only, and the value is pushed on create and on any update. To
 * rotate one in place, change any declared field or recreate it.
 *
 * ```ts
 * new ActionsSecret(org, "NPM_TOKEN", { visibility: "private" });
 *
 * const deck = new Repository(org, "flight-deck");
 * new ActionsSecret(deck, "SENTRY_DSN", { valueFrom: "DECK_SENTRY_DSN" });
 * ```
 */
export class ActionsSecret extends Construct {
  public readonly secretName: string;
  public readonly props: ActionsSecretProps;

  constructor(scope: Construct, id: string, props: ActionsSecretProps = {}) {
    super(scope, id);
    this.props = props;
    this.secretName = props.name ?? id;
  }
}
