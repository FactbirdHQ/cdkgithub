import { Construct } from 'constructs';

import type { OrgConfigVisibility } from '../synth/actions-admin.ts';

export interface ActionsVariableProps {
  /** Variable name. Defaults to the construct id. */
  readonly name?: string;

  /** The value, in the clear. Anything secret belongs in an {@link ActionsSecret}. */
  readonly value: string;

  /**
   * Repository name, when the construct is not nested under a {@link Repository}.
   * Either makes this a repository variable; without both it is an
   * organization variable.
   */
  readonly repository?: string;

  /**
   * A deployment environment on the repository, for a variable only jobs
   * running in that environment read. The environment must already exist:
   * cdkgithub declares variables in it, not the environment itself.
   */
  readonly environment?: string;

  /**
   * Which repositories can read an organization variable. Required there, so
   * nobody finds out at apply time what a default decided; not accepted on a
   * repository variable, which only its own repository reads.
   */
  readonly visibility?: OrgConfigVisibility;

  /** Repository names that can read it. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];
}

/**
 * A GitHub Actions variable: plain configuration a workflow reads through the
 * `vars` context.
 *
 * Nest it under a {@link Repository} (or pass `repository`) for a repository
 * variable; declare it under the organization for an organization one.
 *
 * ```ts
 * new ActionsVariable(org, "DEPLOY_REGION", {
 *   value: "eu-west-1",
 *   visibility: "private",
 * });
 *
 * const deck = new Repository(org, "flow-portal");
 * new ActionsVariable(deck, "SENTRY_PROJECT", { value: "deck" });
 * ```
 */
export class ActionsVariable extends Construct {
  public readonly variableName: string;
  public readonly props: ActionsVariableProps;

  constructor(scope: Construct, id: string, props: ActionsVariableProps) {
    super(scope, id);
    this.props = props;
    this.variableName = props.name ?? id;
  }
}
