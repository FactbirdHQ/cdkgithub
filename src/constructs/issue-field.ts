import { Construct } from 'constructs';

import type { IssueFieldDataType, IssueFieldOptionManifest } from '../synth/governance.ts';

export interface IssueFieldProps {
  /** Field name as issues show it. Defaults to the construct id. */
  readonly name?: string;

  /**
   * What the field holds. GitHub cannot change it on an existing field, so a
   * plan that finds a different type stops rather than replacing the field.
   */
  readonly dataType: IssueFieldDataType;

  readonly description?: string | null;

  /** Who sees the field's values. GitHub defaults to `organization_members_only`. */
  readonly visibility?: 'organization_members_only' | 'all';

  /**
   * The choices of a `single_select` or `multi_select` field, in display order.
   * A bare string is an option with no description and the color `gray`. The
   * list is the whole set, and dropping an option clears it from every issue.
   */
  readonly options?: ReadonlyArray<string | IssueFieldOptionManifest>;
}

/**
 * An organization issue field: structured data every repository's issues can
 * carry, beside the title, labels and issue type.
 *
 * ```ts
 * new IssueField(org, 'Priority', {
 *   dataType: 'single_select',
 *   options: [
 *     { name: 'P0', color: 'red' },
 *     { name: 'P1', color: 'orange' },
 *     'P2',
 *   ],
 * });
 * ```
 */
export class IssueField extends Construct {
  public readonly fieldName: string;
  public readonly props: IssueFieldProps;

  constructor(scope: Construct, id: string, props: IssueFieldProps) {
    super(scope, id);
    this.props = props;
    this.fieldName = props.name ?? id;
  }
}
