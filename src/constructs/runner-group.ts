import { Construct } from 'constructs';

import type { RunnerGroupVisibility } from '../synth/actions-admin.ts';

export interface RunnerGroupProps {
  /** Group name as it appears in the org's Actions settings. Defaults to the construct id. */
  readonly name?: string;

  /**
   * Which repositories may send jobs to the group: every repository, only the
   * private and internal ones, or the ones named in `selectedRepositories`.
   * @default "all"
   */
  readonly visibility?: RunnerGroupVisibility;

  /** Repository names allowed to use the group. Only read with `visibility: "selected"`. */
  readonly selectedRepositories?: string[];

  /**
   * Whether public repositories may use the group. GitHub defaults this off,
   * and it should stay off for any runner that holds credentials: a fork's
   * pull request runs the fork's code.
   */
  readonly allowsPublicRepositories?: boolean;

  /** Restrict the group to the workflows in `selectedWorkflows`. */
  readonly restrictedToWorkflows?: boolean;

  /** Workflow refs, e.g. `factbird/netcore/.github/workflows/deploy.yaml@main`. */
  readonly selectedWorkflows?: string[];
}

/**
 * A self-hosted runner group: which repositories and workflows may use a pool
 * of runners.
 *
 * The group is the access boundary, not the runners in it. Registering the
 * machines themselves happens wherever the machines live. GitHub's default
 * group always exists; declaring it by name manages its settings, and it is
 * never proposed for deletion because GitHub does not allow one.
 *
 * ```ts
 * new RunnerGroup(org, "deploy-runners", {
 *   visibility: "selected",
 *   selectedRepositories: ["flow-portal"],
 *   restrictedToWorkflows: true,
 *   selectedWorkflows: ["factbird/flow-portal/.github/workflows/deploy.yaml@main"],
 * });
 * ```
 */
export class RunnerGroup extends Construct {
  public readonly groupName: string;
  public readonly props: RunnerGroupProps;

  constructor(scope: Construct, id: string, props: RunnerGroupProps = {}) {
    super(scope, id);
    this.props = props;
    this.groupName = props.name ?? id;
  }
}
