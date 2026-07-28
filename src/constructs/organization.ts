import { Construct } from 'constructs';

export interface OrganizationProps {
  /** The GitHub organization login (e.g. `factbird`). */
  readonly login: string;
}

/**
 * A GitHub organization — the top-level scope that `Team`s are defined under.
 */
export class Organization extends Construct {
  public readonly login: string;

  constructor(scope: Construct, id: string, props: OrganizationProps) {
    super(scope, id);
    this.login = props.login;
  }
}
